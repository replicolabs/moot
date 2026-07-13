/**
 * In-memory, single-process state for the Slack app: which channel/message
 * is tracking which on-chain proposal, and whether a poll loop is already
 * running for it. Lost on restart, which is fine -- it's UI-tracking state,
 * not authorization state. The chain remains the source of truth; this only
 * tells the app which Slack message to update when it polls.
 */

export interface TrackedProposal {
  channel: string;
  messageTs: string;
  treasuryId: string;
  proposalId: string;
}

const trackedByKey = new Map<string, TrackedProposal>();
const pollHandles = new Map<string, NodeJS.Timeout>();

function key(channel: string, messageTs: string): string {
  return `${channel}:${messageTs}`;
}

export function trackProposalMessage(entry: TrackedProposal): void {
  trackedByKey.set(key(entry.channel, entry.messageTs), entry);
}

export function getTrackedProposal(channel: string, messageTs: string): TrackedProposal | null {
  return trackedByKey.get(key(channel, messageTs)) ?? null;
}

export function isPolling(channel: string, messageTs: string): boolean {
  return pollHandles.has(key(channel, messageTs));
}

export function setPollHandle(channel: string, messageTs: string, handle: NodeJS.Timeout): void {
  pollHandles.set(key(channel, messageTs), handle);
}

export function clearPoll(channel: string, messageTs: string): void {
  const k = key(channel, messageTs);
  const handle = pollHandles.get(k);
  if (handle) clearInterval(handle);
  pollHandles.delete(k);
}
