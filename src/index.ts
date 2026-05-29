/**
 * HTTP entrypoint for the SilverBullet MCP server.
 *
 * Streamable HTTP transport per the MCP spec (2025-03-26). Single endpoint at
 * /mcp handles POST (client -> server requests), GET (server -> client SSE
 * stream), and DELETE (session teardown).
 *
 * Inbound auth is a static Bearer token (MCP_TOKEN). Outbound calls to
 * SilverBullet use a separate token (SB_TOKEN). Keeping them distinct lets us
 * rotate one without touching the other.
 */

// Load .env in dev. In production Fly injects env vars directly and there is
// no .env file, so this becomes a harmless no-op.
import "dotenv/config";

import express, { type Request, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { SilverBulletClient } from "./sb.js";
import { buildMcpServer } from "./mcp.js";

// ---- env ----------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const SB_URL = requireEnv("SB_URL").replace(/\/$/, "");
const SB_TOKEN = requireEnv("SB_TOKEN");
const MCP_TOKEN = requireEnv("MCP_TOKEN");
const PORT = parseInt(process.env.PORT ?? "8080", 10);

const sb = new SilverBulletClient(SB_URL, SB_TOKEN);

// ---- express ------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));

// Public health check — does not require auth, does not touch SB.
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Deeper readiness — confirms we can reach SilverBullet.
app.get("/readyz", async (_req, res) => {
  const reachable = await sb.ping();
  res.status(reachable ? 200 : 503).json({ ok: reachable });
});

// Bearer auth for the MCP surface only.
function requireBearer(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");
  if (scheme !== "Bearer" || token !== MCP_TOKEN) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

// One MCP session per client; transports are keyed by session id.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", requireBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  let transport = sessionId ? transports.get(sessionId) : undefined;

  if (!transport) {
    if (!isInitializeRequest(req.body)) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "Missing session id or initialize request" },
        id: null,
      });
      return;
    }

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        transports.set(id, transport!);
      },
    });

    transport.onclose = () => {
      if (transport!.sessionId) transports.delete(transport!.sessionId);
    };

    const server = buildMcpServer(sb);
    await server.connect(transport);
  }

  await transport.handleRequest(req, res, req.body);
});

app.get("/mcp", requireBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "unknown session" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireBearer, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(204).end();
    return;
  }
  await transport.close();
  transports.delete(sessionId!);
  res.status(204).end();
});

app.listen(PORT, () => {
  console.log(`silverbullet-mcp listening on :${PORT}, talking to ${SB_URL}`);
});
