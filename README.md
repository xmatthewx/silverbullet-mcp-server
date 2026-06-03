# silverbullet-mcp

A tiny MCP server that exposes a [SilverBullet](https://silverbullet.md) space
to Claude over HTTP. v0.1 shipped read tools; v0.2 added a full write surface;
v0.3 made overwrites collision-safe via `lastModified` envelopes; v0.4 surfaces
every failure mode as a structured, visible error payload.

## Architecture

```
Claude (web / mobile)
        │
        │  Streamable HTTP, Bearer <JWT>  (OAuth)
        │  -or- Bearer MCP_TOKEN          (dev / curl)
        ▼
[ silverbullet-mcp on Fly.io ]   <-- this repo
        │   ↑  /authorize, /token, /.well-known/...
        │   │  Owner approves via OWNER_TOKEN in browser
        │
        │  GET /.fs, GET /.fs/<path>, Bearer SB_TOKEN
        ▼
[ SilverBullet on Pikapod ]
   notes.example.com
```

Three credentials, each scoped tightly:

- **`SB_TOKEN`** — this server presents to SilverBullet upstream.
- **OAuth (`OAUTH_CLIENT_ID` / `OAUTH_CLIENT_SECRET` / `OWNER_TOKEN` / `JWT_SIGNING_KEY`)** — primary path for Claude clients. Claude.ai's web UI requires this flow.
- **`MCP_TOKEN`** — static Bearer kept alongside OAuth as a dev/curl bypass so the server stays smoke-testable without running the full auth dance.

Any of them can rotate without touching the others.

## Tools

**Read tools**

| Tool           | Inputs                             | Returns                                              |
| -------------- | ---------------------------------- | ---------------------------------------------------- |
| `list_pages`   | `include_trash?` (bool, def false) | Every `.md` page in the space, sorted by recency. Each entry carries `{page, path, lastModified}`. |
| `read_page`    | `page` (string)                    | Two content blocks: `[0]` JSON envelope `{path, lastModified}`, `[1]` raw markdown body. The `lastModified` is the version marker for a follow-up `write_page`. |
| `search_pages` | `query`, `limit?`, `include_trash?`| Top substring matches with snippets and match counts. |

`include_trash: true` surfaces pages that have been soft-deleted (under `_trash/`).

Search is naive (fan-out fetch + substring). Fine for personal note volumes;
revisit if latency bites.

**Write tools**

| Tool              | Inputs                                        | Behavior                                                         |
| ----------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| `create_page`     | `page`, `body`                                | Creates a new page; errors if it already exists. Returns `{path, lastModified}`. |
| `write_page`      | `page`, `body`, `expected_last_modified`      | Overwrites an existing page. **Collision-safe**: rejected with a conflict error if the server's current `lastModified` differs from `expected_last_modified`. Refuses to create new pages (use `create_page`). Returns `{path, lastModified}`. |
| `append_to_page`  | `page`, `content`                             | Appends content at the end, separated by a blank line. No `lastModified` returned (caller has not seen the body and isn't write-ready). |
| `prepend_to_page` | `page`, `content`, `position?`                | Inserts at top or after YAML frontmatter (default). Server-side concat — the existing body never passes through the model. No `lastModified` returned. |
| `delete_page`     | `page`                                        | Soft-deletes to `_trash/YYYY-MM/<original-path>`.                |

**Collision-safe overwrites.** `write_page` enforces a version handshake. Workflow: `read_page` returns the current `lastModified` alongside the body; pass that value back as `expected_last_modified` on the subsequent `write_page`. If the page changed in between, the write is rejected with a conflict error and the caller should re-read to reconcile. `create_page` returns a fresh `lastModified` so a caller is left write-ready immediately after creation. `append_to_page` and `prepend_to_page` deliberately omit `lastModified` from their responses — they merge server-side without the caller seeing the full body, so the caller is not in a position to follow up with a guarded `write_page`. There is a narrow TOCTOU window inside `write_page` between the conflict check and the PUT — acceptable for a single-user space; closing it would require an `If-Unmodified-Since` (or equivalent) on the SilverBullet side.

**Version marker hygiene.** The ms-precision `lastModified` is the optimistic-concurrency token for `write_page`. By contract it is only obtainable from `read_page`, `create_page`, or `write_page` — the three tools that have surfaced the full page body. To stop the same value from leaking through other surfaces, `list_pages` and `search_pages` round each entry's `lastModified` to second precision (still useful for recency display, useless as a write key — the rounded value almost never matches the server's true ms value). The `conflict` error response includes `expectedLastModified` (echoing what the caller sent) and a generic "page has been modified" message, but does **not** include the server's current `lastModified` — otherwise a caller could retry the write using the leaked value without re-reading the body.

**Error shape.** Every tool failure comes back as a regular content block carrying a JSON payload with `{error, status, message, ..., remediation}`. The `error` field is a short machine-readable code (`conflict`, `not_found`, `already_exists`, `too_large`, `forbidden_path`, `invalid_path`, `upstream`, `internal`); `status` mirrors the closest HTTP analog (e.g. 409 for `conflict`, 413 for `too_large`); `remediation` gives the agent a concrete next step. The handler stack does **not** set `isError: true` on the MCP response — the Claude.ai connector has been observed to swallow the content payload when that flag is set, leaving the model with only "Error occurred during tool execution." Returning the structured payload as ordinary content keeps the remediation visible. Every error also emits an `[ERROR] tool=... code=... page=...` audit line to stderr (Fly logs).

**Write permission model.** Writes are gated by Claude.ai's per-tool permission UI — set each write tool to Ask for confirmation before every call. No server-side flag or separate OAuth scope; the same connector and credentials serve both read and write tools. On every write the server enforces: a 256 KB body cap, path validation (no `..`, empty segments, double `.md`), and `X-Permission: rw` on every PUT (omitting it would make SilverBullet silently mark the page read-only in its UI). Soft-delete moves pages to `_trash/YYYY-MM/`; collisions in the same month get a `-<unix-ms>` filename suffix. Trash is hidden from list and search by default; `include_trash: true` reveals it. All write operations emit `[WRITE]` audit lines to stderr (visible in Fly logs); `write_page` audit lines include both `expected_last_modified` and the resulting `last_modified`.

## Environment

See `.env.example`. All of the below are required at boot.

| Variable               | What it is                                                                 |
| ---------------------- | -------------------------------------------------------------------------- |
| `SB_URL`               | Base URL of the SilverBullet instance (no trailing slash).                 |
| `SB_TOKEN`             | The `SB_AUTH_TOKEN` configured on the SilverBullet side.                   |
| `MCP_TOKEN`            | Static Bearer accepted as a dev/curl bypass. Generate with `openssl rand`. |
| `PUBLIC_URL`           | Canonical URL of this MCP server. Goes into OAuth metadata documents.      |
| `OAUTH_CLIENT_ID`      | Opaque string. Paste into Claude.ai connector "Advanced settings."         |
| `OAUTH_CLIENT_SECRET`  | Opaque string. Paste into Claude.ai connector "Advanced settings."         |
| `OWNER_TOKEN`          | The password you type into the browser login page to approve a client.    |
| `JWT_SIGNING_KEY`      | Key used to sign 90-day access-token JWTs. Rotating it revokes all tokens.|
| `PORT`                 | HTTP listen port (Fly maps internally). Default `8080`.                    |

## Local development

```bash
cp .env.example .env
# fill in every variable; commands to generate the random ones are in the file

npm install
npm run dev
```

Smoke-test against your live SB instance using the dev-bypass token:

```bash
set -a; source .env; set +a

curl http://localhost:8080/healthz                      # 200 always
curl http://localhost:8080/readyz                       # 200 if SB reachable

# OAuth discovery documents (no auth required on these)
curl http://localhost:8080/.well-known/oauth-protected-resource
curl http://localhost:8080/.well-known/oauth-authorization-server

# MCP initialize handshake (uses dev-bypass MCP_TOKEN)
curl -X POST http://localhost:8080/mcp \
  -H "Authorization: Bearer $MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{
      "protocolVersion":"2025-03-26",
      "capabilities":{},
      "clientInfo":{"name":"curl","version":"0"}
    }
  }'
```

## Deploy to Fly.io

First time only:

```bash
fly apps create your-app

fly secrets set \
  SB_URL=https://notes.example.com \
  SB_TOKEN=<your SB_AUTH_TOKEN> \
  MCP_TOKEN=$(openssl rand -hex 32) \
  PUBLIC_URL=https://your-app.fly.dev \
  OAUTH_CLIENT_ID=$(uuidgen | tr 'A-Z' 'a-z') \
  OAUTH_CLIENT_SECRET=$(openssl rand -hex 32) \
  OWNER_TOKEN=<something memorable but not guessable> \
  JWT_SIGNING_KEY=$(openssl rand -hex 64) \
  --app your-app
```

Then every deploy:

```bash
fly deploy
```

The server scales to zero when idle (see `auto_stop_machines = "suspend"` in
`fly.toml`).

Once you add a custom domain (`fly certs add mcp.example.com`),
update `PUBLIC_URL` to match — OAuth metadata must point at the URL clients
actually reach you on:

```bash
fly secrets set PUBLIC_URL=https://mcp.example.com --app your-app
```

## Connect from Claude (OAuth)

In Claude.ai → **Settings → Connectors → Add custom connector**:

| Field                      | Value                                          |
| -------------------------- | ---------------------------------------------- |
| URL                        | `https://your-app.fly.dev/mcp`              |
| (Advanced) Client ID       | The `OAUTH_CLIENT_ID` from your secrets        |
| (Advanced) Client Secret   | The `OAUTH_CLIENT_SECRET` from your secrets    |

What happens on first use:

1. Claude calls the MCP and gets a 401 with a `WWW-Authenticate` header.
2. Claude reads the discovery documents and opens your browser to
   `https://your-app.fly.dev/authorize?...`.
3. You see a one-field login page. Enter `OWNER_TOKEN`. Approve.
4. Claude exchanges the resulting code for a 90-day JWT and uses it on every
   subsequent tool call.

When the JWT expires, step 3 repeats. To force re-auth across all clients
immediately, rotate `JWT_SIGNING_KEY` and redeploy.

## Roadmap

- v0.2 — write tools: `create_page`, `write_page`, `append_to_page`, `prepend_to_page`, `delete_page`. Soft-delete, 256 KB cap, audit logging. **Shipped.**
- v0.3 — collision-safe overwrites via `lastModified` envelopes; `read_page` returns `{path, lastModified}` + body; `write_page` requires `expected_last_modified` and is overwrite-only. **Shipped.**
- v0.4 — typed errors (`ConflictError`, `PageNotFoundError`, `FileNotFoundError`, `PageAlreadyExistsError`, `BodyTooLargeError`, `ForbiddenPathError`, `InvalidPathError`, `UpstreamError`) routed through a central `mapToolError` that returns structured `{error, status, message, remediation}` payloads as regular content (no `isError`), plus `[ERROR]` audit lines. **Shipped.**
- v0.5 — version-marker hygiene: `lastModified` no longer leaks through `list_pages`, `search_pages`, or conflict-error payloads; rounded to second precision in recency contexts. **Shipped.**
- v0.6 — cached file index, real search ranking, frontmatter awareness.
- v0.7 — refresh tokens, so JWT renewal is silent.
- future — path-prefix allowlist (restrict writes to specific directories if the broad write surface ever feels too open); atomic writes (current SB backend uses non-atomic `os.WriteFile`); switch `statFile` to a header-based metadata GET once SB's `Last-Modified` header behavior is verified, to avoid the per-write directory listing.

See `Home/docs/silverbullet/silverbullet-mcp-setup.md` for active task list,
testing plan, and decision log.
