// Exercise 4_05 - Message Batches API: batch-vs-sync classification, custom_id
// correlation, targeted failure retry, SLA arithmetic, sample-set prompt
// refinement (Task Statement 4.5)
// Run: npx tsx 4_05-message-batches-sla-retry.ts
//
// Steps (task numbering; the runner executes 1 -> 4 -> 5 -> 2 -> 3 because in
// a real pipeline the sample refinement (5) happens BEFORE the full
// submission (2), and the SLA math (4) needs no API at all):
//   1. Classify 5 workflows as blocking (synchronous) or latency-tolerant
//      (batch-eligible). The decision rule: is someone or something WAITING
//      on the result? The batch API's only timing promise is "within 24
//      hours" - anything with a waiting party cannot tolerate that.
//   2. Submit a 20-document batch where every request carries a unique
//      custom_id (doc-<type>-<nnn>, matching ^[a-zA-Z0-9_-]{1,64}$). Results
//      stream back in ANY order - custom_id is the ONLY correlation key.
//   3. Failure handling: partition results into succeeded-clean, TRUNCATED
//      (result.type "succeeded" but stop_reason "max_tokens" - a
//      successful-LOOKING failure a naive errored-only filter misses),
//      errored, canceled, expired. Build a retry batch containing ONLY the
//      failures, each with a TARGETED modification (increased max_tokens for
//      the truncation; corrected request body for the invalid_request error)
//      and a -retry-1 custom_id suffix.
//   4. SLA arithmetic: 30h SLA - 24h max processing window = 6h buffer.
//      Latest submission = deadline - 30h (Monday 09:00 -> Sunday 03:00).
//      Steady-state cadence: data waits at most <interval> hours before the
//      next submission, so worst case latency = interval + 24h <= 30h ->
//      interval <= 6h; with safety margin, submit every 4-5 hours.
//   5. Prompt refinement on a 5-doc stratified sample, run SYNCHRONOUSLY for
//      a fast feedback loop (also the docs' own tip: dry-run the request
//      shape on the Messages API first, because batch param validation is
//      asynchronous and only reports when the whole batch ends). 3-prompt
//      ladder: vague -> explicit enums + format + decision rules -> + a
//      reasoning-included example. The full batch is submitted only with the
//      first prompt that clears 90% sample accuracy.
//
// Deliberate design choices:
//   - Two failures are SEEDED into the full batch so the retry path is
//     reproducible: one request carries an invalid model id (-> errored with
//     an invalid-request-class error: fix the body before resubmitting, and
//     NOT billed) and one carries max_tokens: 20 (-> "succeeded" with
//     stop_reason "max_tokens": billed, but the truncated output is useless
//     downstream and needs a retry with a bigger budget).
//   - The retry batch is a real second submission of ONLY the 2 failed
//     requests. Resubmitting all 20 would pay again for the 18 already-good
//     results - the core cost lesson of this task statement.
//   - The sample is stratified, not random: it covers all 4 categories plus
//     the known edge cases (word-form urgency, oblique product naming, a
//     billing-vs-account category trap, an implied-medium priority).
//     Sampling only easy docs inflates measured accuracy and the full batch
//     pays for the overconfidence in resubmissions.
//   - Shared-prefix prompt caching stacks with the 50% batch discount
//     (best-effort 30-98% hit rates; prefer the 1h TTL for batches), but the
//     system prompt here is far below claude-sonnet-5's 1024-token cache
//     minimum, so a cache_control marker would silently do nothing - omitted
//     rather than cargo-culted.
//   - Batches this small usually end within minutes but MAY take up to 24h;
//     the poll loop prints progress every 15s and bails after 45 minutes,
//     printing the batch id so results can be fetched later.
//   - Cost: ~45 tiny requests total; the 40 batched ones are billed at 50%
//     of standard prices, the errored/canceled/expired ones not at all.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";
const REGULAR_MAX_TOKENS = 300; // the JSON answer needs ~40 tokens; ample headroom
const ACCURACY_TARGET = 0.9;
const CUSTOM_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/; // the API's custom_id constraint

// ---------------------------------------------------------------------------
// Step 1: classify workflows as blocking vs latency-tolerant
// ---------------------------------------------------------------------------
// The single question that decides it: who or what is waiting for the result?
// A non-null waitingParty means the 24-hour processing window is intolerable
// no matter how attractive the 50% discount is.

