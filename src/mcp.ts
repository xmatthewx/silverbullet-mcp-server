/**
 * MCP server definition.
 *
 * Three read-only tools:
 *   - list_pages   : enumerate markdown pages in the space
 *   - read_page    : fetch the full markdown source of one page
 *   - search_pages : substring search across all pages
 *
 * Write tools (write_page, append_to_page, delete_page) will be added in a
 * later milestone. See README.md for the roadmap.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { SilverBulletClient } from "./sb.js";

export function buildMcpServer(sb: SilverBulletClient): McpServer {
  const server = new McpServer({
    name: "silverbullet",
    version: "0.1.0",
  });

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description:
        "Return every markdown page in the SilverBullet space, sorted by last modified. Use this to discover what notes exist before reading or searching.",
      inputSchema: {},
    },
    async () => {
      const pages = await sb.listPages();
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
        "Return the raw markdown source of a page. Accepts a page name with or without the .md suffix (e.g. 'projects/silverbullet-mcp' or 'index').",
      inputSchema: {
        page: z
          .string()
          .min(1)
          .describe("Page name relative to the space root, without the .md suffix"),
      },
    },
    async ({ page }) => {
      const body = await sb.readPage(page);
      return {
        content: [{ type: "text", text: body }],
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
      },
    },
    async ({ query, limit }) => {
      const hits = await sb.searchPages(query, limit ?? 20);
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

  return server;
}
