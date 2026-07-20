// Exercise 2.02 - Structured error responses for all four categories (Task Statement 2.2)
// Run: npx tsx 2_02-structured-error-responses.ts
//
// Steps:
//   1. MCP tool (customer_lookup) with simulated failure modes
//   2. Four error response types: transient, validation, business, permission
//   3. Consistent structured metadata: errorCategory, isRetryable, description
//   4. Valid empty result (isError: false) vs access failure (isError: true)
//   5. Agent recovery loop that branches on the error metadata

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";

// --- Step 1: MCP server with one tool and on-demand failure simulation ------

const server = new McpServer({ name: "customer-db", version: "1.0.0" });

// --- Step 3: one builder guarantees every error carries the same three
// metadata fields - a missed field here would break the agent's recovery
// branching in Step 5.

type ErrorCategory = "transient" | "validation" | "business" | "permission";

function buildErrorResponse(category: ErrorCategory, retryable: boolean, description: string) {
  return {
    isError: true,
    content: [{
      type: "text" as const,
      text: JSON.stringify({
        errorCategory: category,
        isRetryable: retryable,
        description,
      }),
    }],
  };
}

const customerLookupInput = {
  identifier: z.string().describe("Customer email or ID"),
  mode: z
    .enum(["success", "not_found", "timeout", "invalid", "business", "permission"])
    .default("success")
    .describe("Which outcome to simulate"),
};

type CustomerLookupArgs = z.infer<z.ZodObject<typeof customerLookupInput>>;

// Step 2: four error categories. MCP only standardises isError and
// content, so errorCategory / isRetryable / description travel as JSON
// inside the text content - the agent parses them back out in Step 5.
const customerLookupHandler = async ({ identifier, mode }: CustomerLookupArgs) => {
  switch (mode) {
      case "timeout":
        // Transient: the request is fine, the environment hiccuped.
        // Retrying the SAME input can succeed.
        return buildErrorResponse(
          "transient", true,
          "Customer database timed out after 5 seconds. The request is valid and should succeed on retry."
        );
      case "invalid":
        // Validation: retryable, but only after the agent FIXES the input -
        // the description spells out the accepted formats so it can.
        return buildErrorResponse(
          "validation", true,
          `Invalid identifier format: ${identifier}. Expected email (user@domain.com) or ID (CUST-NNNNN).`
        );
      case "business":
        // Business: the request executed against a policy and lost. No retry
        // can change the policy - a human must decide.
        return buildErrorResponse(
          "business", false,
          "Refund of £750 exceeds the £500 automatic limit. Escalate to a manager with refund details."
        );
      case "permission":
        // Permission: not retryable with the CURRENT credentials - retrying
        // as-is yields the identical denial. Needs elevation, not repetition.
        return buildErrorResponse(
          "permission", false,
          "Current service account lacks access to financial records. Escalate to a senior agent."
        );
      // --- Step 4: both branches below are NOT errors - the query executed.
      case "not_found":
        // Valid empty result: structurally a success (isError: false) with
        // resultCount: 0. Contrast with "timeout" above, where the query
        // never executed at all.
        return {
          isError: false,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              resultCount: 0,
              message: `No customer found matching ${identifier}. The query executed successfully but returned no matches.`,
            }),
          }],
        };
      case "success":
        return {
          isError: false,
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              resultCount: 1,
              customer: {
                id: "CUST-4821",
                email: identifier,
                name: "Jane Doe",
                status: "active",
                loyaltyTier: "gold",
              },
            }),
          }],
        };
    }
};

server.registerTool(
  "customer_lookup",
  {
    description:
      "Looks up a customer by email address (e.g. jane@example.com) or customer ID (e.g. CUST-4821) " +
      "and returns the customer profile. Test harness only: the mode parameter simulates a specific " +
      "outcome (success, empty result, or one of four failure categories) on demand.",
    inputSchema: customerLookupInput,
  },
  customerLookupHandler
);

// --- Wire an in-process MCP client to the server -----------------------------

const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
const mcpClient = new Client({ name: "harness", version: "1.0.0" });
await Promise.all([
  server.connect(serverTransport),
  mcpClient.connect(clientTransport),
]);

// Step 1 acceptance criteria: tool registered and callable, mode parameter
// visible in the schema exactly as the model would see it.
const { tools } = await mcpClient.listTools();
for (const t of tools) {
  console.log(`${t.name}: ${t.description}`);
  console.log(`schema: ${JSON.stringify(t.inputSchema, null, 2)}`);
}

// Steps 2+3 acceptance criteria: each error mode returns isError: true and
// parses to a JSON object with EXACTLY three fields of the right types -
// anything less would break the agent recovery branching in Step 5.
const CATEGORIES = ["transient", "validation", "business", "permission"];

