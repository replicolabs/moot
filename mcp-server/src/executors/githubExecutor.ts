import jwt from "jsonwebtoken";
import { Octokit } from "@octokit/rest";
import { getGithubAppConfig } from "../config.js";

/**
 * GitHub App auth: sign a short-lived JWT with the App's private key, then
 * exchange it for an installation access token. The installation token (not
 * the JWT) is what authorizes REST calls against the installed repo. Moot's
 * server never holds a long-lived GitHub credential -- installation tokens
 * expire in ~1 hour and are re-minted per call.
 */
function buildAppJwt(): string {
  const { appId, privateKey } = getGithubAppConfig();
  const now = Math.floor(Date.now() / 1000);
  return jwt.sign(
    {
      iat: now - 60, // allow for clock drift
      exp: now + 9 * 60, // GitHub caps this at 10 minutes
      iss: appId,
    },
    privateKey,
    { algorithm: "RS256" }
  );
}

async function getInstallationToken(installationId: string): Promise<string> {
  const appOctokit = new Octokit({ auth: buildAppJwt() });
  const { data } = await appOctokit.request("POST /app/installations/{installation_id}/access_tokens", {
    installation_id: Number(installationId),
  });
  return data.token;
}

export interface MergeResult {
  merged: boolean;
  sha?: string;
  message: string;
}

/**
 * Merges a PR once quorum has been reached on-chain. Called only after
 * execute_proposal's on-chain check has already confirmed the real approval
 * threshold. `installationId` is resolved per (team, owner) by the caller
 * from store.ts's github_installations table -- one GitHub App, many
 * per-tenant installations.
 */
export async function mergePullRequest(
  installationId: string,
  owner: string,
  repo: string,
  pullNumber: number
): Promise<MergeResult> {
  const token = await getInstallationToken(installationId);
  const octokit = new Octokit({ auth: token });

  const { data } = await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: "squash",
  });

  return { merged: data.merged, sha: data.sha, message: data.message };
}
