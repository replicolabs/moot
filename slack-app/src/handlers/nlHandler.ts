import type { WebClient } from "@slack/web-api";
import { parseIntent } from "../nl/parseIntent.js";
import { getChannelMembers, resolveRecipientByNameOrMention, resolveSlackId, resolveSlackIds } from "../nl/resolveNames.js";
import { buildProposalConfirmation } from "./proposalHandler.js";
import { handleRules, buildCheckResult } from "./rulesHandler.js";
import { handleLinkWallet } from "./linkWalletHandler.js";
import { createTreasuryCore } from "./treasuryHandler.js";
import { createEscrowCore, handleEscrowRelease, handleEscrowRefund } from "./escrowHandler.js";
import { createMergeProposalCore, handleMergePrSubmit } from "./mergePrHandler.js";
import { handleGithubConnect } from "./githubConnectHandler.js";
import type { CardMeta } from "./approvalHandler.js";

export interface NlResult {
  text: string;
  blocks?: any[];
  tracking?: { treasuryId: string; proposalId: string; cardMeta: CardMeta };
}

const DEFAULT_FALLBACK =
  "I didn't catch a clear request there. Try asking me to pay someone, create a treasury or escrow, " +
  "check a policy, or ask \"what can you do\" for a full rundown.";

/**
 * The model is instructed to ask a clarifying question whenever a required
 * field is missing, but that's not guaranteed -- it can classify an action
 * correctly while still leaving a required field null with no question. This
 * is the deterministic fallback for that case: name exactly what's missing
 * instead of a generic "I didn't understand".
 */
function needMessage(missing: string[]): string {
  return `I need a bit more to do that -- specifically: ${missing.join(", ")}.`;
}

const CAPABILITIES_TEXT =
  "*Here's what I can do:*\n\n" +
  "*Payments*\n" +
  "- Pay someone from a treasury (e.g. \"pay Ada 200 USDC from Ops for the logo work\")\n" +
  "- Dry-run a payment without sending anything (e.g. \"what would it take to pay Ada 200 USDC from Ops\")\n" +
  "- Explain a treasury's approval rules (e.g. \"what are the rules for Ops\")\n\n" +
  "*Treasuries*\n" +
  "- Create a new multisig treasury (e.g. \"set up a treasury called Ops needing 2 approvals from me, alice and bob\")\n\n" +
  "*Escrow*\n" +
  "- Create a payer/payee/arbiter escrow (e.g. \"escrow 500 USDC to alice with bob as arbiter, released when the design is approved\")\n" +
  "- Release or refund an existing escrow (e.g. \"release the BuildCoLogo escrow\", \"refund BuildCoLogo\")\n\n" +
  "*GitHub PR merges (no funds involved)*\n" +
  "- Connect Moot's GitHub App to a repo owner/org, once per workspace (e.g. \"connect github to acme\")\n" +
  "- Create a multisig gating a PR merge (e.g. \"gate merging acme/webapp PR 42 behind 2 approvals from alice and bob\")\n" +
  "- Submit the on-chain approval proposal for it (e.g. \"submit the merge proposal for BigRefactor\")\n\n" +
  "*Wallets*\n" +
  "- Link your own wallet (e.g. \"link my wallet\")\n\n" +
  "Approving or holding a specific pending proposal is done with the buttons/reactions on its card, " +
  "since that's the only unambiguous way to say which one you mean.";

/**
 * Routes any natural-language mention of Moot to the right action. Extraction
 * only ever produces a typed draft/intent or a clarifying question -- it
 * never creates anything on-chain itself. Every action that would move funds
 * or change membership still goes through the same confirmation-card or
 * draft-then-approve path as its slash-command equivalent, so a member must
 * explicitly confirm (transfer) or the action only ever drafts a proposal
 * that still needs real wallet approvals (everything else), regardless of
 * what the model extracted.
 */
