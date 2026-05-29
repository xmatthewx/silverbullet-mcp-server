# silverbullet-mcp

A tiny MCP server that exposes a [SilverBullet](https://silverbullet.md) space
to Claude over HTTP. Read-only in v1; write tools planned.

## Architecture

```
Claude (web / desktop / mobile)
        │
        │  Streamable HTTP, Bearer MCP_TOKEN
        ▼
[ silverbullet-mcp on Fly.io ]   <-- this repo
        │
        │  GET /.fs, GET /.fs/<path>, Bearer SB_TOKEN
        ▼
[ SilverBullet on Pikapod ]
   notes.example.com
```

Two tokens deliberately:

- `MCP_TOKEN` — what Claude clients present to *this* server.
- `SB_TOKEN`  — what this server presents to SilverBullet.

They rotate independently. If a Claude client is compromised, you can rotate
`MCP_TOKEN` without touching SB.

## Tools (v1, read-only)

| Tool           | Inputs                  | Returns                                              |
| -------------- | ----------------------- | ---------------------------------------------------- |
| `list_pages`   | —                       | Every `.md` page in the space, sorted by recency.    |
| `read_page`    | `page` (string)         | Raw markdown source.                                 |
| `search_pages` | `query`, `limit?`       | Top substring matches with snippets and match counts.|

Search is naive (fan-out fetch + substring). Fine for personal note volumes;
revisit if latency bites.

## Environment

See `.env.example`. All four are required at boot.

| Variable    | What it is                                                      |
| ----------- | --------------------------------------------------------------- |
| `SB_URL`    | Base URL of the SilverBullet instance (no trailing slash).      |
| `SB_TOKEN`  | The `SB_AUTH_TOKEN` configured on the SilverBullet side.        |
| `MCP_TOKEN` | Long random string Claude clients must present.                 |
| `PORT`      | HTTP listen port (Fly maps internally). Default `8080`.         |

## Local development

```bash
cp .env.example .env
# fill in SB_URL, SB_TOKEN, MCP_TOKEN

npm install
npm run dev
```

Smoke-test against your live SB instance:

```bash
# Health
curl http://localhost:8080/healthz

# Readiness (proves the server can reach SB)
curl http://localhost:8080/readyz

# MCP initialize handshake
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
fly launch --no-deploy            # creates the app, keep generated fly.toml
fly secrets set \
  SB_URL=https://notes.example.com \
  SB_TOKEN=<your SB_AUTH_TOKEN> \
  MCP_TOKEN=$(openssl rand -hex 32)
```

Then every deploy:

```bash
fly deploy
```

The server scales to zero when idle (see `auto_stop_machines` in `fly.toml`).

## Connect from Claude

The MCP server speaks Streamable HTTP at:

```
https://silverbullet-mcp.fly.dev/mcp
Authorization: Bearer <MCP_TOKEN>
```

Add it as a custom MCP / connector in your Claude client of choice. The
`MCP_TOKEN` you generated above is what goes in the auth field.

## Roadmap

- v0.2 — write tools (`write_page`, `append_to_page`, `delete_page`) gated by
  an explicit `--allow-write` flag and per-call confirmation in the prompt.
- v0.3 — cached file index, real search ranking, frontmatter awareness.
- v0.4 — optionally back the auth gate with Cloudflare Access instead of a
  static bearer.

See `Home/docs/silverbullet/silverbullet-mcp-setup.md` for active task list,
testing plan, and decision log.
