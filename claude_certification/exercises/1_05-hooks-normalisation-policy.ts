// Exercise 05 - Hooks for data normalisation (PostToolUse) and policy enforcement (PreToolUse)
// Run: npx tsx 1_05-hooks-normalisation-policy.ts
//
// Steps:
//   1. Three tools with inconsistent formats:
//      - Tool A: Unix timestamps (1710489600), numeric status codes (200)
//      - Tool B: ISO 8601 dates ("2024-03-15T12:00:00Z"), string statuses ("active")
//      - Tool C: DD/MM/YYYY dates ("15/03/2024"), single-char codes ("S" shipped, "P" pending)
//   2. PostToolUse hook: normalise ALL results -> ISO 8601 dates + human-readable
//      English status strings (200 -> "active", "S" -> "shipped", "P" -> "pending")
//   3. Verify: one query calling all three tools; model must only ever see
//      consistent data regardless of source tool
//   4. PreToolUse hook: block process_refund when amount > $500, return
//      human-escalation message (tool must NEVER execute when blocked)
//   5. PreToolUse hook: block transfer_funds until aml_check has passed
//      in the current session (session-scoped state)
//   6. Tests: high refund blocked, transfer-without-AML blocked,
//      AML pass then transfer allowed

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 20;

// ---------------------------------------------------------------------------
// Session-scoped state (Step 5)
// ---------------------------------------------------------------------------
// An AML pass authorises transfers for THIS session only. Written by the
// aml_check HANDLER (via the normal execution path), read by the PreToolUse
// guard. Reset between test scenarios - each scenario is one fresh session.
const amlState = { passed: false };

// ---------------------------------------------------------------------------
// Tool definitions + handlers (Step 1)
// ---------------------------------------------------------------------------
// Best practices applied:
//   - No output_schema: not part of the Anthropic tool definition (name,
//     description, input_schema only). outputSchema exists in MCP proper;
//     here the output contract is enforced by the PostToolUse hook instead.
//   - Descriptions are format-agnostic: the tool description's only reader is
//     the model, and the model only ever sees post-normalisation data. The raw
//     messy formats are an implementation detail, documented on the handlers.

const tools: Anthropic.Tool[] = [
  {
    name: "get_customer",
    description:
      "Fetches the customer record: customer_id, creation timestamp, account status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_order",
    description:
      "Fetches the order record: order_id, creation timestamp, lifecycle status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "get_shipment",
    description:
      "Fetches the shipment record: shipment_id, creation timestamp, shipment status.",
    input_schema: { type: "object", properties: {}, additionalProperties: false },
  },
];

// Deliberately messy: Unix epoch SECONDS + HTTP-style numeric status (200 = active).
// Normalised by the PostToolUse hook (Step 2).
function toolAHandler(): Record<string, unknown> {
  return { customer_id: "C-001", created_at: 1710489600, status: 200 };
}

// Already clean: ISO 8601 + string status. Control case - the hook must pass
// this through untouched.
function toolBHandler(): Record<string, unknown> {
  return { order_id: "ORD-42", created_at: "2024-03-15T12:00:00Z", status: "active" };
}

// Deliberately messy: DD/MM/YYYY (day precedes month) + single-letter code.
// Status domain: "S" shipped, "P" pending. Normalised by the PostToolUse hook.
function toolCHandler(): Record<string, unknown> {
  return { shipment_id: "SHP-7", created_at: "15/03/2024", status: "S" };
}

// Handlers take the tool input; the three data handlers simply ignore it.
type ToolHandler = (input: Record<string, unknown>) => Record<string, unknown>;

const handlers: Record<string, ToolHandler> = {
  get_customer: toolAHandler,
  get_order: toolBHandler,
  get_shipment: toolCHandler,
};

// --- Financial tools (Steps 4 & 5) ---

tools.push({
  name: "process_refund",
  description:
    "Processes a refund to the customer's original payment method. Requires the order ID and the refund amount in USD.",
  input_schema: {
    type: "object",
    properties: {
      order_id: { type: "string" },
      amount: { type: "number", description: "Refund amount in USD" },
    },
    required: ["order_id", "amount"],
    additionalProperties: false,
  },
});

let refundCounter = 0;

// NOTE: this handler must be unreachable for amounts > $500. The refund
// counter doubles as proof: if a blocked call ever executed, it would tick.
handlers.process_refund = (input) => {
  refundCounter++;
  return {
    success: true,
    refund_id: `REF-${String(refundCounter).padStart(4, "0")}`,
    order_id: input.order_id,
    amount: input.amount,
    status: "processed",
  };
};

