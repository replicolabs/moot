# Moot

Moot is a Slack-native treasury and execution platform for stablecoins and crypto on Solana. It lets a team propose payments, holds, and escrows in plain English from inside Slack, while every dollar that actually moves is gated by a Squads v4 multisig on-chain. Moot can propose and crank execution, but it never holds enough permission to approve anything by itself. Member wallets have to sign, and the Solana program enforces that, not application code.

## Core guarantee

This is the one property everything else in this repo is built around: no single person, and not even Moot itself, can move funds alone.

- Every treasury is a Squads v4 multisig on Solana devnet or mainnet
- Moot's own signing key is added to each multisig with `Initiate` and `Execute` permissions only, never `Vote`. It can draft a proposal and crank its execution once threshold is reached, but it cannot approve one.
- Approvals are wallet signatures, produced in a browser by the member's own wallet (Phantom or Solflare), never by Moot.
- Server-side policy checks (thresholds, holds, timelocks, escalations, expiry) are re-verified immediately before execution against live on-chain state, not cached data.

## What it does

- **Payments.** Propose a transfer from a treasury, get an approval card in Slack, execute once threshold is met.
- **Treasuries.** Create a multisig treasury with a name, member list, approval threshold, optional timelock, and allowed tokens.
- **Escrow.** A payer/payee/arbiter arrangement with a fixed amount and milestone description. The payee can request release but can never approve their own payment.
- **Holds.** Any member can pause a proposal before it executes, even if fully approved. A treasury admin releases it.
- **GitHub PR merges.** A governance-only multisig (no funds involved) that gates merging a specific pull request behind the same quorum-and-approval engine used for payments. 
- **Natural language.** Almost everything above can be done by just mentioning `@moot` and describing what you want in plain English, not just via the `/moot` slash command. The extraction model never creates anything on-chain itself. It only produces a typed draft or a clarifying question, and every action that moves funds or changes membership still goes through the same confirmation-card or draft-then-approve path as its slash-command equivalent.
- **Approve and hold via buttons or reactions.** These stay button/reaction driven rather than natural language, since a click on a specific card is the only unambiguous way to say which pending proposal you mean when more than one might be open.

## Architecture

Moot is an npm workspaces monorepo with two runtime services plus a few supporting pieces.

```
moot/
  shared/          Pure policy engine (types, YAML policy loader, evaluate()), no I/O
  mcp-server/       The only component that touches Solana, the database, or GitHub
  slack-app/        Bolt app, Socket Mode, natural language router, zero direct storage access
  signing-webview/  Static HTML/JS served by mcp-server, where members connect a wallet
  policies/         YAML policy documents (transfer, escrow, merge_pr)
  config/           Token mint configuration per Solana cluster
  landing/          Public marketing site (static HTML/CSS/JS, deployed separately)
  deploy/           Caddy config and systemd units for the production VM
```

### Why two services

**`slack-app`** is a Bolt app running in Socket Mode. It never touches Solana, the database, or GitHub directly. Every action it takes is a call to `mcp-server` over MCP (Model Context Protocol), so the Slack process itself holds no sensitive credentials beyond its own Slack tokens.

**`mcp-server`** is the sole component that signs Solana transactions, reads or writes the database, and calls the GitHub API. It exposes:
- `/mcp`, a Streamable HTTP MCP endpoint, bound to `127.0.0.1` only and gated by a shared bearer token (`MCP_INTERNAL_TOKEN`). Only `slack-app`, running on the same machine, ever calls it.
- `/webview`, the static wallet-linking and approval pages.
- `/api/*`, the REST routes those pages call. Every sensitive route requires a short-lived signed capability token (see Security below), not just a bare treasury or proposal ID in the URL.
- `/github/setup`, the callback GitHub redirects to once a workspace connects Moot's GitHub App to a repo owner.
- `/health`.

### Data model

State is stored in SQLite (`mcp-server/data/moot.sqlite3`, via `better-sqlite3`, gitignored). Every table carries a `team_id` column, including ones keyed primarily by an on-chain address, so a workspace's data is isolated at the query level, not just by convention. This matters because Moot is multi-tenant: any Slack workspace can install it via a normal OAuth "Add to Slack" flow and get its own fully isolated set of treasuries, wallet links, and proposals, all served by the same running process.

### Multi-tenant OAuth

`slack-app` uses Bolt's `installationStore` pattern rather than a single fixed bot token. Each workspace's installation (bot token, team ID, and so on) is stored in `mcp-server`'s SQLite database, reached through three MCP tools (`save_installation`, `get_installation`, `delete_installation`) rather than by `slack-app` touching storage directly, keeping the same "only mcp-server touches storage" rule intact even for the OAuth layer itself. `SLACK_SIGNING_SECRET` and the Socket Mode `SLACK_APP_TOKEN` stay global to the app (one Slack app, many installations); only the bot token becomes per-workspace.

### GitHub App

One GitHub App (`moot-merge-executor`) is shared across every tenant. A workspace connects it to a specific repo owner or org with `/moot github connect <owner>`, which sends them to GitHub's install flow; GitHub's own Setup URL callback reports back which `installation_id` resulted, recorded against that workspace's `team_id` and the owner. `mcp-server` resolves the right installation per `(team_id, owner)` at merge time, so many workspaces can each gate PRs on their own repos through the one App.

## Security notes

