// Exercise 5_01 - Context window management: persistent case facts, tool
// result trimming, key findings placement
// Run: npx tsx 5_01-context-window-case-facts.ts
//
// Steps:
//   1. Case facts extractor: pull ONLY the transactional facts (customer id,
//      order number, amount, date, status, item) out of a raw tool result -
//      exactly the data types progressive summarisation destroys first
//   2. Persistent case facts block: buildPrompt prepends the facts as a
//      clearly delimited block OUTSIDE the summarised history, on every call
//   3. Tool result trimmer: a 49-field order lookup -> the 5 return-relevant
//      fields BEFORE the result enters conversation history (80-90% smaller,
//      and the saving is paid back on EVERY subsequent turn)
//   4. Multi-turn verification: progressively summarise turns 1-4 (30 -> 15
//      -> 8 word caps), then ask the agent to confirm the exact refund
//      details WITH and WITHOUT the case facts block - $247.83, #8891 and
//      March 3rd must survive only where the block exists
//   5. Key findings placement: aggregate subagent reports with a Key
//      Findings Summary at the TOP - the structural fix for the
//      lost-in-the-middle effect, not a "pay attention" instruction

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------
// Mock tool result: a realistic 49-field order lookup response
// ---------------------------------------------------------------------------
// Only 7 of these fields matter to a refund workflow. The other 42 are the
// silent context budget killer: unfiltered, they ride along in history and
// are re-paid as input tokens on every subsequent turn.

const ORDER_LOOKUP_RESULT = {
  // -- the transactional core a support agent actually needs --------------
  order_id: "#8891",
  customer_id: "CUST-70431",
  order_date: "2024-03-03",
  total_amount: "$247.83",
  status: "delivered",
  return_eligible: true,
  item_description: "Aurora K87 mechanical keyboard (RGB, brown switches)",
  // -- 42 fields of operational noise -------------------------------------
  internal_order_uuid: "9f8e7d6c-5b4a-4c3d-9e2f-1a0b9c8d7e6f",
  channel: "web",
  store_id: "US-EAST-04",
  warehouse_code: "WH-NJ-2",
  picker_id: "EMP-3341",
  packer_id: "EMP-2087",
  shipping_carrier: "UPS",
  shipping_service: "Ground Saver",
  tracking_number: "1Z999AA10123456784",
  tracking_url: "https://track.example.com/1Z999AA10123456784",
  shipped_at: "2024-03-04T14:22:31Z",
  delivered_at: "2024-03-07T18:03:12Z",
  estimated_delivery: "2024-03-08",
  shipping_cost: "$0.00",
  packaging_type: "standard-box-m",
  gift_wrap: false,
  promo_code: "SPRING10",
  promo_discount: "$24.78",
  loyalty_points_earned: 247,
  loyalty_tier: "silver",
  payment_method: "credit_card",
  payment_processor: "stripe",
  payment_last4: "4242",
  billing_address_id: "ADDR-118842",
  shipping_address_id: "ADDR-118842",
  invoice_url: "https://invoices.example.com/inv/8891.pdf",
  tax_amount: "$18.35",
  tax_jurisdiction: "NJ-US",
  currency: "USD",
  exchange_rate: 1.0,
  fraud_score: 0.12,
  fraud_review_status: "cleared",
  customer_segment: "returning-buyer",
  marketing_opt_in: true,
  source_campaign: "email-mar-2024-keyboards",
  device_fingerprint: "fp_71acc02be9d34",
  session_id: "sess_bb61f0a2277c",
  created_at: "2024-03-03T09:12:44Z",
  updated_at: "2024-03-07T18:03:15Z",
  api_version: "2023-11",
  cache_ttl_seconds: 300,
};

// ---------------------------------------------------------------------------
// Step 1: case facts extractor
// ---------------------------------------------------------------------------
// The extractor and the trimmer (Step 3) feed DIFFERENT destinations: trimmed
// results enter conversation history (and may later be summarised away); the
// extracted facts enter the persistent block that is never summarised. The
// fixed field set targets what summarisation destroys first: numbers, dates,
// identifiers and statuses - the fields needed to actually process a refund.