tools.push(
  {
    name: "aml_check",
    description:
      "Runs an anti-money-laundering (AML) verification for a customer. Must pass before international transfers can be processed.",
    input_schema: {
      type: "object",
      properties: {
        customer_id: { type: "string" },
      },
      required: ["customer_id"],
      additionalProperties: false,
    },
  },
  {
    name: "transfer_funds",
    description:
      "Transfers funds to an external account. Requires the destination account and the amount in USD.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: "Destination account, e.g. an IBAN" },
        amount: { type: "number", description: "Transfer amount in USD" },
      },
      required: ["to", "amount"],
      additionalProperties: false,
    },
  },
);

// Mock: always passes. The state flip is conditional on the result anyway -
// a real implementation could return "fail" and the guard would keep blocking.
handlers.aml_check = (input) => {
  const result = "pass";
  if (result === "pass") amlState.passed = true;
  return { check: "aml", customer_id: input.customer_id, result };
};

let transferCounter = 0;

// Same execution-proof pattern as process_refund: if a blocked transfer ever
// ran, the counter would tick.
handlers.transfer_funds = (input) => {
  transferCounter++;
  return {
    success: true,
    transfer_id: `TRF-${String(transferCounter).padStart(4, "0")}`,
    to: input.to,
    amount: input.amount,
    status: "completed",
  };
};

// ---------------------------------------------------------------------------
// PostToolUse hook (Step 2)
// ---------------------------------------------------------------------------
// Best practices applied:
//   - Provenance over shape: the hook receives toolName because format is a
//     property of the SOURCE, not the data. "03/04/2024" is ambiguous by shape
//     (3 April vs 4 March); knowing it came from get_shipment resolves it.
//     Shape detection remains as a fallback for unknown tools.
//   - Hooks must be more robust than the tools they wrap: they sit on the
//     critical path of every call, so a malformed value degrades to raw
//     passthrough instead of throwing and killing the session.
//   - Unknown values pass through untouched: already-clean data (Tool B's ISO
//     dates, "active") is normalised by omission.

const STATUS_MAP: Record<string, string> = {
  "200": "active", // HTTP-style numeric code (Tool A)
  S: "shipped", //    single-letter codes (Tool C)
  P: "pending",
};

// Epoch seconds -> ISO 8601. Returns undefined if not a plausible timestamp.
function fromEpochSeconds(value: unknown): string | undefined {
  if (typeof value !== "number") return undefined;
  const date = new Date(value * 1000);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

// DD/MM/YYYY (day-first) -> ISO 8601. Returns undefined if not parseable.
function fromDayFirstDate(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^\d{2}\/\d{2}\/\d{4}$/.test(value)) return undefined;
  const [day, month, year] = value.split("/").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  // Round-trip check rejects impossible dates like 31/02/2024, which Date.UTC
  // would otherwise silently roll over into March.
  if (date.getUTCDate() !== day || date.getUTCMonth() !== month - 1) return undefined;
  return date.toISOString();
}

function postToolUseHook(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  const normalised = { ...result };

  // Dates: provenance first, shape-based fallback second.
  const dateConverters: Record<string, (v: unknown) => string | undefined> = {
    get_customer: fromEpochSeconds,
    get_shipment: fromDayFirstDate,
    // get_order already emits ISO 8601 - no converter, passes through.
  };
  const convert = dateConverters[toolName];
  const isoDate = convert
    ? convert(result.created_at)
    : fromEpochSeconds(result.created_at) ?? fromDayFirstDate(result.created_at);
  if (isoDate !== undefined) normalised.created_at = isoDate;

  // Statuses: map known codes to human-readable English, pass unknowns through.
  const mapped = STATUS_MAP[String(result.status)];
  if (mapped !== undefined) normalised.status = mapped;

  return normalised;
}

// --- PostToolUse registry: same shape as the PreToolUse one below ----------
// The normaliser is SCOPED to the three data tools by matcher. Explicit scope
// beats convenient magic: without it, any future tool whose result happens to
// carry status "P" (priority?) or a numeric created_at would be silently
// rewritten. Financial results are now structurally untouchable.
//
// Aggregation differs from PreToolUse by nature: pre hooks return DECISIONS
// (aggregate: most restrictive wins); post hooks return TRANSFORMATIONS
// (compose: each matching hook receives the previous hook's output).

type PostToolUseHookFn = (
  toolName: string,
  result: Record<string, unknown>,
) => Record<string, unknown>;

const postToolUseHooks: Array<{ matcher?: string; hook: PostToolUseHookFn }> = [];