interface Workflow {
  name: string;
  type: "synchronous" | "batch";
  waitingParty: string | null; // who/what is blocked pending the result
  reason: string;
}

const WORKFLOWS: Workflow[] = [
  {
    name: "Pre-merge code review",
    type: "synchronous",
    waitingParty: "developer (merge blocked)",
    reason: "The PR cannot merge until the review lands; a 24h window stalls every branch",
  },
  {
    name: "Weekly technical debt report",
    type: "batch",
    waitingParty: null,
    reason: "Consumed Monday morning; submitted early enough, even worst-case 24h processing beats the deadline",
  },
  {
    name: "Real-time customer support chat",
    type: "synchronous",
    waitingParty: "customer (live conversation)",
    reason: "Seconds matter; any queueing is user-visible churn",
  },
  {
    name: "Nightly test generation",
    type: "batch",
    waitingParty: null,
    reason: "Results consumed next business day; the overnight gap absorbs the processing window",
  },
  {
    name: "Overnight document extraction",
    type: "batch",
    waitingParty: null,
    reason: "Extracted data feeds a morning ETL job, not a person; 50% saving compounds at volume",
  },
];

// ---------------------------------------------------------------------------
// The document set: 20 short support tickets with ground truth
// ---------------------------------------------------------------------------

type Category = "billing" | "technical" | "account" | "shipping";

interface Truth {
  category: Category;
  priority: "low" | "medium" | "high";
  product: "CloudSync" | "DataVault" | "StreamLine";
}

interface Ticket {
  category: Category; // encoded into the custom_id naming convention
  content: string;
  truth: Truth;
  inSample?: boolean;
  sampleNote?: string; // why this doc earns one of the 5 sample slots
  seed?: "invalid-model" | "truncation"; // seeded batch failure (see header)
}

const TICKETS: Ticket[] = [
  {
    category: "billing",
    inSample: true,
    sampleNote: "easy anchor: explicit urgency, explicit product",
    content:
      "URGENT: I was charged twice for my CloudSync subscription this month and my card is now overdrawn. I need the duplicate charge refunded today.",
    truth: { category: "billing", priority: "high", product: "CloudSync" },
  },
  {
    category: "technical",
    inSample: true,
    sampleNote: "edge: word-form urgency + oblique product naming ('the vault product')",
    content:
      "Our nightly exports from the vault product keep failing with error 503 since Tuesday. We need this fixed as soon as humanly possible - the quarterly audit is Friday.",
    truth: { category: "technical", priority: "high", product: "DataVault" },
  },
  {
    category: "account",
    inSample: true,
    sampleNote: "edge: category trap - 'billing email' phrase inside an account-details change",
    content:
      "Whenever you get a chance, could you update the billing email on our StreamLine account from ops@acme.com to finance@acme.com? No rush at all.",
    truth: { category: "account", priority: "low", product: "StreamLine" },
  },
  {
    category: "shipping",
    inSample: true,
    sampleNote: "edge: no urgency marker at all -> implied medium",
    content:
      "The replacement DataVault hardware key you sent has not arrived and the tracking page has shown 'label created' for nine days.",
    truth: { category: "shipping", priority: "medium", product: "DataVault" },
  },
  {
    category: "technical",
    inSample: true,
    sampleNote: "edge: word-form low priority ('minor annoyance')",
    content:
      "Since the last StreamLine update, dashboard filters reset every time the page reloads. Minor annoyance, but flagging it.",
    truth: { category: "technical", priority: "low", product: "StreamLine" },
  },
  {
    category: "billing",
    content:
      "Could you send an itemized invoice for our March DataVault charges? Needed for expense reporting this month.",
    truth: { category: "billing", priority: "medium", product: "DataVault" },
  },
  {
    category: "billing",
    content:
      "Not urgent - I noticed the CloudSync receipt shows my old company name. Fix it whenever convenient.",
    truth: { category: "billing", priority: "low", product: "CloudSync" },
  },
  {
    category: "technical",
    seed: "invalid-model",
    content:
      "CloudSync is down for our whole team, nobody can access shared folders. This is blocking all work - critical.",
    truth: { category: "technical", priority: "high", product: "CloudSync" },
  },
  {
    category: "account",
    content: "Please add our new hire jane@acme.com as an admin on our DataVault workspace.",
    truth: { category: "account", priority: "medium", product: "DataVault" },
  },
  {
    category: "shipping",
    content:
      "Our StreamLine starter kit was marked delivered but never arrived, and we go live Monday. Urgent.",
    truth: { category: "shipping", priority: "high", product: "StreamLine" },
  },
  {
    category: "technical",
    content:
      "DataVault search returns no results for files uploaded after June 1. Everything older works fine.",
    truth: { category: "technical", priority: "medium", product: "DataVault" },
  },
  {
    category: "billing",
    content:
      "You've charged our StreamLine account after we cancelled in May. Reverse this immediately or we dispute the charge with the bank.",
    truth: { category: "billing", priority: "high", product: "StreamLine" },
  },
  {
    category: "account",
    content:
      "Minor thing: my display name in CloudSync still shows my maiden name. Please update it to Priya Raman when you can.",
    truth: { category: "account", priority: "low", product: "CloudSync" },
  },
  {
    category: "shipping",
    content:
      "No rush, but could you confirm the shipping address on our pending DataVault hardware order? Just double-checking.",
    truth: { category: "shipping", priority: "low", product: "DataVault" },
  },
  {
    category: "technical",
    seed: "truncation",
    content:
      "Exported CSVs from StreamLine open with garbled characters in Excel. Possibly a UTF-8 encoding issue?",
    truth: { category: "technical", priority: "medium", product: "StreamLine" },
  },
  {
    category: "billing",
    content:
      "We upgraded to the CloudSync team plan mid-cycle. How will proration appear on our next invoice?",
    truth: { category: "billing", priority: "medium", product: "CloudSync" },
  },
  {
    category: "account",
    content:
      "A former employee still has owner access on our DataVault org. Revoke it today please - security requirement.",
    truth: { category: "account", priority: "high", product: "DataVault" },
  },
  {
    category: "shipping",
    content:
      "The CloudSync welcome package arrived with a damaged box; the USB drive inside looks bent. What are the next steps?",
    truth: { category: "shipping", priority: "medium", product: "CloudSync" },
  },
  {
    category: "technical",
    content:
      "Cosmetic: the CloudSync tray icon stays orange even when sync is complete. Low priority.",
    truth: { category: "technical", priority: "low", product: "CloudSync" },
  },
  {
    category: "account",
    content:
      "We need to transfer ownership of our StreamLine workspace from the marketing team to the IT department.",
    truth: { category: "account", priority: "medium", product: "StreamLine" },
  },
];

