import {
  Connection,
  Keypair,
  PublicKey,
  Signer,
  TransactionMessage,
  TransactionInstruction,
  VersionedTransaction,
} from "@solana/web3.js";
import * as multisig from "@sqds/multisig";

const { Permission, Permissions } = multisig.types;

export type ClusterName = "devnet" | "mainnet-beta";

/**
 * multisig.errors.translateAndThrowAnchorError (in @sqds/multisig@2.1.4) tries
 * to assign `.logs` onto the translated error, but against the installed
 * @solana/web3.js version SendTransactionError.logs is a getter-only
 * accessor, so the assignment throws `TypeError: Cannot set property logs of
 * Error which has only a getter` and swallows the real error. Verified by
 * direct reproduction, not assumed. This wrapper falls back to the original
 * error (with whatever simulation logs it carries) when the translator itself
 * throws, so callers see the actual on-chain failure instead of an SDK bug.
 */
function translateOrRethrow(err: unknown): never {
  try {
    multisig.errors.translateAndThrowAnchorError(err);
  } catch (translateErr) {
    if (translateErr instanceof TypeError && /only a getter/.test(translateErr.message)) {
      const logs = (err as { logs?: string[] })?.logs;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(logs?.length ? `${message}\nLogs:\n${logs.join("\n")}` : message);
    }
    throw translateErr;
  }
  throw err;
}

export function connectionForCluster(rpcUrl: string): Connection {
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Moot's own multisig member: Initiate + Execute, deliberately no Vote.
 * This is the permission set that makes "Moot cannot approve anything" true on-chain,
 * not just in application logic. See moot/CLAUDE.md custody model.
 */
export function mootMemberPermissions() {
  return Permissions.fromPermissions([Permission.Initiate, Permission.Execute]);
}

export function fullMemberPermissions() {
  return Permissions.fromPermissions([
    Permission.Initiate,
    Permission.Vote,
    Permission.Execute,
  ]);
}

/**
 * Same bitmask as mootMemberPermissions() (Initiate + Execute, no Vote), but
 * named separately for escrow payees: they can propose/request a release but
 * can never approve their own payment. Only the payer and arbiter get Vote
 * in an escrow multisig.
 */
export function noVoteMemberPermissions() {
  return Permissions.fromPermissions([Permission.Initiate, Permission.Execute]);
}

export interface TreasuryMember {
  publicKey: PublicKey;
  /** Human voting members get full permissions; Moot's own key must use mootMemberPermissions(). */
  permissions: ReturnType<typeof Permissions.fromPermissions>;
}

export interface CreateTreasuryParams {
  connection: Connection;
  /** Pays for the multisig account rent and the protocol creation fee. */
  payer: Signer;
  /** Fresh, single-use keypair that seeds the multisig's PDA. Discarded after creation. */
  createKey: Signer;
  members: TreasuryMember[];
  threshold: number;
  timeLockSeconds?: number;
  vaultIndex?: number;
  programId?: PublicKey;
}

export interface CreateTreasuryResult {
  multisigPda: PublicKey;
  vaultPda: PublicKey;
  signature: string;
}

/**
 * Creates a real Squads v4 multisig on whatever cluster `connection` points at.
 * configAuthority is always null: per the IDL, that makes the multisig "autonomous",
 * meaning every config change (members, threshold) must itself go through a
 * member-approved multisig proposal. Moot must never hold that key.
 */
export async function createTreasuryMultisig(
  params: CreateTreasuryParams
): Promise<CreateTreasuryResult> {
  const {
    connection,
    payer,
    createKey,
    members,
    threshold,
    timeLockSeconds = 0,
    vaultIndex = 0,
    programId,
  } = params;

  const [multisigPda] = multisig.getMultisigPda({
    createKey: createKey.publicKey,
    programId,
  });

  // Idempotent: `createKey` is a persisted local test keypair, so a re-run after a
  // partial failure would otherwise try to re-create the same multisigPda and fail
  // with "account already in use".
  const existing = await connection.getAccountInfo(multisigPda);
  let signature = "";
  if (!existing) {
    const [programConfigPda] = multisig.getProgramConfigPda({ programId });
    const programConfig =
      await multisig.accounts.ProgramConfig.fromAccountAddress(
        connection,
        programConfigPda
      );

    signature = await multisig.rpc.multisigCreateV2({
      connection,
      treasury: programConfig.treasury,
      createKey,
      creator: payer,
      multisigPda,
      configAuthority: null,
      threshold,
      members: members.map((m) => ({
        key: m.publicKey,
        permissions: m.permissions,
      })),
      timeLock: timeLockSeconds,
      rentCollector: null,
      sendOptions: { skipPreflight: false },
    });

    await connection.confirmTransaction(signature, "confirmed");
  }

  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: vaultIndex,
    programId,
  });

  return { multisigPda, vaultPda, signature };
}

