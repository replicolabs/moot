import { Keypair, PublicKey } from "@solana/web3.js";
import {
  createTreasuryMultisig,
  fullMemberPermissions,
  mootMemberPermissions,
  noVoteMemberPermissions,
} from "../squads/client.js";
import { getConnection, getMootKeypair, getPayerKeypair } from "../config.js";
import { requireLinkedWallet } from "./linkWallet.js";
import { submitProposal } from "./proposal.js";
import {
  EscrowMeta,
  getEscrowMeta,
  getTreasury,
  listTreasuries,
  saveEscrowMeta,
  saveTreasury,
  Treasury,
} from "../store.js";

export interface CreateEscrowInput {
  teamId: string;
  channelId: string;
  name: string;
  payerSlackId: string;
  payeeSlackId: string;
  arbiterSlackId: string;
  amount: number;
  token: string;
  milestone: string;
}

export interface CreateEscrowResult {
  treasuryId: string;
  vaultAddress: string;
  summary: string;
}

export async function createEscrow(input: CreateEscrowInput): Promise<CreateEscrowResult> {
  const { teamId, channelId, name, payerSlackId, payeeSlackId, arbiterSlackId, amount, token, milestone } = input;

  if (payeeSlackId === arbiterSlackId || payerSlackId === arbiterSlackId) {
    throw new Error("payer, payee, and arbiter must be three different people");
  }
  if (listTreasuries(teamId, channelId).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`an escrow or treasury named "${name}" already exists in this channel`);
  }

  const payerPubkey = new PublicKey(requireLinkedWallet(teamId, payerSlackId));
  const payeePubkey = new PublicKey(requireLinkedWallet(teamId, payeeSlackId));
  const arbiterPubkey = new PublicKey(requireLinkedWallet(teamId, arbiterSlackId));
  const moot = getMootKeypair();
  const payer = getPayerKeypair();
  const createKey = Keypair.generate();

  // Threshold 1: the payer alone can approve release on delivery, and the
  // arbiter alone can approve either direction to resolve a dispute if the
  // payer won't act. The payee gets Initiate+Execute but no Vote, so they
  // can request a release but can never approve their own payment. Custody
  // is the multisig: Moot only ever proposes "pay payee" or "refund payer",
  // never anything else, so no single approver can misdirect funds.
  const { multisigPda, vaultPda } = await createTreasuryMultisig({
    connection: getConnection(),
    payer,
    createKey,
    threshold: 1,
    timeLockSeconds: 0,
    members: [
      { publicKey: moot.publicKey, permissions: mootMemberPermissions() },
      { publicKey: payerPubkey, permissions: fullMemberPermissions() },
      { publicKey: payeePubkey, permissions: noVoteMemberPermissions() },
      { publicKey: arbiterPubkey, permissions: fullMemberPermissions() },
    ],
  });

  const treasuryId = multisigPda.toBase58();
  const treasury: Treasury = {
    treasuryId,
    teamId,
    channelId,
    name,
    multisigPda: treasuryId,
    vaultPda: vaultPda.toBase58(),
    threshold: 1,
    timeLockSeconds: 0,
    tokens: [token],
    memberSlackIds: [payerSlackId, payeeSlackId, arbiterSlackId],
    adminSlackIds: [arbiterSlackId],
    createdAtMs: Date.now(),
  };
  saveTreasury(treasury);

  const meta: EscrowMeta = {
    treasuryId,
    teamId,
    payerSlackId,
    payeeSlackId,
    arbiterSlackId,
    amount,
    token,
    milestone,
    createdAtMs: Date.now(),
  };
  saveEscrowMeta(meta);

  const summary =
    `Escrow "${name}": ${amount} ${token} to <@${payeeSlackId}>, released when: ${milestone}. ` +
    `Arbiter: <@${arbiterSlackId}>. Deposit address: ${vaultPda.toBase58()}`;

  return { treasuryId, vaultAddress: vaultPda.toBase58(), summary };
}

/** Moot drafts the "pay payee" proposal. Payer approves on delivery, or arbiter approves to resolve a dispute. */
export async function releaseEscrow(treasuryId: string, actorSlackId: string) {
  const meta = getEscrowMeta(treasuryId);
  if (!meta) throw new Error("not an escrow");
  const payeePubkey = requireLinkedWallet(meta.teamId, meta.payeeSlackId);

  return submitProposal({
    treasuryId,
    actorSlackId,
    recipient: payeePubkey,
    amount: meta.amount,
    token: meta.token,
    memo: `escrow release: ${meta.milestone}`,
  });
}

/** Moot drafts the "refund payer" proposal, for a dispute resolved in the payer's favor. */
export async function refundEscrow(treasuryId: string, actorSlackId: string) {
  const meta = getEscrowMeta(treasuryId);
  if (!meta) throw new Error("not an escrow");
  const payerPubkey = requireLinkedWallet(meta.teamId, meta.payerSlackId);

  return submitProposal({
    treasuryId,
    actorSlackId,
    recipient: payerPubkey,
    amount: meta.amount,
    token: meta.token,
    memo: `escrow refund: ${meta.milestone}`,
  });
}

export async function getEscrow(treasuryId: string) {
  const treasury = getTreasury(treasuryId);
  const meta = getEscrowMeta(treasuryId);
  if (!treasury || !meta) return null;
  return { treasury, meta };
}