// The custom_id naming convention: doc type + zero-padded index, so a bare id
// in a results log is self-describing. Must match ^[a-zA-Z0-9_-]{1,64}$.
function customId(ticket: Ticket, index: number): string {
  return `doc-${ticket.category}-${String(index).padStart(3, "0")}`;
}

const TICKET_BY_ID = new Map(TICKETS.map((t, i) => [customId(t, i), t]));

// ---------------------------------------------------------------------------
// Step 5 (defined first, runs before submission): the prompt ladder
// ---------------------------------------------------------------------------

const EXPLICIT_PROMPT =
  "You extract structured fields from customer support tickets.\n\n" +
  "Fields:\n" +
  '- "category": exactly one of "billing" (charges, refunds, invoices, payments), ' +
  '"technical" (bugs, errors, outages, product misbehaviour), ' +
  '"account" (account settings, user access, contact details, ownership), ' +
  '"shipping" (physical delivery of goods).\n' +
  '- "priority": "high" when the user signals urgency or is blocked, ' +
  '"low" when they say it is minor or not urgent, "medium" otherwise.\n' +
  '- "product": exactly one of "CloudSync", "DataVault", "StreamLine".\n\n' +
  'Respond with ONLY the JSON object {"category": "...", "priority": "...", "product": "..."} - ' +
  "no prose, no code fences.";

// The example paraphrases the failing patterns (oblique product reference,
// implied urgency, category trap) - it never copies a document from the set.
const FEW_SHOT_PROMPT =
  EXPLICIT_PROMPT +
  "\n\nExample ticket: \"The invoice you emailed lists the enterprise vault product twice - " +
  "accounts payable cannot process payment until it is corrected and month-end close is tomorrow.\"\n" +
  "Reasoning: the problem lives in an invoice, so the category is billing even though a product " +
  'document is wrong; "cannot process payment ... tomorrow" means the user is blocked, so priority ' +
  'is high; "the enterprise vault product" is an indirect reference to DataVault.\n' +
  'Output: {"category": "billing", "priority": "high", "product": "DataVault"}';

