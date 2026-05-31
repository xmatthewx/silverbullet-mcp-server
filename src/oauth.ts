/**
 * OAuth 2.1 authorization server — single-user shim.
 *
 * What this does, briefly:
 *   1. Publishes the two well-known metadata documents Claude needs to
 *      discover the auth flow (RFC 9728 + RFC 8414).
 *   2. Serves an HTML login page at /authorize where the owner pastes an
 *      OWNER_TOKEN to approve a connector.
 *   3. Exchanges an authorization code at /token for a signed JWT access
 *      token (HS256, 90-day lifetime by default).
 *
 * What this is NOT:
 *   - Multi-user.  There's exactly one identity: "owner".
 *   - Dynamic Client Registration.  Claude.ai will use the static
 *     client_id / client_secret pasted into its connector UI.
 *   - A persistent token store.  Tokens are stateless JWTs; revoking
 *     everything = rotate JWT_SIGNING_KEY.
 *
 * Spec references kept inline where they matter — this file leans on
 * RFC 6749, RFC 7636 (PKCE), RFC 8414, and the MCP authorization spec.
 */

import { type Application, type Request, type Response } from "express";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface OAuthConfig {
  publicUrl: string;          // canonical, no trailing slash
  clientId: string;
  clientSecret: string;
  ownerToken: string;
  signingKey: Uint8Array;
  tokenLifetimeSeconds: number;
}

export interface OAuthHandle {
  /** Verify a JWT bearer token. Throws if invalid / expired / wrong audience. */
  verifyAccessToken(token: string): Promise<void>;
}

interface PendingAuthCode {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  expiresAt: number;
}

