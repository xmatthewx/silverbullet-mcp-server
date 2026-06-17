/**
 * MCP server definition.
 *
 * Read tools:
 *   - list_pages   : enumerate markdown pages in the space
 *   - read_page    : fetch the full markdown source of one page
 *   - search_pages : substring search across all pages
 *
 * Write tools (opt-in, confirm before destructive ops):
 *   - create_page       : create a brand-new page (errors if exists)
 *   - write_page        : overwrite or create a page (wholesale replace)
 *   - append_to_page    : append content at the end of a page
 *   - prepend_to_page   : insert content at the top of a page
 *   - delete_page       : soft-delete a page into _trash/
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  BodyTooLargeError,
  ConflictError,
  FileNotFoundError,
  ForbiddenPathError,
  InvalidPathError,
  PageAlreadyExistsError,
  PageNotFoundError,
  SilverBulletClient,
  UpstreamError,
} from "./sb.js";

type WriteAction = "create" | "write" | "append" | "prepend" | "delete" | "move";

/**
 * Emit a structured write-audit line to stderr.
 * Goes to stderr so it appears in Fly logs without polluting tool output.
 */
function logWrite(action: WriteAction, page: string, bytes: number, extra?: Record<string, unknown>): void {
  const parts = [
    `[WRITE]`,
    `action=${action}`,
    `page=${JSON.stringify(page)}`,
    `bytes=${bytes}`,
  ];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  console.error(parts.join(" "));
}

/**
 * Round a ms-precision lastModified down to second precision.
 *
 * Apply this ONLY to timestamps that are conveying recency (list_pages,
 * search_pages results, conflict-error remediation hints), never to
 * timestamps that ARE the version marker for write_page.
 *
 * Rationale: the exact ms `lastModified` doubles as the optimistic-
 * concurrency token for write_page. By contract, a caller may only
 * obtain it through a tool that has handed back the full page body
 * (read_page, create_page, write_page) — that's the safety property
 * guaranteeing "you have seen what you're about to overwrite." Any
 * other surface that exposes ms-precision `lastModified` becomes an
 * accidental side-channel for that token. Rounding to seconds makes
 * the value useful for recency display but useless as a write key,
 * because the rounded value almost never matches the server's true
 * ms value.
 *
 * DO NOT apply this to:
 *   - the lastModified field returned by read_page (envelope)
 *   - the lastModified field returned by create_page
 *   - the lastModified field returned by write_page (post-write)
 * These are the only legitimate ways to obtain the marker.
 */
function blurLastModified(ms: number): number {
  return Math.floor(ms / 1000) * 1000;
}

/** Emit a structured error-audit line to stderr (mirrors logWrite shape). */
function logError(tool: string, code: string, page: string | undefined, extra?: Record<string, unknown>): void {
  const parts = [
    `[ERROR]`,
    `tool=${tool}`,
    `code=${code}`,
    `page=${JSON.stringify(page ?? null)}`,
  ];
  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      parts.push(`${k}=${JSON.stringify(v)}`);
    }
  }
  console.error(parts.join(" "));
}

/**
 * Build a tool-result content block from an error payload.
 *
 * NOTE: we deliberately do NOT set `isError: true`. The Claude.ai connector
 * has been observed to swallow the content block when isError is set,
 * surfacing only a generic "Error occurred during tool execution" string to
 * the model. Returning the payload as regular content guarantees the model
 * sees the full structured error, including the remediation hint. The
 * payload's `error` field stands in as the machine-readable status.
 */
function toolError(payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
  };
}

/**
 * Map any thrown error to a uniform tool-result content block.
 *
 * Typed errors from sb.ts produce structured payloads with an HTTP-style
 * status, the offending path, any error-specific detail, and a remediation
 * hint. Anything else falls through to `internal`, which preserves the raw
 * message so the model and the user can still see what happened rather
 * than a generic "tool execution failed" string.
 */
