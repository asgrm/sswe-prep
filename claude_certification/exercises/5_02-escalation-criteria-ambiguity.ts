// Exercise 5_02 - Escalation calibration and ambiguity (Task Statement 5.2)
// Run: npx tsx 5_02-escalation-criteria-ambiguity.ts
//
// Steps:
//   1. System prompt with the three valid escalation triggers - explicit human
//      request, policy gap, inability to progress - each as trigger/description/
//      action, plus the two anti-patterns (sentiment, self-reported confidence)
//      called out as things NOT to escalate on
//   2. Few-shot examples: immediate escalation on an explicit human request, an
//      autonomous resolve for a frustrated-but-simple case, and an escalation for
//      a policy gap - the reasoning line is what teaches generalisation
//   3. Ambiguous customer matching: on multiple name matches, ask for an
//      additional identifier - NEVER select by recency/activity/any heuristic
//   4. Live test of all four scenarios through a small tool-using agent loop
//      (check_policy / customer_lookup / resolve_issue / escalate_to_human)
//   5. Absolute-rule verification: explicit human request escalates in the
//      very first turn with zero investigation, across several phrasings; the
//      ambiguous-match rule holds even when one record looks more likely

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const MAX_TURNS = 4;

// ---------------------------------------------------------------------------
// Step 1: escalation criteria - the three valid triggers, and what isn't one
// ---------------------------------------------------------------------------
// Trigger 2 spells out gap vs violation explicitly: a violation has a
// documented "no" the agent applies directly (no escalation); a gap means
// policy is silent on this exact situation, which needs human judgement.

const ESCALATION_CRITERIA = `## Escalation Criteria

Exactly three situations justify escalating this case to a human agent.
Nothing else does.

1. EXPLICIT HUMAN REQUEST
   Description: The customer directly asks to speak to a human, a person, an
   agent, or a manager - in any phrasing.
   Action: Escalate IMMEDIATELY, in your very first response. Do not
   investigate, do not attempt to resolve first, do not say "let me see if I
   can help with that first." This is an absolute rule with no exceptions.

2. POLICY GAP
   Description: The request falls into a genuine gap where documented policy
   is SILENT on this exact situation. This is different from a POLICY
   VIOLATION, where policy explicitly says no - a violation has a documented
   answer you apply directly, and that is NOT a reason to escalate.
   Action: Escalate for human judgement. Use check_policy first if you are
   not sure whether this is a gap or a documented violation.

3. INABILITY TO PROGRESS
   Description: You have made a genuine attempt to resolve the issue with
   your available tools and cannot advance - a tool error, missing system
   access, or a fix that requires engineering intervention.
   Action: Escalate with full context on what was attempted and why it
   failed.

DO NOT escalate based on either of the following - both are unreliable
signals for case complexity:
- Customer frustration level or sentiment. A furious customer can have a
  trivial case; a calm customer can have a genuine policy gap.
- Your own self-reported confidence score. Self-reported confidence is
  poorly calibrated - confidently wrong on hard cases, needlessly unsure on
  easy ones.`;

// ---------------------------------------------------------------------------
// Step 2: few-shot examples - the frustration-vs-request distinction
// ---------------------------------------------------------------------------

const FEW_SHOT_EXAMPLES = `## Examples

Customer: I want to speak to a real person right now.
Reasoning: Explicit human request (trigger 1) - the absolute rule. No
investigation, no attempt to help first.
Action: escalate_to_human immediately, trigger "explicit_human_request".

Customer: This is ridiculous! My order arrived broken and nobody seems to care!
Reasoning: Frustration is high, but the issue itself - a damaged item - is a
straightforward, documented case. Frustration is not one of the three
triggers, so acknowledge it and resolve directly instead of escalating.
Action: resolve_issue.
Response: "I understand this is frustrating - let's get this sorted. I can
see the item arrived damaged, so I'm arranging a free replacement shipment
right now."

Customer: I want you to match the price I saw at a competitor's store.
Reasoning: Documented policy has no rule on competitor price matching - this
is a gap, not a violation. A calm, polite tone does not change that a
genuine gap needs human judgement.
Action: escalate_to_human, trigger "policy_gap".`;

const AGENT_ROLE = `You are a customer support agent with four tools: check_policy,
customer_lookup, resolve_issue, and escalate_to_human. Use resolve_issue to
close cases you can fully handle yourself; use escalate_to_human per the
criteria below. If customer_lookup returns action "disambiguate", ask the
customer for one of the suggested identifiers directly - that is a
disambiguation step, not one of the three escalation triggers.`;

