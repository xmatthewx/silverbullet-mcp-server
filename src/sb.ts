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
  // Reject absolute paths before normalization.
  if (page.startsWith("/")) {
    const stripped = page.slice(1);
    if (!stripped) throw new Error(`Invalid page path: "${page}" — empty after stripping leading slash`);
    page = stripped;
  }

  if (!page) throw new Error(`Invalid page path: empty string`);

  const segments = page.split("/");
  for (const seg of segments) {
    if (seg === ".." || seg === ".") {
      throw new Error(`Invalid page path: "${page}" — path traversal not allowed`);
    }
    if (seg === "") {
      throw new Error(`Invalid page path: "${page}" — empty segment`);
    }
  }

  const path = page.endsWith(".md") ? page : `${page}.md`;

  if (path.includes(".md.md")) {
    throw new Error(`Invalid page path: "${page}" — results in double .md extension`);
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

  /** Return every file in the space with metadata. */
  async listFiles(): Promise<SBFile[]> {
    const r = await fetch(`${this.baseUrl}/.fs`, { headers: this.headers() });
    if (!r.ok) throw new Error(`SB list failed: ${r.status} ${r.statusText}`);
    return (await r.json()) as SBFile[];
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
    const r = await fetch(`${this.baseUrl}/.fs/${safe}`, { headers: this.headers() });
    if (r.status === 404) throw new Error(`Not found: ${path}`);
    if (!r.ok) throw new Error(`SB read failed: ${r.status} ${path}`);
    return r.text();
  }

  /** Read a markdown page by its page name (with or without .md). */
  async readPage(page: string): Promise<string> {
    const path = page.endsWith(".md") ? page : `${page}.md`;
    return this.readFile(path);
  }

  /**
   * Write raw file content via PUT.
   * Throws if body exceeds MAX_WRITE_BYTES (256 KB).
   */
  async writeFile(path: string, body: string): Promise<void> {
    const byteLen = Buffer.byteLength(body, "utf8");
    if (byteLen > MAX_WRITE_BYTES) {
      throw new Error(
        `Body too large: ${byteLen} bytes exceeds limit of ${MAX_WRITE_BYTES} bytes (256 KB)`
      );
    }
    const safe = this.encodePath(path);
    const r = await fetch(`${this.baseUrl}/.fs/${safe}`, {
      method: "PUT",
      headers: this.writeHeaders(),
      body,
    });
    if (!r.ok) throw new Error(`SB write failed: ${r.status} ${path}`);
  }

  /**
   * Delete a file via DELETE.
   * Throws with "Not found" message on 404.
   */
  async deleteFile(path: string): Promise<void> {
    const safe = this.encodePath(path);
    const r = await fetch(`${this.baseUrl}/.fs/${safe}`, {
      method: "DELETE",
      headers: this.headers(),
    });
    if (r.status === 404) throw new Error(`Not found: ${path}`);
    if (!r.ok) throw new Error(`SB delete failed: ${r.status} ${path}`);
  }

  /**
   * Cheap existence probe using X-Get-Meta — the server returns metadata
   * headers only without streaming the body.
   */
  async existsFile(path: string): Promise<boolean> {
    const safe = this.encodePath(path);
    const r = await fetch(`${this.baseUrl}/.fs/${safe}`, {
      headers: {
        ...this.headers(),
        "X-Get-Meta": "true",
      },
    });
    if (r.status === 200) return true;
    if (r.status === 404) return false;
    throw new Error(`SB exists check failed: ${r.status} ${path}`);
  }

  /**
   * Write (overwrite) a page by name (with or without .md).
   * Refuses to write into `_trash/` — use softDeletePage for that.
   */
  async writePage(page: string, body: string): Promise<{ path: string }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new Error("Refusing to write into _trash/; use delete_page to soft-delete");
    }
    await this.writeFile(path, body);
    return { path };
  }

  /**
   * Create a new page. Throws if the page already exists.
   * Refuses to create inside `_trash/`.
   */
  async createPage(page: string, body: string): Promise<{ path: string }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new Error("Refusing to write into _trash/; use delete_page to soft-delete");
    }
    if (await this.existsFile(path)) {
      throw new Error(`Page already exists: ${page}`);
    }
    await this.writeFile(path, body);
    return { path };
  }

  /**
   * Append content to an existing page, separated by a blank line.
   * Creates the page if it does not yet exist.
   *
   * A single blank line (existing newline + inserted newline) separates the
   * original body from the appended block — this mirrors typical Markdown
   * paragraph spacing convention.
   */
  async appendToPage(page: string, content: string): Promise<{ path: string; bytesAdded: number }> {
    const path = validatePagePath(page);
    if (path.startsWith("_trash/")) {
      throw new Error("Refusing to write into _trash/; use delete_page to soft-delete");
    }

    const bytesAdded = Buffer.byteLength(content, "utf8");

    if (!(await this.existsFile(path))) {
      await this.writeFile(path, content);
      return { path, bytesAdded };
    }

    let existing = await this.readFile(path);
    if (!existing.endsWith("\n")) existing += "\n";
    const combined = existing + "\n" + content;

    if (Buffer.byteLength(combined, "utf8") > MAX_WRITE_BYTES) {
      throw new Error(
        `Append would exceed size limit of ${MAX_WRITE_BYTES} bytes (256 KB)`
      );
    }

    await this.writeFile(path, combined);
    return { path, bytesAdded };
  }

  /**
   * Prepend content to a page, optionally inserting after YAML frontmatter.
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
      throw new Error("Refusing to write into _trash/; use delete_page to soft-delete");
    }

    const bytesAdded = Buffer.byteLength(content, "utf8");
    const position = opts?.position ?? "after_frontmatter";

    if (!(await this.existsFile(path))) {
      await this.writeFile(path, content);
      return { path, bytesAdded, insertedAfterFrontmatter: false };
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

    if (Buffer.byteLength(combined, "utf8") > MAX_WRITE_BYTES) {
      throw new Error(
        `Prepend would exceed size limit of ${MAX_WRITE_BYTES} bytes (256 KB)`
      );
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
      throw new Error("Page is already in trash — refusing to trash the trash");
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
    try {
      const r = await fetch(`${this.baseUrl}/.ping`);
      return r.ok;
    } catch {
      return false;
    }
  }
}
