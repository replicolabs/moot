import "dotenv/config";
import pkg from "@slack/bolt";
const { App } = pkg;
import { handleLinkWallet } from "./handlers/linkWalletHandler.js";
import { handleTreasuryNew } from "./handlers/treasuryHandler.js";
import { handlePropose } from "./handlers/proposalHandler.js";
import { handleApproveClick, handleConfirmProposal, startTrackingProposal } from "./handlers/approvalHandler.js";
import { handleRaiseHold, handleReleaseHold } from "./handlers/holdHandler.js";
import { getProposalMeta } from "./handlers/proposalMeta.js";
import { handleRules, handleCheck } from "./handlers/rulesHandler.js";
import { handleEscrowNew, handleEscrowRelease, handleEscrowRefund } from "./handlers/escrowHandler.js";
import { handleNaturalLanguageMention } from "./handlers/nlHandler.js";
import { handleMergePrNew, handleMergePrSubmit } from "./handlers/mergePrHandler.js";
import { handleGithubConnect } from "./handlers/githubConnectHandler.js";
import { mootInstallationStore } from "./installationStore.js";
import { getTrackedProposal } from "./state.js";

const APPROVE_EMOJIS = new Set(["moot-approve", "white_check_mark", "heavy_check_mark"]);
const HOLD_EMOJIS = new Set(["moot-hold", "octagonal_sign", "no_entry"]);

const BOT_SCOPES = [
  "chat:write",
  "app_mentions:read",
  "channels:history",
  "channels:read",
  "reactions:read",
  "users:read",
  "usergroups:read",
  "im:write",
  "commands",
];

const app = new App({
  clientId: requireEnv("SLACK_CLIENT_ID"),
  clientSecret: requireEnv("SLACK_CLIENT_SECRET"),
  stateSecret: requireEnv("SLACK_STATE_SECRET"),
  signingSecret: requireEnv("SLACK_SIGNING_SECRET"),
  appToken: requireEnv("SLACK_APP_TOKEN"),
  scopes: BOT_SCOPES,
  installationStore: mootInstallationStore,
  socketMode: true,
  // Bolt's SocketModeReceiver still spins up a small internal HTTP server for
  // the /slack/install + /slack/oauth_redirect routes even in Socket Mode --
  // this is the port that needs to sit behind the public reverse proxy.
  port: Number(process.env.SLACK_OAUTH_PORT ?? 3000),
});

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`missing required env var ${name}`);
  }
  return value;
}

const HELP_TEXT =
  "Try `/moot link-wallet`, `/moot treasury new <name> <threshold> @member1 @member2`, " +
  "or just tell me what to do in plain language, e.g. `@moot pay Ada 200 USDC from Ops for the logo work`.";

app.event("app_mention", async ({ event, client, context }) => {
  // Strip the leading <@BOTID> mention Slack always includes in event.text.
  const text = event.text.replace(/^<@[A-Z0-9]+>\s*/, "").trim();

  if (text.length < 5) {
    await client.chat.postMessage({ channel: event.channel, text: HELP_TEXT, thread_ts: event.ts });
    return;
  }

  const result = await handleNaturalLanguageMention(client, context.teamId!, event.channel, event.user!, text);
  const posted = await client.chat.postMessage({
    channel: event.channel,
    text: result.text,
    blocks: result.blocks,
    thread_ts: event.ts,
  });
  if (result.tracking && posted.ts) {
    startTrackingProposal(
      client,
      event.channel,
      posted.ts,
      result.tracking.treasuryId,
      result.tracking.proposalId,
      result.tracking.cardMeta
    );
  }
});

