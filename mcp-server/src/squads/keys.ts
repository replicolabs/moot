import { Keypair } from "@solana/web3.js";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KEYS_DIR = join(__dirname, "..", "..", ".keys");

/**
 * Local devnet test keypairs only. Never used for real member keys in
 * production: real members always sign in their own wallets in the
 * signing web view, and this file must never be reused past Phase 1 proof scripts.
 */
export function loadOrCreateKeypair(name: string): Keypair {
  if (!existsSync(KEYS_DIR)) {
    mkdirSync(KEYS_DIR, { recursive: true });
  }
  const path = join(KEYS_DIR, `${name}.json`);
  if (existsSync(path)) {
    const secret = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")));
    return Keypair.fromSecretKey(secret);
  }
  const kp = Keypair.generate();
  writeFileSync(path, JSON.stringify(Array.from(kp.secretKey)));
  return kp;
}
