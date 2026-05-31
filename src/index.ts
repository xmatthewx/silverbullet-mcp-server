/**
 * HTTP entrypoint for the SilverBullet MCP server.
 *
 * Streamable HTTP transport per the MCP spec (2025-03-26). Single endpoint at
 * /mcp handles POST (client -> server requests), GET (server -> client SSE
 * stream), and DELETE (session teardown).
 *
 * Auth has two modes — both produce a Bearer token on inbound requests:
 *
 *   - OAuth 2.1 (Claude.ai web/mobile path). The MCP server itself hosts the
 *     authorization endpoints; access tokens are signed JWTs. See oauth.ts.
 *
 *   - Static MCP_TOKEN (dev / curl path). A long random string accepted as a
 *     Bearer for testing.  Kept alongside OAuth so smoke-testing doesn't
 *     require running the whole auth dance.
 *
 * Outbound calls to SilverBullet use a separate SB_TOKEN. Keeping the
 * inbound and outbound credentials independent lets us rotate either without
 * touching the other.
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
import { mountOAuth, type OAuthHandle } from "./oauth.js";

// ---- env ----------------------------------------------------------------

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return v;
}

const SB_URL              = requireEnv("SB_URL").replace(/\/$/, "");
const SB_TOKEN            = requireEnv("SB_TOKEN");
const MCP_TOKEN           = requireEnv("MCP_TOKEN");
const PUBLIC_URL          = requireEnv("PUBLIC_URL").replace(/\/$/, "");
const OAUTH_CLIENT_ID     = requireEnv("OAUTH_CLIENT_ID");
const OAUTH_CLIENT_SECRET = requireEnv("OAUTH_CLIENT_SECRET");
const OWNER_TOKEN         = requireEnv("OWNER_TOKEN");
const JWT_SIGNING_KEY     = requireEnv("JWT_SIGNING_KEY");
const PORT = parseInt(process.env.PORT ?? "8080", 10);

// 90 days, per the agreed token lifetime.
const TOKEN_LIFETIME_SECONDS = 90 * 24 * 60 * 60;

const sb = new SilverBulletClient(SB_URL, SB_TOKEN);

// ---- express ------------------------------------------------------------

const app = express();
app.use(express.json({ limit: "4mb" }));
// OAuth /authorize POST and /token POST are form-urlencoded per RFC 6749.
app.use(express.urlencoded({ extended: false }));

// Public health check — does not require auth, does not touch SB.
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});

// Deeper readiness — confirms we can reach SilverBullet.
app.get("/readyz", async (_req, res) => {
  const reachable = await sb.ping();
  res.status(reachable ? 200 : 503).json({ ok: reachable });
});

// ---- OAuth ---------------------------------------------------------------

const oauth: OAuthHandle = mountOAuth(app, {
  publicUrl: PUBLIC_URL,
  clientId: OAUTH_CLIENT_ID,
  clientSecret: OAUTH_CLIENT_SECRET,
  ownerToken: OWNER_TOKEN,
  signingKey: new TextEncoder().encode(JWT_SIGNING_KEY),
  tokenLifetimeSeconds: TOKEN_LIFETIME_SECONDS,
});

// ---- auth middleware -----------------------------------------------------

/**
 * Accept either the static MCP_TOKEN (dev bypass) or a valid OAuth-issued
 * JWT. On failure, emit a WWW-Authenticate header pointing Claude at the
 * protected-resource metadata so it can discover the auth flow.
 */
async function requireAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization ?? "";
  const [scheme, token] = header.split(" ");

  if (scheme !== "Bearer" || !token) {
    sendUnauthorized(res);
    return;
  }

  if (token === MCP_TOKEN) {
    next();
    return;
  }

  try {
    await oauth.verifyAccessToken(token);
    next();
  } catch {
    sendUnauthorized(res);
  }
}

function sendUnauthorized(res: Response) {
  res.set(
    "WWW-Authenticate",
    `Bearer realm="MCP", resource_metadata="${PUBLIC_URL}/.well-known/oauth-protected-resource"`,
  );
  res.status(401).json({ error: "unauthorized" });
}

// ---- MCP routes ----------------------------------------------------------

// One MCP session per client; transports are keyed by session id.
const transports = new Map<string, StreamableHTTPServerTransport>();

app.post("/mcp", requireAuth, async (req, res) => {
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

app.get("/mcp", requireAuth, async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  const transport = sessionId ? transports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).json({ error: "unknown session" });
    return;
  }
  await transport.handleRequest(req, res);
});

app.delete("/mcp", requireAuth, async (req, res) => {
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
  console.log(
    `silverbullet-mcp listening on :${PORT}\n` +
      `  upstream: ${SB_URL}\n` +
      `  public:   ${PUBLIC_URL}\n` +
      `  auth:     MCP_TOKEN (dev bypass) + OAuth JWT (clients)`,
  );
});
