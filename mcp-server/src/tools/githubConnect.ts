import { saveGithubInstallation } from "../store.js";

const GITHUB_APP_SLUG = "moot-merge-executor";

/**
 * One GitHub App, many installations -- each Slack workspace installs the
 * same App into whichever GitHub account/org it wants to gate PR merges for,
 * and GitHub hands back a fresh installation_id per install. `state` carries
 * (teamId, owner) through GitHub's redirect so the App's Setup URL callback
 * (see index.ts's /github/setup route) knows which tenant + repo owner this
 * install belongs to.
 */
export function buildGithubConnectUrl(teamId: string, owner: string): string {
  const state = Buffer.from(JSON.stringify({ teamId, owner })).toString("base64url");
  return `https://github.com/apps/${GITHUB_APP_SLUG}/installations/new?state=${state}`;
}

export interface GithubSetupResult {
  teamId: string;
  owner: string;
}

/** Called by the GitHub App's Setup URL callback once the install completes. */
export function recordGithubInstallation(stateParam: string, installationId: string): GithubSetupResult {
  let parsed: { teamId?: string; owner?: string };
  try {
    parsed = JSON.parse(Buffer.from(stateParam, "base64url").toString("utf8"));
  } catch {
    throw new Error("invalid or expired connect link, run /moot github connect again");
  }
  if (!parsed.teamId || !parsed.owner) {
    throw new Error("invalid or expired connect link, run /moot github connect again");
  }

  saveGithubInstallation({
    teamId: parsed.teamId,
    owner: parsed.owner,
    installationId,
    connectedAtMs: Date.now(),
  });

  return { teamId: parsed.teamId, owner: parsed.owner };
}
