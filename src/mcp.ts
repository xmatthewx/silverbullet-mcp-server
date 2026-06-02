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
import { ConflictError, PageNotFoundError, SilverBulletClient } from "./sb.js";

type WriteAction = "create" | "write" | "append" | "prepend" | "delete";

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

export function buildMcpServer(sb: SilverBulletClient): McpServer {
  const server = new McpServer({
    name: "silverbullet",
    version: "0.3.0",
  });

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "Return every markdown page in the SilverBullet space, sorted by last modified. Each entry carries {page, path, lastModified}. Use this to discover what notes exist before reading or searching. The lastModified value is suitable as expected_last_modified on write_page, though usually you'll want to read_page first to also see the body.",
      inputSchema: {
        include_trash: z
          .boolean()
          .optional()
          .describe("Include soft-deleted pages under _trash/ in the result. Default false."),
      },
    },
    async ({ include_trash }) => {
      const pages = await sb.listPages({ includeTrash: include_trash });
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
    },
  );

  server.registerTool(
    "search_pages",
    {
      title: "Search pages",
      description:
        "Case-insensitive substring search across page titles and page bodies. Returns the top matches with a short snippet around each hit. Slow on first call for large spaces (no index yet).",
      inputSchema: {
        query: z.string().min(1).describe("Substring to search for"),
        limit: z
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
      const hits = await sb.searchPages(query, limit ?? 20, { includeTrash: include_trash });
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
      const result = await sb.createPage(page, body);
      logWrite("create", result.path, Buffer.byteLength(body, "utf8"), {
        last_modified: result.lastModified,
      });
      const payload = { created: true, path: result.path, lastModified: result.lastModified };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
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
          .number()
          .int()
          .describe(
            "The lastModified value from a prior read_page (ms since epoch). The write only succeeds if the server's current lastModified matches.",
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
        if (err instanceof ConflictError) {
          const payload = {
            error: "conflict",
            message: err.message,
            path: err.path,
            expectedLastModified: err.expectedLastModified,
            actualLastModified: err.actualLastModified,
            remediation: "Call read_page to fetch the current body and lastModified, then retry write_page.",
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        }
        if (err instanceof PageNotFoundError) {
          const payload = {
            error: "not_found",
            message: err.message,
            path: err.path,
            remediation: "Use create_page for new pages.",
          };
          return {
            isError: true,
            content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          };
        }
        throw err;
      }
    },
  );

  server.registerTool(
    "append_to_page",
    {
      title: "Append to page",
      description:
        "Append a block of text to the end of a page, separated by a blank line. Creates the page if it does not exist. The existing page body is read server-side and never round-trips through this conversation, which avoids accidental modification of existing content. Final page size is capped at 256 KB. Does not return lastModified — append intentionally leaves the caller without a version marker, since you have not seen the full body and so are not in a position to follow up with write_page. Call read_page if you need to.",
      inputSchema: {
        page: z.string().min(1).describe("Page name relative to the space root, without the .md suffix"),
        content: z.string().min(1).describe("Text to append"),
      },
    },
    async ({ page, content }) => {
      const result = await sb.appendToPage(page, content);
      logWrite("append", result.path, result.bytesAdded);
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
    },
  );

  server.registerTool(
    "prepend_to_page",
    {
      title: "Prepend to page",
      description:
        "Insert content at the top of a page. By default, inserts after YAML frontmatter if present (so frontmatter stays at byte 0); set position to \"top\" to force insertion at byte 0 even when frontmatter exists. Creates the page if it does not exist. The existing page body is read server-side and never round-trips through this conversation. Final page size is capped at 256 KB. Does not return lastModified — prepend intentionally leaves the caller without a version marker, since you have not seen the full body and so are not in a position to follow up with write_page. Call read_page if you need to.",
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
      const result = await sb.prependToPage(page, content, { position });
      logWrite("prepend", result.path, result.bytesAdded, {
        inserted_after_frontmatter: result.insertedAfterFrontmatter,
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
      };
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
      const result = await sb.softDeletePage(page);
      logWrite("delete", page, 0, { trash_path: result.trashPath });
      const payload = { deleted: true, trashPath: result.trashPath };
      return {
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
      };
    },
  );

  return server;
}
