import { createEscrow, findTreasury, getApprovalState, getEscrow, refundEscrow, releaseEscrow } from "../mcpClient.js";
import { buildApprovalCard } from "../blocks/proposalCard.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;

function resolveMention(tok: string, actorSlackId: string): string | null {
  if (["me", "self", "@me"].includes(tok.toLowerCase())) return actorSlackId;
  const m = tok.match(MENTION_RE);
  return m ? m[1] : null;
}

const NEW_USAGE =
  'Usage: `/moot escrow new <name> <amount> <token> @payee arbiter @arbiter milestone <description...>`\n' +
  'Example: `/moot escrow new BuildCoLogo 500 USDC @ada arbiter @lead milestone the design is delivered and approved`\n' +
  "Payer, payee, and arbiter must all have run `/moot link-wallet`. The payer is whoever runs this command.";

/** Creates the escrow from already-resolved fields. Shared by the slash command and NL paths. */
export async function createEscrowCore(
  teamId: string,
  channelId: string,
  payerSlackId: string,
  name: string,
  payeeSlackId: string,
  arbiterSlackId: string,
  amount: number,
  token: string,
  milestone: string
): Promise<string> {
  try {
    const result = await createEscrow({
      teamId,
      channelId,
      name,
      payerSlackId,
      payeeSlackId,
      arbiterSlackId,
      amount,
      token,
      milestone,
    });
    return (
      `${result.summary}\n\n` +
      `Fund it by sending ${amount} ${token} to \`${result.vaultAddress}\`. ` +
      `Run \`/moot escrow release ${name}\` on delivery, or \`/moot escrow refund ${name}\` if it falls through.`
    );
  } catch (err) {
    return `Couldn't create the escrow: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function handleEscrowNew(teamId: string, channelId: string, payerSlackId: string, rest: string): Promise<string> {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 8) return NEW_USAGE;

  const [name, amountStr, tokenSymbol, payeeTok, arbiterKeyword, arbiterTok, milestoneKeyword, ...milestoneWords] =
    tokens;

  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return `"${amountStr}" isn't a valid amount.\n\n${NEW_USAGE}`;

  const payeeSlackId = resolveMention(payeeTok, payerSlackId);
  if (!payeeSlackId) return `"${payeeTok}" isn't a linked member mention.\n\n${NEW_USAGE}`;

  if (arbiterKeyword.toLowerCase() !== "arbiter") return NEW_USAGE;
  const arbiterSlackId = resolveMention(arbiterTok, payerSlackId);
  if (!arbiterSlackId) return `"${arbiterTok}" isn't a linked member mention.\n\n${NEW_USAGE}`;

  if (milestoneKeyword.toLowerCase() !== "milestone" || milestoneWords.length === 0) return NEW_USAGE;
  const milestone = milestoneWords.join(" ");

  return createEscrowCore(teamId, channelId, payerSlackId, name, payeeSlackId, arbiterSlackId, amount, tokenSymbol.toUpperCase(), milestone);
}

export interface EscrowProposalResult {
  text: string;
  blocks?: any[];
  tracking?: {
    treasuryId: string;
    proposalId: string;
    cardMeta: { treasuryName: string; recipientLabel: string; amount: number; token: string; memo?: string };
  };
}

async function postEscrowProposalCard(
  teamId: string,
  channelId: string,
  actorSlackId: string,
  name: string,
  direction: "release" | "refund"
): Promise<EscrowProposalResult> {
  const treasury = await findTreasury(teamId, channelId, name);
  if (!treasury) return { text: `No escrow named "${name}" in this channel.` };

  const escrow = await getEscrow(treasury.treasuryId);
  if (!escrow) return { text: `"${name}" is a treasury, not an escrow.` };

  try {
    const submitted =
      direction === "release"
        ? await releaseEscrow(treasury.treasuryId, actorSlackId)
        : await refundEscrow(treasury.treasuryId, actorSlackId);

    const state = await getApprovalState(treasury.treasuryId, submitted.proposalId);
    const cardMeta = {
      treasuryName: treasury.name,
      recipientLabel:
        direction === "release" ? `<@${escrow.meta.payeeSlackId}> (payee)` : `<@${escrow.meta.payerSlackId}> (payer)`,
      amount: escrow.meta.amount,
      token: escrow.meta.token,
      memo: `${direction}: ${escrow.meta.milestone}`,
    };
    const blocks = buildApprovalCard({
      treasuryId: treasury.treasuryId,
      proposalId: submitted.proposalId,
      ...cardMeta,
      approvals: state.approvals,
      requiredApprovals: state.requiredApprovals,
      decision: state.decision,
      timeLockRemaining: state.timeLockRemaining,
    });
    return {
      text: `Escrow ${direction} drafted for "${name}"`,
      blocks,
      tracking: { treasuryId: treasury.treasuryId, proposalId: submitted.proposalId, cardMeta },
    };
  } catch (err) {
    return { text: `Couldn't draft the ${direction}: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handleEscrowRelease(teamId: string, channelId: string, actorSlackId: string, name: string) {
  return postEscrowProposalCard(teamId, channelId, actorSlackId, name, "release");
}

export async function handleEscrowRefund(teamId: string, channelId: string, actorSlackId: string, name: string) {
  return postEscrowProposalCard(teamId, channelId, actorSlackId, name, "refund");
}
