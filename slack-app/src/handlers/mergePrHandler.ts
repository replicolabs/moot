import { createMergeProposal, findTreasury, getApprovalState, getMergeProposal, submitMergeProposal } from "../mcpClient.js";
import { buildApprovalCard } from "../blocks/proposalCard.js";
import type { CardMeta } from "./approvalHandler.js";

const MENTION_RE = /^<@([A-Z0-9]+)(\|[^>]*)?>$/;

const NEW_USAGE =
  'Usage: `/moot merge-pr new <name> <threshold> @reviewer1 @reviewer2 ... repo <owner/repo> pr <number>`\n' +
  'Example: `/moot merge-pr new BigRefactor 2 @alice @bob repo acme/webapp pr 42`\n' +
  "All reviewers must have run `/moot link-wallet`.";

/** Creates the merge-pr multisig from already-resolved fields. Shared by the slash command and NL paths. */
export async function createMergeProposalCore(
  teamId: string,
  channelId: string,
  name: string,
  reviewerSlackIds: string[],
  threshold: number,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<string> {
  try {
    const result = await createMergeProposal({
      teamId,
      channelId,
      name,
      reviewerSlackIds: [...new Set(reviewerSlackIds)],
      threshold,
      owner,
      repo,
      pullNumber,
    });
    return `${result.summary}\n\nRun \`/moot merge-pr submit ${name}\` to draft the on-chain approval proposal.`;
  } catch (err) {
    return `Couldn't create the merge proposal: ${err instanceof Error ? err.message : String(err)}`;
  }
}

export async function handleMergePrNew(teamId: string, channelId: string, actorSlackId: string, rest: string): Promise<string> {
  const tokens = rest.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 6) return NEW_USAGE;

  const [name, thresholdStr, ...remainder] = tokens;
  const threshold = Number(thresholdStr);
  if (!Number.isInteger(threshold) || threshold < 1) {
    return `"${thresholdStr}" isn't a valid threshold.\n\n${NEW_USAGE}`;
  }

  const reviewerSlackIds: string[] = [];
  let owner: string | null = null;
  let repo: string | null = null;
  let pullNumber: number | null = null;

  for (let i = 0; i < remainder.length; i++) {
    const tok = remainder[i];
    if (["me", "self", "@me"].includes(tok.toLowerCase())) {
      reviewerSlackIds.push(actorSlackId);
      continue;
    }
    const mentionMatch = tok.match(MENTION_RE);
    if (mentionMatch) {
      reviewerSlackIds.push(mentionMatch[1]);
      continue;
    }
    if (tok.toLowerCase() === "repo" && remainder[i + 1]) {
      const [o, r] = remainder[++i].split("/");
      if (!o || !r) return `"repo" needs an <owner>/<repo> value.\n\n${NEW_USAGE}`;
      owner = o;
      repo = r;
      continue;
    }
    if (tok.toLowerCase() === "pr" && remainder[i + 1]) {
      const n = Number(remainder[++i]);
      if (!Number.isInteger(n) || n <= 0) return `"pr" needs a valid PR number.\n\n${NEW_USAGE}`;
      pullNumber = n;
      continue;
    }
    return `Didn't understand "${tok}".\n\n${NEW_USAGE}`;
  }

  if (reviewerSlackIds.length === 0) return `Mention at least one wallet-linked reviewer.\n\n${NEW_USAGE}`;
  if (!owner || !repo || !pullNumber) return `Missing repo or PR number.\n\n${NEW_USAGE}`;
  if (threshold > reviewerSlackIds.length) {
    return `Threshold (${threshold}) can't exceed the number of reviewers (${reviewerSlackIds.length}).`;
  }

  return createMergeProposalCore(teamId, channelId, name, [...new Set(reviewerSlackIds)], threshold, owner, repo, pullNumber);
}

export async function handleMergePrSubmit(
  teamId: string,
  channelId: string,
  actorSlackId: string,
  name: string
): Promise<{ text: string; blocks?: any[]; tracking?: { treasuryId: string; proposalId: string; cardMeta: CardMeta } }> {
  const treasury = await findTreasury(teamId, channelId, name);
  if (!treasury) return { text: `No merge proposal named "${name}" in this channel.` };

  const mergeInfo = await getMergeProposal(treasury.treasuryId);
  if (!mergeInfo) return { text: `"${name}" isn't a merge proposal.` };

  try {
    const submitted = await submitMergeProposal(treasury.treasuryId, actorSlackId);
    const state = await getApprovalState(treasury.treasuryId, submitted.proposalId);

    const cardMeta: CardMeta = {
      treasuryName: treasury.name,
      recipientLabel: "",
      amount: 0,
      token: "N/A",
      headline: `*Merge ${mergeInfo.meta.owner}/${mergeInfo.meta.repo}#${mergeInfo.meta.pullNumber}* (${name})`,
    };

    const blocks = buildApprovalCard({
      treasuryId: treasury.treasuryId,
      proposalId: submitted.proposalId,
      ...cardMeta,
      approvals: state.approvals,
      requiredApprovals: state.requiredApprovals,
      decision: state.decision,
      timeLockRemaining: state.timeLockRemaining,
    });

    return {
      text: `Merge proposal drafted for "${name}"`,
      blocks,
      tracking: { treasuryId: treasury.treasuryId, proposalId: submitted.proposalId, cardMeta },
    };
  } catch (err) {
    return { text: `Couldn't draft the merge proposal: ${err instanceof Error ? err.message : String(err)}` };
  }
}