export async function handleNaturalLanguageMention(
  client: WebClient,
  teamId: string,
  channelId: string,
  actorSlackId: string,
  text: string
): Promise<NlResult> {
  const intent = await parseIntent(text);

  if (intent.action === "capabilities") {
    return { text: CAPABILITIES_TEXT };
  }

  if (intent.action === "unclear" || intent.clarifyingQuestion) {
    return { text: intent.clarifyingQuestion ?? DEFAULT_FALLBACK };
  }

  switch (intent.action) {
    case "link_wallet": {
      await handleLinkWallet(client, teamId, actorSlackId);
      return { text: "Check your DMs for a wallet-linking link." };
    }

    case "rules": {
      if (!intent.name) return { text: "Which treasury do you want the rules for?" };
      return { text: await handleRules(teamId, channelId, intent.name) };
    }

    case "transfer": {
      const missing = [
        !intent.name && "which treasury to pay from",
        !intent.recipientName && "who to pay",
        !intent.amount && "how much",
        !intent.token && "which token",
      ].filter((m): m is string => Boolean(m));
      if (missing.length > 0) return { text: needMessage(missing) };

      const resolved = await resolveRecipientByNameOrMention(client, teamId, channelId, actorSlackId, intent.recipientName!);
      if ("error" in resolved) return { text: resolved.error };

      return buildProposalConfirmation(
        teamId,
        channelId,
        actorSlackId,
        intent.name!,
        resolved.recipient,
        resolved.recipientLabel,
        intent.amount!,
        intent.token!.toUpperCase(),
        intent.memo ?? undefined
      );
    }

    case "check": {
      const missing = [
        !intent.name && "which treasury",
        !intent.recipientName && "who the recipient is",
        !intent.amount && "how much",
        !intent.token && "which token",
      ].filter((m): m is string => Boolean(m));
      if (missing.length > 0) return { text: needMessage(missing) };

      const resolved = await resolveRecipientByNameOrMention(client, teamId, channelId, actorSlackId, intent.recipientName!);
      if ("error" in resolved) return { text: resolved.error };

      return {
        text: await buildCheckResult(teamId, channelId, actorSlackId, intent.name!, resolved.recipient, intent.amount!, intent.token!.toUpperCase()),
      };
    }

    case "treasury_new": {
      const missing = [
        !intent.name && "a name for the treasury",
        !intent.threshold && "how many approvals are needed",
        (!intent.nameList || intent.nameList.length === 0) && "who the members are",
      ].filter((m): m is string => Boolean(m));
      if (missing.length > 0) return { text: needMessage(missing) };

      const members = await getChannelMembers(client, channelId);
      const resolved = resolveSlackIds(intent.nameList!, actorSlackId, members);
      if ("error" in resolved) return { text: resolved.error };
      if (intent.threshold! > resolved.ids.length) {
        return { text: `Threshold (${intent.threshold}) can't exceed the number of members (${resolved.ids.length}).` };
      }

      const tokens = intent.tokens && intent.tokens.length > 0 ? intent.tokens.map((t) => t.toUpperCase()) : ["USDC"];
      return {
        text: await createTreasuryCore(
          teamId,
          channelId,
          actorSlackId,
          intent.name!,
          resolved.ids,
          intent.threshold!,
          tokens,
          intent.timeLockSeconds ?? 0
        ),
      };
    }

    case "escrow_new": {
      const missing = [
        !intent.name && "a name for the escrow",
        !intent.payeeName && "who the payee is",
        !intent.arbiterName && "who the arbiter is",
        !intent.milestone && "the release condition",
        !intent.amount && "how much",
        !intent.token && "which token",
      ].filter((m): m is string => Boolean(m));
      if (missing.length > 0) return { text: needMessage(missing) };

      const members = await getChannelMembers(client, channelId);
      const payee = resolveSlackId(intent.payeeName!, actorSlackId, members);
      if ("error" in payee) return { text: payee.error };
      const arbiter = resolveSlackId(intent.arbiterName!, actorSlackId, members);
      if ("error" in arbiter) return { text: arbiter.error };

      return {
        text: await createEscrowCore(
          teamId,
          channelId,
          actorSlackId,
          intent.name!,
          payee.id,
          arbiter.id,
          intent.amount!,
          intent.token!.toUpperCase(),
          intent.milestone!
        ),
      };
    }

    case "escrow_release": {
      if (!intent.name) return { text: "Which escrow do you want to release?" };
      return handleEscrowRelease(teamId, channelId, actorSlackId, intent.name);
    }

    case "escrow_refund": {
      if (!intent.name) return { text: "Which escrow do you want to refund?" };
      return handleEscrowRefund(teamId, channelId, actorSlackId, intent.name);
    }

    case "merge_pr_new": {
      const missing = [
        !intent.name && "a name for the merge proposal",
        !intent.threshold && "how many approvals are needed",
        (!intent.nameList || intent.nameList.length === 0) && "who the reviewers are",
        !intent.repoFullName && "the repo (owner/repo)",
        !intent.pullNumber && "the PR number",
      ].filter((m): m is string => Boolean(m));
      if (missing.length > 0) return { text: needMessage(missing) };

      const [owner, repo] = intent.repoFullName!.split("/");
      if (!owner || !repo) return { text: `"${intent.repoFullName}" doesn't look like an <owner>/<repo> value.` };

      const members = await getChannelMembers(client, channelId);
      const resolved = resolveSlackIds(intent.nameList!, actorSlackId, members);
      if ("error" in resolved) return { text: resolved.error };
      if (intent.threshold! > resolved.ids.length) {
        return { text: `Threshold (${intent.threshold}) can't exceed the number of reviewers (${resolved.ids.length}).` };
      }

      return {
        text: await createMergeProposalCore(teamId, channelId, intent.name!, resolved.ids, intent.threshold!, owner, repo, intent.pullNumber!),
      };
    }

    case "merge_pr_submit": {
      if (!intent.name) return { text: "Which merge proposal do you want to submit?" };
      return handleMergePrSubmit(teamId, channelId, actorSlackId, intent.name);
    }

    case "github_connect": {
      if (!intent.repoFullName) return { text: "Which GitHub owner/org do you want to connect?" };
      return { text: await handleGithubConnect(teamId, intent.repoFullName) };
    }

    default:
      return { text: DEFAULT_FALLBACK };
  }
}
