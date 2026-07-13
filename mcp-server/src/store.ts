import { db } from "./db.js";

/**
 * SQLite-backed persistence (via better-sqlite3, synchronous -- matches this
 * file's original JSON-file API exactly, so no caller elsewhere needed to
 * change from sync to async). Every table carries team_id; every function
 * that resolves by channelId or slackUserId now also takes teamId, since
 * those Slack-assigned IDs are only unique within a single workspace.
 */

export interface WalletLink {
  teamId: string;
  slackUserId: string;
  pubkey: string;
  linkedAtMs: number;
}

export interface Treasury {
  treasuryId: string;
  teamId: string;
  channelId: string;
  name: string;
  multisigPda: string;
  vaultPda: string;
  threshold: number;
  timeLockSeconds: number;
  tokens: string[];
  memberSlackIds: string[];
  /** Members holding the "treasury-admins" role for policy escalations (e.g. approving new payees). */
  adminSlackIds: string[];
  createdAtMs: number;
}

export interface StoredProposal {
  treasuryId: string;
  teamId: string;
  transactionIndex: string; // bigint serialized as string
  actorSlackId: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
  createdAtMs: number;
}

export interface StoredHold {
  treasuryId: string;
  teamId: string;
  transactionIndex: string;
  raisedBySlackId: string;
  raisedAtMs: number;
  released: boolean;
}

export interface PendingChallenge {
  teamId: string;
  slackUserId: string;
  nonce: string;
  expiresAtMs: number;
}

/**
 * Escrow terms, stored alongside a regular Treasury record (same
 * multisigPda/vaultPda -- an escrow IS a treasury, just one with a fixed
 * amount/recipient and a payer/payee/arbiter permission split instead of
 * open-ended members). Keyed by treasuryId so all the existing propose /
 * approve / execute / hold machinery works unchanged.
 */
export interface EscrowMeta {
  treasuryId: string;
  teamId: string;
  payerSlackId: string;
  payeeSlackId: string;
  arbiterSlackId: string;
  amount: number;
  token: string;
  milestone: string;
  createdAtMs: number;
}

/**
 * A "governance" multisig scoped to approving one specific GitHub PR merge --
 * same pattern as EscrowMeta: stored alongside a regular Treasury record so
 * all the existing propose/approve/execute/hold machinery works unchanged.
 * The on-chain proposal itself is a Memo instruction naming the PR, not a
 * transfer; there is no fund movement at all.
 */
export interface MergeProposalMeta {
  treasuryId: string;
  teamId: string;
  owner: string;
  repo: string;
  pullNumber: number;
  createdAtMs: number;
  /** Set once the on-chain memo transaction has executed, so a retry after a
   * GitHub-merge failure only re-attempts the merge, never the on-chain step. */
  executedTxSignature?: string;
}

export interface GithubInstallation {
  teamId: string;
  owner: string;
  installationId: string;
  connectedAtMs: number;
}

// ---------- wallet links ----------

export function getWalletLink(teamId: string, slackUserId: string): WalletLink | null {
  const row = db
    .prepare("SELECT team_id, slack_user_id, pubkey, linked_at_ms FROM wallet_links WHERE team_id = ? AND slack_user_id = ?")
    .get(teamId, slackUserId) as any;
  if (!row) return null;
  return { teamId: row.team_id, slackUserId: row.slack_user_id, pubkey: row.pubkey, linkedAtMs: row.linked_at_ms };
}

export function saveWalletLink(link: WalletLink): void {
  db.prepare(
    `INSERT INTO wallet_links (team_id, slack_user_id, pubkey, linked_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, slack_user_id) DO UPDATE SET pubkey = excluded.pubkey, linked_at_ms = excluded.linked_at_ms`
  ).run(link.teamId, link.slackUserId, link.pubkey, link.linkedAtMs);
}

// ---------- pending wallet-link challenges ----------

export function createPendingChallenge(challengeId: string, challenge: PendingChallenge): void {
  db.prepare(
    "INSERT INTO pending_challenges (challenge_id, team_id, slack_user_id, nonce, expires_at_ms) VALUES (?, ?, ?, ?, ?)"
  ).run(challengeId, challenge.teamId, challenge.slackUserId, challenge.nonce, challenge.expiresAtMs);
}

