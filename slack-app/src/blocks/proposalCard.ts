export interface ProposalDraftInfo {
  treasuryName: string;
  recipient: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
  requiredApprovals: number;
  unknownRecipient: boolean;
  decision: string;
  reasons: string[];
}

function confirmValue(input: {
  treasuryId: string;
  actorSlackId: string;
  treasuryName: string;
  recipient: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
}) {
  return JSON.stringify(input);
}

export function buildConfirmationCard(
  input: {
    treasuryId: string;
    actorSlackId: string;
  } & ProposalDraftInfo
) {
  const lines = [
    `*Send ${input.amount} ${input.token} to ${input.recipientLabel} from ${input.treasuryName}*`,
    `Needs ${input.requiredApprovals} approval(s).`,
  ];
  if (input.unknownRecipient) lines.push(":warning: First time paying this wallet.");
  if (input.memo) lines.push(`Memo: ${input.memo}`);
  if (input.decision === "blocked_guard" || input.decision === "needs_escalation_approval") {
    lines.push(`:no_entry: ${input.reasons.join("; ")}`);
  }

  const blocks: any[] = [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
  ];

  if (input.decision !== "blocked_guard") {
    blocks.push({
      type: "actions",
      elements: [
        {
          type: "button",
          text: { type: "plain_text", text: "Confirm & send" },
          style: "primary",
          action_id: "confirm_proposal",
          value: confirmValue({
            treasuryId: input.treasuryId,
            actorSlackId: input.actorSlackId,
            treasuryName: input.treasuryName,
            recipient: input.recipient,
            recipientLabel: input.recipientLabel,
            amount: input.amount,
            token: input.token,
            memo: input.memo,
          }),
        },
        {
          type: "button",
          text: { type: "plain_text", text: "Cancel" },
          action_id: "cancel_proposal",
        },
      ],
    });
  }

  return blocks;
}

export interface ApprovalCardState {
  treasuryId: string;
  proposalId: string;
  treasuryName: string;
  recipientLabel: string;
  amount: number;
  token: string;
  memo?: string;
  approvals: string[];
  requiredApprovals: number;
  decision: string;
  executed?: boolean;
  txSignature?: string;
  held?: boolean;
  timeLockRemaining?: number;
  /** Overrides the default "Sending X Y to Z" title, for non-transfer proposals like a PR merge. */
  headline?: string;
  /** Custom "executed" line, e.g. reporting a GitHub merge result instead of an Explorer link. */
  executedLine?: string;
}

export function buildApprovalCard(state: ApprovalCardState) {
  const lines = [
    state.headline ?? `*Sending ${state.amount} ${state.token} to ${state.recipientLabel} from ${state.treasuryName}*`,
  ];
  if (state.memo) lines.push(`Memo: ${state.memo}`);

  if (state.executed) {
    lines.push(
      state.executedLine ??
        `:white_check_mark: Executed.` +
          (state.txSignature ? ` <https://explorer.solana.com/tx/${state.txSignature}?cluster=devnet|View on Explorer>` : "")
    );
    return [{ type: "section", text: { type: "mrkdwn", text: lines.join("\n") } }];
  }

  lines.push(`Approvals: ${state.approvals.length} of ${state.requiredApprovals}`);
  if (state.timeLockRemaining && state.timeLockRemaining > 0) {
    lines.push(`:hourglass_flowing_sand: Chain-enforced cooldown: ${state.timeLockRemaining}s remaining after threshold.`);
  }
  if (state.decision === "needs_escalation_approval") {
    lines.push(":no_entry: needs an additional approval that hasn't landed yet.");
  }
  if (state.held || state.decision === "held") {
    lines.push(":pause_button: On hold. Won't execute even if fully approved until released.");
  }

  const value = JSON.stringify({
    treasuryId: state.treasuryId,
    proposalId: state.proposalId,
    treasuryName: state.treasuryName,
    recipientLabel: state.recipientLabel,
    amount: state.amount,
    token: state.token,
    memo: state.memo,
  });

  const elements: any[] = [
    {
      type: "button",
      text: { type: "plain_text", text: "Approve" },
      style: "primary",
      action_id: "approve_proposal",
      value,
    },
  ];

  if (state.held || state.decision === "held") {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Release hold" },
      action_id: "release_hold",
      value,
    });
  } else {
    elements.push({
      type: "button",
      text: { type: "plain_text", text: "Hold" },
      style: "danger",
      action_id: "raise_hold",
      value,
    });
  }

  return [
    { type: "section", text: { type: "mrkdwn", text: lines.join("\n") } },
    { type: "actions", elements },
  ];
}