- **Never trust a client-supplied treasury or proposal ID on its own.** The webview's `/api/*` routes require a short-lived HMAC-signed token (`mcp-server/src/webviewAuth.ts`), minted server-side and scoped to exactly the workspace, user, treasury, proposal, and purpose (linking a wallet, or approving a specific proposal) it was created for. Before this existed, a bare treasury and proposal ID in a URL was enough to view another workspace's proposal details. It still could never forge an approval, since that always requires a real wallet signature, but it was a real information leak.
- **`/mcp` is not on the public internet.** It is bound to localhost and requires a bearer token identical on both services. The only thing reachable from outside the VM is the webview, its `/api/*` routes, the GitHub setup callback, and health.
- **Never let a developer guess a policy check.** Approval counts, thresholds, holds, and timelocks are all re-read from live on-chain state immediately before `execute_proposal` runs, not from a cache populated earlier in the flow.
- Secrets live in `.env` files (gitignored). See `mcp-server/.env.example` and `slack-app/.env.example` for the full list of what each service needs, with comments on where each value comes from.

## Local development

Requires Node 22 or newer (the workspaces are ESM, run via `tsx`, no separate build step in dev).

```bash
git clone https://github.com/replicolabs/moot
cd moot
npm install
```

Copy `mcp-server/.env.example` to `mcp-server/.env` and `slack-app/.env.example` to `slack-app/.env`, then fill in real values. `MCP_INTERNAL_TOKEN` and `WEBVIEW_TOKEN_SECRET` can be generated with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`MCP_INTERNAL_TOKEN` must be identical in both `.env` files. `SLACK_CLIENT_ID` and `SLACK_CLIENT_SECRET` come from your Slack app's Basic Information page; `SLACK_STATE_SECRET` is any random string, generated the same way as the two tokens above.

Run each service in its own terminal:

```bash
cd mcp-server && npm run dev
cd slack-app && npm run dev
```

`mcp-server` listens on `8787` (public: webview, API, GitHub callback, health) and `8788` (internal: `/mcp`, localhost only). `slack-app` connects to Slack over Socket Mode and also runs a small internal server on `3000` (configurable via `SLACK_OAUTH_PORT`) for the OAuth install and redirect routes, which Bolt manages automatically once `clientId`/`clientSecret` are set.

To install your own dev copy of the Slack app into a workspace during local development, Slack does permit `http://localhost` as a registered OAuth redirect URL for exactly this purpose. Visit `http://localhost:3000/slack/install` once the redirect URL is added in your Slack app's OAuth & Permissions settings.

## Deployment

The `deploy/` directory has everything needed for a small VM (a `t3.micro` on AWS or an Always Free instance on Oracle Cloud both work fine, this is a lightweight Node process, not a compute-heavy one):

- `Caddyfile`, a reverse proxy config that gets and renews a free Let's Encrypt certificate automatically and routes `/slack/*` to Bolt's internal OAuth server and everything else to `mcp-server`'s public listener.
- `moot-mcp-server.service` and `moot-slack-app.service`, systemd units for restart-on-crash and start-on-boot.
- `setup-server.sh`, installs Node 22, Caddy, runs `npm install` at the repo root, and wires up the Caddyfile and both systemd units.

The general shape: provision a small VM, point a subdomain's DNS A record at its IP, copy the repo over (`rsync`, excluding `node_modules`, `.git`, `data`, and `.env`), copy real `.env` files over separately, run `setup-server.sh`, then update the Slack app's OAuth redirect URL and the GitHub App's Setup URL to the real domain, and turn on Slack's "Manage Distribution" so any workspace can install it.

If the VM is small (1GB RAM or less), add a swapfile up front. A memory-tight instance under load can otherwise become unresponsive in a way that looks like a network problem but is not:

```bash
sudo fallocate -l 1G /swapfile
sudo chmod 600 /swapfile
sudo mkswap /swapfile
sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

The landing page (`landing/`) is a separate, fully static site (no build step, fonts and images either self-hosted or embedded) and deploys independently to any static host, such as Cloudflare Pages or Vercel.

## Usage

Everything below works both as a `/moot` slash command and as plain English to `@moot`. Ask `@moot what can you do` for the equivalent in-Slack summary at any time.

- `/moot link-wallet`, or "link my wallet"
- `/moot treasury new <name> <threshold> @member1 @member2 ... [tokens=USDC] [timelock=<seconds>]`, or "set up a treasury called Ops needing 2 approvals from me, alice and bob"
- `/moot propose <treasury> <amount> <token> @recipient [memo]`, or "pay Ada 200 USDC from Ops for the logo work"
- `/moot rules <treasury>`, or "what are the rules for Ops"
- `/moot check <treasury> <amount> <token> @recipient`, or "what would it take to pay Ada 200 USDC from Ops"
- `/moot escrow new <name> <amount> <token> @payee arbiter @arbiter milestone <description>`, or "escrow 500 USDC to alice with bob as arbiter, released when the design is approved"
- `/moot escrow release <name>` / `/moot escrow refund <name>`, or "release the BuildCoLogo escrow"
- `/moot merge-pr new <name> <threshold> @reviewer1 ... repo <owner/repo> pr <number>`, or "gate merging acme/webapp PR 42 behind 2 approvals from alice and bob"
- `/moot merge-pr submit <name>`, or "submit the merge proposal for BigRefactor"
- `/moot github connect <owner>`, or "connect github to acme"

Approving or holding a specific pending proposal is done with the buttons or reactions on its card in Slack, since that is the only unambiguous way to say which one you mean.

## License

MIT. See [LICENSE](LICENSE).