for (const mode of ["timeout", "invalid", "business", "permission"]) {
  const result = await mcpClient.callTool({
    name: "customer_lookup",
    arguments: { identifier: "jane@example.com", mode },
  });
  const meta = JSON.parse((result.content as { text: string }[])[0].text);
  const checks = [
    result.isError === true,
    Object.keys(meta).length === 3,
    CATEGORIES.includes(meta.errorCategory),
    typeof meta.isRetryable === "boolean",
    typeof meta.description === "string",
  ];
  console.log(`\nmode=${mode}: isError=${result.isError} | metadata valid: ${checks.every(Boolean) ? "PASS" : "FAIL"}`);
  console.log(`  errorCategory=${meta.errorCategory}, isRetryable=${meta.isRetryable}`);
  console.log(`  description: ${meta.description}`);
}

// Step 4 acceptance criteria: valid empty result vs access failure - same
// identifier, structurally different responses. not_found is a SUCCESS with
// zero rows; timeout is an ERROR where the query never ran.
console.log("\n=== Step 4: empty result vs access failure ===");
for (const mode of ["not_found", "timeout", "success"]) {
  const result = await mcpClient.callTool({
    name: "customer_lookup",
    arguments: { identifier: "ghost@example.com", mode },
  });
  const body = JSON.parse((result.content as { text: string }[])[0].text);
  console.log(`\nmode=${mode}: isError=${result.isError ?? false}`);
  console.log(`  body: ${JSON.stringify(body)}`);
}

// --- Step 5: agent recovery loop ---------------------------------------------
// The recovery logic OWNS the callTool loop - a handler that merely receives
// a finished result can log intentions but cannot retry. Branching order:
// isRetryable first (retry-shaped vs escalate-shaped), errorCategory second
// (which retry / which escalation). That way an error category this agent has
// never seen still gets a sane default from the boolean alone.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const MAX_RETRIES = 3;

// A real agent would re-derive the identifier from the formats quoted in the
// error description (likely via the model). Here: canonicalise to CUST-NNNNN.
function fixIdentifier(raw: string): string {
  const digits = raw.replace(/\D/g, "").slice(0, 5).padEnd(5, "0");
  return `CUST-${digits}`;
}

async function lookupCustomer(identifier: string, mode: CustomerLookupArgs["mode"]) {
  let currentIdentifier = identifier;
  let inputFixed = false; // validation gets ONE reformat attempt, not a loop

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await mcpClient.callTool({
      name: "customer_lookup",
      arguments: { identifier: currentIdentifier, mode },
    });
    const body = JSON.parse((result.content as { text: string }[])[0].text);

    if (!result.isError) {
      // The Step 4 payoff lives HERE, in the success path: zero rows is a
      // final answer, never a retry.
      if (body.resultCount === 0) {
        console.log(`  Valid empty result: ${body.message} Do NOT retry.`);
        return null;
      }
      console.log(`  Success: ${JSON.stringify(body.customer)}`);
      return body.customer;
    }

    // Non-retryable: repetition cannot change policy or privileges.
    // Pick the escalation path and stop.
    if (!body.isRetryable) {
      switch (body.errorCategory) {
        case "business":
          console.log(`  ESCALATE to manager: ${body.description}`);
          break;
        case "permission":
          console.log(`  REQUEST elevated credentials: ${body.description}`);
          break;
        default:
          // Unknown category, but the boolean already says "don't retry".
          console.log(`  Unknown non-retryable error, escalating: ${body.description}`);
      }
      return null;
    }

    // Retryable: decide what to CHANGE before the next attempt.
    if (body.errorCategory === "validation") {
      if (inputFixed) {
        console.log("  Reformatted input still rejected - escalating instead of looping.");
        return null;
      }
      inputFixed = true;
      currentIdentifier = fixIdentifier(currentIdentifier);
      console.log(`  Validation error - reformatted identifier to ${currentIdentifier}, retrying.`);
      continue;
    }

    // transient (or unknown-but-retryable): same input, exponential backoff.
    if (attempt === MAX_RETRIES) {
      console.log(`  Transient error persisted after ${MAX_RETRIES} retries - giving up, escalate.`);
      return null;
    }
    const delay = 1000 * 2 ** attempt; // 1s, 2s, 4s
    console.log(`  Transient error - retry ${attempt + 1}/${MAX_RETRIES} after ${delay}ms.`);
    await sleep(delay);
  }
  return null;
}

// Step 5 acceptance criteria: one run per mode, watch the branching.
// (The simulator never stops failing, so the retry paths also demonstrate
// their exit conditions: the 3-retry cap and the single-reformat guard.)
for (const mode of ["success", "not_found", "timeout", "invalid", "business", "permission"] as const) {
  console.log(`\n=== Step 5: agent recovery, mode=${mode} ===`);
  await lookupCustomer("jane@example.com", mode);
}
