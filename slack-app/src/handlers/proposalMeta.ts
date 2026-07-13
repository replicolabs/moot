import { getStoredProposal, getTreasuryState } from "../mcpClient.js";

export interface ProposalCardMeta {
  treasuryName: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
}

/**
 * Reconstructs card metadata from stored state for reaction-triggered
 * actions, which (unlike button clicks) carry no `value` payload with the
 * proposal's details already embedded.
 */
export async function getProposalMeta(treasuryId: string, proposalId: string): Promise<ProposalCardMeta | null> {
  const [proposal, { treasury }] = await Promise.all([
    getStoredProposal(treasuryId, proposalId),
    getTreasuryState(treasuryId),
  ]);
  if (!proposal) return null;

  return {
    treasuryName: treasury.name,
    recipientLabel: `\`${proposal.recipient}\``,
    amount: proposal.amount,
    token: proposal.token,
    memo: proposal.memo,
  };
}
