# Quickstart: From zero to a private, Claude-connected notes platform

> What if your notes app wasn't locked down — editable locally, reachable from
> anywhere, with no import or export, and owned by you? This quickstart sets up a
> private, file-based notes platform that you edit locally (in an editor, or with
> Claude Code or Cowork) and reach remotely, with Claude on web and mobile able
> to read and write it too. SilverBullet is the notes app; this server is the
> link that lets Claude.ai reach it.

> **Want a hand?** Share a link to this page with Claude — on web, mobile, or in
> Cowork — and it can walk you through any step, explain a command, or help you
> debug when something doesn't come up green.

This is the full chain — nothing assumed. If you already run SilverBullet, skip to
[Step 2](#step-2-deploy-the-mcp-server-on-flyio).

Time: ~20 minutes of work. The terminal commands below run in macOS Terminal,
a Linux shell, or — on Windows — Git Bash or WSL. Share your feedback!

## The goal

One notes space reachable four ways, all editing the same plain markdown files
you own:

- SilverBullet running on a managed host (Pikapod), notes stored as markdown.
- This MCP server on Fly.io, bridging Claude.ai to that space over OAuth.
- Claude on web and mobile, able to read and write your notes.
- Optional: local files via the SilverBullet.plus desktop app, so Claude Code and
  Cowork edit the same notes directly on disk.

Other hosts work too — both ends are swappable — but this guide uses Pikapod +
Fly because they're a fast and cheap zero-to-one path.

---

## Step 1: Stand up SilverBullet on Pikapods

[SilverBullet](https://silverbullet.md) is an open-source, self-hosted notes app
where every note is a markdown file — a credible open alternative to Notion or
Obsidian, with full ownership of your data.
[Pikapods](https://www.pikapods.com) is managed hosting that runs it for about
$1.50/mo.

1. Sign up at [pikapods.com](https://www.pikapods.com)
2. Add a new pod and choose SilverBullet from the app list. The 256 MB tier is
   plenty for a personal wiki.
3. In the pod's Environment settings, set two variables:
   - `SB_USER` — your web login, in `username:password` format. This is how you
     log into the SilverBullet UI in a browser.
   - `SB_AUTH_TOKEN` — the Bearer token this MCP server will use to reach your
     space's API. Generate a long random one by running `openssl rand -hex 32` in
     a terminal and pasting the result. Save it in your password manager — you'll
     paste it into Fly in Step 2.
4. Deploy. Pikapod gives you a URL like `https://your-space.pikapods.net` (you
   can personalize the subdomain). You can optionally add a custom domain later
   like `notes.example.com` via a CNAME.
5. Open the URL, log in with your `SB_USER` credentials, and create a note or two
   so the space isn't empty.

You now have your own personal online wiki notes app. Congrats!

> The value you set as `SB_AUTH_TOKEN` is the single most important one to carry
> forward. On Fly it's called `SB_TOKEN` — same value, different name.

## Step 2: Deploy the MCP server on Fly.io

[Fly.io](https://fly.io) hosts this server. It scales to zero when idle, so it
costs almost nothing at rest.

1. Sign up at [fly.io](https://fly.io), install the
   [`flyctl` CLI](https://fly.io/docs/flyctl/install/), then run `fly auth login`.
2. Clone this repo and enter it:
   ```bash
   git clone https://github.com/xmatthewx/silverbullet-mcp-server.git
   cd silverbullet-mcp-server
   ```
3. Create the app:
   ```bash
   fly apps create your-app
   ```
4. Generate and save your OAuth pair. You'll paste these into Claude.ai in
   Step 3, and Fly can't show them to you again later, so copy both into your
   password manager now:
   ```bash
   export OAUTH_CLIENT_ID=$(uuidgen | tr 'A-Z' 'a-z')
   export OAUTH_CLIENT_SECRET=$(openssl rand -hex 32)
   echo "CLIENT_ID:     $OAUTH_CLIENT_ID"
   echo "CLIENT_SECRET: $OAUTH_CLIENT_SECRET"
   ```
5. Set every secret in one shot. The `$( … )` pieces generate strong random
   values inline; the OAuth pair reuses what you just saved:
   ```bash
   fly secrets set \
     SB_URL=https://your-space.pikapods.net \
     SB_TOKEN=<the SB_AUTH_TOKEN from Step 1> \
     MCP_TOKEN=$(openssl rand -hex 32) \
     PUBLIC_URL=https://your-app.fly.dev \
     OAUTH_CLIENT_ID=$OAUTH_CLIENT_ID \
     OAUTH_CLIENT_SECRET=$OAUTH_CLIENT_SECRET \
     OWNER_TOKEN=<your-owner-password> \
     JWT_SIGNING_KEY=$(openssl rand -hex 64) \
     --app your-app
   ```
6. Deploy:
   ```bash
   fly deploy
   ```

A few notes on those values:

- `SB_URL` is your Pikapod URL, no trailing slash.
- `SB_TOKEN` must exactly match the `SB_AUTH_TOKEN` from Step 1.
- `OWNER_TOKEN` is the password you'll type into a browser to approve Claude
  (Step 3). Unlike the random secrets above, you type this one by hand — pick a
  strong passphrase you'll remember, or generate one with `openssl rand -hex 16`
  and save it.
- `PUBLIC_URL` must be the exact public URL clients reach (it's baked into the
  OAuth metadata). If you later add a custom domain with
  `fly certs add mcp.example.com`, set `PUBLIC_URL` to match and redeploy.
- `MCP_TOKEN` and `JWT_SIGNING_KEY` don't need saving for normal use — they can
  be rotated anytime.

Confirm it's alive:

```bash
curl https://your-app.fly.dev/healthz   # 200 always
curl https://your-app.fly.dev/readyz    # 200 if SilverBullet is reachable
```

A `200` on `/readyz` means the server can talk to your space. If it fails,
recheck `SB_URL` and `SB_TOKEN`.

You've now launched a personal MCP. Congrats!

## Step 3: Connect Claude.ai

You'll need a Claude.ai plan that supports custom connectors. In Claude.ai →
**Settings → Connectors → Add custom connector**:

| Field                    | Value                          |
| ------------------------ | ------------------------------ |
| URL                      | `https://your-app.fly.dev/mcp` |
| (Advanced) Client ID     | your `OAUTH_CLIENT_ID`         |
| (Advanced) Client Secret | your `OAUTH_CLIENT_SECRET`     |

On first use, Claude opens a one-field login page in your browser. Enter your
`OWNER_TOKEN` and approve. Claude gets a 90-day token and uses it on every
subsequent call; when it expires, you approve once more.

Congrats! You now have a personal notes app that Claude on web and mobile can
read and write. Set each write tool to *Ask for confirmation* in Claude's
per-tool permission UI so nothing changes without your say-so.

## Step 4 (optional): Add local editing with SilverBullet.plus

This is what makes Claude Code and Cowork part of the loop. SilverBullet.plus is
a desktop app from the same developer that syncs your hosted space down to local
markdown files.

1. Install [SilverBullet.plus](https://silverbullet.plus) and point it at your
   Pikapod space (URL + your `SB_USER` login).
2. Let it sync. Your notes now live as real files in a local folder.
3. Point Claude Code or Cowork at that folder. They edit the files directly;
   SilverBullet.plus syncs the changes back up, where Claude web/mobile see them
   through this server.

> **Heads up:** SilverBullet.plus is currently alpha. In practice it's been
> stable, but treat it as early software — keep backups and don't be surprised by
> rough edges.

---

## You're done

You now have one notes space reachable four ways: your browser, your phone,
Claude (web + mobile), and local tools like Claude Code and Cowork — all editing
the same plain markdown files you own.

Stuck anywhere, or want to go further? Share a link to this page with Claude and
it can help. For the full tool reference, error model, and design reasoning, see
the [README](../README.md).