function runPostToolUseHooks(
  toolName: string,
  result: Record<string, unknown>,
): Record<string, unknown> {
  return postToolUseHooks
    .filter(({ matcher }) => matchesTool(matcher, toolName))
    .reduce((acc, { hook }) => {
      try {
        return hook(toolName, acc);
      } catch {
        // Fail open: a broken normaliser passes data through unchanged -
        // the opposite of the policy hooks' fail-closed stance.
        return acc;
      }
    }, result);
}

postToolUseHooks.push({
  matcher: "get_customer|get_order|get_shipment",
  hook: postToolUseHook,
});

// ---------------------------------------------------------------------------
// PreToolUse hooks (Steps 4 & 5)
// ---------------------------------------------------------------------------
// Mirrors the Agent SDK contract (docs: "Register multiple hooks"):
//   - Registration shape: an ARRAY of { matcher?, hook } entries per event.
//     One concern per hook; adding a policy is a registration, not loop surgery.
//   - Aggregation: ALL matching hooks run and the most restrictive decision
//     wins - a single deny blocks the call regardless of other results.
//   - Independence: hooks may not rely on each other having run first
//     (the real SDK runs them in parallel; we run sequentially, but preserve
//     the semantics: all hooks run, deny wins).
//   - Failure mode is the OPPOSITE of PostToolUse: normalisation degrades
//     OPEN (pass raw data through), policy degrades CLOSED (a crashed or
//     confused guard denies; it never waves a call through by accident).

type PreToolUseDecision =
  | { decision: "allow" }
  // reason is addressed to the MODEL (the SDK's permissionDecisionReason):
  // it goes back as the tool result so the model stops retrying and escalates.
  | { decision: "deny"; reason: string };

type PreToolUseHook = (
  toolName: string,
  input: Record<string, unknown>,
) => PreToolUseDecision;

const preToolUseHooks: Array<{ matcher?: string; hook: PreToolUseHook }> = [];

// SDK-style exact matcher: undefined/"*"/"" match everything; "a|b" or "a, b"
// match exactly those tool names. (Regex matchers omitted - not needed here.)
function matchesTool(matcher: string | undefined, toolName: string): boolean {
  if (matcher === undefined || matcher === "" || matcher === "*") return true;
  return matcher.split(/[|,]/).some((m) => m.trim() === toolName);
}

function runPreToolUseHooks(
  toolName: string,
  input: Record<string, unknown>,
): PreToolUseDecision {
  const decisions = preToolUseHooks
    .filter(({ matcher }) => matchesTool(matcher, toolName))
    .map(({ hook }) => {
      try {
        return hook(toolName, input);
      } catch (err) {
        // Fail closed: a broken policy hook must never admit a call.
        const message = err instanceof Error ? err.message : String(err);
        return { decision: "deny", reason: `Policy hook failed: ${message}` } as const;
      }
    });
  // Deny-precedence: do NOT stop at the first result - run everything, then
  // let the most restrictive decision win, exactly as the SDK aggregates.
  return decisions.find((d) => d.decision === "deny") ?? { decision: "allow" };
}

// --- Step 4: refund threshold guard ---

const REFUND_THRESHOLD_USD = 500;

const refundThresholdGuard: PreToolUseHook = (toolName, input) => {
  // Belt and braces: the matcher already scopes us, but matchers are config
  // and config drifts - each hook stays safe standing alone.
  if (toolName !== "process_refund") return { decision: "allow" };

  const amount = typeof input.amount === "number" ? input.amount : NaN;
  // Negated <= so NaN (missing/malformed amount) also denies - fail closed.
  if (!(amount <= REFUND_THRESHOLD_USD)) {
    return {
      decision: "deny",
      reason:
        `Refund of $${input.amount} exceeds the $${REFUND_THRESHOLD_USD} auto-approval threshold. ` +
        `Do not retry with this tool. Redirect the customer to human escalation for manual review.`,
    };
  }
  return { decision: "allow" };
};

preToolUseHooks.push({ matcher: "process_refund", hook: refundThresholdGuard });

// --- Step 5: AML prerequisite guard ---
// Contrast with the refund guard: that deny is TERMINAL (escalate to a
// human), this one is RECOVERABLE - the reason tells the model how to
// satisfy the prerequisite itself, so the agent can self-correct in-session.

const amlPrerequisiteGuard: PreToolUseHook = (toolName) => {
  if (toolName !== "transfer_funds") return { decision: "allow" };

  if (!amlState.passed) {
    return {
      decision: "deny",
      reason:
        "COMPLIANCE BLOCK: transfer_funds requires a passed AML verification in this session. " +
        "Run aml_check for the customer first, then retry the transfer.",
    };
  }
  return { decision: "allow" };
};

