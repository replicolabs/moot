import jwt from "jsonwebtoken";

/**
 * Short-lived, signed capability tokens for the browser-facing /api/* routes.
 * Before this, /api/approval/unsigned and /api/proposal trusted a bare
 * treasuryId+proposalId in the URL with no verification at all -- anyone who
 * could guess or enumerate IDs could view another workspace's proposal
 * details (not forge an approval, that still needs the real wallet's
 * signature, but a real information leak). Every webview link Moot generates
 * now carries one of these, scoped to exactly the team/user/treasury/purpose
 * it was minted for, and every /api/* route verifies it before doing
 * anything.
 */

function getSecret(): string {
  const secret = process.env.WEBVIEW_TOKEN_SECRET;
  if (!secret) throw new Error("WEBVIEW_TOKEN_SECRET must be set");
  return secret;
}

export type WebviewTokenPurpose = "link" | "approve";

export interface WebviewTokenPayload {
  teamId: string;
  slackUserId: string;
  purpose: WebviewTokenPurpose;
  /** Present for purpose "approve"; absent for "link" (no treasury exists yet at link time). */
  treasuryId?: string;
  proposalId?: string;
}

const DEFAULT_TTL_SECONDS = 30 * 60;

export function signWebviewToken(payload: WebviewTokenPayload, ttlSeconds = DEFAULT_TTL_SECONDS): string {
  return jwt.sign(payload, getSecret(), { algorithm: "HS256", expiresIn: ttlSeconds });
}

/** Throws if the token is missing, expired, malformed, or doesn't match the expected purpose/scope. */
export function verifyWebviewToken(
  token: string | undefined,
  expected: { purpose: WebviewTokenPurpose; treasuryId?: string; proposalId?: string }
): WebviewTokenPayload {
  if (!token) throw new Error("missing webview token");

  let decoded: WebviewTokenPayload;
  try {
    decoded = jwt.verify(token, getSecret(), { algorithms: ["HS256"] }) as unknown as WebviewTokenPayload;
  } catch {
    throw new Error("invalid or expired link, go back to Slack and try again");
  }

  if (decoded.purpose !== expected.purpose) {
    throw new Error("token not valid for this action");
  }
  if (expected.treasuryId && decoded.treasuryId !== expected.treasuryId) {
    throw new Error("token does not match this proposal");
  }
  if (expected.proposalId && decoded.proposalId !== expected.proposalId) {
    throw new Error("token does not match this proposal");
  }
  return decoded;
}
