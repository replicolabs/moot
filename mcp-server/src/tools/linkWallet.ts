import { randomBytes } from "node:crypto";
import nacl from "tweetnacl";
import bs58 from "bs58";
import {
  consumePendingChallenge,
  createPendingChallenge,
  getWalletLink,
  peekPendingChallenge,
  saveWalletLink,
} from "../store.js";

const CHALLENGE_TTL_MS = 10 * 60 * 1000;

export interface StartLinkResult {
  challengeId: string;
  message: string;
  expiresAtMs: number;
}

/** Step 1: Moot DMs a one-time signing link built from this. */
export function startWalletLink(teamId: string, slackUserId: string): StartLinkResult {
  const challengeId = randomBytes(16).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  const expiresAtMs = Date.now() + CHALLENGE_TTL_MS;

  const message = buildChallengeMessage(slackUserId, nonce, expiresAtMs);

  createPendingChallenge(challengeId, { teamId, slackUserId, nonce, expiresAtMs });

  return { challengeId, message, expiresAtMs };
}

function buildChallengeMessage(slackUserId: string, nonce: string, expiresAtMs: number): string {
  return [
    "Moot wallet link",
    `Slack user: ${slackUserId}`,
    `Nonce: ${nonce}`,
    `Expires: ${new Date(expiresAtMs).toISOString()}`,
    "",
    "Signing this proves you own this wallet. It authorizes nothing on its own.",
  ].join("\n");
}

/**
 * Lets the web view fetch the exact message to sign by challengeId alone,
 * instead of round-tripping the message text through a DM URL query param
 * (which is fragile: Slack's own link handling and URL
 * encoding/decoding of newlines and punctuation can alter the bytes in
 * transit, which then fails signature verification even though the user
 * signed exactly what they were shown). Non-destructive: does not consume
 * the challenge, since the page may reload before the user signs.
 */
export function getChallengeMessage(challengeId: string): { message: string; expiresAtMs: number } {
  const challenge = peekPendingChallenge(challengeId);
  if (!challenge) {
    throw new Error("link request not found or already used, run /moot link-wallet again");
  }
  if (Date.now() > challenge.expiresAtMs) {
    throw new Error("link request expired, run /moot link-wallet again");
  }
  return {
    message: buildChallengeMessage(challenge.slackUserId, challenge.nonce, challenge.expiresAtMs),
    expiresAtMs: challenge.expiresAtMs,
  };
}

export interface LinkWalletInput {
  challengeId: string;
  pubkeyBase58: string;
  signatureBase64: string;
}

/**
 * Step 2: verifies the wallet's signature over the exact challenge message
 * this server issued, proving ownership before binding slackUserId<->pubkey.
 * Never trusts a claimed pubkey without this check.
 */
export function completeWalletLink(input: LinkWalletInput): { linked: true; pubkey: string } {
  const { challengeId, pubkeyBase58, signatureBase64 } = input;

  const challenge = consumePendingChallenge(challengeId);
  if (!challenge) {
    throw new Error("link request not found or already used");
  }
  if (Date.now() > challenge.expiresAtMs) {
    throw new Error("link request expired, run /moot link-wallet again");
  }

  const message = buildChallengeMessage(challenge.slackUserId, challenge.nonce, challenge.expiresAtMs);
  const messageBytes = new TextEncoder().encode(message);
  const signatureBytes = Buffer.from(signatureBase64, "base64");
  const pubkeyBytes = bs58.decode(pubkeyBase58);

  const valid = nacl.sign.detached.verify(messageBytes, signatureBytes, pubkeyBytes);
  if (!valid) {
    throw new Error("signature does not match the claimed wallet, link rejected");
  }

  saveWalletLink({ teamId: challenge.teamId, slackUserId: challenge.slackUserId, pubkey: pubkeyBase58, linkedAtMs: Date.now() });
  return { linked: true, pubkey: pubkeyBase58 };
}

export function requireLinkedWallet(teamId: string, slackUserId: string): string {
  const link = getWalletLink(teamId, slackUserId);
  if (!link) {
    throw new Error(`<@${slackUserId}> hasn't linked a wallet yet. Run /moot link-wallet first.`);
  }
  return link.pubkey;
}

export function lookupWalletLink(teamId: string, slackUserId: string): { pubkey: string } | null {
  const link = getWalletLink(teamId, slackUserId);
  return link ? { pubkey: link.pubkey } : null;
}
