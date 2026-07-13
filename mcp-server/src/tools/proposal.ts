import { PublicKey, Transaction, sendAndConfirmTransaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  createTransferInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
} from "@solana/spl-token";
import {
  evaluate,
  loadPolicyFromFile,
  EvaluateResult,
  ProposalContext,
  TransferLikeDraft,
} from "@moot/shared";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildProposalApproveTransaction,
  executeProposal as executeProposalOnChain,
  readMultisig,
  readProposal,
  relaySignedTransaction,
  submitProposal as submitProposalOnChain,
} from "../squads/client.js";
import { getConnection, getMootKeypair, getPayerKeypair, getTokenConfig } from "../config.js";
import {
  getAllowlist,
  getHolds,
  getProposal,
  getRecentProposalAmounts,
  getTreasury,
  getWalletLink,
  isEscrow,
  isMergeProposalTreasury,
  saveProposal,
} from "../store.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..", "..");

function loadPolicyFor(actionType: "transfer" | "escrow" | "merge_pr") {
  return loadPolicyFromFile(join(REPO_ROOT, "policies", `${actionType}.yaml`));
}

/** Escrows and merge-PR proposals are stored as regular treasuries (see
 * store.ts's EscrowMeta / MergeProposalMeta doc comments), so proposal
 * evaluation must branch on the right policy: the transfer policy would
 * wrongly flag an escrow's payee as an unknown first-time recipient and
 * demand an admin escalation that can never be satisfied by that multisig. */
function loadPolicyForTreasury(treasuryId: string) {
  if (isEscrow(treasuryId)) return loadPolicyFor("escrow");
  if (isMergeProposalTreasury(treasuryId)) return loadPolicyFor("merge_pr");
  return loadPolicyFor("transfer");
}

interface DraftInput {
  treasuryId: string;
  actorSlackId: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
}

async function buildEvaluateContext(
  treasuryId: string,
  transactionIndexOverride?: bigint
): Promise<{ context: ProposalContext; onChainThreshold: number; onChainStatusKind: string | null }> {
  const treasury = getTreasury(treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${treasuryId}`);

  const connection = getConnection();
  const multisigPda = new PublicKey(treasury.multisigPda);
  const multisigAccount = await readMultisig(connection, multisigPda);
  const onChainThreshold = multisigAccount.threshold;

  let onChainApprovals: string[] = [];
  let timeLockRemainingSeconds = 0;
  let createdAtMs = Date.now();
  let onChainStatusKind: string | null = null;

  const txIndex = transactionIndexOverride;
  if (txIndex !== undefined) {
    const proposal = await readProposal(connection, multisigPda, txIndex);
    onChainApprovals = proposal.approved.map((k) => k.toBase58());
    onChainStatusKind = proposal.status.__kind;
    const stored = getProposal(treasuryId, txIndex.toString());
    createdAtMs = stored?.createdAtMs ?? createdAtMs;
    if (treasury.timeLockSeconds > 0 && "timestamp" in proposal.status) {
      const approvedAtMs = Number((proposal.status as any).timestamp.toString()) * 1000;
      const remaining = treasury.timeLockSeconds * 1000 - (Date.now() - approvedAtMs);
      timeLockRemainingSeconds = Math.max(0, Math.ceil(remaining / 1000));
    }
  }

  // Resolve each member's real wallet pubkey, since on-chain approvals are
  // recorded by wallet pubkey, not Slack ID. Members who somehow lost their
  // link are dropped rather than crashing the whole evaluation.
  const adminSlackIds = new Set(treasury.adminSlackIds ?? []);
  const members = treasury.memberSlackIds
    .map((slackId) => ({ slackId, link: getWalletLink(treasury.teamId, slackId) }))
    .filter((m): m is { slackId: string; link: NonNullable<ReturnType<typeof getWalletLink>> } => m.link !== null)
    .map((m) => ({
      pubkey: m.link.pubkey,
      roles: adminSlackIds.has(m.slackId) ? ["treasury-admins"] : [],
    }));

  const context: ProposalContext = {
    onChainApprovals,
    onChainThreshold,
    timeLockRemainingSeconds,
    createdAtMs,
    nowMs: Date.now(),
    members,
    allowlists: { ops_known_payees: getAllowlist(treasuryId, "ops_known_payees") },
    recentTransfers: [],
    holds: txIndex !== undefined
      ? getHolds(treasuryId, txIndex.toString()).map((h) => ({
          raisedBy: h.raisedBySlackId,
          raisedAtMs: h.raisedAtMs,
          released: h.released,
        }))
      : [],
  };

  return { context, onChainThreshold, onChainStatusKind };
}

export async function draftProposal(input: DraftInput): Promise<EvaluateResult & { resolvedRecipient: string }> {
  const treasury = getTreasury(input.treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${input.treasuryId}`);

  const policy = loadPolicyForTreasury(input.treasuryId);
  const draft: TransferLikeDraft = {
    recipient: input.recipient,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
  };

  const { context } = await buildEvaluateContext(input.treasuryId);
  context.recentTransfers = getRecentProposalAmounts(
    input.treasuryId,
    input.token,
    Date.now() - 24 * 3600 * 1000
  );

  const result = evaluate(policy, draft, context);
  return { ...result, resolvedRecipient: input.recipient };
}

interface SubmitInput {
  treasuryId: string;
  actorSlackId: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
}

