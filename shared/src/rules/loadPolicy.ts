import { parse } from "yaml";
import { readFileSync } from "node:fs";
import {
  ApprovalsPolicy,
  EscalationRule,
  FieldSchema,
  HoldPolicy,
  PolicyDocument,
  RecipientControlsPolicy,
  VelocityPolicy,
} from "./schema.js";

/**
 * Parses a policies/*.yaml file into a validated PolicyDocument. This is the
 * only place YAML key names (snake_case, matching moot/CLAUDE.md's schema
 * examples) get translated into the camelCase TypeScript types used by
 * evaluate(). Throws on any missing/malformed required field: a broken policy
 * file must fail loudly at load time, not silently produce a permissive
 * policy at runtime.
 */
export function loadPolicyFromYamlString(source: string): PolicyDocument {
  const raw = parse(source);
  return parsePolicy(raw);
}

export function loadPolicyFromFile(path: string): PolicyDocument {
  return loadPolicyFromYamlString(readFileSync(path, "utf8"));
}

function fail(message: string): never {
  throw new Error(`invalid policy document: ${message}`);
}

function parsePolicy(raw: any): PolicyDocument {
  if (!raw || typeof raw !== "object") fail("root must be a mapping");
  if (typeof raw.name !== "string" || raw.name.length === 0) fail('"name" is required');
  if (!raw.schema || typeof raw.schema !== "object") fail('"schema" is required');
  if (!raw.approvals) fail('"approvals" is required');
  if (!raw.recipient_controls) fail('"recipient_controls" is required');

  return {
    name: raw.name,
    schema: parseFieldSchemas(raw.schema),
    approvals: parseApprovals(raw.approvals),
    recipientControls: parseRecipientControls(raw.recipient_controls),
    velocity: raw.velocity ? parseVelocity(raw.velocity) : undefined,
    hold: raw.hold ? parseHold(raw.hold) : undefined,
    expiry: raw.expiry ? { window: requireString(raw.expiry.window, "expiry.window") } : undefined,
  };
}

function parseFieldSchemas(raw: Record<string, any>): Record<string, FieldSchema> {
  const out: Record<string, FieldSchema> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!value || typeof value !== "object") fail(`schema.${key} must be a mapping`);
    if (!["address", "number", "string"].includes(value.type)) {
      fail(`schema.${key}.type must be one of address|number|string`);
    }
    out[key] = {
      type: value.type,
      required: Boolean(value.required),
      min: typeof value.min === "number" ? value.min : undefined,
    };
  }
  return out;
}

function parseApprovals(raw: any): ApprovalsPolicy {
  if (raw.base !== "from_multisig_threshold") {
    fail('approvals.base must be "from_multisig_threshold": the on-chain threshold is the floor and cannot be overridden by policy');
  }
  const escalations: EscalationRule[] = Array.isArray(raw.escalations)
    ? raw.escalations.map((e: any, i: number) => parseEscalation(e, i))
    : [];
  return { base: "from_multisig_threshold", escalations };
}

function parseEscalation(raw: any, index: number): EscalationRule {
  if (typeof raw.when !== "string") fail(`approvals.escalations[${index}].when must be a string`);
  return {
    when: raw.when,
    requireExtra: typeof raw.require_extra === "number" ? raw.require_extra : undefined,
    requireRole: Array.isArray(raw.require_role) ? raw.require_role.map(String) : undefined,
  };
}

function parseRecipientControls(raw: any): RecipientControlsPolicy {
  return {
    allowlistRef: typeof raw.allowlist_ref === "string" ? raw.allowlist_ref : undefined,
    flagUnknown: Boolean(raw.flag_unknown),
  };
}

function parseVelocity(raw: any): VelocityPolicy {
  return {
    window: requireString(raw.window, "velocity.window"),
    maxTotalAmount: requireNumber(raw.max_total_amount, "velocity.max_total_amount"),
  };
}

function parseHold(raw: any): HoldPolicy {
  return {
    enabled: Boolean(raw.enabled),
    emoji: requireString(raw.emoji, "hold.emoji"),
    eligibility: raw.eligibility === "admins" ? "admins" : "members",
    quorumToHold: requireNumber(raw.quorum_to_hold, "hold.quorum_to_hold"),
    quorumToRelease: requireNumber(raw.quorum_to_release, "hold.quorum_to_release"),
  };
}

function requireString(value: any, field: string): string {
  if (typeof value !== "string") fail(`${field} must be a string`);
  return value;
}

function requireNumber(value: any, field: string): number {
  if (typeof value !== "number") fail(`${field} must be a number`);
  return value;
}
