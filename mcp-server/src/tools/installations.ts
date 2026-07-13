import { deleteInstallationRow, getInstallationRow, saveInstallationRow } from "../store.js";

/**
 * Raw storage for Bolt's per-workspace OAuth installations (bot token, team
 * id, etc). Exposed as MCP tools -- not read/written directly by slack-app --
 * so mcp-server stays the one place that ever touches storage, same as every
 * other piece of Moot's state.
 */

export function saveInstallation(teamId: string, installation: Record<string, unknown>): void {
  const bot = installation.bot as { token?: string; id?: string; userId?: string } | undefined;
  saveInstallationRow(
    teamId,
    JSON.stringify(installation),
    bot?.token ?? null,
    bot?.id ?? null,
    bot?.userId ?? null
  );
}

export function getInstallation(teamId: string): Record<string, unknown> | null {
  const row = getInstallationRow(teamId);
  return row ? JSON.parse(row.data) : null;
}

export function deleteInstallation(teamId: string): void {
  deleteInstallationRow(teamId);
}
