import type { WebClient } from "@slack/web-api";
import { draftProposal, findTreasury, lookupWalletLink } from "../mcpClient.js";
import { buildConfirmationCard } from "../blocks/proposalCard.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;
// Base58, no 0/O/I/l, typical Solana pubkey length.
const ADDRESS_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

const USAGE =
  'Usage: `/moot propose <treasury> <amount> <token> <@recipient-or-address> [memo]`\n' +
  'Example: `/moot propose Ops 10 USDC @ada for the logo work`\n' +
  "Use `me` to pay yourself (handy for solo testing).\n" +
  "The recipient must either be a wallet-linked Slack member (picked from the @ dropdown) or a raw wallet address.";

/** Resolves an @mention/"me"/raw-address token to a wallet address + display label. Shared by the slash command and NL paths. */
export async function resolveRecipientToken(
  teamId: string,
  recipientTok: string,
  actorSlackId: string
): Promise<{ recipient: string; recipientLabel: string } | { error: string }> {
  const isSelf = ["me", "self", "@me"].includes(recipientTok.toLowerCase());
  const mentionMatch = recipientTok.match(MENTION_RE);
  if (isSelf || mentionMatch) {
    const targetSlackId = isSelf ? actorSlackId : mentionMatch![1];
    const link = await lookupWalletLink(teamId, targetSlackId);
    if (!link) {
      return {
        error: isSelf
          ? "You haven't linked a wallet yet. Run `/moot link-wallet` first."
          : `<@${targetSlackId}> hasn't linked a wallet yet. They need to run \`/moot link-wallet\` first.`,
      };
    }
    return {
      recipient: link.pubkey,
      recipientLabel: isSelf ? `<@${targetSlackId}> (you)` : `<@${targetSlackId}>`,
    };
  }
  if (ADDRESS_RE.test(recipientTok)) {
    return { recipient: recipientTok, recipientLabel: `\`${recipientTok}\`` };
  }
  return { error: `"${recipientTok}" isn't a linked member mention or a wallet address.` };
}

/** Builds the confirmation card once treasury + recipient are already resolved. Shared by the slash command and NL paths. */
export async function buildProposalConfirmation(
  teamId: string,
  channelId: string,
  actorSlackId: string,
  treasuryName: string,
  recipient: string,
  recipientLabel: string,
  amount: number,
  token: string,
  memo: string | undefined
): Promise<{ text: string; blocks?: any[] }> {
  const treasury = await findTreasury(teamId, channelId, treasuryName);
  if (!treasury) {
    return { text: `No treasury named "${treasuryName}" in this channel. Run \`/moot treasury new\` first.` };
  }

  try {
    const draft = await draftProposal({
      treasuryId: treasury.treasuryId,
      actorSlackId,
      recipient,
      amount,
      token,
      memo,
    });

    const blocks = buildConfirmationCard({
      treasuryId: treasury.treasuryId,
      actorSlackId,
      treasuryName: treasury.name,
      recipient,
      recipientLabel,
      amount,
      token,
      memo,
      requiredApprovals: draft.requiredApprovals,
      unknownRecipient: draft.flags?.unknownRecipient ?? false,
      decision: draft.decision,
      reasons: draft.reasons ?? [],
    });

    return { text: `Proposal draft for ${treasury.name}`, blocks };
  } catch (err) {
    return { text: `Couldn't draft that proposal: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export async function handlePropose(
  client: WebClient,
  teamId: string,
  channelId: string,
  actorSlackId: string,
  rest: string
): Promise<{ text: string; blocks?: any[] }> {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 4) return { text: USAGE };

  const [treasuryName, amountStr, tokenSymbol, recipientTok, ...memoParts] = tokens;
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { text: `"${amountStr}" isn't a valid amount.\n\n${USAGE}` };
  }

  const resolved = await resolveRecipientToken(teamId, recipientTok, actorSlackId);
  if ("error" in resolved) return { text: `${resolved.error}\n\n${USAGE}` };

  const memo = memoParts.join(" ") || undefined;

  return buildProposalConfirmation(
    teamId,
    channelId,
    actorSlackId,
    treasuryName,
    resolved.recipient,
    resolved.recipientLabel,
    amount,
    tokenSymbol.toUpperCase(),
    memo
  );
}