function rowToChallenge(row: any): PendingChallenge | null {
  if (!row) return null;
  return { teamId: row.team_id, slackUserId: row.slack_user_id, nonce: row.nonce, expiresAtMs: row.expires_at_ms };
}

/** Non-destructive read, for the web view to fetch the exact message to sign without consuming the challenge. */
export function peekPendingChallenge(challengeId: string): PendingChallenge | null {
  const row = db.prepare("SELECT * FROM pending_challenges WHERE challenge_id = ?").get(challengeId);
  return rowToChallenge(row);
}

export function consumePendingChallenge(challengeId: string): PendingChallenge | null {
  const row = db.prepare("SELECT * FROM pending_challenges WHERE challenge_id = ?").get(challengeId);
  if (!row) return null;
  db.prepare("DELETE FROM pending_challenges WHERE challenge_id = ?").run(challengeId);
  return rowToChallenge(row);
}

// ---------- treasuries ----------

function rowToTreasury(row: any): Treasury | null {
  if (!row) return null;
  return {
    treasuryId: row.treasury_id,
    teamId: row.team_id,
    channelId: row.channel_id,
    name: row.name,
    multisigPda: row.multisig_pda,
    vaultPda: row.vault_pda,
    threshold: row.threshold,
    timeLockSeconds: row.timelock_seconds,
    tokens: JSON.parse(row.tokens),
    memberSlackIds: JSON.parse(row.member_slack_ids),
    adminSlackIds: JSON.parse(row.admin_slack_ids),
    createdAtMs: row.created_at_ms,
  };
}

export function saveTreasury(treasury: Treasury): void {
  db.prepare(
    `INSERT INTO treasuries
       (treasury_id, team_id, channel_id, name, multisig_pda, vault_pda, threshold, timelock_seconds, tokens, member_slack_ids, admin_slack_ids, created_at_ms)
     VALUES (@treasuryId, @teamId, @channelId, @name, @multisigPda, @vaultPda, @threshold, @timeLockSeconds, @tokens, @memberSlackIds, @adminSlackIds, @createdAtMs)`
  ).run({
    treasuryId: treasury.treasuryId,
    teamId: treasury.teamId,
    channelId: treasury.channelId,
    name: treasury.name,
    multisigPda: treasury.multisigPda,
    vaultPda: treasury.vaultPda,
    threshold: treasury.threshold,
    timeLockSeconds: treasury.timeLockSeconds,
    tokens: JSON.stringify(treasury.tokens),
    memberSlackIds: JSON.stringify(treasury.memberSlackIds),
    adminSlackIds: JSON.stringify(treasury.adminSlackIds),
    createdAtMs: treasury.createdAtMs,
  });
}

export function getTreasury(treasuryId: string): Treasury | null {
  const row = db.prepare("SELECT * FROM treasuries WHERE treasury_id = ?").get(treasuryId);
  return rowToTreasury(row);
}

export function listTreasuries(teamId: string, channelId?: string): Treasury[] {
  const rows = channelId
    ? db.prepare("SELECT * FROM treasuries WHERE team_id = ? AND channel_id = ?").all(teamId, channelId)
    : db.prepare("SELECT * FROM treasuries WHERE team_id = ?").all(teamId);
  return rows.map((r) => rowToTreasury(r)!);
}

export function findTreasuryByName(teamId: string, channelId: string, name: string): Treasury | null {
  const match = listTreasuries(teamId, channelId).find((t) => t.name.toLowerCase() === name.toLowerCase());
  return match ?? null;
}

// ---------- proposals ----------

function rowToProposal(row: any): StoredProposal | null {
  if (!row) return null;
  return {
    treasuryId: row.treasury_id,
    teamId: row.team_id,
    transactionIndex: row.transaction_index,
    actorSlackId: row.actor_slack_id,
    recipient: row.recipient,
    amount: row.amount,
    token: row.token,
    memo: row.memo ?? undefined,
    createdAtMs: row.created_at_ms,
  };
}