preToolUseHooks.push({ matcher: "transfer_funds", hook: amlPrerequisiteGuard });

// ---------------------------------------------------------------------------
// Agentic loop wiring the hooks around tool execution (Steps 3 & 4)
// ---------------------------------------------------------------------------
// The two hook seams per tool_use block:
//   1. PreToolUse BEFORE dispatch - a deny short-circuits: the handler is
//      never invoked, the deny reason goes back as the tool_result.
//   2. PostToolUse on the handler result, BEFORE it is serialised into the
//      tool_result - the model only ever sees post-normalisation data.

// Deliberately says nothing about date formats, status codes, refund limits
// or AML: consistency and policy are enforced by hooks, not the prompt.
const SYSTEM_PROMPT = `You are a customer operations agent. Use your tools to
                       answer questions and carry out requests. If a tool
                       reports that an action is not permitted, do not retry
                       it - follow the guidance in the tool's response.`;

// Everything the model saw this scenario, post-normalisation. Captured at the
// execution seam (not inside postToolUseHook - the hook stays a pure
// transformation) so Step 3/6 assertions are programmatic, not eyeballed.
// Reset between scenarios.
const normalisedOutputs: Record<string, unknown>[] = [];

type ToolExecution =
  | { blocked: true; reason: string }
  | { blocked: false; result: Record<string, unknown> };

// THE single enforcement path. Both the agent loop and the deterministic
// tests go through here - one code path means the tests exercise exactly
// what the agent runs, and the two can never drift apart.
function executeToolWithHooks(
  name: string,
  input: Record<string, unknown>,
): ToolExecution {
  // Seam 1: PreToolUse. Runs BEFORE the handler; deny means the handler is
  // never invoked - pre-execution blocking, not post-hoc detection.
  const decision = runPreToolUseHooks(name, input);
  if (decision.decision === "deny") {
    return { blocked: true, reason: decision.reason };
  }

  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);

  // Seam 2: PostToolUse. The raw result exists only inside this function;
  // callers only ever see the post-hook version. Matcher-scoped: only the
  // three data tools are normalised, everything else passes through.
  const raw = handler(input);
  const normalised = runPostToolUseHooks(name, raw);
  console.log(`  <- raw:        ${JSON.stringify(raw)}`);
  console.log(`  <- normalised: ${JSON.stringify(normalised)}`);
  normalisedOutputs.push(normalised);
  return { blocked: false, result: normalised };
}

