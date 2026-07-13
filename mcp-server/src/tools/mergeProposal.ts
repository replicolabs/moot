import { Keypair, PublicKey } from "@solana/web3.js";
import { createMemoInstruction } from "@solana/spl-memo";
import {
  createTreasuryMultisig,
  executeProposal as executeProposalOnChain,
  fullMemberPermissions,
  mootMemberPermissions,
  submitProposal as submitProposalOnChain,
} from "../squads/client.js";
import { getConnection, getMootKeypair, getPayerKeypair } from "../config.js";
import { mergePullRequest } from "../executors/githubExecutor.js";
import { requireLinkedWallet } from "./linkWallet.js";
import { getApprovalState } from "./proposal.js";
import {
  getGithubInstallation,
  getMergeProposalMeta,
  getTreasury,
  listTreasuries,
  markMergeProposalExecuted,
  MergeProposalMeta,
  saveMergeProposalMeta,
  saveProposal,
  saveTreasury,
  Treasury,
} from "../store.js";

export interface CreateMergeProposalInput {
  teamId: string;
  channelId: string;
  name: string;
  reviewerSlackIds: string[];
  threshold: number;
  owner: string;
  repo: string;
  pullNumber: number;
}

export interface CreateMergeProposalResult {
  treasuryId: string;
  summary: string;
}

/**
 * Creates a "governance" multisig scoped to one PR. No funds are ever
 * involved -- this exists purely to show the same quorum-and-approval engine
 * that gates a payment can gate any other real-world action, with the same
 * custody guarantee: Moot can crank execution once threshold is reached, but
 * it holds no Vote and cannot approve on its own.
 */
export async function createMergeProposal(input: CreateMergeProposalInput): Promise<CreateMergeProposalResult> {
  const { teamId, channelId, name, reviewerSlackIds, threshold, owner, repo, pullNumber } = input;

  if (reviewerSlackIds.length === 0) {
    throw new Error("a merge proposal needs at least one wallet-linked reviewer");
  }
  if (threshold < 1 || threshold > reviewerSlackIds.length) {
    throw new Error(`threshold must be between 1 and the number of reviewers (${reviewerSlackIds.length})`);
  }
  if (listTreasuries(teamId, channelId).some((t) => t.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`a treasury or proposal named "${name}" already exists in this channel`);
  }
  if (!getGithubInstallation(teamId, owner)) {
    throw new Error(
      `no GitHub App installation connected for "${owner}" in this workspace yet -- run \`/moot github connect ${owner}\` first`
    );
  }

  const reviewerPubkeys = reviewerSlackIds.map((id) => new PublicKey(requireLinkedWallet(teamId, id)));
  const moot = getMootKeypair();
  const payer = getPayerKeypair();
  const createKey = Keypair.generate();

  const { multisigPda, vaultPda } = await createTreasuryMultisig({
    connection: getConnection(),
    payer,
    createKey,
    threshold,
    timeLockSeconds: 0,
    members: [
      { publicKey: moot.publicKey, permissions: mootMemberPermissions() },
      ...reviewerPubkeys.map((pk) => ({ publicKey: pk, permissions: fullMemberPermissions() })),
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
    threshold,
    timeLockSeconds: 0,
    tokens: [],
    memberSlackIds: reviewerSlackIds,
    adminSlackIds: reviewerSlackIds,
    createdAtMs: Date.now(),
  };
  saveTreasury(treasury);

  const meta: MergeProposalMeta = { treasuryId, teamId, owner, repo, pullNumber, createdAtMs: Date.now() };
  saveMergeProposalMeta(meta);

  return {
    treasuryId,
    summary:
      `"${name}": ${reviewerSlackIds.length} reviewer(s), needs ${threshold} on-chain approval(s) to merge ` +
      `${owner}/${repo}#${pullNumber}.`,
  };
}

/** Moot drafts a Memo-only on-chain proposal naming the PR. No transfer instruction at all. */
export async function submitMergeProposal(treasuryId: string, actorSlackId: string) {
  const treasury = getTreasury(treasuryId);
  const meta = getMergeProposalMeta(treasuryId);
  if (!treasury || !meta) throw new Error("not a merge proposal");

  const connection = getConnection();
  const moot = getMootKeypair();
  const payer = getPayerKeypair();
  const multisigPda = new PublicKey(treasury.multisigPda);

  const memoText = `merge-pr:${meta.owner}/${meta.repo}#${meta.pullNumber}`;
  const memoIx = createMemoInstruction(memoText);

  const { transactionIndex, vaultTransactionSignature, proposalSignature } = await submitProposalOnChain({
    connection,
    payer,
    creator: moot,
    multisigPda,
    instructions: [memoIx],
    memo: memoText,
  });

  saveProposal({
    treasuryId,
    teamId: meta.teamId,
    transactionIndex: transactionIndex.toString(),
    actorSlackId,
    recipient: `${meta.owner}/${meta.repo}#${meta.pullNumber}`,
    amount: 0,
    token: "N/A",
    memo: memoText,
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

/**
 * Re-checks the real on-chain approval state, executes the (no-op-value) memo
 * transaction, then merges the PR. The on-chain step and the GitHub step are
 * treated as separable: once the memo transaction lands we persist its
 * signature immediately, so a retry (e.g. the Slack poll loop reacting to a
 * thrown error) never re-attempts an already-executed Squads proposal -- it
 * only ever retries the GitHub merge. And a GitHub-only failure is returned
 * as merged:false rather than thrown, so it doesn't look like the whole
 * execution failed when the on-chain approval already succeeded.
 */
export async function executeMergeProposal(treasuryId: string, proposalId: string) {
  const treasury = getTreasury(treasuryId);
  const meta = getMergeProposalMeta(treasuryId);
  if (!treasury || !meta) throw new Error("not a merge proposal");

  let txSignature = meta.executedTxSignature;

  if (!txSignature) {
    const state = await getApprovalState(treasuryId, proposalId);
    if (state.decision !== "ready") {
      throw new Error(`proposal is not ready to execute (decision: ${state.decision})`);
    }

    const connection = getConnection();
    const moot = getMootKeypair();
    const payer = getPayerKeypair();

    txSignature = await executeProposalOnChain({
      connection,
      payer,
      executor: moot,
      multisigPda: new PublicKey(treasury.multisigPda),
      transactionIndex: BigInt(proposalId),
    });

    markMergeProposalExecuted(treasuryId, txSignature);
  }

  const explorerUrl = `https://explorer.solana.com/tx/${txSignature}?cluster=devnet`;

  try {
    const installation = getGithubInstallation(meta.teamId, meta.owner);
    if (!installation) {
      throw new Error(`no GitHub App installation connected for "${meta.owner}" in this workspace`);
    }
    const merge = await mergePullRequest(installation.installationId, meta.owner, meta.repo, meta.pullNumber);
    return { txSignature, explorerUrl, merged: merge.merged, mergeSha: merge.sha, mergeMessage: merge.message };
  } catch (err) {
    return {
      txSignature,
      explorerUrl,
      merged: false,
      mergeMessage: `on-chain approval executed, but GitHub merge failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export async function getMergeProposal(treasuryId: string) {
  const treasury = getTreasury(treasuryId);
  const meta = getMergeProposalMeta(treasuryId);
  if (!treasury || !meta) return null;
  return { treasury, meta };
}