function mapToolError(err: unknown, ctx: { tool: string; page?: string }) {
  if (err instanceof ConflictError) {
    // Audit line keeps both values for server-side observability — they
    // do not cross the wire.
    logError(ctx.tool, "conflict", ctx.page, {
      expected: err.expectedLastModified,
      actual: err.actualLastModified,
    });
    // Payload deliberately omits actualLastModified. See the comment on
    // ConflictError.actualLastModified for why leaking it would defeat
    // the write_page safety property.
    return toolError({
      error: "conflict",
      status: 409,
      message: err.message,
      path: err.path,
      expectedLastModified: err.expectedLastModified,
      remediation:
        "Re-read the page to fetch its current body and lastModified, then retry write_page with that value.",
    });
  }
  if (err instanceof PageNotFoundError) {
    logError(ctx.tool, "not_found", ctx.page);
    return toolError({
      error: "not_found",
      status: 404,
      message: err.message,
      path: err.path,
      remediation: "Use create_page for new pages.",
    });
  }
  if (err instanceof FileNotFoundError) {
    logError(ctx.tool, "not_found", ctx.page);
    return toolError({
      error: "not_found",
      status: 404,
      message: err.message,
      path: err.path,
      remediation:
        "Verify the page name with list_pages (or include_trash: true if you expect a soft-deleted page).",
    });
  }
  if (err instanceof PageAlreadyExistsError) {
    logError(ctx.tool, "already_exists", ctx.page);
    return toolError({
      error: "already_exists",
      status: 409,
      message: err.message,
      path: err.path,
      remediation:
        "Use write_page (with expected_last_modified from a read_page) to overwrite, or pick a different page name.",
    });
  }
  if (err instanceof BodyTooLargeError) {
    logError(ctx.tool, "too_large", ctx.page, { bytes: err.bytes, limit: err.limit });
    return toolError({
      error: "too_large",
      status: 413,
      message: err.message,
      path: err.path,
      bytes: err.bytes,
      limit: err.limit,
      remediation: "Split the content into smaller pages or shorten the input.",
    });
  }
  if (err instanceof ForbiddenPathError) {
    logError(ctx.tool, "forbidden_path", ctx.page);
    return toolError({
      error: "forbidden_path",
      status: 403,
      message: err.message,
      path: err.path,
      remediation:
        "Pick a path outside _trash/. Use delete_page to soft-delete an existing page.",
    });
  }
  if (err instanceof InvalidPathError) {
    logError(ctx.tool, "invalid_path", ctx.page);
    return toolError({
      error: "invalid_path",
      status: 422,
      message: err.message,
      input: err.input,
      reason: err.reason,
      remediation:
        "Use a relative path with no '..', '.', empty segments, or '.md.md' (e.g. 'projects/foo' or 'index').",
    });
  }
  if (err instanceof UpstreamError) {
    const transient = err.status === null || err.status >= 500;
    logError(ctx.tool, "upstream", ctx.page, { status: err.status });
    return toolError({
      error: "upstream",
      status: err.status ?? 503,
      message: err.message,
      path: err.path,
      transient,
      remediation: transient
        ? "The upstream SilverBullet server is unreachable or returned a 5xx. Retry in a moment (the host may be cold-starting)."
        : "The upstream SilverBullet server returned a non-2xx status. Check the page path and try again.",
    });
  }
  // Unknown shape — still surface message so it isn't opaque.
  const message = err instanceof Error ? err.message : String(err);
  logError(ctx.tool, "internal", ctx.page, { message });
  return toolError({
    error: "internal",
    status: 500,
    message,
    tool: ctx.tool,
    page: ctx.page,
    remediation:
      "Unexpected server-side error. Retry once; if it persists, check Fly logs for context.",
  });
}