const SYSTEM_PROMPT = `${AGENT_ROLE}

${ESCALATION_CRITERIA}

${FEW_SHOT_EXAMPLES}`;

// ---------------------------------------------------------------------------
// Step 3: ambiguous customer matching - never select heuristically
// ---------------------------------------------------------------------------
// On multiple matches the result withholds every candidate's details (city,
// activity, ...) - so even a model that WANTED to pick heuristically has
// nothing to pick from. The safety property is structural, not just a prompt
// instruction.

interface CustomerRecord {
  name: string;
  lastActive?: string;
  city?: string;
}

interface LookupResult {
  action: "not_found" | "matched" | "disambiguate";
  message?: string;
  customer?: CustomerRecord;
  matchCount?: number;
}

function handleCustomerLookup(results: CustomerRecord[]): LookupResult {
  if (results.length === 0) {
    return { action: "not_found", message: "No matching customer records found." };
  }
  if (results.length === 1) {
    return { action: "matched", customer: results[0] };
  }
  return {
    action: "disambiguate",
    message: `I found multiple accounts matching that name. Could you provide one
              of the following to help me find the right account?
              - Email address
              - Phone number
              - Order number
              - Postcode`,
    matchCount: results.length,
  };
}

// A tempting case: one record is recent and in a plausible city, the other is
// stale. Neither fact may be used to pick - see acceptance check below.
const AMBIGUOUS_CUSTOMERS: CustomerRecord[] = [
  { name: "John Smith", lastActive: "2024-03-14", city: "London" },
  { name: "John Smith", lastActive: "2023-01-02", city: "Manchester" },
];

// ---------------------------------------------------------------------------
// Mock backends for the live agent loop (Steps 4 & 5)
// ---------------------------------------------------------------------------

const POLICY_DOCS: Record<string, string> = {
  "late delivery": "Late deliveries qualify for reshipment or refund, agent discretion, no approval needed.",
  "damaged item": "Damaged-in-transit items qualify for a free replacement shipment, no return required.",
  "defective item": "Defective items qualify for free return shipping and a full refund.",
};

function checkPolicy(topic: string): string {
  const hit = Object.entries(POLICY_DOCS).find(([key]) => topic.toLowerCase().includes(key));
  return hit
    ? `Policy on "${topic}": ${hit[1]}`
    : `Policy is SILENT on "${topic}" - no documented rule covers this. This is a gap, not a violation.`;
}

