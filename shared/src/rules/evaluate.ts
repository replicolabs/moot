import {
  EvaluateFlags,
  EvaluateResult,
  HoldRecord,
  PolicyDocument,
  ProposalContext,
  TransferLikeDraft,
} from "./schema.js";

/**
 * evaluate() order (see moot/CLAUDE.md "Policy engine"):
 *   active hold -> guards (allowlist/velocity/balance) -> escalations not yet
 *   met -> on-chain approvals below required -> otherwise ready.
 *
 * `approvals.base` is always the live on-chain multisig threshold. Policy can
 * only ADD requirements on top of it; it can never lower the floor. That
 * guarantee is enforced here, not just documented: requiredApprovals is always
 * >= context.onChainThreshold.
 */
export function evaluate(
  policy: PolicyDocument,
  draft: TransferLikeDraft,
  context: ProposalContext
): EvaluateResult {
  const reasons: string[] = [];
  const flags: EvaluateFlags = { unknownRecipient: false, velocityExceeded: false };

  const activeHold = findActiveHold(policy, context);
  if (activeHold) {
    return {
      decision: "held",
      reasons: [`hold raised by ${activeHold.raisedBy}, not yet released`],
      requiredApprovals: context.onChainThreshold,
      currentApprovals: context.onChainApprovals.length,
      flags,
    };
  }

  const allowlist = resolveAllowlist(policy, context);
  const recipientKnown = allowlist === null || allowlist.includes(draft.recipient);
  flags.unknownRecipient = !recipientKnown;
  if (!recipientKnown && policy.recipientControls.flagUnknown) {
    reasons.push(`first-time recipient ${draft.recipient}, not on the known-payee list`);
  }

  if (policy.velocity) {
    const windowMs = parseWindowToMs(policy.velocity.window);
    const windowStart = context.nowMs - windowMs;
    const spentInWindow = context.recentTransfers
      .filter((t) => t.atMs >= windowStart)
      .reduce((sum, t) => sum + t.amount, 0);
    const totalIfSent = spentInWindow + draft.amount;
    if (totalIfSent > policy.velocity.maxTotalAmount) {
      flags.velocityExceeded = true;
      return {
        decision: "blocked_guard",
        reasons: [
          `velocity cap exceeded: ${spentInWindow} already sent in the last ${policy.velocity.window}, ` +
            `this proposal's ${draft.amount} would bring it to ${totalIfSent}, cap is ${policy.velocity.maxTotalAmount}`,
        ],
        requiredApprovals: context.onChainThreshold,
        currentApprovals: context.onChainApprovals.length,
        flags,
      };
    }
  }

  let requiredApprovals = context.onChainThreshold;
  const unmetEscalations: string[] = [];
  for (const rule of policy.approvals.escalations) {
    if (!conditionHolds(rule.when, draft, recipientKnown)) {
      continue;
    }
    if (rule.requireExtra) {
      requiredApprovals = Math.max(requiredApprovals, context.onChainThreshold + rule.requireExtra);
    }
    if (rule.requireRole && rule.requireRole.length > 0) {
      const approverRoles = new Set(
        context.members
          .filter((m) => context.onChainApprovals.includes(m.pubkey))
          .flatMap((m) => m.roles)
      );
      const roleSatisfied = rule.requireRole.some((role) => approverRoles.has(role));
      if (!roleSatisfied) {
        unmetEscalations.push(
          `requires an approver with role [${rule.requireRole.join(", ")}] because: ${rule.when}`
        );
      }
    }
  }

  // requiredApprovals can only ever be >= the on-chain floor, never below it.
  requiredApprovals = Math.max(requiredApprovals, context.onChainThreshold);

  if (unmetEscalations.length > 0) {
    return {
      decision: "needs_escalation_approval",
      reasons: unmetEscalations,
      requiredApprovals,
      currentApprovals: context.onChainApprovals.length,
      flags,
    };
  }

  if (policy.expiry) {
    const windowMs = parseWindowToMs(policy.expiry.window);
    if (context.nowMs - context.createdAtMs > windowMs) {
      return {
        decision: "expired",
        reasons: [`unapproved for longer than ${policy.expiry.window}`],
        requiredApprovals,
        currentApprovals: context.onChainApprovals.length,
        flags,
      };
    }
  }

  if (context.onChainApprovals.length < requiredApprovals) {
    return {
      decision: "needs_more_approvals",
      reasons: [`${context.onChainApprovals.length} of ${requiredApprovals} approvals`],
      requiredApprovals,
      currentApprovals: context.onChainApprovals.length,
      flags,
    };
  }

  if (context.timeLockRemainingSeconds > 0) {
    return {
      decision: "needs_more_approvals",
      reasons: [`timelock: ${context.timeLockRemainingSeconds}s remaining`],
      requiredApprovals,
      currentApprovals: context.onChainApprovals.length,
      flags,
    };
  }

  reasons.push("all requirements met");
  return {
    decision: "ready",
    reasons,
    requiredApprovals,
    currentApprovals: context.onChainApprovals.length,
    flags,
  };
}

function findActiveHold(policy: PolicyDocument, context: ProposalContext): HoldRecord | null {
  if (!policy.hold?.enabled) return null;
  const active = context.holds.filter((h) => !h.released);
  if (active.length >= Math.max(1, policy.hold.quorumToHold)) {
    return active[0];
  }
  return null;
}

function resolveAllowlist(policy: PolicyDocument, context: ProposalContext): string[] | null {
  const ref = policy.recipientControls.allowlistRef;
  if (!ref) return null;
  return context.allowlists[ref] ?? [];
}

/**
 * Minimal, deliberately non-Turing-complete condition language for
 * escalations.when. This is policy text checked into git, not user input,
 * but it still must not become an arbitrary-code eval: only two shapes are
 * recognized, everything else throws at evaluate-time so a typo in a policy
 * file fails loudly instead of silently matching nothing.
 *
 * Supported:
 *   "amount <op> <number>"       op in > >= < <= == !=
 *   "recipient (not )?in allowlist"
 */
function conditionHolds(when: string, draft: TransferLikeDraft, recipientKnown: boolean): boolean {
  const trimmed = when.trim();

  const allowlistMatch = trimmed.match(/^recipient\s+(not\s+)?in\s+allowlist$/);
  if (allowlistMatch) {
    const negated = Boolean(allowlistMatch[1]);
    return negated ? !recipientKnown : recipientKnown;
  }

  const comparisonMatch = trimmed.match(/^amount\s*(>=|<=|==|!=|>|<)\s*(-?\d+(\.\d+)?)$/);
  if (comparisonMatch) {
    const [, op, valueStr] = comparisonMatch;
    const value = Number(valueStr);
    switch (op) {
      case ">":
        return draft.amount > value;
      case ">=":
        return draft.amount >= value;
      case "<":
        return draft.amount < value;
      case "<=":
        return draft.amount <= value;
      case "==":
        return draft.amount === value;
      case "!=":
        return draft.amount !== value;
    }
  }

  throw new Error(`unsupported escalation condition: "${when}"`);
}

const WINDOW_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

function parseWindowToMs(window: string): number {
  const match = window.trim().match(/^(\d+(?:\.\d+)?)([smhd])$/);
  if (!match) {
    throw new Error(`unsupported window format: "${window}" (expected e.g. "24h", "48h", "30m")`);
  }
  const [, amountStr, unit] = match;
  return Number(amountStr) * WINDOW_UNIT_MS[unit];
}
