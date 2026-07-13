import type { WebClient } from "@slack/web-api";
import { createTreasury } from "../mcpClient.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;

export interface ParsedTreasuryNew {
  name: string;
  threshold: number;
  memberSlackIds: string[];
  tokens: string[];
  timeLockSeconds: number;
}

const USAGE =
  'Usage: `/moot treasury new <name> <threshold> @member1 @member2 ... [tokens=USDC] [timelock=<seconds>]`\n' +
  'Example: `/moot treasury new Ops 2 @alice @bob tokens=USDC timelock=60`\n' +
  'Use `me` for yourself (handy for solo testing).\n' +
  "Every member must have already run `/moot link-wallet`. " +
  "Mentions must be picked from Slack's @ autocomplete dropdown, not just typed as plain text.";

export function parseTreasuryNew(rest: string, creatorSlackId: string): ParsedTreasuryNew | { error: string } {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 3) return { error: USAGE };

  const [name, thresholdStr, ...remainder] = tokens;
  const threshold = Number(thresholdStr);
  if (!Number.isInteger(threshold) || threshold < 1) {
    return { error: `"${thresholdStr}" isn't a valid threshold (whole number >= 1).\n\n${USAGE}` };
  }

  const memberSlackIds: string[] = [];
  let tokenSymbols = ["USDC"];
  let timeLockSeconds = 0;
  for (const tok of remainder) {
    if (tok.toLowerCase() === "me" || tok.toLowerCase() === "self" || tok.toLowerCase() === "@me") {
      memberSlackIds.push(creatorSlackId);
      continue;
    }
    const mentionMatch = tok.match(MENTION_RE);
    if (mentionMatch) {
      memberSlackIds.push(mentionMatch[1]);
      continue;
    }
    const tokensMatch = tok.match(/^tokens=(.+)$/i);
    if (tokensMatch) {
      tokenSymbols = tokensMatch[1].split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
      continue;
    }
    const timelockMatch = tok.match(/^timelock=(\d+)$/i);
    if (timelockMatch) {
      timeLockSeconds = Number(timelockMatch[1]);
      continue;
    }
    if (tok.startsWith("@")) {
      return {
        error:
          `"${tok}" wasn't recognized as a Slack mention. Type @ and pick the person from the dropdown ` +
          `that appears, rather than typing their name and pressing enter.\n\n${USAGE}`,
      };
    }
    return { error: `Didn't understand "${tok}".\n\n${USAGE}` };
  }

  const uniqueMemberSlackIds = [...new Set(memberSlackIds)];

  if (uniqueMemberSlackIds.length === 0) {
    return { error: `Mention at least one wallet-linked member.\n\n${USAGE}` };
  }
  if (threshold > uniqueMemberSlackIds.length) {
    return {
      error: `Threshold (${threshold}) can't exceed the number of members (${uniqueMemberSlackIds.length}).`,
    };
  }

  return { name, threshold, memberSlackIds: uniqueMemberSlackIds, tokens: tokenSymbols, timeLockSeconds };
}

/** Creates the treasury from already-resolved fields. Shared by the slash command and NL paths. */
export async function createTreasuryCore(
  teamId: string,
  channelId: string,
  creatorSlackId: string,
  name: string,
  memberSlackIds: string[],
  threshold: number,
  tokens: string[],
  timeLockSeconds: number
): Promise<string> {
  try {
    const result = await createTreasury({
      teamId,
      channelId,
      creatorSlackId,
      name,
      memberSlackIds,
      threshold,
      timeLockSeconds,
      tokens,
    });
    return (
      `${result.summary}\n\n` +
      `Fund it by sending ${tokens.join("/")} to \`${result.vaultAddress}\`. ` +
      `This is a real devnet address; nothing here is simulated.`
    );
  } catch (err) {
    return `Couldn't create the treasury: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function handleTreasuryNew(
  client: WebClient,
  teamId: string,
  channelId: string,
  creatorSlackId: string,
  rest: string
): Promise<string> {
  const parsed = parseTreasuryNew(rest, creatorSlackId);
  if ("error" in parsed) return parsed.error;

  return createTreasuryCore(
    teamId,
    channelId,
    creatorSlackId,
    parsed.name,
    parsed.memberSlackIds,
    parsed.threshold,
    parsed.tokens,
    parsed.timeLockSeconds
  );
}
