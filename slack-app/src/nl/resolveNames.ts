import type { WebClient } from "@slack/web-api";
import { resolveRecipientToken } from "../handlers/proposalHandler.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;

export interface ChannelMember {
  id: string;
  names: string[];
}

/** Same channel-member listing used across every NL action that needs to fuzzy-match a plain name. */
export async function getChannelMembers(client: WebClient, channelId: string): Promise<ChannelMember[]> {
  const memberIds = new Set<string>();
  let cursor: string | undefined;
  do {
    const resp = await client.conversations.members({ channel: channelId, cursor, limit: 200 });
    for (const id of resp.members ?? []) memberIds.add(id);
    cursor = resp.response_metadata?.next_cursor || undefined;
  } while (cursor);

  const members: ChannelMember[] = [];
  for (const id of memberIds) {
    try {
      const info = await client.users.info({ user: id });
      const profile = info.user?.profile;
      const names = [profile?.display_name, profile?.real_name, info.user?.name, profile?.first_name]
        .filter((n): n is string => Boolean(n && n.trim()));
      members.push({ id, names });
    } catch {
      // Skip members we can't look up (e.g. bots without full profiles).
    }
  }
  return members;
}

function findNameMatches(members: ChannelMember[], name: string): string[] {
  const needle = name.trim().toLowerCase();
  const matches = new Set<string>();
  for (const member of members) {
    if (member.names.some((n) => n.toLowerCase() === needle || n.toLowerCase().startsWith(needle))) {
      matches.add(member.id);
    }
  }
  return [...matches];
}

/** Resolves a single "me"/mention/plain-name token to exactly one Slack user ID. */
export function resolveSlackId(
  token: string,
  actorSlackId: string,
  members: ChannelMember[]
): { id: string } | { error: string } {
  const trimmed = token.trim();
  if (["me", "self", "@me"].includes(trimmed.toLowerCase())) return { id: actorSlackId };

  const mentionMatch = trimmed.match(MENTION_RE);
  if (mentionMatch) return { id: mentionMatch[1] };

  const matches = findNameMatches(members, trimmed);
  if (matches.length === 0) {
    return { error: `I couldn't find anyone named "${trimmed}" in this channel. Try @mentioning them directly.` };
  }
  if (matches.length > 1) {
    return {
      error: `I found more than one person matching "${trimmed}": ${matches
        .map((id) => `<@${id}>`)
        .join(", ")}. Try mentioning the right one directly.`,
    };
  }
  return { id: matches[0] };
}

/** Resolves a list of name/mention tokens, short-circuiting on the first unresolved one. */
export function resolveSlackIds(
  tokens: string[],
  actorSlackId: string,
  members: ChannelMember[]
): { ids: string[] } | { error: string } {
  const ids: string[] = [];
  for (const token of tokens) {
    const resolved = resolveSlackId(token, actorSlackId, members);
    if ("error" in resolved) return { error: resolved.error };
    ids.push(resolved.id);
  }
  return { ids: [...new Set(ids)] };
}

/**
 * Resolves a payment recipient by "me"/mention/raw-address first (no Slack
 * lookup needed), falling back to a fuzzy channel-member name match. Shared
 * by the transfer and check NL actions, which both need a wallet address +
 * display label rather than a bare Slack ID.
 */
export async function resolveRecipientByNameOrMention(
  client: WebClient,
  teamId: string,
  channelId: string,
  actorSlackId: string,
  nameOrMention: string
): Promise<{ recipient: string; recipientLabel: string } | { error: string }> {
  const direct = await resolveRecipientToken(teamId, nameOrMention, actorSlackId);
  if (!("error" in direct)) return direct;

  const members = await getChannelMembers(client, channelId);
  const matches = findNameMatches(members, nameOrMention);
  if (matches.length === 0) {
    return { error: `I couldn't find anyone named "${nameOrMention}" in this channel. Try @mentioning them directly.` };
  }
  if (matches.length > 1) {
    return {
      error: `I found more than one person matching "${nameOrMention}": ${matches
        .map((id) => `<@${id}>`)
        .join(", ")}. Which one did you mean? Try mentioning them directly.`,
    };
  }
  return resolveRecipientToken(teamId, `<@${matches[0]}>`, actorSlackId);
}
