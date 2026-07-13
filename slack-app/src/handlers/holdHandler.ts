import type { WebClient } from "@slack/web-api";
import { getApprovalState, getTreasuryState, raiseHold, releaseHold } from "../mcpClient.js";
import { buildApprovalCard } from "../blocks/proposalCard.js";

/**
 * Anyone can raise a hold (matches policy: quorum_to_hold: 1, eligibility:
 * members). Releasing is simplified from the policy's fractional
 * quorum_to_release (0.51) down to "any treasury admin can release" -- a
 * real quorum vote would need its own tracking UI, which isn't built yet.
 * This is a deliberate v1 simplification, not the literal spec.
 */
export async function handleRaiseHold(
  client: WebClient,
  channel: string,
  messageTs: string,
  userId: string,
  treasuryId: string,
  proposalId: string,
  cardMeta: { treasuryName: string; recipientLabel: string; amount: number; token: string; memo?: string }
) {
  await raiseHold(treasuryId, proposalId, userId);
  const state = await getApprovalState(treasuryId, proposalId);

  await client.chat.update({
    channel,
    ts: messageTs,
    text: "Proposal on hold",
    blocks: buildApprovalCard({
      treasuryId,
      proposalId,
      ...cardMeta,
      approvals: state.approvals,
      requiredApprovals: state.requiredApprovals,
      decision: state.decision,
      held: true,
    }),
  });
}

export async function handleReleaseHold(
  client: WebClient,
  channel: string,
  messageTs: string,
  userId: string,
  treasuryId: string,
  proposalId: string,
  cardMeta: { treasuryName: string; recipientLabel: string; amount: number; token: string; memo?: string }
): Promise<{ error?: string }> {
  const { treasury } = await getTreasuryState(treasuryId);
  if (!treasury.adminSlackIds?.includes(userId)) {
    return { error: "Only a treasury admin can release a hold." };
  }

  await releaseHold(treasuryId, proposalId);
  const state = await getApprovalState(treasuryId, proposalId);

  await client.chat.update({
    channel,
    ts: messageTs,
    text: "Hold released",
    blocks: buildApprovalCard({
      treasuryId,
      proposalId,
      ...cardMeta,
      approvals: state.approvals,
      requiredApprovals: state.requiredApprovals,
      decision: state.decision,
      held: false,
    }),
  });
  return {};
}
