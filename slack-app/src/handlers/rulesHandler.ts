import { draftProposal, findTreasury, getPolicy, lookupWalletLink } from "../mcpClient.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export async function handleRules(teamId: string, channelId: string, treasuryName: string): Promise<string> {
  if (!treasuryName) return "Usage: `/moot rules <treasury>`";

  const treasury = await findTreasury(teamId, channelId, treasuryName);
  if (!treasury) return `No treasury named "${treasuryName}" in this channel.`;

  const policy = await getPolicy("transfer");
  const lines: string[] = [`*Rules for ${treasury.name}*`];

  lines.push(`- Base: needs ${treasury.threshold} on-chain approval(s). This is the floor and no policy can lower it.`);
  if (treasury.timeLockSeconds > 0) {
    lines.push(`- A ${treasury.timeLockSeconds}s cooldown applies after threshold is reached, before execution.`);
  }

  for (const rule of policy.approvals.escalations) {
    const parts: string[] = [];
    if (rule.requireExtra) parts.push(`${rule.requireExtra} extra approval(s)`);
    if (rule.requireRole?.length) parts.push(`an approver with role [${rule.requireRole.join(", ")}]`);
    if (parts.length) lines.push(`- If ${rule.when}: requires ${parts.join(" and ")}.`);
  }

  if (policy.recipientControls.flagUnknown) {
    lines.push(`- First-time recipients are flagged on the confirmation card.`);
  }
  if (policy.velocity) {
    lines.push(`- Velocity cap: no more than ${policy.velocity.maxTotalAmount} total sent per ${policy.velocity.window}.`);
  }
  if (policy.hold?.enabled) {
    lines.push(`- Any member can pause a proposal (Hold button or :${policy.hold.emoji}: reaction); a treasury admin can release it.`);
  }
  if (policy.expiry) {
    lines.push(`- Unapproved proposals expire after ${policy.expiry.window}.`);
  }

  return lines.join("\n");
}

const CHECK_USAGE =
  'Usage: `/moot check <treasury> <amount> <token> <@recipient-or-address> [memo]`\n' +
  "Dry-runs the policy without creating anything on-chain.";

/** Dry-runs the policy for already-resolved fields. Shared by the slash command and NL paths. */
export async function buildCheckResult(
  teamId: string,
  channelId: string,
  actorSlackId: string,
  treasuryName: string,
  recipient: string,
  amount: number,
  token: string
): Promise<string> {
  const treasury = await findTreasury(teamId, channelId, treasuryName);
  if (!treasury) return `No treasury named "${treasuryName}" in this channel.`;

  const draft = await draftProposal({
    treasuryId: treasury.treasuryId,
    actorSlackId,
    recipient,
    amount,
    token,
  });

  const lines = [
    `*Dry run for ${amount} ${token} from ${treasury.name}*`,
    `Would need ${draft.requiredApprovals} approval(s).`,
  ];
  if (draft.flags?.unknownRecipient) lines.push(":warning: First-time recipient.");
  if (draft.decision !== "ready" && draft.decision !== "needs_more_approvals") {
    lines.push(`:no_entry: ${draft.reasons.join("; ")}`);
  }
  return lines.join("\n");
}

export async function handleCheck(teamId: string, channelId: string, actorSlackId: string, rest: string): Promise<string> {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return CHECK_USAGE;

  const [treasuryName, amountStr, tokenSymbol, recipientTok] = tokens;
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) return `"${amountStr}" isn't a valid amount.\n\n${CHECK_USAGE}`;

  let recipient: string;
  const isSelf = ["me", "self", "@me"].includes(recipientTok.toLowerCase());
  const mentionMatch = recipientTok.match(MENTION_RE);
  if (isSelf || mentionMatch) {
    const targetSlackId = isSelf ? actorSlackId : mentionMatch![1];
    const link = await lookupWalletLink(teamId, targetSlackId);
    if (!link) return `<@${targetSlackId}> hasn't linked a wallet yet.`;
    recipient = link.pubkey;
  } else if (ADDRESS_RE.test(recipientTok)) {
    recipient = recipientTok;
  } else {
    return `"${recipientTok}" isn't a linked member mention or a wallet address.\n\n${CHECK_USAGE}`;
  }

  return buildCheckResult(teamId, channelId, actorSlackId, treasuryName, recipient, amount, tokenSymbol.toUpperCase());
}
