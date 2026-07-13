import "dotenv/config";
import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync } from "node:fs";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildMootMcpServer } from "./mcpServer.js";
import { handleWebviewApi } from "./httpApi.js";
import { recordGithubInstallation } from "./tools/githubConnect.js";

const PUBLIC_PORT = Number(process.env.MCP_SERVER_PORT ?? 8787);
const INTERNAL_PORT = Number(process.env.MCP_INTERNAL_PORT ?? 8788);
const INTERNAL_TOKEN = process.env.MCP_INTERNAL_TOKEN;
const __dirname = dirname(fileURLToPath(import.meta.url));
const WEBVIEW_DIR = join(__dirname, "..", "..", "signing-webview", "public");

if (!INTERNAL_TOKEN) {
  throw new Error("MCP_INTERNAL_TOKEN must be set (shared secret between slack-app and mcp-server).");
}

async function handleMcpRequest(req: IncomingMessage, res: ServerResponse) {
  // Stateless: a fresh McpServer + transport per request. Simple and correct
  // for a tool-call-shaped server with no long-lived client sessions.
  const server = buildMootMcpServer();
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    transport.close();
    server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res);
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function serveStatic(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (!url.pathname.startsWith("/webview")) return false;

  const relative = url.pathname === "/webview" || url.pathname === "/webview/"
    ? "index.html"
    : url.pathname.replace(/^\/webview\//, "");
  const filePath = normalize(join(WEBVIEW_DIR, relative));

  if (!filePath.startsWith(WEBVIEW_DIR) || !existsSync(filePath) || !statSync(filePath).isFile()) {
    res.writeHead(404);
    res.end("not found");
    return true;
  }

  const ext = extname(filePath);
  res.writeHead(200, { "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream" });
  createReadStream(filePath).pipe(res);
  return true;
}

function handleGithubSetup(req: IncomingMessage, res: ServerResponse): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/github/setup") return false;

  const installationId = url.searchParams.get("installation_id") ?? "";
  const state = url.searchParams.get("state") ?? "";

  try {
    const { owner } = recordGithubInstallation(state, installationId);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;">
      <h2>Connected</h2>
      <p>Moot can now merge PRs for <b>${owner}</b>. You can close this tab and go back to Slack.</p>
    </body></html>`);
  } catch (err) {
    res.writeHead(400, { "content-type": "text/html; charset=utf-8" });
    res.end(`<!doctype html><html><body style="font-family:sans-serif;padding:40px;">
      <h2>Couldn't connect</h2>
      <p>${err instanceof Error ? err.message : String(err)}</p>
    </body></html>`);
  }
  return true;
}

// ---- Internal listener: /mcp only, localhost-bound, bearer-token gated. ----
// slack-app (co-located on the same host) is the only intended caller --
// this never needs to be reachable from the public internet.
const internalServer = createServer((req, res) => {
  if (req.url !== "/mcp") {
    res.writeHead(404);
    res.end();
    return;
  }

  const auth = req.headers.authorization ?? "";
  if (auth !== `Bearer ${INTERNAL_TOKEN}`) {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return;
  }

  handleMcpRequest(req, res).catch((err) => {
    console.error("MCP request failed:", err);
    if (!res.headersSent) {
      res.writeHead(500, { "content-type": "application/json" });
    }
    res.end(JSON.stringify({ error: "internal error" }));
  });
});

// ---- Public listener: webview, its API, GitHub App setup callback, health. ----
const publicServer = createServer((req, res) => {
  if (req.url?.startsWith("/api/")) {
    handleWebviewApi(req, res).then((handled) => {
      if (!handled) {
        res.writeHead(404);
        res.end();
      }
    });
    return;
  }

  if (handleGithubSetup(req, res)) return;
  if (serveStatic(req, res)) return;

  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  res.writeHead(404);
  res.end();
});

internalServer.listen(INTERNAL_PORT, "127.0.0.1", () => {
  console.log(`Moot MCP internal endpoint listening on http://127.0.0.1:${INTERNAL_PORT}/mcp (localhost only)`);
});

publicServer.listen(PUBLIC_PORT, () => {
  console.log(`Moot public endpoints listening on http://localhost:${PUBLIC_PORT}`);
  console.log(`Signing web view at http://localhost:${PUBLIC_PORT}/webview`);
});
