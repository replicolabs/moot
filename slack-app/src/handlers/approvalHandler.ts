import type { WebClient } from "@slack/web-api";
import { executeProposal, getApprovalState, mintWebviewToken, submitProposal } from "../mcpClient.js";
import { buildApprovalCard } from "../blocks/proposalCard.js";
import { clearPoll, isPolling, setPollHandle, trackProposalMessage } from "../state.js";

const WEBVIEW_BASE_URL = process.env.SIGNING_WEBVIEW_URL ?? "http://localhost:8787/webview";
const POLL_INTERVAL_MS = 8000;
const MAX_POLLS = 225; // ~30 minutes at 8s, matches the default policy expiry window

export interface ConfirmedProposalInput {
  treasuryId: string;
  actorSlackId: string;
  treasuryName: string;
  recipient: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
}

export async function handleConfirmProposal(
  client: WebClient,
  channel: string,
  input: ConfirmedProposalInput
): Promise<{ blocks: any[]; treasuryId: string; proposalId: string }> {
  const submitted = await submitProposal({
    treasuryId: input.treasuryId,
    actorSlackId: input.actorSlackId,
    recipient: input.recipient,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
  });

  const state = await getApprovalState(input.treasuryId, submitted.proposalId);

  const blocks = buildApprovalCard({
    treasuryId: input.treasuryId,
    proposalId: submitted.proposalId,
    treasuryName: input.treasuryName,
    recipientLabel: input.recipientLabel,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
    approvals: state.approvals,
    requiredApprovals: state.requiredApprovals,
    decision: state.decision,
    timeLockRemaining: state.timeLockRemaining,
  });

  return { blocks, treasuryId: input.treasuryId, proposalId: submitted.proposalId };
}

export interface CardMeta {
  treasuryName: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
  /** Overrides the default "Sending X Y to Z" title, for non-transfer proposals like a PR merge. */
  headline?: string;
}

export function startTrackingProposal(
  client: WebClient,
  channel: string,
  messageTs: string,
  treasuryId: string,
  proposalId: string,
  cardMeta: CardMeta
) {
  trackProposalMessage({ channel, messageTs, treasuryId, proposalId });
  if (isPolling(channel, messageTs)) return;

  console.log(`[poll] starting for ${treasuryId}:${proposalId}`);
  let pollCount = 0;
  const handle = setInterval(async () => {
    pollCount += 1;
    try {
      const state = await getApprovalState(treasuryId, proposalId);
      console.log(`[poll ${pollCount}] ${treasuryId}:${proposalId} decision=${state.decision} approvals=${state.approvals.length}/${state.requiredApprovals}`);

      if (state.decision === "already_executed") {
        console.log(`[poll ${pollCount}] ${treasuryId}:${proposalId} already executed on-chain, stopping poll.`);
        await client.chat.update({
          channel,
          ts: messageTs,
          text: "Proposal executed",
          blocks: buildApprovalCard({
            treasuryId,
            proposalId,
            ...cardMeta,
            approvals: state.approvals,
            requiredApprovals: state.requiredApprovals,
            decision: state.decision,
            executed: true,
            timeLockRemaining: state.timeLockRemaining,
          }),
        });
        clearPoll(channel, messageTs);
        return;
      }

      if (state.decision === "ready") {
        console.log(`[poll ${pollCount}] executing ${treasuryId}:${proposalId}...`);
        const result = await executeProposal(treasuryId, proposalId);
        console.log(`[poll ${pollCount}] executed: ${result.txSignature}`);
        const executedLine =
          result.merged !== undefined
            ? result.merged
              ? `:white_check_mark: Approved on-chain (<https://explorer.solana.com/tx/${result.txSignature}?cluster=devnet|tx>) and merged: ${result.mergeMessage}`
              : `:warning: Approved on-chain, but GitHub didn't merge it: ${result.mergeMessage}`
            : undefined;
        await client.chat.update({
          channel,
          ts: messageTs,
          text: "Proposal executed",
          blocks: buildApprovalCard({
            treasuryId,
            proposalId,
            ...cardMeta,
            approvals: state.approvals,
            requiredApprovals: state.requiredApprovals,
            decision: state.decision,
            executed: true,
            txSignature: result.txSignature,
            executedLine,
            timeLockRemaining: state.timeLockRemaining,
          }),
        });
        clearPoll(channel, messageTs);
        return;
      }

      await client.chat.update({
        channel,
        ts: messageTs,
        text: "Proposal awaiting approval",
        blocks: buildApprovalCard({
          treasuryId,
          proposalId,
          ...cardMeta,
          approvals: state.approvals,
          requiredApprovals: state.requiredApprovals,
          decision: state.decision,
          timeLockRemaining: state.timeLockRemaining,
        }),
      });
    } catch (err) {
      console.error("approval poll failed:", err);
    }

    if (pollCount >= MAX_POLLS) {
      clearPoll(channel, messageTs);
    }
  }, POLL_INTERVAL_MS);

  setPollHandle(channel, messageTs, handle);
}

export async function handleApproveClick(
  client: WebClient,
  teamId: string,
  slackUserId: string,
  treasuryId: string,
  proposalId: string
) {
  const { token } = await mintWebviewToken({ teamId, slackUserId, purpose: "approve", treasuryId, proposalId });

  const url = new URL(WEBVIEW_BASE_URL + "/");
  url.searchParams.set("mode", "approve");
  url.searchParams.set("treasuryId", treasuryId);
  url.searchParams.set("proposalId", proposalId);
  url.searchParams.set("token", token);

  await client.chat.postMessage({
    channel: slackUserId,
    text: `Review and approve this proposal with your own wallet:\n${url.toString()}`,
  });
}

