/**
 * Types for the policy documents in moot/policies/*.yaml and for the
 * evaluate() input/output. Shared by the Slack app (display) and the
 * MCP server (authoritative pre-execution check) so the two can never
 * diverge on what a proposal requires.
 */

export type FieldType = "address" | "number" | "string";

export interface FieldSchema {
  type: FieldType;
  required: boolean;
  min?: number;
}

export interface EscalationRule {
  /** e.g. "amount > 5000" or "recipient not in allowlist". Parsed by evaluate.ts. */
  when: string;
  requireExtra?: number;
  requireRole?: string[];
}

export interface ApprovalsPolicy {
  /** Always "from_multisig_threshold": the on-chain threshold is the non-negotiable floor. */
  base: "from_multisig_threshold";
  escalations: EscalationRule[];
}

export interface RecipientControlsPolicy {
  allowlistRef?: string;
  flagUnknown: boolean;
}

export interface VelocityPolicy {
  /** e.g. "24h" */
  window: string;
  maxTotalAmount: number;
}

export interface HoldPolicy {
  enabled: boolean;
  emoji: string;
  eligibility: "members" | "admins";
  quorumToHold: number;
  /** Fraction of members (0-1) required to release a hold. */
  quorumToRelease: number;
}

export interface ExpiryPolicy {
  /** e.g. "48h" */
  window: string;
}

export interface PolicyDocument {
  name: string;
  schema: Record<string, FieldSchema>;
  approvals: ApprovalsPolicy;
  recipientControls: RecipientControlsPolicy;
  velocity?: VelocityPolicy;
  hold?: HoldPolicy;
  expiry?: ExpiryPolicy;
}

/** A member's real, wallet-linked identity and the roles they hold in this treasury. */
export interface MemberContext {
  pubkey: string;
  roles: string[];
}

export interface HoldRecord {
  raisedBy: string;
  raisedAtMs: number;
  released: boolean;
}

export interface TransferLikeDraft {
  recipient: string;
  amount: number;
  token: string;
  memo?: string;
}

export interface ProposalContext {
  /** Live on-chain state, read fresh immediately before both display and execution. */
  onChainApprovals: string[];
  onChainThreshold: number;
  timeLockRemainingSeconds: number;
  createdAtMs: number;
  nowMs: number;

  /** Policy inputs that are not on-chain. */
  members: MemberContext[];
  allowlists: Record<string, string[]>;
  /** Amounts (in the proposal's token) already sent in the velocity window, most recent first. */
  recentTransfers: { amount: number; atMs: number }[];
  holds: HoldRecord[];
}

export type EvaluateDecision =
  | "held"
  | "blocked_guard"
  | "needs_escalation_approval"
  | "needs_more_approvals"
  | "expired"
  | "ready";

export interface EvaluateFlags {
  unknownRecipient: boolean;
  velocityExceeded: boolean;
}

export interface EvaluateResult {
  decision: EvaluateDecision;
  reasons: string[];
  requiredApprovals: number;
  currentApprovals: number;
  flags: EvaluateFlags;
}
