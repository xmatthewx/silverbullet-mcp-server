# Changelog

All notable changes to this project are documented here. This is also the
project's design log — each release records not just what changed but the
trade-off behind it, since the reasoning is often more useful than the diff.

The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0] — Version-marker hygiene

- `list_pages` and `search_pages` now round each entry's `lastModified` to
  second precision (`blurLastModified`), and the `conflict` error payload no
  longer reveals the server's current `lastModified`.
- Why: the ms-precision `lastModified` doubles as the optimistic-concurrency
  token for `write_page`. A live test showed an agent could lift that value
  out of a conflict error and retry a write without re-reading the body —
  defeating the v0.3 safety property ("you must have seen what you're about to
  overwrite"). When a value carries two meanings (recency display + version
  token), every surface that only needs one must downgrade it. Only
  `read_page` / `create_page` / `write_page` may surface the full marker now.

## [0.4.1] — Fetch-layer hardening

- A single `sbFetch` helper centralizes every upstream call, adds a 20s
  `AbortSignal` timeout (Node's `fetch` has none by default), sets
  `redirect: "manual"`, and surfaces the underlying cause (`ENOTFOUND`,
  `ECONNRESET`, `ETIMEDOUT`, certificate failures) instead of a bare
  "fetch failed."
- Why: a real ~15-minute outage logged `status=null` with no clue which layer
  failed. Defaults matter — Node's `fetch` is forgiving on the happy path and
  silent on the unhappy one.

## [0.4.0] — Structured, visible errors

- Typed errors for every detectable failure (`ConflictError`,
  `PageNotFoundError`, `FileNotFoundError`, `PageAlreadyExistsError`,
  `BodyTooLargeError`, `ForbiddenPathError`, `InvalidPathError`,
  `UpstreamError`), all routed through a central `mapToolError` that returns a
  structured `{error, status, message, remediation}` payload, plus `[ERROR]`
  audit lines.
- Errors are returned as regular content blocks — `isError: true` is
  deliberately not set, because the Claude.ai connector was observed to
  swallow the content payload in that case, leaving only a generic
  "Error occurred during tool execution." Returning the payload as ordinary
  content keeps the remediation hint visible to the model.

## [0.3.x] — Collision-safe overwrites

- `read_page` returns a `{path, lastModified}` envelope alongside the body;
  `create_page` returns a fresh `lastModified`; `write_page` is overwrite-only
  and requires `expected_last_modified`, rejecting stale writes with a
  conflict error and missing pages with a not-found error.
- `append_to_page` / `prepend_to_page` deliberately omit `lastModified` — they
  merge server-side without the caller seeing the body, so they must not hand
  back a write-ready marker. That asymmetry is the safety property.
- 0.3.1 hotfix: the connector sends numeric tool args as JSON strings on the
  wire, so numeric inputs use `z.coerce.number()`. Lesson: across an MCP wire,
  prefer `z.coerce.*` for any non-string scalar.

## [0.2.0] — Write tools

- Five write tools: `create_page`, `write_page`, `append_to_page`,
  `prepend_to_page`, `delete_page`. Soft-delete to `_trash/YYYY-MM/`, a 256 KB
  body cap, path validation, `X-Permission: rw` on every PUT, and `[WRITE]`
  audit lines.
- `append`/`prepend` exist so an existing page body never round-trips through
  the model — a real safety property, not just an optimization. Writes are
  gated by the client's per-tool permission UI rather than a server-side flag.

## [0.1.0] — Initial release

- Read-only MCP server over SilverBullet's HTTP API: `list_pages`,
  `read_page`, `search_pages`. Streamable HTTP transport on Fly.io.
- Built-in OAuth 2.1 (JWT access tokens) plus a static `MCP_TOKEN` dev bypass.
- Chose a focused, spec-compliant OAuth implementation over adopting an
  external auth-as-a-service — lighter than the alternative for a single
  codebase, and exactly what the Claude.ai connector flow needs.
