/**
 * SilverBullet HTTP client.
 *
 * Talks to a running SilverBullet instance over its /.fs REST surface.
 * Auth is a static Bearer token (SB_AUTH_TOKEN on the SB side).
 *
 * Reference: https://silverbullet.md/HTTP%20API
 */

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

  /** Return every file in the space with metadata. */
  async listFiles(): Promise<SBFile[]> {
    const r = await fetch(`${this.baseUrl}/.fs`, { headers: this.headers() });
    if (!r.ok) throw new Error(`SB list failed: ${r.status} ${r.statusText}`);
    return (await r.json()) as SBFile[];
  }

  /** Return only markdown pages (and strip the .md suffix for ergonomics). */
  async listPages(): Promise<Array<{ page: string; path: string; lastModified: number }>> {
    const files = await this.listFiles();
    return files
      .filter((f) => f.name.endsWith(".md"))
      .map((f) => ({
        page: f.name.replace(/\.md$/, ""),
        path: f.name,
        lastModified: f.lastModified,
      }))
      .sort((a, b) => b.lastModified - a.lastModified);
  }

  /** Read raw file content (markdown source). */
  async readFile(path: string): Promise<string> {
    const safe = path.split("/").map(encodeURIComponent).join("/");
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
   * Simple full-text search across markdown pages.
   *
   * SilverBullet has no search endpoint of its own — the real search lives in
   * the client-side index. So for v1 we fan out: list pages, fetch in parallel,
   * substring match. Fine for personal note volumes; revisit with caching if
   * latency becomes a problem.
   */
  async searchPages(query: string, limit = 20): Promise<SearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const needle = q.toLowerCase();
    const pages = await this.listPages();

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