export function mountOAuth(app: Application, cfg: OAuthConfig): OAuthHandle {
  // Short-lived auth codes live in memory only. They expire in 60s and are
  // single-use, so losing them on restart is fine — worst case the user
  // re-clicks the approve button.
  const codes = new Map<string, PendingAuthCode>();

  const reap = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of codes) {
      if (entry.expiresAt < now) codes.delete(code);
    }
  }, 60_000);
  reap.unref();

  // ---- discovery ------------------------------------------------------

  // RFC 9728 — Protected Resource Metadata
  app.get("/.well-known/oauth-protected-resource", (_req, res) => {
    res.json({
      resource: cfg.publicUrl,
      authorization_servers: [cfg.publicUrl],
      scopes_supported: ["mcp"],
      bearer_methods_supported: ["header"],
    });
  });

  // RFC 8414 — Authorization Server Metadata
  app.get("/.well-known/oauth-authorization-server", (_req, res) => {
    res.json({
      issuer: cfg.publicUrl,
      authorization_endpoint: `${cfg.publicUrl}/authorize`,
      token_endpoint: `${cfg.publicUrl}/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: [
        "client_secret_post",
        "client_secret_basic",
      ],
      scopes_supported: ["mcp"],
    });
  });

  // ---- authorize ------------------------------------------------------

  app.get("/authorize", (req, res) => {
    const params = req.query as Record<string, string | undefined>;
    const issues = validateAuthorizeParams(params, cfg.clientId);

    if (issues.length > 0) {
      res.status(400).type("html").send(renderError(issues));
      return;
    }

    res.type("html").send(
      renderLoginPage({
        hidden: pickHidden(params),
      }),
    );
  });

  app.post("/authorize", (req, res) => {
    const body = req.body as Record<string, string | undefined>;
    const issues = validateAuthorizeParams(body, cfg.clientId);

    if (issues.length > 0) {
      res.status(400).type("html").send(renderError(issues));
      return;
    }

    const submitted = body.owner_token ?? "";
    if (!constantTimeEquals(submitted, cfg.ownerToken)) {
      res
        .status(401)
        .type("html")
        .send(
          renderLoginPage({
            hidden: pickHidden(body),
            error: "That owner token didn't match. Try again.",
          }),
        );
      return;
    }

    const code = randomBytes(32).toString("hex");
    codes.set(code, {
      clientId: body.client_id!,
      redirectUri: body.redirect_uri!,
      codeChallenge: body.code_challenge!,
      expiresAt: Date.now() + 60_000,
    });

    const target = new URL(body.redirect_uri!);
    target.searchParams.set("code", code);
    if (body.state) target.searchParams.set("state", body.state);
    res.redirect(target.toString());
  });

  // ---- token ----------------------------------------------------------

  app.post("/token", async (req, res) => {
    const body = req.body as Record<string, string | undefined>;

    if (body.grant_type !== "authorization_code") {
      res.status(400).json({ error: "unsupported_grant_type" });
      return;
    }

    const code = body.code ?? "";
    const stored = codes.get(code);
    codes.delete(code); // single-use regardless of outcome

    if (!stored || stored.expiresAt < Date.now()) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "Authorization code is missing or expired",
      });
      return;
    }

    const creds = extractClientCreds(req);
    if (
      creds.clientId !== cfg.clientId ||
      !constantTimeEquals(creds.clientSecret, cfg.clientSecret)
    ) {
      res.status(401).json({ error: "invalid_client" });
      return;
    }

    // PKCE — required, S256 only
    const verifier = body.code_verifier ?? "";
    const computed = createHash("sha256").update(verifier).digest("base64url");
    if (computed !== stored.codeChallenge) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "PKCE verification failed",
      });
      return;
    }

    if (body.redirect_uri !== stored.redirectUri) {
      res.status(400).json({
        error: "invalid_grant",
        error_description: "redirect_uri does not match the authorization request",
      });
      return;
    }

    const accessToken = await new SignJWT({ scope: "mcp" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer(cfg.publicUrl)
      .setAudience(cfg.publicUrl)
      .setSubject("owner")
      .setIssuedAt()
      .setExpirationTime(`${cfg.tokenLifetimeSeconds}s`)
      .sign(cfg.signingKey);

    res.json({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: cfg.tokenLifetimeSeconds,
      scope: "mcp",
    });
  });

  // ---- handle ---------------------------------------------------------

  return {
    async verifyAccessToken(token: string): Promise<void> {
      await jwtVerify(token, cfg.signingKey, {
        issuer: cfg.publicUrl,
        audience: cfg.publicUrl,
      });
    },
  };
}

// ----- helpers -----------------------------------------------------------

function validateAuthorizeParams(
  p: Record<string, string | undefined>,
  expectedClientId: string,
): string[] {
  const issues: string[] = [];
  if (p.response_type !== "code") {
    issues.push(`response_type must be "code"`);
  }
  if (p.client_id !== expectedClientId) {
    issues.push("Unknown client_id");
  }
  if (!p.redirect_uri) {
    issues.push("redirect_uri is required");
  }
  if (p.code_challenge_method !== "S256") {
    issues.push("PKCE S256 is required");
  }
  if (!p.code_challenge) {
    issues.push("code_challenge is required");
  }
  return issues;
}

function pickHidden(
  p: Record<string, string | undefined>,
): Record<string, string> {
  return {
    response_type: p.response_type ?? "code",
    client_id: p.client_id ?? "",
    redirect_uri: p.redirect_uri ?? "",
    state: p.state ?? "",
    scope: p.scope ?? "mcp",
    code_challenge: p.code_challenge ?? "",
    code_challenge_method: p.code_challenge_method ?? "S256",
  };
}

function extractClientCreds(req: Request): {
  clientId: string;
  clientSecret: string;
} {
  const header = req.headers.authorization ?? "";
  if (header.startsWith("Basic ")) {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const idx = decoded.indexOf(":");
    if (idx > 0) {
      return {
        clientId: decoded.slice(0, idx),
        clientSecret: decoded.slice(idx + 1),
      };
    }
  }
  const body = (req.body ?? {}) as Record<string, string | undefined>;
  return {
    clientId: body.client_id ?? "",
    clientSecret: body.client_secret ?? "",
  };
}

function constantTimeEquals(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) {
    // Compare against itself just to keep timing similar; result is always false.
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

// ----- HTML --------------------------------------------------------------

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return c;
    }
  });
}

function renderLoginPage(opts: {
  hidden: Record<string, string>;
  error?: string;
}): string {
  const hiddenInputs = Object.entries(opts.hidden)
    .map(
      ([k, v]) =>
        `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`,
    )
    .join("\n      ");

  const errorBanner = opts.error
    ? `<div class="error">${esc(opts.error)}</div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize SilverBullet MCP</title>
  <style>
    :root { color-scheme: light dark; }
    body {
      font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      max-width: 28rem; margin: 4rem auto; padding: 0 1rem;
      color: #1a1a1a; background: #fafafa;
    }
    h1 { font-size: 1.15rem; margin-bottom: 0.25rem; }
    .sub { color: #666; font-size: 0.9rem; line-height: 1.5; margin: 0; }
    form {
      margin-top: 1.5rem; display: flex; flex-direction: column; gap: 0.75rem;
    }
    label { font-size: 0.85rem; color: #444; }
    input[type="password"] {
      padding: 0.65rem 0.75rem; border: 1px solid #ccc; border-radius: 6px;
      font-size: 1rem; background: white; color: inherit;
    }
    button {
      padding: 0.65rem 1rem; background: #1a1a1a; color: white;
      border: 0; border-radius: 6px; font-size: 0.95rem; cursor: pointer;
    }
    button:hover { background: #000; }
    .error {
      padding: 0.6rem 0.75rem; background: #fee2e2; border: 1px solid #fecaca;
      color: #991b1b; border-radius: 6px; font-size: 0.9rem;
    }
    @media (prefers-color-scheme: dark) {
      body { background: #111; color: #eee; }
      .sub { color: #999; }
      label { color: #bbb; }
      input[type="password"] { background: #1a1a1a; border-color: #333; color: #eee; }
      button { background: #eee; color: #111; }
      button:hover { background: #fff; }
      .error { background: #3f1d1d; border-color: #5a2727; color: #fca5a5; }
    }
  </style>
</head>
<body>
  <h1>Authorize SilverBullet MCP</h1>
  <p class="sub">A client is requesting access to your SilverBullet notes through this MCP server. Enter your owner token to approve.</p>
  ${errorBanner}
  <form method="post" action="/authorize">
      ${hiddenInputs}
    <label for="owner_token">Owner token</label>
    <input id="owner_token" name="owner_token" type="password" autocomplete="off" autofocus required>
    <button type="submit">Approve</button>
  </form>
</body>
</html>`;
}

function renderError(issues: string[]): string {
  const items = issues.map((i) => `<li>${esc(i)}</li>`).join("\n      ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Authorization request rejected</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.15rem; }
    ul { color: #991b1b; }
  </style>
</head>
<body>
  <h1>Authorization request rejected</h1>
  <p>The request to /authorize was missing required parameters or had unexpected values:</p>
  <ul>
      ${items}
  </ul>
</body>
</html>`;
}