export function saveProposal(proposal: StoredProposal): void {
  db.prepare(
    `INSERT INTO proposals (treasury_id, transaction_index, team_id, actor_slack_id, recipient, amount, token, memo, created_at_ms)
     VALUES (@treasuryId, @transactionIndex, @teamId, @actorSlackId, @recipient, @amount, @token, @memo, @createdAtMs)
     ON CONFLICT(treasury_id, transaction_index) DO UPDATE SET
       actor_slack_id = excluded.actor_slack_id, recipient = excluded.recipient, amount = excluded.amount,
       token = excluded.token, memo = excluded.memo, created_at_ms = excluded.created_at_ms`
  ).run({
    treasuryId: proposal.treasuryId,
    transactionIndex: proposal.transactionIndex,
    teamId: proposal.teamId,
    actorSlackId: proposal.actorSlackId,
    recipient: proposal.recipient,
    amount: proposal.amount,
    token: proposal.token,
    memo: proposal.memo ?? null,
    createdAtMs: proposal.createdAtMs,
  });
}

export function getProposal(treasuryId: string, transactionIndex: string): StoredProposal | null {
  const row = db
    .prepare("SELECT * FROM proposals WHERE treasury_id = ? AND transaction_index = ?")
    .get(treasuryId, transactionIndex);
  return rowToProposal(row);
}

export function getRecentProposalAmounts(
  treasuryId: string,
  token: string,
  sinceMs: number
): { amount: number; atMs: number }[] {
  const rows = db
    .prepare("SELECT amount, created_at_ms FROM proposals WHERE treasury_id = ? AND token = ? AND created_at_ms >= ?")
    .all(treasuryId, token, sinceMs) as any[];
  return rows.map((r) => ({ amount: r.amount, atMs: r.created_at_ms }));
}

// ---------- allowlists ----------

export function getAllowlist(treasuryId: string, ref: string): string[] {
  const rows = db
    .prepare("SELECT address FROM allowlists WHERE treasury_id = ? AND ref = ?")
    .all(treasuryId, ref) as any[];
  return rows.map((r) => r.address);
}

export function addToAllowlist(treasuryId: string, ref: string, address: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO allowlists (treasury_id, ref, address) VALUES (?, ?, ?)"
  ).run(treasuryId, ref, address);
}

// ---------- holds ----------

