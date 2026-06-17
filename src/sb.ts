/**
 * SilverBullet HTTP client.
 *
 * Talks to a running SilverBullet instance over its /.fs REST surface.
 * Auth is a static Bearer token (SB_AUTH_TOKEN on the SB side).
 *
 * Reference: https://silverbullet.md/HTTP%20API
 */

/** Hard cap on write body size to avoid accidentally huge PUTs. */
const MAX_WRITE_BYTES = 256 * 1024;

/**
 * Hard timeout for any upstream HTTP request. Node's fetch has no default
 * timeout — a stalled TCP connection would otherwise block the MCP request
 * indefinitely. 20s is generous for a personal SB instance but still
 * short enough that the Claude.ai connector won't have hung up first.
 */
const FETCH_TIMEOUT_MS = 20_000;

/**
 * Extract the underlying cause from a fetch error so the UpstreamError
 * message names the actual failure (ENOTFOUND, ECONNRESET, ETIMEDOUT,
 * UND_ERR_CONNECT_TIMEOUT, certificate error, etc.) instead of just
 * "fetch failed".
 */
function describeFetchError(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const cause = (err as Error & { cause?: unknown }).cause;
  if (cause instanceof Error) {
    const code = (cause as Error & { code?: string }).code;
    return code ? `${err.message}: ${code} ${cause.message}` : `${err.message}: ${cause.message}`;
  }
  return err.message;
}

/**
 * Normalize a page name or path to a safe `.md` path.
 *
 * Rules:
 * - Strip a single leading slash, then reject if the result is empty.
 * - Reject any path segment equal to `..` or `.` (no traversal).
 * - Append `.md` if the path does not already end with it.
 * - Reject if the result contains `.md.md` (double-extension).
 * - Returns the validated path string (e.g. `foo/bar.md`).
 */
export function validatePagePath(page: string): string {
  const original = page;

  // Reject absolute paths before normalization.
  if (page.startsWith("/")) {
    const stripped = page.slice(1);
    if (!stripped) throw new InvalidPathError(original, "empty after stripping leading slash");
    page = stripped;
  }

  if (!page) throw new InvalidPathError(original, "empty string");

  const segments = page.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new InvalidPathError(original, "path traversal not allowed");
    }
    if (seg === "") {
      throw new InvalidPathError(original, "empty segment");
    }
  }

  const path = page.endsWith(".md") ? page : `${page}.md`;

  if (path.includes(".md.md")) {
    throw new InvalidPathError(original, "results in double .md extension");
  }

  return path;
}

export interface SBFile {
  name: string;
  lastModified: number;
  contentType?: string;
  size?: number;
  perm?: "rw" | "ro";
}

export interface SearchHit {
  page: string;        // path without the .md suffix
  path: string;        // full path as SB stores it
  lastModified: number;
  snippet: string;     // a short excerpt around the first match
  matches: number;     // total match count in this file
}

/**
 * Thrown when a conditional write fails because the page on the server has
 * been modified since the caller's last read.
 *
 * Carries the actual lastModified so the caller can decide whether to retry
 * after re-reading, or surface the conflict to the user.
 */
export class ConflictError extends Error {
  readonly path: string;
  readonly expectedLastModified: number;
  /**
   * The current server-side lastModified at the moment of conflict.
   *
   * Carried for server-side audit logging only — DO NOT include this value
   * in any payload that crosses the MCP wire. The exact ms-precision
   * lastModified is the optimistic-concurrency token for write_page, and
   * leaking it through a conflict response would let a caller retry the
   * write without re-reading the page (defeating the safety property that
   * the caller must have seen the current body before overwriting).
   */
  readonly actualLastModified: number;
  constructor(path: string, expected: number, actual: number) {
    super(
      `Conflict on ${path}: the page has been modified since you last read it. ` +
        `Re-read the page to reconcile before writing again.`
    );
    this.name = "ConflictError";
    this.path = path;
    this.expectedLastModified = expected;
    this.actualLastModified = actual;
  }
}

/**
 * Thrown by writePage when the target page does not exist. The intent of
 * write_page is overwrite-only; new pages must go through create_page.
 */
export class PageNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Page does not exist: ${path}. Use create_page for new pages.`);
    this.name = "PageNotFoundError";
    this.path = path;
  }
}

/** Thrown when a file path is not present on the SB server (read/delete). */
export class FileNotFoundError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Not found: ${path}`);
    this.name = "FileNotFoundError";
    this.path = path;
  }
}