export function buildMcpServer(sb: SilverBulletClient): McpServer {
  const server = new McpServer({
    name: "silverbullet",
    version: "0.6.0",
  });

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "Return every markdown page in the SilverBullet space, sorted by last modified. Each entry carries {page, path, lastModified}. The lastModified here is rounded to the nearest second and is intended only for showing recency — it is NOT a valid expected_last_modified for write_page. To obtain a usable version marker, call read_page (or create_page / write_page).",
      inputSchema: {
        include_trash: z
          .boolean()
          .optional()
          .describe("Include soft-deleted pages under _trash/ in the result. Default false."),
      },
    },
    async ({ include_trash }) => {
      try {
        const raw = await sb.listPages({ includeTrash: include_trash });
        const pages = raw.map((p) => ({ ...p, lastModified: blurLastModified(p.lastModified) }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { count: pages.length, pages },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return mapToolError(err, { tool: "list_pages" });
      }
    },
  );

  server.registerTool(
    "read_page",
    {
      title: "Read page",
      description:
        "Return a page as two content blocks: [0] a JSON envelope {path, lastModified}, [1] the raw markdown body. The lastModified is the version marker — pass it back as expected_last_modified on a follow-up write_page to guard against interim edits. Accepts a page name with or without the .md suffix (e.g. 'projects/silverbullet-mcp' or 'index').",
      inputSchema: {
        page: z
          .string()
          .min(1)
          .describe("Page name relative to the space root, without the .md suffix"),
      },
    },
    async ({ page }) => {
      try {
        const { content, lastModified, path } = await sb.readPageEnvelope(page);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ path, lastModified }, null, 2),
            },
            { type: "text", text: content },
          ],
        };
      } catch (err) {
        return mapToolError(err, { tool: "read_page", page });
      }
    },
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search pages",
      description:
        "Case-insensitive substring search across page titles and page bodies. Returns the top matches with a short snippet around each hit. Slow on first call for large spaces (no index yet). Each hit's lastModified is rounded to the nearest second for recency display only — it is NOT a valid expected_last_modified for write_page. Call read_page to obtain a usable version marker.",
      inputSchema: {
        query: z.string().min(1).describe("Substring to search for"),
        limit: z
          .coerce
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum number of hits to return (default 20)"),
        include_trash: z
          .boolean()
          .optional()
          .describe("Include soft-deleted pages under _trash/ in the result. Default false."),
      },
    },
    async ({ query, limit, include_trash }) => {
      try {
        const raw = await sb.searchPages(query, limit ?? 20, { includeTrash: include_trash });
        const hits = raw.map((h) => ({ ...h, lastModified: blurLastModified(h.lastModified) }));
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { query, count: hits.length, hits },
                null,
                2,
              ),
            },
          ],
        };
      } catch (err) {
        return mapToolError(err, { tool: "search_pages" });
      }
    },
  );

  server.registerTool(
    "create_page",
    {
      title: "Create page",
      description:
        "Create a brand-new page. Errors if the page already exists — use write_page if you intend to overwrite. Returns the resulting {path, lastModified}, leaving the caller write-ready for a follow-up write_page. Path is validated; cannot write into _trash/. Body is capped at 256 KB.",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
        body: z.string().describe("Full markdown content for the new page"),
      },
    },
    async ({ page, body }) => {
      try {
        const result = await sb.createPage(page, body);
        logWrite("create", result.path, Buffer.byteLength(body, "utf8"), {
          last_modified: result.lastModified,
        });
        const payload = { created: true, path: result.path, lastModified: result.lastModified };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return mapToolError(err, { tool: "create_page", page });
      }
    },
  );

  server.registerTool(
    "write_page",
    {
      title: "Write page (overwrite, collision-safe)",
      description:
        "OVERWRITES an existing page wholesale. Requires expected_last_modified — the lastModified value the caller obtained from a prior read_page (or list_pages). If the server's current value differs, the write is rejected with a conflict error and the caller should re-read to reconcile. Refuses to create new pages; route those through create_page. Refuses paths under _trash/. Body is capped at 256 KB. Returns the new lastModified, leaving the caller write-ready for further overwrites. For adding to existing content, prefer append_to_page or prepend_to_page (no version handshake needed, since they merge server-side).",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
        body: z.string().describe("Full markdown content to write (replaces any existing body)"),
        expected_last_modified: z
          .coerce
          .number()
          .int()
          .describe(
            "The lastModified value from a prior read_page (ms since epoch). The write only succeeds if the server's current lastModified matches. Accepted as either a JSON number or a numeric string — some MCP clients serialize large integers as strings on the wire.",
          ),
      },
    },
    async ({ page, body, expected_last_modified }) => {
      try {
        const result = await sb.writePage(page, body, expected_last_modified);
        logWrite("write", result.path, Buffer.byteLength(body, "utf8"), {
          expected_last_modified,
          last_modified: result.lastModified,
        });
        const payload = {
          written: true,
          path: result.path,
          lastModified: result.lastModified,
        };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return mapToolError(err, { tool: "write_page", page });
      }
    },
  );

  server.registerTool(
    "append_to_page",
    {
      title: "Append to page",
      description:
        "Append a block of text to the end of an existing page, separated by a blank line. Errors if the page does not exist — use create_page for new pages. The existing page body is read server-side and never round-trips through this conversation, which avoids accidental modification of existing content. Final page size is capped at 256 KB. Does not return lastModified — append intentionally leaves the caller without a version marker, since you have not seen the full body and so are not in a position to follow up with write_page. Call read_page if you need to.",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
        content: z.string().min(1).describe("Text to append"),
      },
    },
    async ({ page, content }) => {
      try {
        const result = await sb.appendToPage(page, content);
        logWrite("append", result.path, result.bytesAdded);
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return mapToolError(err, { tool: "append_to_page", page });
      }
    },
  );

  server.registerTool(
    "prepend_to_page",
    {
      title: "Prepend to page",
      description:
        "Insert content at the top of an existing page. By default, inserts after YAML frontmatter if present (so frontmatter stays at byte 0); set position to \"top\" to force insertion at byte 0 even when frontmatter exists. Errors if the page does not exist — use create_page for new pages. The existing page body is read server-side and never round-trips through this conversation. Final page size is capped at 256 KB. Does not return lastModified — prepend intentionally leaves the caller without a version marker, since you have not seen the full body and so are not in a position to follow up with write_page. Call read_page if you need to.",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
        content: z.string().min(1).describe("Text to insert"),
        position: z
          .enum(["after_frontmatter", "top"])
          .optional()
          .describe("Where to insert when the page has YAML frontmatter. Default 'after_frontmatter'."),
      },
    },
    async ({ page, content, position }) => {
      try {
        const result = await sb.prependToPage(page, content, { position });
        logWrite("prepend", result.path, result.bytesAdded, {
          inserted_after_frontmatter: result.insertedAfterFrontmatter,
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        return mapToolError(err, { tool: "prepend_to_page", page });
      }
    },
  );

  server.registerTool(
    "delete_page",
    {
      title: "Delete page (soft delete)",
      description:
        "Soft-delete a page by moving it to _trash/<YYYY-MM>/<original-path>. Recoverable from within SilverBullet itself. Always confirm with the user before calling. Returns the trash path so the user can find the moved file if they want to restore it.",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
      },
    },
    async ({ page }) => {
      try {
        const result = await sb.softDeletePage(page);
        logWrite("delete", page, 0, { trash_path: result.trashPath });
        const payload = { deleted: true, trashPath: result.trashPath };
        return {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        };
      } catch (err) {
        return mapToolError(err, { tool: "delete_page", page });
      }
    },
  );

  server.registerTool(
    "move_page",
    {
      title: "Move page",
      description:
        "Move a page to a new location (read → create destination → delete source). Refuses if the destination already exists. If the source was edited between the read and the delete, the delete is skipped — leaving a recoverable duplicate at the destination rather than losing interim edits. Does NOT rewrite [[backlinks]] — SilverBullet's backlink-rewriting Rename is an editor-only command, not reachable over HTTP. Returns {from, to, moved} with no version marker. One approval covers both the create and the soft-delete.",
      inputSchema: {
        from: z.string().min(1).describe("Source page name to move"),
        to: z.string().min(1).describe("Destination page name"),
      },
    },
    async ({ from, to }) => {
      try {
        const result = await sb.movePage(from, to);
        logWrite("move", from, 0, { from: result.from, to: result.to });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        };
      } catch (err) {
        if (err instanceof ConflictError) {
          const conflictResult = mapToolError(err, { tool: "move_page", page: from });
          const payload = JSON.parse(conflictResult.content[0].text);
          payload.remediation =
            "The source page was modified after move_page read it. The destination may contain a duplicate. " +
            "Re-read the source page to check its current state, and remove the duplicate at the destination if needed.";
          delete payload.expectedLastModified;
          return {
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        }
        return mapToolError(err, { tool: "move_page", page: from });
      }
    },
  );

  return server;
}
