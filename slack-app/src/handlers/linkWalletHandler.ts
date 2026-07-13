import type { WebClient } from "@slack/web-api";
import { mintWebviewToken, startWalletLink } from "../mcpClient.js";

const WEBVIEW_BASE_URL = process.env.SIGNING_WEBVIEW_URL ?? "http://localhost:8787/webview";

export async function handleLinkWallet(client: WebClient, teamId: string, slackUserId: string) {
  const { challengeId, expiresAtMs } = await startWalletLink(teamId, slackUserId);
  const { token } = await mintWebviewToken({ teamId, slackUserId, purpose: "link" });

  // Only the challengeId (+ signed token) goes in the URL; the page fetches
  // the exact message to sign straight from the server. See
  // getChallengeMessage's doc comment for why round-tripping the message
  // itself through a DM link was fragile.
  const url = new URL(WEBVIEW_BASE_URL + "/");
  url.searchParams.set("mode", "link");
  url.searchParams.set("challengeId", challengeId);
  url.searchParams.set("token", token);

  const minutesLeft = Math.round((expiresAtMs - Date.now()) / 60000);

  await client.chat.postMessage({
    channel: slackUserId,
    text:
      `Connect your wallet to link it to your Slack account. This proves ownership, it doesn't authorize any payment.\n` +
      `${url.toString()}\n\nThis link expires in ${minutesLeft} minutes.`,
  });
}
