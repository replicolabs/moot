import type { Installation, InstallationQuery, InstallationStore } from "@slack/oauth";
import { deleteInstallationRaw, getInstallationRaw, saveInstallationRaw } from "./mcpClient.js";

/**
 * Bolt's InstallationStore interface, backed by mcp-server's SQLite
 * `installations` table via MCP tool calls -- mcp-server stays the only
 * thing that ever touches storage, same as everywhere else in this app.
 */
export const mootInstallationStore: InstallationStore = {
  async storeInstallation(installation: Installation) {
    const teamId = installation.team?.id ?? installation.enterprise?.id;
    if (!teamId) throw new Error("installation has no team or enterprise id");
    await saveInstallationRaw(teamId, installation as unknown as Record<string, unknown>);
  },

  async fetchInstallation(query: InstallationQuery<boolean>) {
    const teamId = query.teamId ?? query.enterpriseId;
    if (!teamId) throw new Error("installation query has no team or enterprise id");
    const installation = await getInstallationRaw(teamId);
    if (!installation) throw new Error(`no installation found for ${teamId}`);
    return installation as unknown as Installation<"v1" | "v2", boolean>;
  },

  async deleteInstallation(query: InstallationQuery<boolean>) {
    const teamId = query.teamId ?? query.enterpriseId;
    if (!teamId) throw new Error("installation query has no team or enterprise id");
    await deleteInstallationRaw(teamId);
  },
};