/** Thrown by createPage when the target page already exists. */
export class PageAlreadyExistsError extends Error {
  readonly path: string;
  constructor(path: string) {
    super(`Page already exists: ${path}`);
    this.name = "PageAlreadyExistsError";
    this.path = path;
  }
}

/** Thrown when a write body (after any server-side concat) exceeds the cap. */
export class BodyTooLargeError extends Error {
  readonly path: string | null;
  readonly bytes: number;
  readonly limit: number;
  constructor(path: string | null, bytes: number, limit: number) {
    super(
      `Body too large${path ? ` for ${path}` : ""}: ${bytes} bytes exceeds limit of ${limit} bytes (${Math.round(limit / 1024)} KB)`
    );
    this.name = "BodyTooLargeError";
    this.path = path;
    this.bytes = bytes;
    this.limit = limit;
  }
}

/** Thrown when a write targets a forbidden subtree (currently _trash/). */
export class ForbiddenPathError extends Error {
  readonly path: string;
  constructor(path: string, reason: string) {
    super(`Forbidden path ${path}: ${reason}`);
    this.name = "ForbiddenPathError";
    this.path = path;
  }
}

/** Thrown by validatePagePath when the input fails structural checks. */
export class InvalidPathError extends Error {
  readonly input: string;
  readonly reason: string;
  constructor(input: string, reason: string) {
    super(`Invalid page path "${input}": ${reason}`);
    this.name = "InvalidPathError";
    this.input = input;
    this.reason = reason;
  }
}

/**
 * Thrown when the upstream SilverBullet server returns a non-2xx response or
 * is unreachable. Carries the HTTP status when available so callers can
 * distinguish transient (5xx/0) from permanent (4xx) failures.
 */
export class UpstreamError extends Error {
  readonly status: number | null;
  readonly path: string | null;
  constructor(message: string, status: number | null, path: string | null) {
    super(message);
    this.name = "UpstreamError";
    this.status = status;
    this.path = path;
  }
}

