import { describe, expect, it } from "vitest";
import { evaluate } from "./evaluate.js";
import { loadPolicyFromYamlString } from "./loadPolicy.js";
import { PolicyDocument, ProposalContext, TransferLikeDraft } from "./schema.js";

const TRANSFER_YAML = `
name: transfer
schema:
  recipient: { type: address, required: true }
  amount:    { type: number, required: true, min: 0 }
  token:     { type: string, required: true }
  memo:      { type: string, required: false }

approvals:
  base: from_multisig_threshold
  escalations:
    - when: "amount > 5000"
      require_extra: 1
    - when: "recipient not in allowlist"
      require_role: ["treasury-admins"]

recipient_controls:
  allowlist_ref: ops_known_payees
  flag_unknown: true

velocity:
  window: 24h
  max_total_amount: 20000

hold:
  enabled: true
  emoji: moot-hold
  eligibility: members
  quorum_to_hold: 1
  quorum_to_release: 0.51

expiry:
  window: 48h
`;

function policy(): PolicyDocument {
  return loadPolicyFromYamlString(TRANSFER_YAML);
}

function draft(overrides: Partial<TransferLikeDraft> = {}): TransferLikeDraft {
  return {
    recipient: "ADA_WALLET",
    amount: 200,
    token: "USDC",
    memo: "logo work",
    ...overrides,
  };
}

function context(overrides: Partial<ProposalContext> = {}): ProposalContext {
  const now = 1_000_000_000;
  return {
    onChainApprovals: [],
    onChainThreshold: 2,
    timeLockRemainingSeconds: 0,
    createdAtMs: now,
    nowMs: now,
    members: [
      { pubkey: "ALICE", roles: [] },
      { pubkey: "BOB", roles: [] },
      { pubkey: "CARL_ADMIN", roles: ["treasury-admins"] },
    ],
    allowlists: { ops_known_payees: ["ADA_WALLET"] },
    recentTransfers: [],
    holds: [],
    ...overrides,
  };
}

describe("evaluate: on-chain floor semantics", () => {
  it("requiredApprovals is never below the on-chain threshold", () => {
    const result = evaluate(policy(), draft({ amount: 1 }), context({ onChainThreshold: 3 }));
    expect(result.requiredApprovals).toBeGreaterThanOrEqual(3);
  });

  it("is ready once on-chain approvals reach the floor with no escalations triggered", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 200 }),
      context({ onChainApprovals: ["ALICE", "BOB"], onChainThreshold: 2 })
    );
    expect(result.decision).toBe("ready");
    expect(result.requiredApprovals).toBe(2);
  });

  it("reports needs_more_approvals when below the floor", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 200 }),
      context({ onChainApprovals: ["ALICE"], onChainThreshold: 2 })
    );
    expect(result.decision).toBe("needs_more_approvals");
    expect(result.currentApprovals).toBe(1);
  });
});

describe("evaluate: hold", () => {
  it("blocks with decision=held when an active hold exists, even if fully approved", () => {
    const result = evaluate(
      policy(),
      draft(),
      context({
        onChainApprovals: ["ALICE", "BOB"],
        holds: [{ raisedBy: "BOB", raisedAtMs: 1, released: false }],
      })
    );
    expect(result.decision).toBe("held");
  });

  it("does not block on a released hold", () => {
    const result = evaluate(
      policy(),
      draft(),
      context({
        onChainApprovals: ["ALICE", "BOB"],
        holds: [{ raisedBy: "BOB", raisedAtMs: 1, released: true }],
      })
    );
    expect(result.decision).toBe("ready");
  });
});

describe("evaluate: recipient allowlist", () => {
  it("flags unknown recipients but does not block by itself", () => {
    const result = evaluate(
      policy(),
      draft({ recipient: "UNKNOWN_WALLET" }),
      context({ onChainApprovals: ["ALICE", "BOB", "CARL_ADMIN"] })
    );
    expect(result.flags.unknownRecipient).toBe(true);
  });

  it("requires a treasury-admin approver for an unknown recipient (escalation)", () => {
    const result = evaluate(
      policy(),
      draft({ recipient: "UNKNOWN_WALLET" }),
      context({ onChainApprovals: ["ALICE", "BOB"] }) // 2 approvals, floor met, but no admin
    );
    expect(result.decision).toBe("needs_escalation_approval");
  });

  it("is ready for an unknown recipient once an admin has approved", () => {
    const result = evaluate(
      policy(),
      draft({ recipient: "UNKNOWN_WALLET" }),
      context({ onChainApprovals: ["ALICE", "CARL_ADMIN"] })
    );
    expect(result.decision).toBe("ready");
  });
});

describe("evaluate: escalation on amount", () => {
  it("requires one extra approval above the floor for amount > 5000", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 6000 }),
      context({ onChainApprovals: ["ALICE", "BOB"], onChainThreshold: 2 })
    );
    expect(result.requiredApprovals).toBe(3);
    expect(result.decision).toBe("needs_more_approvals");
  });

  it("is ready for amount > 5000 once the extra approval is in", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 6000 }),
      context({ onChainApprovals: ["ALICE", "BOB", "CARL_ADMIN"], onChainThreshold: 2 })
    );
    expect(result.decision).toBe("ready");
  });

  it("does not escalate at exactly the threshold amount", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 5000 }),
      context({ onChainApprovals: ["ALICE", "BOB"], onChainThreshold: 2 })
    );
    expect(result.requiredApprovals).toBe(2);
    expect(result.decision).toBe("ready");
  });
});

describe("evaluate: velocity", () => {
  it("blocks when the window total would exceed the cap", () => {
    const result = evaluate(
      policy(),
      draft({ amount: 5000 }),
      context({
        onChainApprovals: ["ALICE", "BOB"],
        recentTransfers: [
          { amount: 16000, atMs: 1_000_000_000 - 1000 },
        ],
      })
    );
    expect(result.decision).toBe("blocked_guard");
    expect(result.flags.velocityExceeded).toBe(true);
  });

  it("ignores transfers outside the window", () => {
    const dayMs = 24 * 3600 * 1000;
    const result = evaluate(
      policy(),
      draft({ amount: 5000 }),
      context({
        onChainApprovals: ["ALICE", "BOB"],
        recentTransfers: [
          { amount: 16000, atMs: 1_000_000_000 - dayMs - 1 },
        ],
      })
    );
    expect(result.decision).toBe("ready");
  });
});

describe("evaluate: expiry", () => {
  it("expires an unapproved proposal past the expiry window", () => {
    const dayMs = 24 * 3600 * 1000;
    const now = 1_000_000_000;
    const result = evaluate(
      policy(),
      draft(),
      context({
        onChainApprovals: ["ALICE"],
        onChainThreshold: 2,
        createdAtMs: now - 3 * dayMs,
        nowMs: now,
      })
    );
    expect(result.decision).toBe("expired");
  });
});

describe("evaluate: timelock", () => {
  it("is not ready while timelock remains, even if fully approved", () => {
    const result = evaluate(
      policy(),
      draft(),
      context({ onChainApprovals: ["ALICE", "BOB"], timeLockRemainingSeconds: 600 })
    );
    expect(result.decision).toBe("needs_more_approvals");
  });
});

describe("evaluate: unsupported condition syntax", () => {
  it("throws at evaluate time rather than silently matching nothing", () => {
    const bad: PolicyDocument = {
      ...policy(),
      approvals: {
        base: "from_multisig_threshold",
        escalations: [{ when: "token == USDC" }],
      },
    };
    expect(() => evaluate(bad, draft(), context())).toThrow(/unsupported escalation condition/);
  });
});