app.command("/moot", async ({ command, ack, respond, client, context }) => {
  await ack();

  const teamId = context.teamId!;
  const text = command.text.trim();
  const [sub, ...restParts] = text.split(/\s+/);
  const rest = restParts.join(" ");

  if (sub === "link-wallet") {
    try {
      await handleLinkWallet(client, teamId, command.user_id);
      await respond({ response_type: "ephemeral", text: "Check your DMs for a wallet-linking link." });
    } catch (err) {
      await respond({
        response_type: "ephemeral",
        text: `Couldn't start wallet linking: ${err instanceof Error ? err.message : String(err)}`,
      });
    }
    return;
  }

  if (sub === "treasury" && restParts[0] === "new") {
    const treasuryRest = restParts.slice(1).join(" ");
    const resultText = await handleTreasuryNew(client, teamId, command.channel_id, command.user_id, treasuryRest);
    await respond({ response_type: "in_channel", text: resultText });
    return;
  }

  if (sub === "propose") {
    const result = await handlePropose(client, teamId, command.channel_id, command.user_id, rest);
    // Posted via chat.postMessage, not respond(): messages posted through a
    // slash command's response_url can't later be updated with chat.update
    // (fails with cant_update_message). The confirm/approve buttons need a
    // message the bot can genuinely update as the on-chain state changes.
    await client.chat.postMessage({ channel: command.channel_id, text: result.text, blocks: result.blocks });
    return;
  }

  if (sub === "rules") {
    const text = await handleRules(teamId, command.channel_id, restParts.join(" "));
    await respond({ response_type: "ephemeral", text });
    return;
  }

  if (sub === "check") {
    const text = await handleCheck(teamId, command.channel_id, command.user_id, rest);
    await respond({ response_type: "ephemeral", text });
    return;
  }

  if (sub === "escrow") {
    if (restParts[0] === "new") {
      const text = await handleEscrowNew(teamId, command.channel_id, command.user_id, restParts.slice(1).join(" "));
      await respond({ response_type: "in_channel", text });
      return;
    }

    if (restParts[0] === "release" || restParts[0] === "refund") {
      const name = restParts.slice(1).join(" ");
      const result =
        restParts[0] === "release"
          ? await handleEscrowRelease(teamId, command.channel_id, command.user_id, name)
          : await handleEscrowRefund(teamId, command.channel_id, command.user_id, name);

      const posted = await client.chat.postMessage({
        channel: command.channel_id,
        text: result.text,
        blocks: result.blocks,
      });
      if (result.tracking && posted.ts) {
        startTrackingProposal(
          client,
          command.channel_id,
          posted.ts,
          result.tracking.treasuryId,
          result.tracking.proposalId,
          result.tracking.cardMeta
        );
      }
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: "Usage: `/moot escrow new ...`, `/moot escrow release <name>`, or `/moot escrow refund <name>`.",
    });
    return;
  }

  if (sub === "merge-pr") {
    if (restParts[0] === "new") {
      const text = await handleMergePrNew(teamId, command.channel_id, command.user_id, restParts.slice(1).join(" "));
      await respond({ response_type: "in_channel", text });
      return;
    }

    if (restParts[0] === "submit") {
      const name = restParts.slice(1).join(" ");
      const result = await handleMergePrSubmit(teamId, command.channel_id, command.user_id, name);

      const posted = await client.chat.postMessage({
        channel: command.channel_id,
        text: result.text,
        blocks: result.blocks,
      });
      if (result.tracking && posted.ts) {
        startTrackingProposal(
          client,
          command.channel_id,
          posted.ts,
          result.tracking.treasuryId,
          result.tracking.proposalId,
          result.tracking.cardMeta
        );
      }
      return;
    }

    await respond({
      response_type: "ephemeral",
      text: "Usage: `/moot merge-pr new ...` or `/moot merge-pr submit <name>`.",
    });
    return;
  }

  if (sub === "github" && restParts[0] === "connect") {
    const owner = restParts.slice(1).join(" ").trim();
    const text = await handleGithubConnect(teamId, owner);
    await respond({ response_type: "ephemeral", text });
    return;
  }

  await respond({
    response_type: "ephemeral",
    text:
      `Moot received: "${command.text}".\n\n` +
      "Available now: `/moot link-wallet`, `/moot treasury new <name> <threshold> @member1 @member2 ... [tokens=USDC]`, " +
      "`/moot propose <treasury> <amount> <token> @recipient [memo]`, `/moot rules <treasury>`, `/moot check <treasury> <amount> <token> @recipient`, " +
      "`/moot escrow new/release/refund`, `/moot merge-pr new/submit`, `/moot github connect <owner>`.",
  });
});

