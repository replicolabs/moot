import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { startWalletLink, completeWalletLink, lookupWalletLink } from "./tools/linkWallet.js";
import { createTreasury, findTreasury, getTreasuryState, listTreasuriesForChannel } from "./tools/treasury.js";
import {
  buildApprovalForSigning,
  draftProposal,
  executeProposal,
  getApprovalState,
  getStoredProposal,
  relayApproval,
  submitProposal,
} from "./tools/proposal.js";
import { getHoldsTool, raiseHoldTool, releaseHoldTool } from "./tools/holds.js";
import { getPolicy } from "./tools/policyInfo.js";
import { createEscrow, getEscrow, refundEscrow, releaseEscrow } from "./tools/escrow.js";
import { createMergeProposal, executeMergeProposal, getMergeProposal, submitMergeProposal } from "./tools/mergeProposal.js";
import { buildGithubConnectUrl } from "./tools/githubConnect.js";
import { deleteInstallation, getInstallation, saveInstallation } from "./tools/installations.js";
import { signWebviewToken } from "./webviewAuth.js";
import { isMergeProposalTreasury } from "./store.js";

function textResult(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

function errorResult(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

export function buildMootMcpServer(): McpServer {
  const server = new McpServer({ name: "moot", version: "0.1.0" });

  server.registerTool(
    "start_wallet_link",
    {
      description: "Begins wallet linking: issues a one-time signing challenge for a Slack user.",
      inputSchema: { teamId: z.string(), slackUserId: z.string() },
    },
    async ({ teamId, slackUserId }) => {
      try {
        return textResult(startWalletLink(teamId, slackUserId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "link_wallet",
    {
      description:
        "Verifies a signed challenge and binds slackUserId<->memberPubkey. Never trusts a claimed pubkey without a valid signature.",
      inputSchema: {
        challengeId: z.string(),
        pubkeyBase58: z.string(),
        signatureBase64: z.string(),
      },
    },
    async ({ challengeId, pubkeyBase58, signatureBase64 }) => {
      try {
        return textResult(completeWalletLink({ challengeId, pubkeyBase58, signatureBase64 }));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "lookup_wallet_link",
    {
      description: "Returns the linked wallet pubkey for a Slack user, or null if not linked.",
      inputSchema: { teamId: z.string(), slackUserId: z.string() },
    },
    async ({ teamId, slackUserId }) => {
      try {
        return textResult(lookupWalletLink(teamId, slackUserId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_treasury",
    {
      description: "Creates a real Squads multisig with Moot as Propose|Execute-only (no vote).",
      inputSchema: {
        teamId: z.string(),
        channelId: z.string(),
        creatorSlackId: z.string(),
        name: z.string(),
        memberSlackIds: z.array(z.string()),
        threshold: z.number().int().min(1),
        timeLockSeconds: z.number().int().min(0).optional(),
        tokens: z.array(z.string()),
      },
    },
    async (input) => {
      try {
        return textResult(await createTreasury(input));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_treasury_state",
    {
      description: "Live balances, members, and policy summary for a treasury, read from chain.",
      inputSchema: { treasuryId: z.string() },
    },
    async ({ treasuryId }) => {
      try {
        return textResult(await getTreasuryState(treasuryId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "find_treasury",
    {
      description: "Looks up a treasury by its human name within a channel.",
      inputSchema: { teamId: z.string(), channelId: z.string(), name: z.string() },
    },
    async ({ teamId, channelId, name }) => {
      try {
        return textResult(await findTreasury(teamId, channelId, name));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "list_treasuries",
    {
      description: "Lists all treasuries in a channel.",
      inputSchema: { teamId: z.string(), channelId: z.string() },
    },
    async ({ teamId, channelId }) => {
      try {
        return textResult(await listTreasuriesForChannel(teamId, channelId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "draft_proposal",
    {
      description:
        "Validates a typed proposal draft against policy. Does NOT create anything on-chain; pure preview.",
      inputSchema: {
        treasuryId: z.string(),
        actorSlackId: z.string(),
        recipient: z.string(),
        amount: z.number().positive(),
        token: z.string(),
        memo: z.string().optional(),
      },
    },
    async (input) => {
      try {
        return textResult(await draftProposal(input));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "submit_proposal",
    {
      description:
        "Creates the real on-chain vault transaction + proposal after human confirmation of the parsed draft.",
      inputSchema: {
        treasuryId: z.string(),
        actorSlackId: z.string(),
        recipient: z.string(),
        amount: z.number().positive(),
        token: z.string(),
        memo: z.string().optional(),
      },
    },
    async (input) => {
      try {
        return textResult(await submitProposal(input));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_approval_state",
    {
      description: "Reads live approvals + threshold + timelock from the on-chain proposal account.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string() },
    },
    async ({ treasuryId, proposalId }) => {
      try {
        return textResult(await getApprovalState(treasuryId, proposalId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_proposal",
    {
      description: "Returns the stored draft fields (recipient, amount, token, memo) for a proposal.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string() },
    },
    async ({ treasuryId, proposalId }) => {
      try {
        return textResult(await getStoredProposal(treasuryId, proposalId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "build_approval_for_signing",
    {
      description:
        "Returns the unsigned approval transaction bytes (base64) for a member's own wallet to sign in the web view.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string(), memberPubkey: z.string() },
    },
    async ({ treasuryId, proposalId, memberPubkey }) => {
      try {
        const base64 = await buildApprovalForSigning(treasuryId, proposalId, memberPubkey);
        return textResult({ unsignedTransactionBase64: base64 });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "relay_approval",
    {
      description: "Submits a member-signed proposalApprove transaction. Moot never signs approvals itself.",
      inputSchema: { signedTransactionBase64: z.string() },
    },
    async ({ signedTransactionBase64 }) => {
      try {
        return textResult(await relayApproval(signedTransactionBase64));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "execute_proposal",
    {
      description:
        "Re-checks policy + on-chain threshold + timelock server-side, then cranks execution.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string() },
    },
    async ({ treasuryId, proposalId }) => {
      try {
        // Merge-PR treasuries execute the same on-chain memo transaction but
        // must also merge the PR afterward -- branch here rather than in
        // tools/proposal.ts to avoid a circular import (mergeProposal.ts
        // already imports getApprovalState from proposal.ts).
        const result = isMergeProposalTreasury(treasuryId)
          ? await executeMergeProposal(treasuryId, proposalId)
          : await executeProposal(treasuryId, proposalId);
        return textResult(result);
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "raise_hold",
    {
      description: "Any member can pause a proposal before it executes.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string(), raisedBySlackId: z.string() },
    },
    async ({ treasuryId, proposalId, raisedBySlackId }) => {
      try {
        return textResult(raiseHoldTool(treasuryId, proposalId, raisedBySlackId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "release_hold",
    {
      description: "Releases an active hold on a proposal.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string() },
    },
    async ({ treasuryId, proposalId }) => {
      try {
        return textResult(releaseHoldTool(treasuryId, proposalId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_holds",
    {
      description: "Lists holds (active and released) on a proposal.",
      inputSchema: { treasuryId: z.string(), proposalId: z.string() },
    },
    async ({ treasuryId, proposalId }) => {
      try {
        return textResult(getHoldsTool(treasuryId, proposalId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_policy",
    {
      description: "Returns the parsed policy document for an action type (transfer or escrow), for /moot rules.",
      inputSchema: { actionType: z.enum(["transfer", "escrow"]).optional() },
    },
    async ({ actionType }) => {
      try {
        return textResult(getPolicy(actionType));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_escrow",
    {
      description:
        "Creates a real dedicated escrow multisig (payer, payee, arbiter). Payee can propose but never self-approve.",
      inputSchema: {
        teamId: z.string(),
        channelId: z.string(),
        name: z.string(),
        payerSlackId: z.string(),
        payeeSlackId: z.string(),
        arbiterSlackId: z.string(),
        amount: z.number().positive(),
        token: z.string(),
        milestone: z.string(),
      },
    },
    async (input) => {
      try {
        return textResult(await createEscrow(input));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_escrow",
    {
      description: "Returns the treasury + escrow terms (payer, payee, arbiter, amount, milestone).",
      inputSchema: { treasuryId: z.string() },
    },
    async ({ treasuryId }) => {
      try {
        return textResult(await getEscrow(treasuryId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "release_escrow",
    {
      description: "Drafts the on-chain 'pay payee' proposal for an escrow. Still needs real approval to execute.",
      inputSchema: { treasuryId: z.string(), actorSlackId: z.string() },
    },
    async ({ treasuryId, actorSlackId }) => {
      try {
        return textResult(await releaseEscrow(treasuryId, actorSlackId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "refund_escrow",
    {
      description: "Drafts the on-chain 'refund payer' proposal for an escrow. Still needs real approval to execute.",
      inputSchema: { treasuryId: z.string(), actorSlackId: z.string() },
    },
    async ({ treasuryId, actorSlackId }) => {
      try {
        return textResult(await refundEscrow(treasuryId, actorSlackId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_merge_proposal",
    {
      description:
        "Creates a real on-chain 'governance' multisig scoped to one GitHub PR -- demonstrates the same quorum-and-approval engine gating a non-financial action. No funds involved.",
      inputSchema: {
        teamId: z.string(),
        channelId: z.string(),
        name: z.string(),
        reviewerSlackIds: z.array(z.string()),
        threshold: z.number().int().min(1),
        owner: z.string(),
        repo: z.string(),
        pullNumber: z.number().int().positive(),
      },
    },
    async (input) => {
      try {
        return textResult(await createMergeProposal(input));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "submit_merge_proposal",
    {
      description: "Drafts the on-chain memo proposal naming the PR. Still needs real reviewer approval to execute.",
      inputSchema: { treasuryId: z.string(), actorSlackId: z.string() },
    },
    async ({ treasuryId, actorSlackId }) => {
      try {
        return textResult(await submitMergeProposal(treasuryId, actorSlackId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_merge_proposal",
    {
      description: "Returns the treasury + PR reference (owner, repo, pull number) for a merge proposal.",
      inputSchema: { treasuryId: z.string() },
    },
    async ({ treasuryId }) => {
      try {
        return textResult(await getMergeProposal(treasuryId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "save_installation",
    {
      description: "Stores (or updates) a workspace's Slack OAuth installation. Used by slack-app's Bolt installationStore, never called directly by a user.",
      inputSchema: { teamId: z.string(), installation: z.record(z.string(), z.any()) },
    },
    async ({ teamId, installation }) => {
      try {
        saveInstallation(teamId, installation);
        return textResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "get_installation",
    {
      description: "Fetches a workspace's Slack OAuth installation, or null. Used by slack-app's Bolt installationStore.",
      inputSchema: { teamId: z.string() },
    },
    async ({ teamId }) => {
      try {
        return textResult(getInstallation(teamId));
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "delete_installation",
    {
      description: "Removes a workspace's Slack OAuth installation (e.g. on uninstall). Used by slack-app's Bolt installationStore.",
      inputSchema: { teamId: z.string() },
    },
    async ({ teamId }) => {
      try {
        deleteInstallation(teamId);
        return textResult({ ok: true });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "mint_webview_token",
    {
      description: "Mints a short-lived signed token authorizing one member to use the signing web view for one specific purpose.",
      inputSchema: {
        teamId: z.string(),
        slackUserId: z.string(),
        purpose: z.enum(["link", "approve"]),
        treasuryId: z.string().optional(),
        proposalId: z.string().optional(),
      },
    },
    async ({ teamId, slackUserId, purpose, treasuryId, proposalId }) => {
      try {
        return textResult({ token: signWebviewToken({ teamId, slackUserId, purpose, treasuryId, proposalId }) });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  server.registerTool(
    "create_github_connect_link",
    {
      description: "Builds the install link for connecting this workspace's own GitHub App installation to a repo owner/org.",
      inputSchema: { teamId: z.string(), owner: z.string() },
    },
    async ({ teamId, owner }) => {
      try {
        return textResult({ url: buildGithubConnectUrl(teamId, owner) });
      } catch (err) {
        return errorResult(err);
      }
    }
  );

  return server;
}
