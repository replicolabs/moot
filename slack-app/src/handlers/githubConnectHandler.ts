import { createGithubConnectLink } from "../mcpClient.js";

export async function handleGithubConnect(teamId: string, owner: string): Promise<string> {
  if (!owner) return "Usage: `/moot github connect <owner>` (a GitHub username or org, e.g. `acme`).";

  try {
    const { url } = await createGithubConnectLink(teamId, owner);
    return (
      `Click to connect Moot's GitHub App to *${owner}*:\n${url}\n\n` +
      `Once installed, this workspace's \`/moot merge-pr\` commands can gate merges on any repo under ${owner}.`
    );
  } catch (err) {
    return `Couldn't build the connect link: ${err instanceof Error ? err.message : String(err)}`;
  }
}