export async function submitProposal(input: SubmitInput) {
  const treasury = getTreasury(input.treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${input.treasuryId}`);

  const connection = getConnection();
  const moot = getMootKeypair();
  const payer = getPayerKeypair();
  const multisigPda = new PublicKey(treasury.multisigPda);
  const vaultPda = new PublicKey(treasury.vaultPda);

  const tokenConfig = getTokenConfig(input.token);
  const mint = new PublicKey(tokenConfig.mint);
  const amountRaw = Math.round(input.amount * 10 ** tokenConfig.decimals);

  const vaultAta = getAssociatedTokenAddressSync(mint, vaultPda, true);
  const recipientPubkey = new PublicKey(input.recipient);
  const recipientAta = getAssociatedTokenAddressSync(mint, recipientPubkey, true);

  // SPL transfers require the destination token account to already exist;
  // they don't auto-create it. Creating it isn't a value transfer, so it
  // doesn't need multisig approval -- Moot's own payer key funds it directly,
  // the same way a sending wallet normally would. Idempotent: a no-op if it
  // already exists.
  if (!(await connection.getAccountInfo(recipientAta))) {
    await sendAndConfirmTransaction(
      connection,
      new Transaction().add(
        createAssociatedTokenAccountIdempotentInstruction(payer.publicKey, recipientAta, recipientPubkey, mint)
      ),
      [payer]
    );
  }

  const transferIx = createTransferInstruction(vaultAta, recipientAta, vaultPda, amountRaw);

  const { transactionIndex, vaultTransactionSignature, proposalSignature } =
    await submitProposalOnChain({
      connection,
      payer,
      creator: moot,
      multisigPda,
      instructions: [transferIx],
      memo: input.memo,
    });

  saveProposal({
    treasuryId: input.treasuryId,
    teamId: treasury.teamId,
    transactionIndex: transactionIndex.toString(),
    actorSlackId: input.actorSlackId,
    recipient: input.recipient,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
    createdAtMs: Date.now(),
  });

  return {
    proposalId: transactionIndex.toString(),
    transactionIndex: transactionIndex.toString(),
    requiredApprovals: treasury.threshold,
    vaultTransactionSignature,
    proposalSignature,
  };
}

export async function getStoredProposal(treasuryId: string, proposalId: string) {
  return getProposal(treasuryId, proposalId);
}

export async function getApprovalState(treasuryId: string, proposalId: string) {
  const transactionIndex = BigInt(proposalId);
  const { context, onChainStatusKind } = await buildEvaluateContext(treasuryId, transactionIndex);
  const treasury = getTreasury(treasuryId);
  const stored = getProposal(treasuryId, proposalId);

  // Once Squads itself reports the proposal as Executed on-chain, stop here:
  // don't hand it to evaluate(), which knows nothing about execution status
  // and would keep reporting "ready" forever, causing a caller's poll loop
  // to call execute_proposal again on an already-executed proposal (which
  // Squads correctly rejects with "Invalid proposal status").
  if (onChainStatusKind === "Executed") {
    return {
      approvals: context.onChainApprovals,
      threshold: context.onChainThreshold,
      requiredApprovals: context.onChainThreshold,
      timeLockRemaining: 0,
      decision: "already_executed",
      reasons: [],
    };
  }

  let evaluateResult: EvaluateResult | null = null;
  if (treasury && stored) {
    const policy = loadPolicyForTreasury(treasuryId);
    context.recentTransfers = getRecentProposalAmounts(
      treasuryId,
      stored.token,
      Date.now() - 24 * 3600 * 1000
    );
    evaluateResult = evaluate(
      policy,
      { recipient: stored.recipient, amount: stored.amount, token: stored.token, memo: stored.memo },
      context
    );
  }

  return {
    approvals: context.onChainApprovals,
    threshold: context.onChainThreshold,
    requiredApprovals: evaluateResult?.requiredApprovals ?? context.onChainThreshold,
    timeLockRemaining: context.timeLockRemainingSeconds,
    decision: evaluateResult?.decision ?? null,
    reasons: evaluateResult?.reasons ?? [],
  };
}

/** Returns the unsigned bytes a member's own wallet must sign in the web view. */
export async function buildApprovalForSigning(treasuryId: string, proposalId: string, memberPubkey: string) {
  const treasury = getTreasury(treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${treasuryId}`);

  const tx = await buildProposalApproveTransaction({
    connection: getConnection(),
    member: new PublicKey(memberPubkey),
    multisigPda: new PublicKey(treasury.multisigPda),
    transactionIndex: BigInt(proposalId),
  });

  return Buffer.from(tx.serialize()).toString("base64");
}

/** Relays a member's already wallet-signed approval. Moot never sees a private key. */
export async function relayApproval(signedTransactionBase64: string): Promise<{ txSignature: string }> {
  const txSignature = await relaySignedTransaction({
    connection: getConnection(),
    signedTransactionBase64,
  });
  return { txSignature };
}

export async function executeProposal(treasuryId: string, proposalId: string) {
  const treasury = getTreasury(treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${treasuryId}`);

  const transactionIndex = BigInt(proposalId);

  // Re-check policy + on-chain threshold + timelock server-side immediately before execution,
  // reading live chain state, per moot/CLAUDE.md: "Guards and approval counts are re-checked
  // server-side immediately before execute_proposal."
  const state = await getApprovalState(treasuryId, proposalId);
  if (state.decision !== "ready") {
    throw new Error(`proposal is not ready to execute (decision: ${state.decision})`);
  }

  const connection = getConnection();
  const moot = getMootKeypair();
  const payer = getPayerKeypair();

  const txSignature = await executeProposalOnChain({
    connection,
    payer,
    executor: moot,
    multisigPda: new PublicKey(treasury.multisigPda),
    transactionIndex,
  });

  return { txSignature, explorerUrl: `https://explorer.solana.com/tx/${txSignature}?cluster=devnet` };
}
