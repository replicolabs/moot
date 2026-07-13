import Database from "better-sqlite3";
import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "data");
const DB_PATH = join(DATA_DIR, "moot.sqlite3");

if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

/**
 * Every table carries a team_id column, including ones keyed primarily by
 * treasury_id (whose on-chain PDA is already globally unique) -- this is
 * deliberate defense-in-depth so every query can filter by team_id directly
 * instead of relying on a join to stay tenant-isolated.
 */
db.exec(`
  CREATE TABLE IF NOT EXISTS wallet_links (
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    pubkey TEXT NOT NULL,
    linked_at_ms INTEGER NOT NULL,
    PRIMARY KEY (team_id, slack_user_id)
  );

  CREATE TABLE IF NOT EXISTS treasuries (
    treasury_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    name TEXT NOT NULL,
    multisig_pda TEXT NOT NULL,
    vault_pda TEXT NOT NULL,
    threshold INTEGER NOT NULL,
    timelock_seconds INTEGER NOT NULL,
    tokens TEXT NOT NULL,
    member_slack_ids TEXT NOT NULL,
    admin_slack_ids TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_treasuries_team_channel ON treasuries(team_id, channel_id);

  CREATE TABLE IF NOT EXISTS allowlists (
    treasury_id TEXT NOT NULL,
    ref TEXT NOT NULL,
    address TEXT NOT NULL,
    PRIMARY KEY (treasury_id, ref, address)
  );

  CREATE TABLE IF NOT EXISTS proposals (
    treasury_id TEXT NOT NULL,
    transaction_index TEXT NOT NULL,
    team_id TEXT NOT NULL,
    actor_slack_id TEXT NOT NULL,
    recipient TEXT NOT NULL,
    amount REAL NOT NULL,
    token TEXT NOT NULL,
    memo TEXT,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (treasury_id, transaction_index)
  );

  CREATE TABLE IF NOT EXISTS holds (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    treasury_id TEXT NOT NULL,
    transaction_index TEXT NOT NULL,
    team_id TEXT NOT NULL,
    raised_by_slack_id TEXT NOT NULL,
    raised_at_ms INTEGER NOT NULL,
    released INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_holds_treasury_tx ON holds(treasury_id, transaction_index);

  CREATE TABLE IF NOT EXISTS pending_challenges (
    challenge_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    slack_user_id TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS escrows (
    treasury_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    payer_slack_id TEXT NOT NULL,
    payee_slack_id TEXT NOT NULL,
    arbiter_slack_id TEXT NOT NULL,
    amount REAL NOT NULL,
    token TEXT NOT NULL,
    milestone TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS merge_proposals (
    treasury_id TEXT PRIMARY KEY,
    team_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pull_number INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    executed_tx_signature TEXT
  );

  CREATE TABLE IF NOT EXISTS installations (
    team_id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    bot_token TEXT,
    bot_id TEXT,
    bot_user_id TEXT,
    updated_at_ms INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS github_installations (
    team_id TEXT NOT NULL,
    owner TEXT NOT NULL,
    installation_id TEXT NOT NULL,
    connected_at_ms INTEGER NOT NULL,
    PRIMARY KEY (team_id, owner)
  );
`);