export interface SubmitProposalParams {
  connection: Connection;
  payer: Signer;
  /** Multisig member with Initiate permission who is drafting this proposal. */
  creator: Signer;
  multisigPda: PublicKey;
  vaultIndex?: number;
  /** Inner instructions to execute from the vault once approved (e.g. an SPL transfer). */
  instructions: TransactionInstruction[];
  memo?: string;
  programId?: PublicKey;
}

export interface SubmitProposalResult {
  transactionIndex: bigint;
  vaultTransactionSignature: string;
  proposalSignature: string;
}

/**
 * Creates the on-chain vault transaction + proposal for a transfer. This is the
 * "draft" becoming real, but it authorizes nothing by itself: it still needs
 * threshold approvals before it can execute.
 */
export async function submitProposal(
  params: SubmitProposalParams
): Promise<SubmitProposalResult> {
  const {
    connection,
    payer,
    creator,
    multisigPda,
    vaultIndex = 0,
    instructions,
    memo,
    programId,
  } = params;

  const multisigAccount = await multisig.accounts.Multisig.fromAccountAddress(
    connection,
    multisigPda
  );
  const transactionIndex = BigInt(multisigAccount.transactionIndex.toString()) + 1n;

  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: vaultIndex,
    programId,
  });

  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const transactionMessage = new TransactionMessage({
    payerKey: vaultPda,
    recentBlockhash: blockhash,
    instructions,
  });

  // rentPayer is explicitly `payer`, not `creator`: the multisig member drafting a
  // proposal (Moot, or any human member) should never need its own SOL balance just
  // to be authorized. Only feePayer's key ends up debited for rent + fees.
  const vaultTransactionSignature = await multisig.rpc.vaultTransactionCreate({
    connection,
    feePayer: payer,
    multisigPda,
    transactionIndex,
    creator: creator.publicKey,
    rentPayer: payer.publicKey,
    vaultIndex,
    ephemeralSigners: 0,
    transactionMessage,
    memo,
    signers: [creator].filter((s) => s.publicKey !== payer.publicKey),
    programId,
  });
  await connection.confirmTransaction(vaultTransactionSignature, "confirmed");

  // NOTE: multisig.rpc.proposalCreate in @sqds/multisig@2.1.4 accepts a `rentPayer`
  // argument but never forwards it into the transaction it builds (verified by
  // reading node_modules/@sqds/multisig/src/rpc/proposalCreate.ts), so it silently
  // defaults rent-payment to `creator`. We build the transaction via the lower-level
  // `transactions.proposalCreate`, which does thread `rentPayer` correctly, to keep
  // proposal drafters (including Moot) from ever needing their own SOL balance.
  const proposalBlockhash = (await connection.getLatestBlockhash()).blockhash;
  const proposalTx = multisig.transactions.proposalCreate({
    blockhash: proposalBlockhash,
    feePayer: payer.publicKey,
    multisigPda,
    transactionIndex,
    creator: creator.publicKey,
    rentPayer: payer.publicKey,
    programId,
  });
  const proposalTxSigners = creator.publicKey.equals(payer.publicKey)
    ? [payer]
    : [payer, creator];
  proposalTx.sign(proposalTxSigners);

  let proposalSignature: string;
  try {
    proposalSignature = await connection.sendTransaction(proposalTx);
  } catch (err) {
    translateOrRethrow(err);
  }
  await connection.confirmTransaction(proposalSignature, "confirmed");

  return { transactionIndex, vaultTransactionSignature, proposalSignature };
}

/**
 * Signs and submits an approval using a LOCAL keypair. Only ever used by the
 * Phase 1 proof script's own test keypairs. Moot's server code must never call
 * this with a real member's key, because it never holds one -- real members
 * sign in their own wallet via buildProposalApproveTransaction +
 * relaySignedTransaction below.
 */