export function raiseHold(hold: StoredHold): void {
  db.prepare(
    `INSERT INTO holds (treasury_id, transaction_index, team_id, raised_by_slack_id, raised_at_ms, released)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(hold.treasuryId, hold.transactionIndex, hold.teamId, hold.raisedBySlackId, hold.raisedAtMs, hold.released ? 1 : 0);
}

export function releaseHolds(treasuryId: string, transactionIndex: string): void {
  db.prepare(
    "UPDATE holds SET released = 1 WHERE treasury_id = ? AND transaction_index = ?"
  ).run(treasuryId, transactionIndex);
}

export function getHolds(treasuryId: string, transactionIndex: string): StoredHold[] {
  const rows = db
    .prepare("SELECT * FROM holds WHERE treasury_id = ? AND transaction_index = ?")
    .all(treasuryId, transactionIndex) as any[];
  return rows.map((r) => ({
    treasuryId: r.treasury_id,
    teamId: r.team_id,
    transactionIndex: r.transaction_index,
    raisedBySlackId: r.raised_by_slack_id,
    raisedAtMs: r.raised_at_ms,
    released: !!r.released,
  }));
}

// ---------- escrows ----------

function rowToEscrow(row: any): EscrowMeta | null {
  if (!row) return null;
  return {
    treasuryId: row.treasury_id,
    teamId: row.team_id,
    payerSlackId: row.payer_slack_id,
    payeeSlackId: row.payee_slack_id,
    arbiterSlackId: row.arbiter_slack_id,
    amount: row.amount,
    token: row.token,
    milestone: row.milestone,
    createdAtMs: row.created_at_ms,
  };
}

export function saveEscrowMeta(meta: EscrowMeta): void {
  db.prepare(
    `INSERT INTO escrows (treasury_id, team_id, payer_slack_id, payee_slack_id, arbiter_slack_id, amount, token, milestone, created_at_ms)
     VALUES (@treasuryId, @teamId, @payerSlackId, @payeeSlackId, @arbiterSlackId, @amount, @token, @milestone, @createdAtMs)`
  ).run(meta);
}

export function getEscrowMeta(treasuryId: string): EscrowMeta | null {
  const row = db.prepare("SELECT * FROM escrows WHERE treasury_id = ?").get(treasuryId);
  return rowToEscrow(row);
}

export function isEscrow(treasuryId: string): boolean {
  return !!db.prepare("SELECT 1 FROM escrows WHERE treasury_id = ?").get(treasuryId);
}

// ---------- merge proposals ----------

function rowToMergeProposal(row: any): MergeProposalMeta | null {
  if (!row) return null;
  return {
    treasuryId: row.treasury_id,
    teamId: row.team_id,
    owner: row.owner,
    repo: row.repo,
    pullNumber: row.pull_number,
    createdAtMs: row.created_at_ms,
    executedTxSignature: row.executed_tx_signature ?? undefined,
  };
}

export function saveMergeProposalMeta(meta: MergeProposalMeta): void {
  db.prepare(
    `INSERT INTO merge_proposals (treasury_id, team_id, owner, repo, pull_number, created_at_ms, executed_tx_signature)
     VALUES (@treasuryId, @teamId, @owner, @repo, @pullNumber, @createdAtMs, @executedTxSignature)`
  ).run({ ...meta, executedTxSignature: meta.executedTxSignature ?? null });
}

export function getMergeProposalMeta(treasuryId: string): MergeProposalMeta | null {
  const row = db.prepare("SELECT * FROM merge_proposals WHERE treasury_id = ?").get(treasuryId);
  return rowToMergeProposal(row);
}

export function markMergeProposalExecuted(treasuryId: string, txSignature: string): void {
  db.prepare("UPDATE merge_proposals SET executed_tx_signature = ? WHERE treasury_id = ?").run(txSignature, treasuryId);
}

export function isMergeProposalTreasury(treasuryId: string): boolean {
  return !!db.prepare("SELECT 1 FROM merge_proposals WHERE treasury_id = ?").get(treasuryId);
}

// ---------- GitHub App installations (per team, per repo owner) ----------

export function saveGithubInstallation(installation: GithubInstallation): void {
  db.prepare(
    `INSERT INTO github_installations (team_id, owner, installation_id, connected_at_ms) VALUES (?, ?, ?, ?)
     ON CONFLICT(team_id, owner) DO UPDATE SET installation_id = excluded.installation_id, connected_at_ms = excluded.connected_at_ms`
  ).run(installation.teamId, installation.owner, installation.installationId, installation.connectedAtMs);
}

export function getGithubInstallation(teamId: string, owner: string): GithubInstallation | null {
  const row = db
    .prepare("SELECT * FROM github_installations WHERE team_id = ? AND owner = ?")
    .get(teamId, owner) as any;
  if (!row) return null;
  return { teamId: row.team_id, owner: row.owner, installationId: row.installation_id, connectedAtMs: row.connected_at_ms };
}

// ---------- Slack OAuth installation store rows (raw access for installationStore.ts) ----------

export function saveInstallationRow(teamId: string, data: string, botToken: string | null, botId: string | null, botUserId: string | null): void {
  db.prepare(
    `INSERT INTO installations (team_id, data, bot_token, bot_id, bot_user_id, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(team_id) DO UPDATE SET data = excluded.data, bot_token = excluded.bot_token, bot_id = excluded.bot_id, bot_user_id = excluded.bot_user_id, updated_at_ms = excluded.updated_at_ms`
  ).run(teamId, data, botToken, botId, botUserId, Date.now());
}

export function getInstallationRow(teamId: string): { data: string } | null {
  const row = db.prepare("SELECT data FROM installations WHERE team_id = ?").get(teamId) as any;
  return row ? { data: row.data } : null;
}

export function deleteInstallationRow(teamId: string): void {
  db.prepare("DELETE FROM installations WHERE team_id = ?").run(teamId);
}
