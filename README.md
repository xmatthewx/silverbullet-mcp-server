# silverbullet-mcp

A tiny MCP server that exposes a [SilverBullet](https://silverbullet.md) space
to Claude over HTTP. Read-only in v1; write tools planned.

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

## Tools (v1, read-only)

| Tool           | Inputs                  | Returns                                              |
| -------------- | ----------------------- | ---------------------------------------------------- |
| `list_pages`   | —                       | Every `.md` page in the space, sorted by recency.    |
| `read_page`    | `page` (string)         | Raw markdown source.                                 |
| `search_pages` | `query`, `limit?`       | Top substring matches with snippets and match counts.|

Search is naive (fan-out fetch + substring). Fine for personal note volumes;
revisit if latency bites.

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

- v0.2 — write tools (`write_page`, `append_to_page`, `delete_page`) gated by
  an explicit `--allow-write` flag and per-call confirmation in the prompt.
- v0.3 — cached file index, real search ranking, frontmatter awareness.
- v0.4 — refresh tokens, so JWT renewal is silent.

See `Home/docs/silverbullet/silverbullet-mcp-setup.md` for active task list,
testing plan, and decision log.