export async function approveProposal(params: {
  connection: Connection;
  payer: Signer;
  member: Signer;
  multisigPda: PublicKey;
  transactionIndex: bigint;
  programId?: PublicKey;
}): Promise<string> {
  const { connection, payer, member, multisigPda, transactionIndex, programId } =
    params;

  const signature = await multisig.rpc.proposalApprove({
    connection,
    feePayer: payer,
    member,
    multisigPda,
    transactionIndex,
    programId,
  });
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

/**
 * Builds an UNSIGNED approval transaction for a real member to sign in their
 * own wallet in the signing web view. The member pays their own fee (they are
 * the fee payer), so Moot's server never needs to fund or touch this
 * transaction beyond building and later relaying it. This is the only
 * approval path real members ever go through.
 */
export async function buildProposalApproveTransaction(params: {
  connection: Connection;
  member: PublicKey;
  multisigPda: PublicKey;
  transactionIndex: bigint;
  memo?: string;
  programId?: PublicKey;
}): Promise<VersionedTransaction> {
  const { connection, member, multisigPda, transactionIndex, memo, programId } = params;

  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const message = new TransactionMessage({
    payerKey: member,
    recentBlockhash: blockhash,
    instructions: [
      multisig.instructions.proposalApprove({
        multisigPda,
        transactionIndex,
        member,
        memo,
        programId,
      }),
    ],
  }).compileToV0Message();

  return new VersionedTransaction(message);
}

/**
 * Relays an already-signed transaction (an approval signed by a member's own
 * wallet in the signing web view). Moot never sees the private key, only the
 * signed bytes the browser produced.
 */
export async function relaySignedTransaction(params: {
  connection: Connection;
  signedTransactionBase64: string;
}): Promise<string> {
  const { connection, signedTransactionBase64 } = params;
  const raw = Buffer.from(signedTransactionBase64, "base64");
  let signature: string;
  try {
    signature = await connection.sendRawTransaction(raw, { skipPreflight: false });
  } catch (err) {
    translateOrRethrow(err);
  }
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

/**
 * Cranks execution of an already-approved proposal. Safe for Moot to call:
 * executing a transaction that already has threshold approvals does not
 * require any authority Moot doesn't have.
 */
export async function executeProposal(params: {
  connection: Connection;
  payer: Signer;
  /** Member whose Execute permission is used to crank this. Can be Moot. */
  executor: Signer;
  multisigPda: PublicKey;
  transactionIndex: bigint;
  programId?: PublicKey;
}): Promise<string> {
  const { connection, payer, executor, multisigPda, transactionIndex, programId } =
    params;

  // Bypassing multisig.rpc.vaultTransactionExecute: it calls the SDK's own
  // translateAndThrowAnchorError internally on send failure with no way for
  // callers to intercept it, so it hits the same getter-only `.logs` bug
  // documented on translateOrRethrow above and masks the real execution
  // error (e.g. insufficient funds) behind a TypeError. Building the
  // transaction via the lower-level `transactions.vaultTransactionExecute`
  // and sending it ourselves lets us surface the actual failure.
  const blockhash = (await connection.getLatestBlockhash()).blockhash;
  const tx = await multisig.transactions.vaultTransactionExecute({
    connection,
    blockhash,
    feePayer: payer.publicKey,
    multisigPda,
    transactionIndex,
    member: executor.publicKey,
    programId,
  });
  const executeSigners = [payer, executor].filter(
    (s, i, arr) => arr.findIndex((o) => o.publicKey.equals(s.publicKey)) === i
  );
  tx.sign(executeSigners);

  let signature: string;
  try {
    signature = await connection.sendTransaction(tx);
  } catch (err) {
    translateOrRethrow(err);
  }
  await connection.confirmTransaction(signature, "confirmed");
  return signature;
}

export async function readMultisig(connection: Connection, multisigPda: PublicKey) {
  return multisig.accounts.Multisig.fromAccountAddress(connection, multisigPda);
}

export async function readProposal(
  connection: Connection,
  multisigPda: PublicKey,
  transactionIndex: bigint,
  programId?: PublicKey
) {
  const [proposalPda] = multisig.getProposalPda({
    multisigPda,
    transactionIndex,
    programId,
  });
  return multisig.accounts.Proposal.fromAccountAddress(connection, proposalPda);
}

export function vaultAddress(
  multisigPda: PublicKey,
  vaultIndex = 0,
  programId?: PublicKey
): PublicKey {
  const [vaultPda] = multisig.getVaultPda({
    multisigPda,
    index: vaultIndex,
    programId,
  });
  return vaultPda;
}

export function newSigner(): Keypair {
  return Keypair.generate();
}