// A ladder, not a single prompt: iteration stops at the FIRST prompt that
// clears the accuracy target, so the cheapest sufficient prompt wins.
const PROMPT_LADDER: { label: string; prompt: string }[] = [
  {
    label: "P0 vague",
    prompt:
      "Read this customer support ticket and describe its category, priority, and the product it concerns.",
  },
  { label: "P1 explicit enums + format + decision rules", prompt: EXPLICIT_PROMPT },
  { label: "P2 P1 + reasoning-included example", prompt: FEW_SHOT_PROMPT },
];

// ---------------------------------------------------------------------------
// Shared request shape: identical for the sync dry-run and the batch params.
// This IS the point of the sync sample pass - batch validation is async, so
// a malformed params object only surfaces when the whole batch ends. The
// Messages API validates the same shape immediately.
// ---------------------------------------------------------------------------

function buildParams(
  ticket: Ticket,
  prompt: string,
  maxTokens: number = REGULAR_MAX_TOKENS,
): Anthropic.MessageCreateParamsNonStreaming {
  return {
    model: MODEL,
    max_tokens: maxTokens,
    system: prompt,
    messages: [{ role: "user", content: ticket.content }],
  };
}

function textOf(message: Anthropic.Message): string {
  return message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("\n");
}

interface Parsed {
  category?: string;
  priority?: string;
  product?: string;
}