interface CaseIssue {
  orderId: string;
  orderDate: string;
  refundAmount: string;
  status: string;
  itemDescription: string;
}

interface CaseFacts {
  customerId: string;
  issues: CaseIssue[];
}

interface OrderLookupCore {
  customer_id: string;
  order_id: string;
  order_date: string;
  total_amount: string;
  status: string;
  item_description: string;
}

function extractCaseFacts(toolResult: OrderLookupCore): CaseFacts {
  return {
    customerId: toolResult.customer_id,
    issues: [
      {
        orderId: toolResult.order_id,
        orderDate: toolResult.order_date,
        refundAmount: toolResult.total_amount,
        status: toolResult.status,
        itemDescription: toolResult.item_description,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Step 2: persistent case facts block
// ---------------------------------------------------------------------------
// The block is prepended to EVERY API call, above whatever the summariser has
// done to the history. The section header is the delimiter that keeps the
// model treating it as standing reference data rather than conversation. A
// null caseFacts builds the control version (Step 4's WITHOUT arm).

function buildPrompt(
  caseFacts: CaseFacts | null,
  summarisedHistory: string,
  currentMessage: string,
): Anthropic.MessageParam[] {
  const caseFactsBlock = caseFacts
    ? `## Active Case Facts (DO NOT SUMMARISE)\n${JSON.stringify(caseFacts, null, 2)}\n\n`
    : "";
  return [
    { role: "user", content: caseFactsBlock + summarisedHistory },
    { role: "assistant", content: "I have the case facts and the conversation history." },
    { role: "user", content: currentMessage },
  ];
}

// ---------------------------------------------------------------------------
// Step 3: tool result trimmer
// ---------------------------------------------------------------------------
// Runs BEFORE the result enters conversation history - in production this is
// a PostToolUse hook or lives inside the tool implementation itself. The
// relevant set is task-scoped: these 5 fields are what a RETURN decision
// needs; a shipping-status task would pass a different list.

const RETURN_RELEVANT_FIELDS = [
  "order_id",
  "order_date",
  "total_amount",
  "return_eligible",
  "item_description",
];

function trimToolResult(
  rawResult: Record<string, unknown>,
  relevantFields: string[] = RETURN_RELEVANT_FIELDS,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(rawResult).filter(([key]) => relevantFields.includes(key)),
  );
}

// Chars/4 is a rough token proxy - good enough to show the order of magnitude.
function approxTokens(value: unknown): number {
  return Math.round(JSON.stringify(value).length / 4);
}

// ---------------------------------------------------------------------------
// Step 4: multi-turn verification
// ---------------------------------------------------------------------------
// A 7-turn refund conversation. All three critical values (amount, order
// number, date) appear ONLY in turns 1-4 - the region that gets summarised.
// Turns 5-6 survive verbatim as recent history but contain no specifics, so
// after compaction the case facts block is the values' only home.

const TRIMMED_LOOKUP = trimToolResult(ORDER_LOOKUP_RESULT);

const TURNS_1_TO_4 = `Turn 1 - Customer: Hi, I'd like to return the mechanical keyboard from my recent order and get a refund. Two of the switches are dead out of the box.

Turn 2 - Agent: Sorry to hear that - let me pull up the order.
[tool result: order_lookup] ${JSON.stringify(TRIMMED_LOOKUP)}
Found it: order #8891, placed 2024-03-03 - "Aurora K87 mechanical keyboard (RGB, brown switches)" for $247.83, and it is return-eligible.

Turn 3 - Customer: Great. Do I have to pay for return shipping? And how long does the refund usually take?

Turn 4 - Agent: Return shipping is free for defective items - I'll email you a prepaid label. Refunds land 5-10 business days after the warehouse receives the item.`;

const TURNS_5_TO_6 = `Turn 5 - Customer: OK. Also, please make sure the refund goes back to my original card, not store credit.

Turn 6 - Agent: Absolutely - refunds go to the original payment method by default. Anything else before I set this up?`;

const TURN_7_ASK =
  "Before you process anything, please confirm the exact refund amount, the order number, and the order date of the item I'm returning.";

// The agent must not paper over missing context by guessing - a fabricated
// amount would make the WITHOUT arm look like it "remembered".
const AGENT_SYSTEM = `You are a customer support agent handling a product return.
Answer ONLY from information present in this conversation.
If you do not have an exact value (amount, order number, date), say so explicitly and ask the customer for it - NEVER guess or invent a value.`;

// The three facts summarisation is expected to destroy, with the spellings a
// model might legitimately use when it DOES know them.
const CRITICAL_FACTS = [
  { label: "refund amount $247.83", patterns: [/247\.83/] },
  { label: "order number #8891", patterns: [/8891/] },
  { label: "order date March 3rd", patterns: [/march\s*3/i, /2024-03-03/, /03\/03\/2024/, /3\s+march/i] },
];

function factsPresent(text: string): { label: string; present: boolean }[] {
  return CRITICAL_FACTS.map((f) => ({
    label: f.label,
    present: f.patterns.some((p) => p.test(text)),
  }));
}

function renderFactCheck(text: string): string {
  return factsPresent(text)
    .map((f) => `    ${f.present ? "KEPT" : "LOST"}: ${f.label}`)
    .join("\n");
}

// MessageParam content is a union - a plain string or an array of content
// blocks - so extract text through a type guard, never a cast; and locate
// messages by ROLE, never by array position (same approach as 1_03's
// extractResultText).
function messageText(content: Anthropic.MessageParam["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((b): b is Anthropic.TextBlockParam => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

function firstUserText(messages: Anthropic.MessageParam[]): string {
  const first = messages.find((m) => m.role === "user");
  if (!first) throw new Error("No user message in prompt");
  return messageText(first.content);
}

// Content blocks are a union; find the text with a type guard instead of
// indexing blindly (same helper as 1_06/4_01/4_02/4_06).
function textOf(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!block) throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
  return block.text;
}

// Same retry policy as 4_06, plain-text variant: capacity/rate/server errors
// retry with jittered exponential backoff; schema/auth errors fail fast.
const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
const MAX_ATTEMPTS = 4;

async function textRequest(
  label: string,
  messages: Anthropic.MessageParam[],
  system?: string,
): Promise<string> {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await client.messages.create({
        model: MODEL,
        max_tokens: 4000,
        ...(system ? { system } : {}),
        messages,
      });
      return textOf(response).trim();
    } catch (err) {
      const retryable =
        err instanceof Anthropic.APIConnectionError ||
        (err instanceof Anthropic.APIError &&
          typeof err.type === "string" &&
          RETRYABLE_ERROR_TYPES.has(err.type));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const delayMs = 2000 * 2 ** (attempt - 1) + Math.random() * 1000;
      const kind = err instanceof Anthropic.APIError ? err.type : "connection error";
      console.warn(`  ${label}: ${kind} - retrying (${attempt}/${MAX_ATTEMPTS - 1}) in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// Progressive summarisation: each round compresses the PREVIOUS round's
// output under a tighter word cap - the real mechanism by which a value
// survives compaction one, two times and then silently disappears. The caps
// force the trade-off a live summariser makes under token pressure.
async function progressiveSummaries(source: string): Promise<string[]> {
  const caps = [30, 15, 8];
  const summaries: string[] = [];
  let input = source;
  for (const cap of caps) {
    const summary = await textRequest(`summarise (<=${cap} words)`, [
      {
        role: "user",
        content: `Summarise the following customer-support conversation for a context-window compaction step. Maximum ${cap} words. Output only the summary text.\n\n${input}`,
      },
    ]);
    summaries.push(summary);
    input = summary;
  }
  return summaries;
}

// ---------------------------------------------------------------------------
// Step 5: key findings placement
// ---------------------------------------------------------------------------
// When several subagent reports are aggregated into one input, findings
// buried in the middle may be missed (lost-in-the-middle). The fix is
// STRUCTURAL - reorganise so every critical claim also appears at the top -
// not a prompt instruction to "read carefully".

interface SubagentReport {
  name: string;
  keyClaim: string;
  fullContent: string;
}

const SUBAGENT_REPORTS: SubagentReport[] = [
  {
    name: "Order history check",
    keyClaim: "3 returns in the last 12 months, all confirmed defective by the warehouse - no abuse pattern",
    fullContent:
      "Customer CUST-70431 has placed 14 orders over 26 months totalling $2,912.40. Three returns were filed in the last 12 months (orders #7712, #8105, #8891); in each prior case the warehouse inspection confirmed the reported defect. Return rate is within one standard deviation of the returning-buyer segment average. No chargebacks on record.",
  },
  {
    name: "Fraud screening",
    keyClaim: "fraud score 0.12 (low); device fingerprint and shipping address match order history",
    fullContent:
      "The refund request originates from device fingerprint fp_71acc02be9d34, seen on 11 of the customer's 14 orders. Shipping and billing addresses are unchanged since 2023. The order's fraud score at purchase time was 0.12 and the review status is cleared. No velocity anomalies in the last 30 days.",
  },
  {
    name: "Warranty and policy check",
    keyClaim: "return filed on day 4 of the 30-day window; defective items qualify for free return shipping",
    fullContent:
      "Order #8891 was delivered 2024-03-07 and the return was requested 2024-03-11, day 4 of the 30-day return window. Policy section 4.2 classifies dead switches as a manufacturing defect, which waives the restocking fee and grants a prepaid return label. The manufacturer warranty (24 months) is not needed for this path.",
  },
  {
    name: "Inventory disposition",
    keyClaim: "returned units of this SKU route to refurbishment, not restock - refund is not blocked on resale",
    fullContent:
      "SKU AUR-K87-RGB-BRN is on the refurbishment list: returned units are inspected at WH-NJ-2 and routed to the certified-refurbished channel regardless of condition grade. Because disposition does not depend on resale-as-new, the refund can be released on warehouse receipt scan rather than after full inspection.",
  },
];

function aggregateWithKeyFindings(sources: SubagentReport[]): string {
  const keyFindings = sources.map((s) => `- ${s.name}: ${s.keyClaim}`);
  return (
    `## Key Findings Summary\n${keyFindings.join("\n")}\n\n` +
    `## Detailed Findings\n\n` +
    sources.map((s) => `### ${s.name}\n${s.fullContent}`).join("\n\n")
  );
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  // --- Step 1: case facts extractor ---------------------------------------
  console.log("=== Step 1: case facts extractor ===");
  const caseFacts = extractCaseFacts(ORDER_LOOKUP_RESULT);
  console.log(JSON.stringify(caseFacts, null, 2));

  // --- Step 2: persistent case facts block --------------------------------
  console.log("\n=== Step 2: persistent case facts block ===");
  const demoMessages = buildPrompt(caseFacts, "(summarised history goes here)", "(current turn goes here)");
  const firstUserContent = firstUserText(demoMessages);
  console.log("First user message begins:");
  console.log(firstUserContent.split("\n").slice(0, 4).map((l) => `  | ${l}`).join("\n"));
  console.log(`  ... block is prepended on EVERY call, above whatever summarisation did to history.`);

  // --- Step 3: tool result trimmer ----------------------------------------
  console.log("\n=== Step 3: tool result trimmer ===");
  const rawFieldCount = Object.keys(ORDER_LOOKUP_RESULT).length;
  const trimmedFieldCount = Object.keys(TRIMMED_LOOKUP).length;
  const rawTokens = approxTokens(ORDER_LOOKUP_RESULT);
  const trimmedTokens = approxTokens(TRIMMED_LOOKUP);
  const reduction = 1 - JSON.stringify(TRIMMED_LOOKUP).length / JSON.stringify(ORDER_LOOKUP_RESULT).length;
  console.log(`  raw:     ${rawFieldCount} fields, ~${rawTokens} tokens`);
  console.log(`  trimmed: ${trimmedFieldCount} fields, ~${trimmedTokens} tokens (${Object.keys(TRIMMED_LOOKUP).join(", ")})`);
  console.log(`  reduction: ${Math.round(reduction * 100)}% - and history re-pays the raw size on every later turn`);

  // --- Step 4: multi-turn verification ------------------------------------
  console.log("\n=== Step 4: multi-turn verification ===");
  console.log("Progressive summarisation of turns 1-4 (each round compresses the previous):");
  const summaries = await progressiveSummaries(TURNS_1_TO_4);
  const caps = [30, 15, 8];
  summaries.forEach((s, i) => {
    console.log(`\n  Round ${i + 1} (<=${caps[i]} words): "${s}"`);
    console.log(renderFactCheck(s));
  });
  const finalSummary = summaries[summaries.length - 1];
  const summaryLost = factsPresent(finalSummary).filter((f) => !f.present);

  const summarisedHistory = `[Summary of turns 1-4]: ${finalSummary}\n\n${TURNS_5_TO_6}`;

  console.log("\nTurn 7 ask (both arms): confirm exact refund amount, order number, order date.");
  const [withResponse, withoutResponse] = await Promise.all([
    textRequest("turn 7 WITH case facts", buildPrompt(caseFacts, summarisedHistory, TURN_7_ASK), AGENT_SYSTEM),
    textRequest("turn 7 WITHOUT case facts", buildPrompt(null, summarisedHistory, TURN_7_ASK), AGENT_SYSTEM),
  ]);

  console.log("\n  WITH case facts block:");
  console.log(withResponse.split("\n").map((l) => `  | ${l}`).join("\n"));
  console.log(renderFactCheck(withResponse));

  console.log("\n  WITHOUT case facts block:");
  console.log(withoutResponse.split("\n").map((l) => `  | ${l}`).join("\n"));
  console.log(renderFactCheck(withoutResponse));

  const withFacts = factsPresent(withResponse);
  const withoutFacts = factsPresent(withoutResponse);

  // --- Step 5: key findings placement --------------------------------------
  console.log("\n=== Step 5: key findings placement ===");
  const aggregated = aggregateWithKeyFindings(SUBAGENT_REPORTS);
  console.log(aggregated.split("\n").slice(0, 8).map((l) => `  | ${l}`).join("\n"));
  console.log("  | ... (detailed sections follow with ### headers)");
  const detailedAt = aggregated.indexOf("## Detailed Findings");
  const claimsAtTop = SUBAGENT_REPORTS.every(
    (s) => aggregated.indexOf(s.keyClaim) !== -1 && aggregated.indexOf(s.keyClaim) < detailedAt,
  );
  const allSectionHeaders = SUBAGENT_REPORTS.every((s) => aggregated.includes(`### ${s.name}`));

  // --- Acceptance criteria --------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  const issue = caseFacts.issues[0];
  check(
    "extractor captures all six transactional fields from the raw result",
    caseFacts.customerId === ORDER_LOOKUP_RESULT.customer_id &&
      issue.orderId === ORDER_LOOKUP_RESULT.order_id &&
      issue.orderDate === ORDER_LOOKUP_RESULT.order_date &&
      issue.refundAmount === ORDER_LOOKUP_RESULT.total_amount &&
      issue.status === ORDER_LOOKUP_RESULT.status &&
      issue.itemDescription === ORDER_LOOKUP_RESULT.item_description,
  );
  check(
    "case facts block sits at the very top of the first message, before history",
    firstUserContent.startsWith("## Active Case Facts (DO NOT SUMMARISE)") &&
      firstUserContent.indexOf("## Active Case Facts") < firstUserContent.indexOf("(summarised history goes here)"),
  );
  check(
    "null caseFacts builds a clean control (no block, history intact)",
    !firstUserText(buildPrompt(null, "H", "M")).includes("Active Case Facts"),
  );
  check(
    "trimmed result contains exactly the 5 return-relevant fields",
    trimmedFieldCount === 5 && RETURN_RELEVANT_FIELDS.every((f) => f in TRIMMED_LOOKUP),
  );
  check(`trimming reduces serialised size by >= 80% (measured ${Math.round(reduction * 100)}%)`, reduction >= 0.8);
  check(
    "progressive summarisation destroyed at least one exact value",
    summaryLost.length > 0,
  );
  check(
    "WITH case facts: agent cites all three exact values after summarisation",
    withFacts.every((f) => f.present),
  );
  check(
    "WITHOUT case facts: at least one exact value is gone (or honestly asked for)",
    withoutFacts.some((f) => !f.present),
  );
  check("aggregated input starts with the Key Findings Summary", aggregated.startsWith("## Key Findings Summary"));
  check("every key claim appears before the detailed section, each source has a ### header", claimsAtTop && allSectionHeaders);
}

main().catch(console.error);