export class SilverBulletClient {
  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
  ) {
    if (!baseUrl) throw new Error("SB_URL is required");
    if (!token) throw new Error("SB_TOKEN is required");
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "X-Sync-Mode": "true",
    };
  }

  /** Headers required for write (PUT) requests. */
  private writeHeaders(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      "Content-Type": "text/markdown",
      // X-Permission: rw is critical — omitting it causes SB to mark the page
      // read-only in its UI even though the file was written successfully.
      "X-Permission": "rw",
    };
  }

  /** Encode a path for use in a /.fs URL (each segment encoded separately). */
  private encodePath(path: string): string {
    return path.split("/").map(encodeURIComponent).join("/");
  }

  /**
   * Single point of entry for upstream HTTP requests.
   *
   * Wraps `fetch` with:
   *   - A hard timeout via AbortSignal (FETCH_TIMEOUT_MS).
   *   - `redirect: "manual"` so an SB auth redirect (302 → /auth) doesn't
   *     get silently followed and then fail at the JSON parse step.
   *   - Cause-chain extraction so the UpstreamError message says the real
   *     thing (ENOTFOUND, ECONNRESET, …) instead of bare "fetch failed".
   *
   * Returns the Response if and only if it's a non-redirect, non-2xx-or-2xx
   * outcome. The caller decides whether to treat non-OK statuses as errors.
   * Throws UpstreamError on fetch failure, timeout, or any 3xx (treated as
   * auth/config drift on /.fs endpoints).
   */
  private async sbFetch(
    url: string,
    init: RequestInit,
    ctx: { verb: string; path: string | null },
  ): Promise<Response> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(url, { ...init, signal: controller.signal, redirect: "manual" });
    } catch (e) {
      const detail = describeFetchError(e);
      const aborted = (e as Error)?.name === "AbortError";
      throw new UpstreamError(
        aborted
          ? `SB request timed out after ${FETCH_TIMEOUT_MS}ms while ${ctx.verb}${ctx.path ? ` ${ctx.path}` : ""}`
          : `SB unreachable while ${ctx.verb}${ctx.path ? ` ${ctx.path}` : ""}: ${detail}`,
        null,
        ctx.path,
      );
    } finally {
      clearTimeout(timeout);
    }

    // 3xx on /.fs is almost always an auth-stale redirect to the login page.
    // Surface it as a clear UpstreamError instead of letting the caller try
    // to parse the auth-page HTML as JSON.
    if (r.status >= 300 && r.status < 400) {
      throw new UpstreamError(
        `SB returned ${r.status} (redirect) while ${ctx.verb}${ctx.path ? ` ${ctx.path}` : ""}; ` +
          `the upstream SB_TOKEN may be stale or the endpoint may have moved`,
        r.status,
        ctx.path,
      );
    }
    return r;
  }

  /** Return every file in the space with metadata. */
  async listFiles(): Promise<SBFile[]> {
    const r = await this.sbFetch(
      `${this.baseUrl}/.fs`,
      { headers: this.headers() },
      { verb: "listing files", path: null },
    );
    if (!r.ok) throw new UpstreamError(`SB list failed: ${r.status} ${r.statusText}`, r.status, null);
    try {
      return (await r.json()) as SBFile[];
    } catch (e) {
      throw new UpstreamError(
        `SB returned non-JSON while listing files: ${(e as Error).message}`,
        r.status,
        null,
      );
    }
  }

  /**
   * Return only markdown pages (strip the .md suffix for ergonomics).
   *
   * @param opts.includeTrash - When false (default), pages under `_trash/` are excluded.
   */
  async listPages(opts?: { includeTrash?: boolean }): Promise<Array<{ page: string; path: string; lastModified: number }>> {
    const includeTrash = opts?.includeTrash ?? false;
    const files = await this.listFiles();
    return files
      .filter((f) => f.name.endsWith(".md"))
      .filter((f) => includeTrash || !f.name.startsWith("_trash/"))
      .map((f) => ({
        page: f.name.replace(/\.md$/, ""),
        path: f.name,
        lastModified: f.lastModified,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  /** Read raw file content (markdown source). */
  async readFile(path: string): Promise<string> {
    const safe = this.encodePath(path);
    const r = await this.sbFetch(
      `${this.baseUrl}/.fs/${safe}`,
      { headers: this.headers() },
      { verb: "reading", path },
    );
    if (r.status === 404) throw new FileNotFoundError(path);
    if (!r.ok) throw new UpstreamError(`SB read failed: ${r.status} ${path}`, r.status, path);
    return r.text();
  }

  /**
   * Return the lastModified for a path, or null if absent.
   *
   * Sourced from the /.fs directory listing — the same value surfaced via
   * list_pages — so reads and writes compare apples to apples. One extra
   * round-trip per call; acceptable at personal-note scale. If the space
   * grows large enough that the listing latency bites, switch to a
   * header-based stat (Last-Modified on a metadata GET) once we've verified
   * which header SB sets in production.
   */
  async statFile(path: string): Promise<{ lastModified: number } | null> {
    const files = await this.listFiles();
    const hit = files.find((f) => f.name === path);
    return hit ? { lastModified: hit.lastModified } : null;
  }

  /** Read a markdown page by its page name (with or without .md). */
  async readPage(page: string): Promise<string> {
    const path = validatePagePath(page);
    return this.readFile(path);
  }

  /**
   * Read a page and return an envelope carrying its current lastModified.
   *
   * The lastModified value lets a caller pass it back as expectedLastModified
   * on a subsequent writePage to guard against interim edits. It is sourced
   * from the /.fs directory listing for consistency with list_pages.
   *
   * Throws InvalidPathError if the input fails validation, FileNotFoundError
   * if the page is absent. The "missing from listing after a successful
   * body read" case maps to FileNotFoundError too — this happens when the
   * input encodes a path that the SB server URL-resolves (e.g. `../foo`
   * collapsing) such that the body read succeeds against a different file
   * than the listing entry, which we'd rather surface clearly than paper
   * over.
   */
  async readPageEnvelope(
    page: string,
  ): Promise<{ content: string; lastModified: number; path: string }> {
    const path = validatePagePath(page);
    const content = await this.readFile(path);
    const stat = await this.statFile(path);
    if (!stat) throw new FileNotFoundError(path);
    return { content, lastModified: stat.lastModified, path };
  }

  /**
   * Write raw file content via PUT.
   * Throws BodyTooLargeError if body exceeds MAX_WRITE_BYTES (256 KB).
   */
  async writeFile(path: string, body: string): Promise<void> {
    const byteLen = Buffer.byteLength(body, "utf8");
    if (byteLen > MAX_WRITE_BYTES) {
      throw new BodyTooLargeError(path, byteLen, MAX_WRITE_BYTES);
    }
    const safe = this.encodePath(path);
    const r = await this.sbFetch(
      `${this.baseUrl}/.fs/${safe}`,
      { method: "PUT", headers: this.writeHeaders(), body },
      { verb: "writing", path },
    );
    if (!r.ok) throw new UpstreamError(`SB write failed: ${r.status} ${path}`, r.status, path);
  }

  /**
   * Delete a file via DELETE.
   * Throws FileNotFoundError on 404.
   */
  async deleteFile(path: string): Promise<void> {
    const safe = this.encodePath(path);
    const r = await this.sbFetch(
      `${this.baseUrl}/.fs/${safe}`,
      { method: "DELETE", headers: this.headers() },
      { verb: "deleting", path },
    );
    if (r.status === 404) throw new FileNotFoundError(path);
    if (!r.ok) throw new UpstreamError(`SB delete failed: ${r.status} ${path}`, r.status, path);
  }

  /**
   * Cheap existence probe using X-Get-Meta — the server returns metadata
   * headers only without streaming the body.
   */
  async existsFile(path: string): Promise<boolean> {
    const safe = this.encodePath(path);
    const r = await this.sbFetch(
      `${this.baseUrl}/.fs/${safe}`,
      { headers: { ...this.headers(), "X-Get-Meta": "true" } },
      { verb: "checking", path },
    );
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    throw new UpstreamError(`SB exists check failed: ${r.status} ${path}`, r.status, path);
  }

  /**
   * Overwrite an existing page. Refuses to create a new page; refuses to
   * write into `_trash/`.
   *
   * Collision-safe: requires expectedLastModified, which the caller obtained
   * from a prior readPageEnvelope (or list_pages). If the current server
   * lastModified differs, throws ConflictError so the caller can re-read and
   * decide whether to retry.
   *
   * Returns the new lastModified, so the caller is left write-ready for a
   * follow-up overwrite without an extra read.
   *
   * A narrow TOCTOU window exists between the stat check and the PUT —
   * unavoidable without an If-Unmodified-Since equivalent on the SB side.
   * Acceptable for a single-user space; document the limitation.
   */
  async writePage(
    page: string,
    body: string,
    expectedLastModified: number,
  ): Promise<{ path: string; lastModified: number }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new ForbiddenPathError(path, "writes into _trash/ are not allowed; use delete_page to soft-delete");
    }

    const before = await this.statFile(path);
    if (!before) throw new PageNotFoundError(path);
    if (before.lastModified !== expectedLastModified) {
      throw new ConflictError(path, expectedLastModified, before.lastModified);
    }

    await this.writeFile(path, body);

    const after = await this.statFile(path);
    if (!after) {
      // Wrote successfully but the directory listing has no entry — surface
      // rather than fabricate a value.
      throw new Error(`Wrote ${path} but it is missing from the file listing afterwards`);
    }
    return { path, lastModified: after.lastModified };
  }

  /**
   * Create a new page. Throws if the page already exists.
   * Refuses to create inside `_trash/`.
   *
   * Returns the new lastModified, leaving the caller write-ready.
   */
  async createPage(
    page: string,
    body: string,
  ): Promise<{ path: string; lastModified: number }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new ForbiddenPathError(path, "writes into _trash/ are not allowed; use delete_page to soft-delete");
    }
    if (await this.existsFile(path)) {
      throw new PageAlreadyExistsError(path);
    }
    await this.writeFile(path, body);

    const after = await this.statFile(path);
    if (!after) {
      throw new Error(`Wrote ${path} but it is missing from the file listing afterwards`);
    }
    return { path, lastModified: after.lastModified };
  }

  /**
   * Append content to an existing page, separated by a blank line.
   * Throws FileNotFoundError if the page does not exist — use create_page
   * for new pages.
   *
   * A single blank line (existing newline + inserted newline) separates the
   * original body from the appended block — this mirrors typical Markdown
   * paragraph spacing convention.
   */
  async appendToPage(page: string, content: string): Promise<{ path: string; bytesAdded: number }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new ForbiddenPathError(path, "writes into _trash/ are not allowed; use delete_page to soft-delete");
    }

    const bytesAdded = Buffer.byteLength(content, "utf8");

    if (!(await this.existsFile(path))) {
      throw new FileNotFoundError(path);
    }

    let existing = await this.readFile(path);
    if (!existing.endsWith("\n")) existing += "\n";
    const combined = existing + "\n" + content;

    const combinedBytes = Buffer.byteLength(combined, "utf8");
    if (combinedBytes > MAX_WRITE_BYTES) {
      throw new BodyTooLargeError(path, combinedBytes, MAX_WRITE_BYTES);
    }

    await this.writeFile(path, combined);
    return { path, bytesAdded };
  }

  /**
   * Prepend content to a page, optionally inserting after YAML frontmatter.
   * Throws FileNotFoundError if the page does not exist — use create_page
   * for new pages.
   *
   * @param opts.position - `"after_frontmatter"` (default) inserts after the
   *   closing `---` of YAML frontmatter, if present; falls back to top of file.
   *   `"top"` always inserts at byte 0.
   *
   * When inserting after frontmatter a blank line is added between the closing
   * `---` fence and the prepended content, matching Markdown paragraph convention.
   * Top-mode inserts at byte 0 with no leading blank line.
   */
  async prependToPage(
    page: string,
    content: string,
    opts?: { position?: "after_frontmatter" | "top" }
  ): Promise<{ path: string; bytesAdded: number; insertedAfterFrontmatter: boolean }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new ForbiddenPathError(path, "writes into _trash/ are not allowed; use delete_page to soft-delete");
    }

    const bytesAdded = Buffer.byteLength(content, "utf8");
    const position = opts?.position ?? "after_frontmatter";

    if (!(await this.existsFile(path))) {
      throw new FileNotFoundError(path);
    }

    const existing = await this.readFile(path);
    let insertAt = 0;
    let insertedAfterFrontmatter = false;

    if (position === "after_frontmatter") {
      const fmMatch = existing.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n/);
      if (fmMatch) {
        insertAt = fmMatch[0].length;
        insertedAfterFrontmatter = true;
      }
    }

    const leadingSep = insertedAfterFrontmatter ? "\n" : "";
    const combined =
      existing.slice(0, insertAt) + leadingSep + content + "\n" + existing.slice(insertAt);

    const combinedBytes = Buffer.byteLength(combined, "utf8");
    if (combinedBytes > MAX_WRITE_BYTES) {
      throw new BodyTooLargeError(path, combinedBytes, MAX_WRITE_BYTES);
    }

    await this.writeFile(path, combined);
    return { path, bytesAdded, insertedAfterFrontmatter };
  }

  /**
   * Soft-delete a page by moving it to `_trash/YYYY-MM/<original-path>`.
   *
   * If a trash copy already exists at that path (same page deleted twice in
   * one calendar month), the trash filename is suffixed with `-<unix-ms>`
   * before the `.md` extension to avoid clobbering the earlier copy.
   *
   * If the deleteFile step fails after the trash write, the error surfaces
   * as-is — the caller should treat it as an incomplete soft-delete. No
   * automatic rollback is attempted.
   */
  async softDeletePage(page: string): Promise<{ trashPath: string }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new ForbiddenPathError(path, "page is already in trash; cannot soft-delete it again");
    }

    // Reads the file (surfaces Not found via existing error path).
    const body = await this.readFile(path);

    // Compute month-granularity trash directory using UTC.
    const now = new Date();
    const yyyy = now.getUTCFullYear().toString();
    const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
    let trashPath = `_trash/${yyyy}-${mm}/${path}`;

    // Collision: same page soft-deleted twice this month — suffix with timestamp.
    if (await this.existsFile(trashPath)) {
      const ts = Date.now();
      // Insert timestamp before the final .md extension.
      trashPath = trashPath.replace(/\.md$/, `-${ts}.md`);
    }

    // Route directly through writeFile — writePage would refuse _trash/ writes.
    await this.writeFile(trashPath, body);

    // Delete the original; surfaces as-is if it fails.
    await this.deleteFile(path);

    return { trashPath };
  }

  /**
   * Move a page from one path to another.
   *
   * Implemented as read → create(dest) → re-stat(source) → delete(source).
   * `create` is the clobber guard — it refuses an existing destination.
   * The re-stat guard catches edits to the source between our read and
   * the delete; if the source changed, the delete is skipped, leaving a
   * recoverable duplicate at `to` rather than losing interim edits.
   *
   * Does NOT rewrite [[backlinks]] — SilverBullet's Rename command is
   * editor-only and not reachable over HTTP.
   *
   * No response (success or error) carries a server lastModified — the
   * caller never saw the body, so handing back a version marker would
   * violate the write-readiness contract.
   */
  async movePage(
    from: string,
    to: string,
  ): Promise<{ from: string; to: string; moved: true }> {
    const fromPath = validatePagePath(from);
    const toPath = validatePagePath(to);

    if (fromPath === toPath) {
      throw new InvalidPathError(to, "source and destination are identical");
    }
    if (toPath.startsWith("_trash/")) {
      throw new ForbiddenPathError(toPath, "use delete_page to soft-delete; move into _trash/ is not allowed");
    }

    // 1. Read source body + snapshot its lastModified.
    const content = await this.readFile(fromPath);
    const statBefore = await this.statFile(fromPath);
    if (!statBefore) throw new FileNotFoundError(fromPath);
    const lastModifiedAtRead = statBefore.lastModified;

    // 2. Create destination — refuses if it already exists.
    await this.createPage(to, content);

    // 3. Re-stat source — abort delete if it changed since our read.
    const statAfter = await this.statFile(fromPath);
    if (!statAfter || statAfter.lastModified !== lastModifiedAtRead) {
      throw new ConflictError(fromPath, lastModifiedAtRead, statAfter?.lastModified ?? 0);
    }

    // 4. Soft-delete source.
    try {
      await this.softDeletePage(from);
    } catch (err) {
      throw new UpstreamError(
        `Move created ${toPath} but failed to delete source ${fromPath}. ` +
          `A duplicate now exists at ${toPath}. ` +
          `Original error: ${err instanceof Error ? err.message : String(err)}`,
        null,
        fromPath,
      );
    }

    return { from: fromPath, to: toPath, moved: true };
  }

  /**
   * Simple full-text search across markdown pages.
   *
   * SilverBullet has no search endpoint of its own — the real search lives in
   * the client-side index. So for v1 we fan out: list pages, fetch in parallel,
   * substring match. Fine for personal note volumes; revisit with caching if
   * latency becomes a problem.
   *
   * @param opts.includeTrash - When false (default), trash pages are excluded.
   */
  async searchPages(query: string, limit = 20, opts?: { includeTrash?: boolean }): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const needle = q.toLowerCase();
    const pages = await this.listPages({ includeTrash: opts?.includeTrash });

    const concurrency = 8;
    const hits: SearchHit[] = [];
    let cursor = 0;

    const worker = async () => {
      while (cursor < pages.length) {
        const i = cursor++;
        const p = pages[i];
        try {
          const body = await this.readFile(p.path);
          const lc = body.toLowerCase();
          const titleHit = p.page.toLowerCase().includes(needle);
          const idx = lc.indexOf(needle);
          if (idx === -1 && !titleHit) continue;

          // Count occurrences without regex (avoids escaping).
          let matches = 0;
          let from = 0;
          while (from < lc.length) {
            const next = lc.indexOf(needle, from);
            if (next === -1) break;
            matches++;
            from = next + needle.length;
          }

          const snippetIdx = idx === -1 ? 0 : idx;
          const start = Math.max(0, snippetIdx - 60);
          const end = Math.min(body.length, snippetIdx + needle.length + 140);
          const snippet = body.slice(start, end).replace(/\s+/g, " ").trim();

          hits.push({
            page: p.page,
            path: p.path,
            lastModified: p.lastModified,
            snippet,
            matches: Math.max(matches, titleHit ? 1 : 0),
          });
        } catch {
          // Skip pages we can't read; don't fail the whole search.
        }
      }
    };

    await Promise.all(Array.from({ length: concurrency }, worker));

    hits.sort((a, b) => b.matches - a.matches || b.lastModified - a.lastModified);
    return hits.slice(0, limit);
  }

  /** Lightweight health check — calls SB's /.ping. */
  async ping(): Promise<boolean> {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await fetch(`${this.baseUrl}/.ping`, { signal: controller.signal });
      return r.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(t);
    }
  }
}