app.action("confirm_proposal", async ({ ack, body, client }) => {
  await ack();
  const action = (body as any).actions[0];
  const input = JSON.parse(action.value);
  const channel = (body as any).channel.id;
  const messageTs = (body as any).message.ts;

  try {
    console.log(`[confirm_proposal] submitting for treasury ${input.treasuryId}...`);
    const { blocks, treasuryId, proposalId } = await handleConfirmProposal(client, channel, input);
    console.log(`[confirm_proposal] submitted, proposalId=${proposalId}, updating card...`);

    await client.chat.update({ channel, ts: messageTs, text: "Proposal submitted", blocks });
    console.log(`[confirm_proposal] card updated, starting poll loop...`);

    startTrackingProposal(client, channel, messageTs, treasuryId, proposalId, {
      treasuryName: input.treasuryName,
      recipientLabel: input.recipientLabel,
      amount: input.amount,
      token: input.token,
      memo: input.memo,
    });
    console.log(`[confirm_proposal] poll loop started for ${channel}:${messageTs}`);
  } catch (err) {
    console.error(`[confirm_proposal] FAILED:`, err);
    try {
      await client.chat.update({
        channel,
        ts: messageTs,
        text: `Couldn't submit that proposal: ${err instanceof Error ? err.message : String(err)}`,
      });
    } catch (updateErr) {
      console.error(`[confirm_proposal] also failed to report the error back to the card:`, updateErr);
    }
  }
});

app.action("cancel_proposal", async ({ ack, body, client }) => {
  await ack();
  const channel = (body as any).channel.id;
  const messageTs = (body as any).message.ts;
  await client.chat.update({ channel, ts: messageTs, text: "Cancelled.", blocks: [] });
});

app.action("approve_proposal", async ({ ack, body, client, context }) => {
  await ack();
  const action = (body as any).actions[0];
  const { treasuryId, proposalId } = JSON.parse(action.value);
  const userId = (body as any).user.id;
  await handleApproveClick(client, context.teamId!, userId, treasuryId, proposalId);
});

app.action("raise_hold", async ({ ack, body, client }) => {
  await ack();
  const action = (body as any).actions[0];
  const input = JSON.parse(action.value);
  const channel = (body as any).channel.id;
  const messageTs = (body as any).message.ts;
  const userId = (body as any).user.id;

  await handleRaiseHold(client, channel, messageTs, userId, input.treasuryId, input.proposalId, {
    treasuryName: input.treasuryName,
    recipientLabel: input.recipientLabel,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
  });
});

app.action("release_hold", async ({ ack, body, client, respond }) => {
  await ack();
  const action = (body as any).actions[0];
  const input = JSON.parse(action.value);
  const channel = (body as any).channel.id;
  const messageTs = (body as any).message.ts;
  const userId = (body as any).user.id;

  const result = await handleReleaseHold(client, channel, messageTs, userId, input.treasuryId, input.proposalId, {
    treasuryName: input.treasuryName,
    recipientLabel: input.recipientLabel,
    amount: input.amount,
    token: input.token,
    memo: input.memo,
  });
  if (result.error) {
    await respond({ response_type: "ephemeral", text: result.error });
  }
});

app.event("reaction_added", async ({ event, client, context }) => {
  if (event.item.type !== "message") return;
  const tracked = getTrackedProposal(event.item.channel, event.item.ts);
  if (!tracked) return;

  if (APPROVE_EMOJIS.has(event.reaction)) {
    await handleApproveClick(client, context.teamId!, event.user, tracked.treasuryId, tracked.proposalId);
    return;
  }

  if (HOLD_EMOJIS.has(event.reaction)) {
    const meta = await getProposalMeta(tracked.treasuryId, tracked.proposalId);
    if (!meta) return;
    await handleRaiseHold(client, event.item.channel, event.item.ts, event.user, tracked.treasuryId, tracked.proposalId, meta);
  }
});

(async () => {
  await app.start();
  console.log("Moot is running (Socket Mode).");
})();
