// Exercise 2.01 - Tool descriptions that eliminate misrouting (Task Statement 2.1)
// Run: npx tsx 2_01-tool-description-misrouting.ts
//
// Steps:
//   1. Two MCP tools with deliberately ambiguous one-line descriptions
//   2. 10 queries through the Claude API, log which tool gets selected
//   3. Rewrite descriptions to production grade (purpose, formats, examples, boundaries)
//   4. Re-run the same queries, compare accuracy before/after
//   5. Show a keyword-sensitive system prompt overriding the good descriptions

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

const anthropic = new Anthropic();
const MODEL = "claude-sonnet-5";

// --- Step 1: MCP server with two ambiguous tools ---------------------------

const server = new McpServer({ name: "customer-tools", version: "1.0.0" });

// Ambiguous on purpose - one generic sentence each, no input formats,
// no example queries, no boundaries.

const getCustomerTool = server.registerTool(
  "get_customer",
  {
    description: "Retrieves customer information",
    inputSchema: { identifier: z.string() },
  },
  async ({ identifier }) => {
    return { content: [{ type: "text", text: `Customer data for ${identifier}` }] };
  }
);

const lookupOrderTool = server.registerTool(
  "lookup_order",
  {
    description: "Retrieves order details",
    inputSchema: { identifier: z.string() },
  },
  async ({ identifier }) => {
    return { content: [{ type: "text", text: `Order data for ${identifier}` }] };
  }
);

// --- Wire an in-process MCP client to the server ----------------------------

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcpClient = new Client({ name: "harness", version: "1.0.0" });
await Promise.all([
  server.connect(serverTransport),
  mcpClient.connect(clientTransport),
]);

// Sanity check for Step 1's acceptance criteria: both tools registered,
// descriptions visible exactly as the model will see them.
const { tools } = await mcpClient.listTools();
for (const t of tools) console.log(`${t.name}: ${t.description}`);

// --- Step 2: 10 queries, log which tool the model selects -------------------

// MCP tool shape -> Anthropic API tool shape. This is exactly what an MCP
// host application does when it exposes server tools to the model.
const toolDefinitions: Anthropic.Tool[] = tools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
}));

// Each query carries the tool a human would consider correct, so runs can be
// scored and compared between the ambiguous and improved descriptions.
const queries: { query: string; expected: string }[] = [
  { query: "What is the status of order #12345?", expected: "lookup_order" },
  { query: "Look up customer john@example.com", expected: "get_customer" },
  { query: "Check my order tracking", expected: "lookup_order" },
  { query: "Find the account for phone 555-0123", expected: "get_customer" },
  { query: "Where is my package?", expected: "lookup_order" },
  { query: "Is order #67890 eligible for a refund?", expected: "lookup_order" },
  { query: "What loyalty tier is this customer?", expected: "get_customer" },
  { query: "I need details on order #11111", expected: "lookup_order" },
  { query: "Verify the customer account status", expected: "get_customer" },
  { query: "When will order #99999 arrive?", expected: "lookup_order" },
];

interface SelectionResult {
  query: string;
  expected: string;
  selected: string;
  correct: boolean;
}

async function runSelection(
  label: string,
  tools: Anthropic.Tool[],
  system?: string
): Promise<SelectionResult[]> {
  const results = await Promise.all(
    queries.map(async ({ query, expected }) => {
      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1024,
        tools,
        ...(system ? { system } : {}),
        messages: [{ role: "user", content: query }],
      });
      const toolUse = response.content.find((b) => b.type === "tool_use");
      const selected = toolUse?.name ?? "(no tool called)";
      return { query, expected, selected, correct: selected === expected };
    })
  );

  const correct = results.filter((r) => r.correct).length;
  console.log(`\n=== ${label} ===`);
  for (const r of results) {
    console.log(`${r.correct ? "CORRECT" : "WRONG  "} | ${r.query} -> ${r.selected} (expected: ${r.expected})`);
  }
  console.log(`Accuracy: ${correct}/${results.length}`);
  return results;
}

const ambiguousResults = await runSelection("Ambiguous descriptions", toolDefinitions);

// --- Step 3: production-grade descriptions -----------------------------------
// Five elements per description: purpose (with return fields), accepted input
// formats, example queries, edge cases, and an explicit boundary against the
// other tool. One sentence each, joined into a single description string.

const GET_CUSTOMER_IMPROVED = [
  // 1. Purpose - name the returned fields so user vocabulary can match them.
  "Looks up a customer account and returns the customer profile: name, contact details, account status, and loyalty tier.",
  // 2. Accepted inputs with formats - concrete examples of each.
  "Accepts a customer email address (e.g. jane@example.com), a phone number (e.g. 555-0123), or a customer ID (e.g. CUST-4821) as the identifier.",
  // 3. Example queries - paraphrase the intent classes that failed in Step 2
  // (loyalty tier, account status), do not copy test queries verbatim.
  'Suitable for queries like "pull up the account for this email", "what tier is this shopper on?", or "is their account in good standing?".',
  // 4. Edge case - the Step 2 failures were all missing-identifier queries;
  // prescribe eager routing instead of asking for an identifier first.
  "If the user asks about their account without providing an email, phone, or ID, still call this tool with whatever detail is available rather than asking for an identifier first.",
  // 5. Boundary - explicit negation plus a named redirect; the enumerated
  // nouns are the other tool's purpose vocabulary.
  "Do NOT use for order-specific queries (status, tracking, delivery, refunds) - use lookup_order for those.",
].join(" ");