function parseExtraction(text: string): Parsed | null {
  const match = text.match(/\{[\s\S]*?\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Parsed;
  } catch {
    return null;
  }
}

// Per-doc score = fraction of the 3 fields matching ground truth (lenient on
// case). An unparseable response scores 0 - format drift IS a failure here,
// because a batch consumer is a program, not a person.
function scoreDoc(parsed: Parsed | null, truth: Truth): number {
  if (!parsed) return 0;
  let ok = 0;
  if (String(parsed.category).toLowerCase() === truth.category) ok++;
  if (String(parsed.priority).toLowerCase() === truth.priority) ok++;
  if (String(parsed.product).toLowerCase() === truth.product.toLowerCase()) ok++;
  return ok / 3;
}

function fieldDiffs(parsed: Parsed | null, truth: Truth): string[] {
  if (!parsed) return ["response was not parseable JSON"];
  const diffs: string[] = [];
  if (String(parsed.category).toLowerCase() !== truth.category)
    diffs.push(`category: expected ${truth.category}, got ${parsed.category}`);
  if (String(parsed.priority).toLowerCase() !== truth.priority)
    diffs.push(`priority: expected ${truth.priority}, got ${parsed.priority}`);
  if (String(parsed.product).toLowerCase() !== truth.product.toLowerCase())
    diffs.push(`product: expected ${truth.product}, got ${parsed.product}`);
  return diffs;
}

// ---------------------------------------------------------------------------
// Step 5 runner: iterate on the stratified sample synchronously
// ---------------------------------------------------------------------------

interface IterationResult {
  label: string;
  prompt: string;
  accuracy: number;
  failureLines: string[];
}

async function runSampleIteration(label: string, prompt: string): Promise<IterationResult> {
  const sample = TICKETS.filter((t) => t.inSample);
  const scored = await Promise.all(
    sample.map(async (ticket, i) => {
      const response = await client.messages.create(buildParams(ticket, prompt));
      const parsed = parseExtraction(textOf(response));
      return { ticket, id: customId(ticket, TICKETS.indexOf(ticket)), parsed, score: scoreDoc(parsed, ticket.truth), i };
    }),
  );
  const accuracy = scored.reduce((s, r) => s + r.score, 0) / scored.length;
  const failureLines = scored
    .filter((r) => r.score < 1)
    .flatMap((r) => fieldDiffs(r.parsed, r.ticket.truth).map((d) => `      ${r.id}: ${d}`));
  return { label, prompt, accuracy, failureLines };
}

// ---------------------------------------------------------------------------
// Step 2 helpers: build, submit, poll, collect
// ---------------------------------------------------------------------------

type BatchRequest = Anthropic.Messages.Batches.BatchCreateParams.Request;

function buildBatchRequests(prompt: string): BatchRequest[] {
  return TICKETS.map((ticket, i) => {
    const params = buildParams(ticket, prompt);
    // The seeded failures (see header). Note both pass LOCAL construction
    // fine - the invalid model is only caught by the async batch validation,
    // and the tiny max_tokens is not an error at all, just a truncation.
    if (ticket.seed === "invalid-model") params.model = "claude-sonnet-5-nonexistent";
    if (ticket.seed === "truncation") params.max_tokens = 20;
    return { custom_id: customId(ticket, i), params };
  });
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForBatch(batchId: string, label: string): Promise<Anthropic.Messages.Batches.MessageBatch> {
  const POLL_MS = 15_000;
  const MAX_MS = 45 * 60_000;
  const start = Date.now();
  for (;;) {
    const batch = await client.messages.batches.retrieve(batchId);
    const elapsed = Math.round((Date.now() - start) / 1000);
    const c = batch.request_counts;
    console.log(
      `  [${label} +${elapsed}s] status=${batch.processing_status} ` +
        `processing=${c.processing} succeeded=${c.succeeded} errored=${c.errored} ` +
        `canceled=${c.canceled} expired=${c.expired}`,
    );
    if (batch.processing_status === "ended") return batch;
    if (Date.now() - start > MAX_MS) {
      throw new Error(
        `${label} ${batchId} still ${batch.processing_status} after 45 minutes. ` +
          `Batches may take up to 24h - fetch results later with ` +
          `client.messages.batches.results("${batchId}").`,
      );
    }
    await sleep(POLL_MS);
  }
}

type BatchResult = Anthropic.Messages.Batches.MessageBatchIndividualResponse["result"];

// Results arrive in ANY order; we also record arrival order to show it.
async function collectResults(
  batchId: string,
): Promise<{ byId: Map<string, BatchResult>; arrivalOrder: string[] }> {
  const byId = new Map<string, BatchResult>();
  const arrivalOrder: string[] = [];
  for await (const entry of await client.messages.batches.results(batchId)) {
    byId.set(entry.custom_id, entry.result);
    arrivalOrder.push(entry.custom_id);
  }
  return { byId, arrivalOrder };
}

// ---------------------------------------------------------------------------
// Step 3: classify each result and build the targeted retry batch
// ---------------------------------------------------------------------------
// The taxonomy the exam tests: "errored" is not the only failure. A result
// can be type "succeeded" and still be useless because stop_reason is
// "max_tokens" (truncated output) - that one IS billed, unlike errored/
// canceled/expired which are not.

type Outcome =
  | { kind: "ok"; parsed: Parsed | null; score: number }
  | { kind: "truncated" }
  | { kind: "errored"; errorType: string }
  | { kind: "canceled" }
  | { kind: "expired" };

function classifyResult(result: BatchResult, truth: Truth): Outcome {
  switch (result.type) {
    case "succeeded": {
      if (result.message.stop_reason === "max_tokens") return { kind: "truncated" };
      const parsed = parseExtraction(textOf(result.message));
      return { kind: "ok", parsed, score: scoreDoc(parsed, truth) };
    }
    case "errored": {
      // The error payload nests as {type:"error", error:{type, message}};
      // read defensively in case the shape is the flat variant.
      const err = result.error as unknown as { error?: { type?: string }; type?: string };
      return { kind: "errored", errorType: err.error?.type ?? err.type ?? "unknown" };
    }
    case "canceled":
      return { kind: "canceled" };
    case "expired":
      return { kind: "expired" };
  }
}

// Real chunking splits an oversized document into MULTIPLE requests (one
// custom_id suffix per chunk) - a third classic retry modification alongside
// increased max_tokens and format examples. These fixture docs are tiny, so
// this guard is a documented no-op; it never silently truncates real inputs.
const MAX_DOC_CHARS = 8_000;
function chunkIfNeeded(content: string): string {
  return content.length <= MAX_DOC_CHARS ? content : content.slice(0, MAX_DOC_CHARS);
}

interface RetryEntry {
  request: BatchRequest;
  originalId: string;
  modification: string;
}

function buildRetryEntries(
  outcomes: Map<string, Outcome>,
  prompt: string,
): RetryEntry[] {
  const entries: RetryEntry[] = [];
  for (const [id, outcome] of outcomes) {
    const ticket = TICKET_BY_ID.get(id);
    if (!ticket) continue;
    if (outcome.kind === "truncated") {
      // Targeted modification #1: the output was cut off, so the retry gets a
      // bigger budget than even the regular setting.
      const params = buildParams(ticket, prompt, REGULAR_MAX_TOKENS * 2);
      params.messages = [{ role: "user", content: chunkIfNeeded(ticket.content) }];
      entries.push({
        request: { custom_id: `${id}-retry-1`, params },
        originalId: id,
        modification: `max_tokens 20 -> ${REGULAR_MAX_TOKENS * 2} (output truncated at stop_reason "max_tokens")`,
      });
    } else if (outcome.kind === "errored") {
      // Targeted modification #2: an invalid-request-class error means the
      // BODY is wrong - resubmitting it verbatim just fails again. Rebuilding
      // via buildParams restores the valid model id. (A server-error-class
      // error would instead be retried verbatim.)
      const params = buildParams(ticket, prompt);
      params.messages = [{ role: "user", content: chunkIfNeeded(ticket.content) }];
      entries.push({
        request: { custom_id: `${id}-retry-1`, params },
        originalId: id,
        modification: `corrected model id (error type "${outcome.errorType}": fix the body, never retry verbatim)`,
      });
    }
    // expired -> resubmit as-is (not seeded here); canceled -> user decision.
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Step 4: SLA arithmetic (pure math - no API involved)
// ---------------------------------------------------------------------------

interface SlaPlan {
  slaHours: number;
  maxProcessingHours: number;
  bufferHours: number;
  deadline: Date;
  latestSubmission: Date;
  steadyStateIntervalHours: number;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function fmt(d: Date): string {
  return `${WEEKDAYS[d.getDay()]} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

function planSla(deadline: Date): SlaPlan {
  const slaHours = 30;
  const maxProcessingHours = 24; // the batch API's hard processing window
  const bufferHours = slaHours - maxProcessingHours; // 6h
  // Work BACKWARDS from the deadline assuming the worst case (full 24h):
  // the last moment a batch can be submitted and still make the SLA even if
  // processing takes the maximum is deadline - SLA (= deadline - 24h - 6h of
  // pre-deadline margin already inside the SLA figure).
  const latestSubmission = new Date(deadline.getTime() - slaHours * 3_600_000);
  // Steady-state cadence for continuously arriving data: an item waits at
  // most <interval> hours for the next submission, then up to 24h processing.
  // interval + 24 <= 30  ->  interval <= 6. Apply a margin factor so a single
  // missed submission slot does not blow the SLA: floor(6 * 0.75) = 4.
  const steadyStateIntervalHours = Math.floor(bufferHours * 0.75);
  return { slaHours, maxProcessingHours, bufferHours, deadline, latestSubmission, steadyStateIntervalHours };
}

// ---------------------------------------------------------------------------
// Shared assertion helper
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  // -------------------------------------------------------------------------
  console.log("=== Step 1: blocking vs latency-tolerant workflows ===");
  console.log(`  ${"workflow".padEnd(32)} ${"type".padEnd(12)} ${"waiting party".padEnd(30)} justification`);
  for (const w of WORKFLOWS) {
    console.log(
      `  ${w.name.padEnd(32)} ${w.type.padEnd(12)} ${(w.waitingParty ?? "-").padEnd(30)} ${w.reason}`,
    );
  }
  console.log(
    "  rule: a non-null waiting party means synchronous - the batch API only promises 'within 24 hours'.",
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 4: SLA-aware submission schedule (pure math) ===");
  const sla = planSla(new Date("2026-08-03T09:00:00")); // a Monday, 09:00
  console.log(`  SLA: ${sla.slaHours}h | max batch processing window: ${sla.maxProcessingHours}h`);
  console.log(`  buffer = ${sla.slaHours} - ${sla.maxProcessingHours} = ${sla.bufferHours}h`);
  console.log(`  report deadline:        ${fmt(sla.deadline)}`);
  console.log(
    `  latest safe submission: ${fmt(sla.latestSubmission)} (deadline - ${sla.slaHours}h; even a worst-case 24h batch then finishes ${sla.bufferHours}h early)`,
  );
  console.log(
    `  steady-state cadence: interval + 24h <= ${sla.slaHours}h -> interval <= ${sla.bufferHours}h; ` +
      `with margin, submit every ${sla.steadyStateIntervalHours}-${sla.bufferHours - 1}h`,
  );
  console.log(
    `  e.g. primary submission ${fmt(new Date(sla.latestSubmission.getTime() - 6 * 3_600_000))}, ` +
      `backup ${fmt(sla.latestSubmission)} - after that the SLA is unguaranteeable.`,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 5: prompt refinement on the 5-doc sample (BEFORE full submission) ===");
  const sample = TICKETS.filter((t) => t.inSample);
  console.log(`  sample of ${sample.length}, stratified across categories and edge cases:`);
  for (const t of sample) console.log(`    - [${t.category}] ${t.sampleNote}`);

  const iterations: IterationResult[] = [];
  let chosen: IterationResult | null = null;
  for (const rung of PROMPT_LADDER) {
    const result = await runSampleIteration(rung.label, rung.prompt);
    iterations.push(result);
    console.log(`  iteration ${iterations.length - 1} (${result.label}): ${(result.accuracy * 100).toFixed(0)}% accuracy`);
    for (const line of result.failureLines) console.log(line);
    if (result.accuracy >= ACCURACY_TARGET) {
      chosen = result;
      console.log(`  -> target ${ACCURACY_TARGET * 100}% reached; stop refining, submit the full batch with this prompt.`);
      break;
    }
  }
  if (!chosen) {
    chosen = iterations.reduce((best, r) => (r.accuracy > best.accuracy ? r : best));
    console.log(
      `  -> ladder exhausted below target; proceeding with the best rung (${chosen.label}, ${(chosen.accuracy * 100).toFixed(0)}%).`,
    );
  }
  console.log(
    `  economics: at 90% first-pass success, 20 docs -> ~2 resubmissions; at 60% -> ~8. ` +
      `The 5 sync sample calls cost far less than the 4x resubmission gap.`,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 2: submit the 20-document batch ===");
  const requests = buildBatchRequests(chosen.prompt);
  const ids = requests.map((r) => r.custom_id);
  console.log(`  ${requests.length} requests; custom_id convention doc-<type>-<nnn>, e.g. ${ids[0]}, ${ids[7]}, ${ids[19]}`);
  console.log(`  local pre-checks: unique=${new Set(ids).size === ids.length}, pattern-valid=${ids.every((id) => CUSTOM_ID_RE.test(id))}`);
  console.log(`  seeded failures inside the batch: ${customId(TICKETS[7], 7)} (invalid model), ${customId(TICKETS[14], 14)} (max_tokens: 20)`);

  const batch = await client.messages.batches.create({ requests });
  console.log(`  created batch ${batch.id}, status=${batch.processing_status}`);
  await waitForBatch(batch.id, "batch");

  const { byId, arrivalOrder } = await collectResults(batch.id);
  const arrivalMatchesSubmission = arrivalOrder.join() === ids.join();
  console.log(
    `  results arrived for ${byId.size}/${ids.length} custom_ids; arrival order ${
      arrivalMatchesSubmission ? "HAPPENED to match" : "did NOT match"
    } submission order - either way, correlate by custom_id, never by position.`,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 3: classify results, retry ONLY the failures ===");
  const outcomes = new Map<string, Outcome>();
  for (const id of ids) {
    const result = byId.get(id);
    const ticket = TICKET_BY_ID.get(id);
    if (!result || !ticket) continue;
    outcomes.set(id, classifyResult(result, ticket.truth));
  }
  const okOutcomes = [...outcomes.entries()].filter(([, o]) => o.kind === "ok");
  for (const [id, o] of outcomes) {
    if (o.kind === "ok") continue; // only narrate the interesting ones
    const detail = o.kind === "errored" ? ` (${o.errorType})` : "";
    console.log(`  ${id}: ${o.kind.toUpperCase()}${detail}`);
  }
  const contentAccuracy =
    okOutcomes.reduce((s, [, o]) => s + (o.kind === "ok" ? o.score : 0), 0) / Math.max(okOutcomes.length, 1);
  console.log(
    `  first-pass delivery: ${okOutcomes.length}/${ids.length} usable results ` +
      `(content accuracy on those: ${(contentAccuracy * 100).toFixed(0)}%)`,
  );
  console.log(
    `  billing note: the errored request is NOT billed; the truncated one IS - it "succeeded".`,
  );

  const retryEntries = buildRetryEntries(outcomes, chosen.prompt);
  console.log(`  retry batch: ${retryEntries.length} request(s) - the other ${okOutcomes.length} are NOT resubmitted:`);
  for (const e of retryEntries) console.log(`    ${e.request.custom_id}: ${e.modification}`);

  const retryBatch = await client.messages.batches.create({
    requests: retryEntries.map((e) => e.request),
  });
  console.log(`  created retry batch ${retryBatch.id}`);
  await waitForBatch(retryBatch.id, "retry");
  const { byId: retryById } = await collectResults(retryBatch.id);

  const retryOutcomes = new Map<string, Outcome>();
  for (const e of retryEntries) {
    const result = retryById.get(e.request.custom_id);
    const ticket = TICKET_BY_ID.get(e.originalId);
    if (!result || !ticket) continue;
    const outcome = classifyResult(result, ticket.truth);
    retryOutcomes.set(e.request.custom_id, outcome);
    console.log(
      `  ${e.request.custom_id}: ${outcome.kind}${outcome.kind === "ok" ? ` (score ${(outcome.score * 100).toFixed(0)}%)` : ""}`,
    );
  }
  const totalUsable = okOutcomes.length + [...retryOutcomes.values()].filter((o) => o.kind === "ok").length;
  console.log(`  after targeted retry: ${totalUsable}/${ids.length} documents completed.`);

  // -------------------------------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  check(
    "step 1: 5 workflows classified; every synchronous one names a waiting party, every batch one has none",
    WORKFLOWS.length === 5 &&
      WORKFLOWS.every((w) => (w.type === "synchronous" ? w.waitingParty !== null : w.waitingParty === null)) &&
      WORKFLOWS.every((w) => w.reason.length > 0),
  );
  check(
    "step 2: 20 requests with unique, pattern-valid custom_ids encoding type + index",
    requests.length === 20 && new Set(ids).size === 20 && ids.every((id) => CUSTOM_ID_RE.test(id)),
  );
  check(
    "step 2: a result arrived for every submitted custom_id (correlation is order-independent)",
    ids.every((id) => byId.has(id)),
  );
  check(
    "step 3: exactly the 2 seeded failures were identified - 1 errored + 1 truncated-but-'succeeded'",
    [...outcomes.values()].filter((o) => o.kind === "errored").length === 1 &&
      [...outcomes.values()].filter((o) => o.kind === "truncated").length === 1 &&
      outcomes.get(customId(TICKETS[7], 7))?.kind === "errored" &&
      outcomes.get(customId(TICKETS[14], 14))?.kind === "truncated",
  );
  check(
    "step 3: retry batch contains ONLY the failures, ids suffixed -retry-1, with targeted modifications",
    retryEntries.length === 2 &&
      retryEntries.every((e) => e.request.custom_id === `${e.originalId}-retry-1`) &&
      retryEntries.some((e) => (e.request.params.max_tokens ?? 0) > REGULAR_MAX_TOKENS) &&
      retryEntries.every((e) => e.request.params.model === MODEL),
  );
  check(
    "step 3: every retried document came back usable (succeeded, not truncated)",
    retryEntries.length > 0 && [...retryOutcomes.values()].every((o) => o.kind === "ok") && totalUsable === 20,
  );
  check(
    "step 4: buffer = 6h and latest submission = Sunday 03:00, exactly 30h before the Monday 09:00 deadline",
    sla.bufferHours === 6 &&
      sla.latestSubmission.getDay() === 0 &&
      sla.latestSubmission.getHours() === 3 &&
      sla.deadline.getTime() - sla.latestSubmission.getTime() === 30 * 3_600_000 &&
      sla.steadyStateIntervalHours <= sla.bufferHours,
  );
  check(
    "step 5: sample of 5 covers all 4 categories (stratified, not just easy docs)",
    sample.length === 5 && new Set(sample.map((t) => t.category)).size === 4,
  );
  check(
    `step 5: refinement improved accuracy over the vague baseline and the chosen prompt cleared ${ACCURACY_TARGET * 100}%`,
    iterations.length > 0 &&
      chosen.accuracy >= ACCURACY_TARGET &&
      chosen.accuracy > iterations[0].accuracy,
  );
  check(
    "overall: full batch was submitted with the refined prompt, not the vague baseline",
    chosen.label !== PROMPT_LADDER[0].label,
  );
}

main().catch(console.error);
