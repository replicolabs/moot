import { IncomingMessage, ServerResponse } from "node:http";
import { completeWalletLink, getChallengeMessage } from "./tools/linkWallet.js";
import { buildApprovalForSigning, getApprovalState, relayApproval } from "./tools/proposal.js";
import { getProposal } from "./store.js";
import { verifyWebviewToken } from "./webviewAuth.js";

/**
 * Plain REST routes for the signing web view (the one place members leave
 * Slack). Kept separate from the /mcp JSON-RPC endpoint so the browser needs
 * no MCP client, just fetch(). Still goes through the exact same tool
 * functions the Slack app uses via MCP, so behavior can't diverge.
 */

function readJsonBody(req: IncomingMessage): Promise<any> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (chunk) => (data += chunk));
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "access-control-allow-origin": "*" });
  res.end(JSON.stringify(body));
}

/** Returns true if this request was handled (matched a known API route). */
export async function handleWebviewApi(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (req.method === "OPTIONS" && url.pathname.startsWith("/api/")) {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "GET,POST,OPTIONS",
      "access-control-allow-headers": "content-type",
    });
    res.end();
    return true;
  }

  try {
    if (url.pathname === "/api/link/message" && req.method === "GET") {
      const challengeId = url.searchParams.get("challengeId") ?? "";
      const token = url.searchParams.get("token") ?? undefined;
      verifyWebviewToken(token, { purpose: "link" });
      sendJson(res, 200, getChallengeMessage(challengeId));
      return true;
    }

    if (url.pathname === "/api/link/complete" && req.method === "POST") {
      const body = await readJsonBody(req);
      verifyWebviewToken(body.token, { purpose: "link" });
      sendJson(res, 200, completeWalletLink(body));
      return true;
    }

    if (url.pathname === "/api/approval/unsigned" && req.method === "POST") {
      const { treasuryId, proposalId, memberPubkey, token } = await readJsonBody(req);
      verifyWebviewToken(token, { purpose: "approve", treasuryId, proposalId });
      const unsignedTransactionBase64 = await buildApprovalForSigning(treasuryId, proposalId, memberPubkey);
      const proposal = getProposal(treasuryId, proposalId);
      const state = await getApprovalState(treasuryId, proposalId);
      sendJson(res, 200, { unsignedTransactionBase64, proposal, state });
      return true;
    }

    if (url.pathname === "/api/approval/relay" && req.method === "POST") {
      const { signedTransactionBase64 } = await readJsonBody(req);
      sendJson(res, 200, await relayApproval(signedTransactionBase64));
      return true;
    }
  } catch (err) {
    sendJson(res, 400, { error: err instanceof Error ? err.message : String(err) });
    return true;
  }

  return false;
}