async function runAgentLoop(
  userPrompt: string,
): Promise<{ result: string; iterations: number }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_ITERATIONS) {
      console.warn(`Safety cap reached (${MAX_ITERATIONS} iterations) - aborting loop`);
      break;
    }
    iterations++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages,
    });

    console.log(`[iteration ${iterations}] stop_reason: ${response.stop_reason}`);

    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      return { result: textBlock?.text ?? "", iterations };
    }

    if (response.stop_reason !== "tool_use") {
      console.warn(`Unexpected stop_reason "${response.stop_reason}" - stopping`);
      return { result: "", iterations };
    }

    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => {
      const input = block.input as Record<string, unknown>;
      console.log(`  -> tool: ${block.name}(${JSON.stringify(input)})`);

      try {
        const execution = executeToolWithHooks(block.name, input);

        if (execution.blocked) {
          console.log(`  X  BLOCKED by PreToolUse hook: ${execution.reason}`);
          // is_error: true - the call FAILED, no data was produced. The error
          // channel makes the model treat it as a failed action, and the
          // reason tells it what to do instead (escalate, not retry).
          return {
            type: "tool_result",
            tool_use_id: block.id,
            content: execution.reason,
            is_error: true,
          };
        }

        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: JSON.stringify(execution.result),
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  <- error: ${message}`);
        return {
          type: "tool_result",
          tool_use_id: block.id,
          content: `Error: ${message}`,
          is_error: true,
        };
      }
    });

    messages.push({ role: "user", content: toolResults });
  }

  return { result: "", iterations };
}

// ---------------------------------------------------------------------------
// Test scenarios (Steps 3 & 6)
// ---------------------------------------------------------------------------
const ISO_8601 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/;
// The normalised vocabulary IS the contract - assert membership, not just
// "looks stringy" (a missed "200" or "S" would sneak past a weaker check).
const NORMALISED_STATUSES = Object.values(STATUS_MAP);

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  // --- Scenario 1 (Step 3): normalisation through the live agent -----------
  // Expected: three raw/normalised log pairs; model's answer contains only
  // ISO dates and English statuses. NB: Tool A's 1710489600 normalises to
  // 2024-03-15T08:00:00.000Z - same DATE as tools B and C, not same instant.
  console.log("=== Scenario 1: normalisation (Step 3 verification) ===");
  normalisedOutputs.length = 0;
  const s1 = await runAgentLoop(
    "Look up customer C-001, find their order ORD-42, and check shipment SHP-7 status.",
  );
  console.log(`\nModel answer:\n${s1.result}\n`);
  check("agent called all three data tools", normalisedOutputs.length >= 3);
  check(
    "every date the model saw is ISO 8601",
    normalisedOutputs.every((o) => ISO_8601.test(String(o.created_at))),
  );
  check(
    "every status the model saw is in the normalised vocabulary",
    normalisedOutputs.every((o) => NORMALISED_STATUSES.includes(String(o.status))),
  );

  // --- Scenario 2 (Step 6, refund half): deterministic, no model -----------
  // Like exercise 04's Test A: the guard proven blocked/allowed on every run,
  // independent of any prompt or model behaviour.
  console.log("\n=== Scenario 2: refund guard unit test (no model) ===");
  normalisedOutputs.length = 0;
  const counterBefore = refundCounter;

  const high = executeToolWithHooks("process_refund", { order_id: "ORD-42", amount: 750 });
  check("$750 refund blocked", high.blocked);
  check("blocked refund never executed (counter unchanged)", refundCounter === counterBefore);

  // Boundary: the brief says "exceeds $500", so exactly $500 must be ALLOWED.
  const boundary = executeToolWithHooks("process_refund", { order_id: "ORD-42", amount: 500 });
  check("$500 refund allowed (threshold is 'exceeds', not 'reaches')", !boundary.blocked);

  const low = executeToolWithHooks("process_refund", { order_id: "ORD-42", amount: 200 });
  check("$200 refund allowed", !low.blocked);
  check("allowed refunds executed (counter +2)", refundCounter === counterBefore + 2);

  const malformed = executeToolWithHooks("process_refund", { order_id: "ORD-42" });
  check("missing amount fails closed", malformed.blocked);

  // --- Scenario 2b (Step 6): high-value refund through the live agent ------
  console.log("\n=== Scenario 2b: $800 refund via agent (expect block + escalation) ===");
  normalisedOutputs.length = 0;
  const counterBefore2b = refundCounter;
  const s2 = await runAgentLoop(
    "Process a refund of $800 for order ORD-42 right away, please.",
  );
  console.log(`\nModel answer:\n${s2.result}\n`);
  check("agent's $800 refund never executed", refundCounter === counterBefore2b);

  // --- Scenario 3 (Step 6, AML half): deterministic, no model --------------
  console.log("\n=== Scenario 3: AML prerequisite unit test (no model) ===");
  normalisedOutputs.length = 0;
  amlState.passed = false;
  const transfersBefore = transferCounter;

  const noAml = executeToolWithHooks("transfer_funds", { to: "IBAN-123", amount: 10000 });
  check("transfer without AML blocked", noAml.blocked);
  check("blocked transfer never executed (counter unchanged)", transferCounter === transfersBefore);

  // The prerequisite is satisfied through the SAME execution path the agent
  // uses - the handler flips the session state, nothing else may.
  const aml = executeToolWithHooks("aml_check", { customer_id: "C-001" });
  check("aml_check itself is not gated", !aml.blocked);

  const withAml = executeToolWithHooks("transfer_funds", { to: "IBAN-123", amount: 10000 });
  check("transfer after AML pass allowed", !withAml.blocked);
  check("allowed transfer executed (counter +1)", transferCounter === transfersBefore + 1);

  // "Current session" is load-bearing: a fresh session must NOT inherit the pass.
  amlState.passed = false;
  const freshSession = executeToolWithHooks("transfer_funds", { to: "IBAN-123", amount: 50 });
  check("fresh session blocked again (pass is session-scoped)", freshSession.blocked);

  // --- Scenario 3b (Step 6): transfer through the live agent ---------------
  // Expected arc: transfer attempt -> COMPLIANCE BLOCK -> model reads the
  // recoverable deny reason -> runs aml_check -> retries -> transfer succeeds.
  console.log("\n=== Scenario 3b: $10,000 transfer via agent (expect self-recovery) ===");
  normalisedOutputs.length = 0;
  amlState.passed = false;
  const transfersBefore3b = transferCounter;
  const s3 = await runAgentLoop(
    "Please transfer $10,000 to account IBAN-123 on behalf of customer C-001.",
  );
  console.log(`\nModel answer:\n${s3.result}\n`);
  check("transfer executed exactly once, after AML", transferCounter === transfersBefore3b + 1);
  check("AML passed within the session", amlState.passed);
}

main().catch(console.error);
