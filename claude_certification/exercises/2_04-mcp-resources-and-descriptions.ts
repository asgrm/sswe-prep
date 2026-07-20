// Exercise 2.04 - MCP resources and enhanced tool descriptions (Task Statement 2.4)
// Run: npx tsx 2_04-mcp-resources-and-descriptions.ts
//
// Steps (4 and 5 of the exercise; 1-2 are covered by .mcp.json, 3 skipped):
//   4. Expose a content catalogue (db schema) as an MCP resource at db://schema/main
//      with a name, description, and mimeType, so the agent can see what data
//      exists without exploratory tool calls
//   5. Register a tool with an enhanced 3-5 sentence description (what it does,
//      what it returns, when to use it, when to prefer the built-in alternative)
//
// The verification harness at the bottom checks the acceptance criteria and
// prints PASS/FAIL - it runs even while the TODOs are empty, and passes once
// both registrations are in place.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const server = new McpServer({ name: "db-tools", version: "1.0.0" });

// --- Step 4: TODO - register the schema catalogue resource -------------------
//
// Use server.registerResource(name, uri, config, handler):
//   - name:    "db-schema"
//   - uri:     "db://schema/main"
//   - config:  { description, mimeType } (this is what the agent sees at discovery)
//   - handler: async (uri) => ({ contents: [{ uri: uri.href, mimeType, text }] })
//     where text is JSON.stringify(...) of a tables/columns structure

server.registerResource(
  "db-schema",
  "db://schema/main",
  {
    description:
      "Database schema catalogue: every table with its columns and types. " +
      "Read this before writing queries instead of exploring the database with tool calls.",
    mimeType: "application/json",
  },
  async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: "application/json",
        text: JSON.stringify(
          {
            tables: [
              {
                name: "customers",
                columns: [
                  { name: "id", type: "integer", primaryKey: true },
                  { name: "email", type: "text" },
                  { name: "name", type: "text" },
                  { name: "tier", type: "text" },
                ],
              },
              {
                name: "orders",
                columns: [
                  { name: "id", type: "integer", primaryKey: true },
                  { name: "customer_id", type: "integer", references: "customers.id" },
                  { name: "status", type: "text" },
                  { name: "total", type: "numeric" },
                ],
              },
            ],
          },
          null,
          2
        ),
      },
    ],
  })
);

// --- Step 5: TODO - register a tool with an enhanced description -------------
//
// Use server.registerTool(name, { description, inputSchema }, handler) as in 2_01.
// The description must cover, in 3-5 sentences:
//   1. what the tool does
//   2. what it returns (format and fields)
//   3. when to use it
//   4. when to use the built-in alternative (e.g. Grep) instead

server.registerTool(
  "search_codebase",
  {
    description:
      "Performs semantic code search across the entire repository using AST-aware indexing. " +
      "Returns matching functions, classes, and methods with full context: file path, line numbers, and surrounding code. " +
      "More accurate than text-based Grep for finding code by intent rather than exact string match. " +
      'Use this instead of Grep when searching for code by what it does (such as "where do we validate auth tokens?"). ' +
      "Prefer Grep when you already know the exact identifier or string to match - it is faster for literal lookups.",
    inputSchema: {
      query: z
        .string()
        .describe("Natural-language description of the code you are looking for, e.g. 'retry logic for failed API calls'"),
    },
  },
  async ({ query }) => {
    return { content: [{ type: "text", text: `Results for: ${query}` }] };
  }
);

// --- Verification harness (acceptance criteria) ------------------------------

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcpClient = new Client({ name: "harness", version: "1.0.0" });
await Promise.all([
  server.connect(serverTransport),
  mcpClient.connect(clientTransport),
]);

function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` | ${detail}` : ""}`);
  return ok;
}

// Step 4 criteria: a discoverable resource with name, description, mimeType,
// readable at db://schema/main, returning parseable structured JSON.
const { resources } = await mcpClient.listResources();
const schema = resources.find((r) => r.uri === "db://schema/main");
check("resource exists at db://schema/main", !!schema);
check("resource has a description", !!schema?.description, schema?.description ?? "");
check("resource has a mimeType", !!schema?.mimeType, schema?.mimeType ?? "");

if (schema) {
  const { contents } = await mcpClient.readResource({ uri: schema.uri });
  // Resource contents are a text/blob union - narrow before touching .text.
  const first = contents[0];
  const text = first && "text" in first ? first.text : undefined;
  let parsed: unknown = undefined;
  try {
    parsed = typeof text === "string" ? JSON.parse(text) : undefined;
  } catch {}
  check("resource content is valid JSON with tables", !!parsed && typeof parsed === "object" && "tables" in (parsed as object));
}

// Step 5 criteria: at least one tool whose description is 3-5 sentences and
// mentions the built-in alternative it competes with.
const { tools } = await mcpClient.listTools();
check("at least one tool registered", tools.length > 0);
for (const t of tools) {
  const description = t.description ?? "";
  const sentences = description.split(/[.!?]+\s|[.!?]+$/).filter((s) => s.trim().length > 0);
  check(
    `tool "${t.name}" description is 3-5 sentences`,
    sentences.length >= 3 && sentences.length <= 5,
    `${sentences.length} sentence(s)`
  );
  check(
    `tool "${t.name}" description names a built-in alternative`,
    /grep|glob|read|bash/i.test(description)
  );
  console.log(`\n${t.name}: ${description}\n`);
}
