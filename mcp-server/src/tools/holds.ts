import { getHolds, getTreasury, raiseHold, releaseHolds } from "../store.js";

/** Not one of the 8 primary tools in moot/CLAUDE.md, but holds are app state
 * (not on-chain), and the architecture keeps all state behind the MCP server
 * so the Slack process never touches storage directly. */
export function raiseHoldTool(treasuryId: string, transactionIndex: string, raisedBySlackId: string) {
  const treasury = getTreasury(treasuryId);
  if (!treasury) throw new Error(`no treasury found for id ${treasuryId}`);
  raiseHold({ treasuryId, teamId: treasury.teamId, transactionIndex, raisedBySlackId, raisedAtMs: Date.now(), released: false });
  return { held: true };
}

export function releaseHoldTool(treasuryId: string, transactionIndex: string) {
  releaseHolds(treasuryId, transactionIndex);
  return { released: true };
}

export function getHoldsTool(treasuryId: string, transactionIndex: string) {
  return getHolds(treasuryId, transactionIndex);
}