function customerLookup(name: string): LookupResult {
  const matches = name.toLowerCase().includes("john smith") ? AMBIGUOUS_CUSTOMERS : [];
  return handleCustomerLookup(matches);
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS: Anthropic.Tool[] = [
  {
    name: "check_policy",
    description: `Look up documented company policy on a topic. Returns the policy text
                  if one exists, or explicitly states that policy is silent on the topic
                  (a gap, not a violation).`,
    input_schema: {
      type: "object",
      properties: { topic: { type: "string" } },
      required: ["topic"],
    },
  },
  {
    name: "customer_lookup",
    description: `Search customer records by name. May return zero, one, or multiple
                  matches. On multiple matches the result tells you how to disambiguate
                  - never guess which one is correct.`,
    input_schema: {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    },
  },
  {
    name: "resolve_issue",
    description: "Resolve the customer's issue directly, without any human involvement.",
    input_schema: {
      type: "object",
      properties: {
        customer_response: { type: "string", description: "The exact message to send the customer" },
        action_taken: { type: "string", description: "What was done, e.g. 'issued replacement shipment'" },
      },
      required: ["customer_response", "action_taken"],
    },
  },
  {
    name: "escalate_to_human",
    description: `Hand this case off to a human agent. The human sees ONLY these
                  fields, never the conversation transcript, so the summary must be
                  self-contained.`,
    input_schema: {
      type: "object",
      properties: {
        trigger: {
          type: "string",
          enum: ["explicit_human_request", "policy_gap", "cannot_progress"],
        },
        customer_id: { type: ["string", "null"] },
        conversation_summary: { type: "string" },
        root_cause_analysis: { type: "string" },
        refund_amount: { type: ["number", "null"] },
        recommended_action: { type: "string" },
      },
      required: [
        "trigger",
        "customer_id",
        "conversation_summary",
        "root_cause_analysis",
        "refund_amount",
        "recommended_action",
      ],
    },
  },
];

interface EscalationInput {
  trigger: "explicit_human_request" | "policy_gap" | "cannot_progress";
  recommended_action: string;
}

interface ResolveInput {
  customer_response: string;
}

// ---------------------------------------------------------------------------
// Agent loop plumbing - type guards, never positional indexing or casts on
// content blocks (same idiom as textOf/messageText elsewhere in this folder)
// ---------------------------------------------------------------------------

function optionalTextOf(response: Anthropic.Message): string {
  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  return block?.text ?? "";
}

function toolUseOf(response: Anthropic.Message): Anthropic.ToolUseBlock | undefined {
  return response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use");
}

// Same retry policy as 4_06/5_01: capacity/rate/server errors retry with
// jittered exponential backoff; schema/auth errors fail fast.
const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
const MAX_ATTEMPTS = 4;

async function callAgent(messages: Anthropic.MessageParam[]): Promise<Anthropic.Message> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.messages.create({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        tools: TOOLS,
        tool_choice: { type: "auto", disable_parallel_tool_use: true },
        messages,
      });
    } catch (err) {
      const retryable =
        err instanceof Anthropic.APIConnectionError ||
        (err instanceof Anthropic.APIError && typeof err.type === "string" && RETRYABLE_ERROR_TYPES.has(err.type));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const delayMs = 2000 * 2 ** (attempt - 1) + Math.random() * 1000;
      const kind = err instanceof Anthropic.APIError ? err.type : "connection error";
      console.warn(`  callAgent: ${kind} - retrying (${attempt}/${MAX_ATTEMPTS - 1}) in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function runInvestigativeTool(name: string, input: unknown): unknown {
  switch (name) {
    case "check_policy":
      return { policy: checkPolicy((input as { topic: string }).topic) };
    case "customer_lookup":
      return customerLookup((input as { name: string }).name);
    default:
      throw new Error(`Unexpected investigative tool: ${name}`);
  }
}

const DISAMBIGUATION_MARKERS = ["email", "phone", "order number", "postcode"];

function looksLikeDisambiguation(text: string): boolean {
  const lower = text.toLowerCase();
  return DISAMBIGUATION_MARKERS.filter((marker) => lower.includes(marker)).length >= 2;
}

interface ScenarioResult {
  action: "resolve" | "escalate_immediate" | "escalate" | "disambiguate";
  investigationSteps: number;
  toolSequence: string[];
  finalText: string;
}

// investigationSteps counts check_policy/customer_lookup calls made BEFORE a
// terminal decision (resolve_issue or escalate_to_human) - the number that
// must be exactly zero for an explicit human request.
async function processScenario(userMessage: string): Promise<ScenarioResult> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userMessage }];
  const toolSequence: string[] = [];
  let investigationSteps = 0;

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const response = await callAgent(messages);
    const call = toolUseOf(response);

    if (!call) {
      const text = optionalTextOf(response);
      return {
        action: looksLikeDisambiguation(text) ? "disambiguate" : "resolve",
        investigationSteps,
        toolSequence,
        finalText: text,
      };
    }

    toolSequence.push(call.name);

    if (call.name === "escalate_to_human") {
      const input = call.input as EscalationInput;
      return {
        action: input.trigger === "explicit_human_request" ? "escalate_immediate" : "escalate",
        investigationSteps,
        toolSequence,
        finalText: input.recommended_action,
      };
    }

    if (call.name === "resolve_issue") {
      const input = call.input as ResolveInput;
      return { action: "resolve", investigationSteps, toolSequence, finalText: input.customer_response };
    }

    // check_policy / customer_lookup: gathering information, not a decision.
    investigationSteps++;
    const toolResult = runInvestigativeTool(call.name, call.input);
    messages.push({ role: "assistant", content: response.content });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: call.id, content: JSON.stringify(toolResult) }],
    });
  }

  throw new Error(`Scenario did not reach a terminal action within ${MAX_TURNS} turns: "${userMessage}"`);
}

// ---------------------------------------------------------------------------
// Step 4: the four required test scenarios
// ---------------------------------------------------------------------------

interface TestScenario {
  input: string;
  expected: ScenarioResult["action"];
  reason: string;
}

const TEST_SCENARIOS: TestScenario[] = [
  {
    input: "This is SO frustrating! My order arrived broken and I've been waiting for a week!",
    expected: "resolve",
    reason: "Frustrated tone, but a documented damaged-item case - resolve directly",
  },
  {
    input: "I want you to match the price I saw at a competitor's store for this item.",
    expected: "escalate",
    reason: "Competitor price matching is a policy gap, not a documented violation",
  },
  {
    input: "I want to talk to a real human being.",
    expected: "escalate_immediate",
    reason: "Explicit human request - the absolute rule, zero investigation",
  },
  {
    input: "Look up my account, my name is John Smith.",
    expected: "disambiguate",
    reason: "Multiple John Smith matches - must ask for an additional identifier",
  },
];

// ---------------------------------------------------------------------------
// Step 5: absolute-rule verification across phrasings
// ---------------------------------------------------------------------------

const HUMAN_REQUEST_PHRASINGS = [
  "Transfer me to a human.",
  "I want to speak to a real person.",
  "Get me a manager.",
  "Let me talk to someone real, not a bot.",
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  console.log("=== Steps 1 & 2: system prompt (criteria + few-shot examples) ===");
  console.log(SYSTEM_PROMPT);

  console.log("\n=== Step 3: ambiguous customer matching (pure function, no model) ===");
  console.log("  zero matches:    ", JSON.stringify(handleCustomerLookup([])));
  console.log("  one match:       ", JSON.stringify(handleCustomerLookup([{ name: "Jane Doe" }])));
  const heuristicTempting = handleCustomerLookup(AMBIGUOUS_CUSTOMERS);
  console.log("  multiple matches (recent London vs stale Manchester - tempting but must not select):");
  console.log(`    ${JSON.stringify(heuristicTempting)}`);

  console.log("\n=== Step 4: live test scenarios ===");
  const results = await Promise.all(
    TEST_SCENARIOS.map(async (scenario) => ({ scenario, result: await processScenario(scenario.input) })),
  );
  for (const { scenario, result } of results) {
    console.log(`\n  "${scenario.input}"`);
    console.log(`    expected: ${result.action === scenario.expected ? "PASS" : "FAIL"} - ${scenario.expected} (${scenario.reason})`);
    console.log(
      `    got:      ${result.action} | tools: [${result.toolSequence.join(", ") || "none"}] | investigationSteps: ${result.investigationSteps}`,
    );
    console.log(`    response: ${result.finalText}`);
  }

  console.log("\n=== Step 5: absolute-rule verification across phrasings ===");
  const phrasingResults = await Promise.all(
    HUMAN_REQUEST_PHRASINGS.map(async (phrasing) => ({ phrasing, result: await processScenario(phrasing) })),
  );
  for (const { phrasing, result } of phrasingResults) {
    console.log(`  "${phrasing}" -> ${result.action}, investigationSteps=${result.investigationSteps}`);
  }

  // --- Acceptance criteria --------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  check(
    "system prompt names all three triggers, each with a description and action",
    ["EXPLICIT HUMAN REQUEST", "POLICY GAP", "INABILITY TO PROGRESS"].every((t) => ESCALATION_CRITERIA.includes(t)) &&
      ESCALATION_CRITERIA.includes("Description:") &&
      ESCALATION_CRITERIA.includes("Action:"),
  );
  check(
    "system prompt distinguishes policy gap (silent) from policy violation (documented no)",
    /silent/i.test(ESCALATION_CRITERIA) && /violation/i.test(ESCALATION_CRITERIA),
  );
  check(
    "system prompt explicitly excludes sentiment/frustration and self-reported confidence as triggers",
    /sentiment|frustration/i.test(ESCALATION_CRITERIA) && /confidence/i.test(ESCALATION_CRITERIA),
  );
  check(
    "few-shot examples cover all three demonstration cases",
    /real person/i.test(FEW_SHOT_EXAMPLES) && /frustrat/i.test(FEW_SHOT_EXAMPLES) && /competitor/i.test(FEW_SHOT_EXAMPLES),
  );
  check(
    "frustrated-but-resolvable example acknowledges frustration THEN resolves, not escalates",
    /understand this is frustrating/i.test(FEW_SHOT_EXAMPLES) && /resolve_issue/.test(FEW_SHOT_EXAMPLES),
  );
  check("zero matches -> not_found", handleCustomerLookup([]).action === "not_found");
  check("one match -> matched", handleCustomerLookup([{ name: "Jane Doe" }]).action === "matched");
  check(
    "multiple matches -> disambiguate, even with a more-recent/plausible-city record tempting a heuristic",
    heuristicTempting.action === "disambiguate" && heuristicTempting.customer === undefined,
  );
  for (const { scenario, result } of results) {
    check(`scenario "${scenario.input.slice(0, 45)}..." resolves to ${scenario.expected}`, result.action === scenario.expected);
  }
  check(
    "explicit human request escalates in the very first response, zero investigation, across all phrasings",
    phrasingResults.every(({ result }) => result.action === "escalate_immediate" && result.investigationSteps === 0),
  );
}

main().catch(console.error);