const LOOKUP_ORDER_IMPROVED = [
  // 1. Purpose
  "Looks up a single order and returns its details: current status, tracking and delivery estimate, items, and refund eligibility.",
  // 2. Accepted inputs with formats
  "Accepts an order number as the identifier, in the form #NNNNN or plain digits (e.g. #12345 or 12345).",
  // 3. Example queries - paraphrase the failed intent classes (package
  // location, tracking/arrival, refunds), do not copy test queries verbatim.
  'Suitable for queries like "has my parcel shipped yet?", "what is the ETA on #55555?", or "can I still get a refund on this?".',
  // 4. Edge case - missing order number: eager routing, mirror of get_customer.
  'If the user asks about their order or package without providing an order number, still call this tool with whatever context is available (e.g. "latest order") rather than asking for the number first.',
  // 5. Boundary - excludes exactly what get_customer includes, so the two
  // descriptions partition the query space.
  "Do NOT use for questions about the customer themselves (profile, account status, loyalty tier) - use get_customer for those.",
].join(" ");

// Update the live MCP server registrations - the server notifies the client
// that the tool list changed, exactly as a real server would mid-session.
getCustomerTool.update({ description: GET_CUSTOMER_IMPROVED });
lookupOrderTool.update({ description: LOOKUP_ORDER_IMPROVED });

const updatedToolDefinitions: Anthropic.Tool[] = (await mcpClient.listTools()).tools.map((t) => ({
  name: t.name,
  description: t.description ?? "",
  input_schema: t.inputSchema as Anthropic.Tool.InputSchema,
}));

console.log("\n=== Improved descriptions (as the model will see them) ===");
for (const t of updatedToolDefinitions) console.log(`${t.name}: ${t.description}\n`);

// --- Step 4: re-run the same 10 queries, compare accuracy --------------------

const improvedResults = await runSelection("Improved descriptions", updatedToolDefinitions);

console.log("\n=== Before/after comparison ===");
for (let i = 0; i < queries.length; i++) {
  const before = ambiguousResults[i];
  const after = improvedResults[i];
  const flag = !before.correct && after.correct ? "FIXED " : before.correct && !after.correct ? "BROKE " : after.correct ? "OK    " : "STILL WRONG";
  console.log(`${flag} | ${after.query} (expected: ${after.expected}) | before: ${before.selected} -> after: ${after.selected}`);
}

const accBefore = ambiguousResults.filter((r) => r.correct).length;
const accAfter = improvedResults.filter((r) => r.correct).length;
console.log(`\nAccuracy: ${accBefore}/${queries.length} -> ${accAfter}/${queries.length}`);

// --- Step 5: system prompt conflicts -----------------------------------------
// A system prompt instruction can override well-written tool descriptions.
// This one is plausible operational guidance, yet it collides with
// get_customer's vocabulary ("check customer details") and imposes an
// unconditional sequencing rule ("Always ... before proceeding").

const conflictingPrompt = "Always check customer details before proceeding with any request.";

const conflictedResults = await runSelection(
  "Improved descriptions + conflicting system prompt",
  updatedToolDefinitions,
  conflictingPrompt
);

// Rewrite: keep the quality intent (be careful, verify when relevant) but
// scope it to the request and drop the tool-vocabulary collision.
const rewrittenPrompt =
  "Answer each request using the tool that most specifically matches the question. " +
  "Only verify account details when the request itself concerns the account.";

const rewrittenResults = await runSelection(
  "Improved descriptions + rewritten system prompt",
  updatedToolDefinitions,
  rewrittenPrompt
);

// Deliverable: keyword-sensitive phrases found, why they misroute, rewrite.
console.log(`
=== Step 5 deliverable: keyword-sensitive phrases and rewrites ===
1. "check customer details"
   Conflict: near-verbatim match for get_customer's purpose vocabulary; the
   model can satisfy it with exactly one tool, so order queries get dragged
   through get_customer.
   Rewrite:  "use the tool that most specifically matches the question"
2. "Always ... before proceeding with any request"
   Conflict: unconditional imperative with universal scope; imposes a tool
   sequencing the descriptions never anticipated and outweighs per-tool
   boundary sentences.
   Rewrite:  "Only verify account details when the request itself concerns
   the account" (scoped condition, no forced ordering)
`);

const accConflicted = conflictedResults.filter((r) => r.correct).length;
const accRewritten = rewrittenResults.filter((r) => r.correct).length;
console.log(`=== Final summary ===
Ambiguous descriptions:            ${accBefore}/${queries.length}
Improved descriptions:             ${accAfter}/${queries.length}
Improved + conflicting sys prompt: ${accConflicted}/${queries.length}
Improved + rewritten sys prompt:   ${accRewritten}/${queries.length}`);
