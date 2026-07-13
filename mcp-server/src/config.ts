import { Connection, Keypair, PublicKey, clusterApiUrl } from "@solana/web3.js";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MCP_SERVER_ROOT = join(__dirname, ".."); // mcp-server/ -- where .keys/ lives (see squads/keys.ts)
const REPO_ROOT = join(__dirname, "..", ".."); // moot/ -- where config/ and policies/ live

export type Cluster = "devnet" | "mainnet-beta";

export function getCluster(): Cluster {
  const value = process.env.SOLANA_CLUSTER ?? "devnet";
  if (value !== "devnet" && value !== "mainnet-beta") {
    throw new Error(`SOLANA_CLUSTER must be "devnet" or "mainnet-beta", got "${value}"`);
  }
  return value;
}

export function getConnection(): Connection {
  const rpcUrl = process.env.SOLANA_RPC_URL ?? clusterApiUrl(getCluster());
  return new Connection(rpcUrl, "confirmed");
}

/**
 * Moot's own Propose|Execute-only multisig member key. In Phase 1 dev this is
 * the same local test keypair the proof script uses; production points
 * MOOT_PROPOSER_KEYPAIR_PATH at a real, rotatable, least-privilege key.
 */
export function getMootKeypair(): Keypair {
  const configuredPath = process.env.MOOT_PROPOSER_KEYPAIR_PATH;
  const path = configuredPath
    ? configuredPath
    : join(MCP_SERVER_ROOT, ".keys", "moot.json");
  if (!existsSync(path)) {
    throw new Error(
      `Moot's proposer keypair not found at ${path}. Run the Phase 1 script first, or set MOOT_PROPOSER_KEYPAIR_PATH.`
    );
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

/**
 * Pays rent/fees for proposals Moot drafts on members' behalf. In Phase 1 dev
 * this is the same funded local test keypair; production would give Moot's
 * ops payer its own funded, monitored key.
 */
export function getPayerKeypair(): Keypair {
  const configuredPath = process.env.MOOT_PAYER_KEYPAIR_PATH;
  const path = configuredPath
    ? configuredPath
    : join(MCP_SERVER_ROOT, ".keys", "payer.json");
  if (!existsSync(path)) {
    throw new Error(`Payer keypair not found at ${path}.`);
  }
  const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
  return Keypair.fromSecretKey(secret);
}

interface TokenEntry {
  mint: string;
  decimals: number;
}

export function getTokenConfig(symbol: string): TokenEntry {
  const cluster = getCluster();
  const path = join(REPO_ROOT, "config", `tokens.${cluster}.json`);
  if (!existsSync(path)) {
    throw new Error(`missing token config for cluster "${cluster}" at ${path}`);
  }
  const all = JSON.parse(readFileSync(path, "utf8")) as Record<string, TokenEntry>;
  const entry = all[symbol.toUpperCase()];
  if (!entry) {
    throw new Error(`unknown token "${symbol}" for cluster "${cluster}"`);
  }
  return entry;
}

export function getTokenMint(symbol: string): PublicKey {
  return new PublicKey(getTokenConfig(symbol).mint);
}

export interface GithubAppConfig {
  appId: string;
  privateKey: string;
}

/**
 * GITHUB_APP_PRIVATE_KEY_PATH takes a file path; GITHUB_APP_PRIVATE_KEY takes
 * the PEM contents directly (e.g. in a hosted env without a filesystem for
 * secrets). One App ID/key is shared across every tenant -- it's the same
 * GitHub App, just installed into many different accounts/orgs, each
 * producing its own installation_id (see store.ts's github_installations
 * table, keyed by team_id + owner).
 */
export function getGithubAppConfig(): GithubAppConfig {
  const appId = process.env.GITHUB_APP_ID;
  const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  const privateKeyInline = process.env.GITHUB_APP_PRIVATE_KEY;

  if (!appId) {
    throw new Error("GITHUB_APP_ID must be set to use the GitHub executor.");
  }
  const privateKey = privateKeyInline
    ? privateKeyInline.replace(/\\n/g, "\n")
    : privateKeyPath
    ? readFileSync(privateKeyPath, "utf8")
    : null;
  if (!privateKey) {
    throw new Error("Set either GITHUB_APP_PRIVATE_KEY (PEM contents) or GITHUB_APP_PRIVATE_KEY_PATH (file path).");
  }

  return { appId, privateKey };
}
