import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const MCP_SERVER_URL = process.env.MCP_SERVER_URL ?? "http://localhost:8788/mcp";
const MCP_INTERNAL_TOKEN = process.env.MCP_INTERNAL_TOKEN;

if (!MCP_INTERNAL_TOKEN) {
  throw new Error("MCP_INTERNAL_TOKEN must be set (shared secret between slack-app and mcp-server).");
}

/**
 * The Bolt app never touches Solana or the Squads SDK directly -- it only
 * ever talks to the MCP server, which is the sole component that touches the
 * chain (see moot/CLAUDE.md architecture). One short-lived client connection
 * per call keeps this simple and matches the MCP server's stateless mode.
 * The bearer token proves this is really slack-app calling, since /mcp is
 * otherwise reachable only from localhost anyway (defense in depth).
 */
async function callTool(name: string, args: Record<string, unknown>): Promise<any> {
  const client = new Client({ name: "moot-slack-app", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(MCP_SERVER_URL), {
    requestInit: { headers: { authorization: `Bearer ${MCP_INTERNAL_TOKEN}` } },
  });
  await client.connect(transport);
  try {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as any[])[0]?.text ?? "{}";
    if (result.isError) {
      throw new Error(text);
    }
    return JSON.parse(text);
  } finally {
    await client.close();
  }
}

export function startWalletLink(teamId: string, slackUserId: string) {
  return callTool("start_wallet_link", { teamId, slackUserId });
}

export function createTreasury(input: {
  teamId: string;
  channelId: string;
  creatorSlackId: string;
  name: string;
  memberSlackIds: string[];
  threshold: number;
  timeLockSeconds?: number;
  tokens: string[];
}) {
  return callTool("create_treasury", input);
}

export function findTreasury(teamId: string, channelId: string, name: string) {
  return callTool("find_treasury", { teamId, channelId, name });
}

export function lookupWalletLink(teamId: string, slackUserId: string): Promise<{ pubkey: string } | null> {
  return callTool("lookup_wallet_link", { teamId, slackUserId });
}

export function getTreasuryState(treasuryId: string) {
  return callTool("get_treasury_state", { treasuryId });
}

export function draftProposal(input: {
  treasuryId: string;
  actorSlackId: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
}) {
  return callTool("draft_proposal", input);
}

export function getStoredProposal(
  treasuryId: string,
  proposalId: string
): Promise<{ recipient: string; amount: number; token: string; memo?: string } | null> {
  return callTool("get_proposal", { treasuryId, proposalId });
}

export function submitProposal(input: {
  treasuryId: string;
  actorSlackId: string;
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
}) {
  return callTool("submit_proposal", input);
}

export function getApprovalState(treasuryId: string, proposalId: string) {
  return callTool("get_approval_state", { treasuryId, proposalId });
}

export function executeProposal(treasuryId: string, proposalId: string) {
  return callTool("execute_proposal", { treasuryId, proposalId });
}

export function raiseHold(treasuryId: string, proposalId: string, raisedBySlackId: string) {
  return callTool("raise_hold", { treasuryId, proposalId, raisedBySlackId });
}

export function releaseHold(treasuryId: string, proposalId: string) {
  return callTool("release_hold", { treasuryId, proposalId });
}

export function getPolicy(actionType: "transfer" | "escrow" = "transfer") {
  return callTool("get_policy", { actionType });
}

export function createEscrow(input: {
  teamId: string;
  channelId: string;
  name: string;
  payerSlackId: string;
  payeeSlackId: string;
  arbiterSlackId: string;
  amount: number;
  token: string;
  milestone: string;
}) {
  return callTool("create_escrow", input);
}

export function releaseEscrow(treasuryId: string, actorSlackId: string) {
  return callTool("release_escrow", { treasuryId, actorSlackId });
}

export function refundEscrow(treasuryId: string, actorSlackId: string) {
  return callTool("refund_escrow", { treasuryId, actorSlackId });
}

export function getEscrow(treasuryId: string): Promise<{
  treasury: any;
  meta: {
    payerSlackId: string;
    payeeSlackId: string;
    arbiterSlackId: string;
    amount: number;
    token: string;
    milestone: string;
  };
} | null> {
  return callTool("get_escrow", { treasuryId });
}

export function createMergeProposal(input: {
  teamId: string;
  channelId: string;
  name: string;
  reviewerSlackIds: string[];
  threshold: number;
  owner: string;
  repo: string;
  pullNumber: number;
}) {
  return callTool("create_merge_proposal", input);
}

export function submitMergeProposal(treasuryId: string, actorSlackId: string) {
  return callTool("submit_merge_proposal", { treasuryId, actorSlackId });
}

export function getMergeProposal(
  treasuryId: string
): Promise<{ treasury: any; meta: { owner: string; repo: string; pullNumber: number } } | null> {
  return callTool("get_merge_proposal", { treasuryId });
}

export function createGithubConnectLink(teamId: string, owner: string): Promise<{ url: string }> {
  return callTool("create_github_connect_link", { teamId, owner });
}

export type WebviewTokenPurpose = "link" | "approve";

export function mintWebviewToken(input: {
  teamId: string;
  slackUserId: string;
  purpose: WebviewTokenPurpose;
  treasuryId?: string;
  proposalId?: string;
}): Promise<{ token: string }> {
  return callTool("mint_webview_token", input);
}

// ---- Raw installation-row access, used only by installationStore.ts ----

export function saveInstallationRaw(teamId: string, installation: Record<string, unknown>): Promise<{ ok: true }> {
  return callTool("save_installation", { teamId, installation });
}

export function getInstallationRaw(teamId: string): Promise<Record<string, unknown> | null> {
  return callTool("get_installation", { teamId });
}

export function deleteInstallationRaw(teamId: string): Promise<{ ok: true }> {
  return callTool("delete_installation", { teamId });
}
