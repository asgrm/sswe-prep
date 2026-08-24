// Exercise 4_04 - validation-retry loops and self-correction schemas (Task Statement 4.4)
// Run: npx tsx 4_04-validation-retry-loop.ts
//
// Steps:
//   1. Self-correction schema with TWO layers: the extraction data (line_items,
//      dates, currency) and the self-assessment metadata (calculated_total vs
//      stated_total, total_discrepancy, conflict_detected, and a
//      detected_pattern on every line-item finding). Shape verified in code.
//   2. Semantic validation - the errors tool_use CANNOT eliminate: field
//      completeness, numerical consistency (recomputed sum vs calculated_total
//      vs stated_total), enum validity, date ordering, flag-state consistency.
//      PLUS a grounding layer checking extracted values against the source
//      text. Every error states what was expected versus what was found.
//   3. Retry loop: on validation failure, a sectioned follow-up message
//      (Original document / Your extraction / Validation errors) with a
//      MAX_RETRIES=3 cap. Retry-with-error-feedback gives the model a target;
//      a naive retry typically reproduces the same mistake.
//   4. 5 documents - 2 FIXABLE (misread amount, silently-"corrected" total:
//      the right answer exists in the document) and 3 UNFIXABLE (due date
//      absent, currency outside the enum, the document's own date
//      contradiction: no retry can create or represent the answer).
//      Errors are CLASSIFIED before retrying - unfixable ones go straight to
//      human review with zero retries.
//   5. detected_pattern telemetry: group all line-item findings by pattern,
//      apply (simulated) reviewer dismissal decisions, and prioritise prompt
//      refinement by impact = frequency * dismissal rate.
//
// Deliberate design choices:
//   - The two fixable docs get SEEDED failed first attempts. A capable model
//     usually extracts them correctly on the first try, which would leave the
//     retry path unexercised - seeding a documented, realistic first-pass
//     mistake makes the retry-with-feedback mechanism reproducible. The
//     retries themselves are live API calls.
//   - The discrepancy-flag check compares flags against the RECOMPUTED sum,
//     not the naive "sum != stated_total is an error" (starter-code style):
//     an extraction reporting a genuine document discrepancy (items sum to
//     460, stated total 500, both flags true) is CORRECT and must validate
//     clean. The paired totals + flags are exactly what lets validation
//     distinguish "document is wrong, faithfully reported" from "extraction
//     is wrong".
//   - The grounding layer is what catches silent correction: stated_total=460
//     with flags false is internally consistent - only checking 460 against
//     the source text reveals the model rewrote the document.
//   - due_date and currency are REQUIRED with no null/escape values. That is
//     the deliberate seeded flaw (4_03's lesson inverted) that makes the
//     u-docs unfixable-by-retry: the real fix is a schema change or human
//     review, never more retries.
//
// Empirical note (claude-sonnet-5): both fixable docs converged in ONE retry.
// On f1 the model had a cheaper escape available - keeping the misread 450
// and flipping the flags would also have validated clean, because line-item
// amounts are not grounded in this fixture - but it re-read the document and
// corrected the amount instead (validation is a FILTER, not an oracle: it
// bounds the failure modes, the model still has to do the reading). On u2 the
// model respected the non-strict currency enum and picked a wrong-but-valid
// enum value rather than emitting "JPY" - fabrication under constraint that
// the semantic enum check can never see; only the grounding layer caught it.
// On u3 the model faithfully reproduced the document's contradictory dates
// rather than "fixing" them, as the tool description instructs.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";
const MAX_RETRIES = 3;

// ---------------------------------------------------------------------------
// Step 1: the self-correction extraction tool
// ---------------------------------------------------------------------------
// Layer 1 (extraction data): line_items, invoice_date, due_date, currency.
// Layer 2 (self-assessment metadata): calculated_total (the model's own sum)
// vs stated_total (the figure printed in the document), total_discrepancy,
// conflict_detected, and detected_pattern per finding. The paired totals make
// discrepancy detection automatic - no external arithmetic oracle needed.

const CURRENCY_ENUM = ["USD", "EUR", "GBP"] as const;
const PATTERN_ENUM = [
  "plain-numeric",
  "word-form-amount",
  "comma-thousands",
  "negative-adjustment",
  "narrative-inline",
  "other",
] as const;

const extractionTool: Anthropic.Tool = {
  name: "extract_invoice",
  description:
    "Extract structured invoice data EXACTLY as the document states it. " +
    "calculated_total is the sum YOU compute by adding the line item amounts; " +
    "stated_total is the total figure as PRINTED in the document, even when that figure is wrong. " +
    "Set total_discrepancy true when they differ, and conflict_detected true when the document " +
    "contains internally conflicting information (totals that do not add up, dates that contradict " +
    "each other). Never silently correct the document - report its errors through the flag fields. " +
    "Dates in ISO 8601 (YYYY-MM-DD).",
  input_schema: {
    type: "object",
    properties: {
      line_items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            amount: {
              type: "number",
              description: "Line amount as stated; negative for credits/discounts",
            },
            detected_pattern: {
              type: "string",
              enum: [...PATTERN_ENUM],
              description:
                'The formatting construct that triggered this finding: "plain-numeric" ' +
                '(e.g. 540.00 in a plain column), "word-form-amount" (amount written in words), ' +
                '"comma-thousands" (e.g. 205,000), "negative-adjustment" (credit or discount line), ' +
                '"narrative-inline" (amount embedded in prose), "other".',
            },
          },
          required: ["description", "amount", "detected_pattern"],
        },
      },
      calculated_total: {
        type: "number",
        description: "The sum of the line item amounts, computed by you",
      },
      stated_total: {
        type: "number",
        description: "The total exactly as printed in the document, even if it is wrong",
      },
      total_discrepancy: {
        type: "boolean",
        description: "true when calculated_total and stated_total differ",
      },
      conflict_detected: {
        type: "boolean",
        description: "true when the document contains internally conflicting information",
      },
      invoice_date: { type: "string", description: "Issue date, ISO 8601 (YYYY-MM-DD)" },
      // The seeded flaws: due_date and currency are required with no escape.
      // When a document has no due date, or a currency outside the enum, the
      // model has no valid way to answer - THAT is what makes those documents
      // unfixable by retry (step 4).
      due_date: {
        type: "string",
        description: "Payment due date exactly as stated, ISO 8601 (YYYY-MM-DD)",
      },
      currency: { type: "string", enum: [...CURRENCY_ENUM] },
    },
    required: [
      "line_items",
      "calculated_total",
      "stated_total",
      "total_discrepancy",
      "conflict_detected",
      "invoice_date",
      "due_date",
      "currency",
    ],
  },
};

interface LineItem {
  description: string;
  amount: number;
  detected_pattern: string;
}

interface ExtractionResult {
  line_items: LineItem[];
  calculated_total: number;
  stated_total: number;
  total_discrepancy: boolean;
  conflict_detected: boolean;
  invoice_date: string;
  due_date: string;
  currency: string;
}

// ---------------------------------------------------------------------------
// Test set: 2 fixable documents (with seeded failed first attempts) and
// 3 unfixable documents (processed live)
// ---------------------------------------------------------------------------

interface TestDoc {
  id: string;
  expectFixable: boolean;
  content: string;
  // Present only on the fixable docs: the simulated first-pass mistake that
  // the retry loop must correct (see design choices above).
  seededFailure?: ExtractionResult;
  note: string;
}

const DOCS: TestDoc[] = [
  {
    id: "f1-misread-amount",
    expectFixable: true,
    note: "seeded: first amount misread 540->450 and calculated_total copied from the printed total",
    content: `INVOICE INV-3401
Halcyon Office Supplies
Invoice date: 2024-03-01
Payment due: 2024-03-31
Currency: USD

| Item           | Amount |
|----------------|--------|
| Standing desk  | 540.00 |
| Monitor arm x2 | 180.00 |
| Cable trays    |  45.00 |
| Delivery       |  35.00 |
| TOTAL          | 800.00 |`,
    // The document is internally consistent (540+180+45+35 = 800). The seeded
    // mistake: one misread digit-transposed amount, and calculated_total
    // copied from the printed TOTAL instead of actually summing - so the
    // items sum to 710 while both totals claim 800.
    seededFailure: {
      line_items: [
        { description: "Standing desk", amount: 450.0, detected_pattern: "plain-numeric" },
        { description: "Monitor arm x2", amount: 180.0, detected_pattern: "plain-numeric" },
        { description: "Cable trays", amount: 45.0, detected_pattern: "plain-numeric" },
        { description: "Delivery", amount: 35.0, detected_pattern: "plain-numeric" },
      ],
      calculated_total: 800.0,
      stated_total: 800.0,
      total_discrepancy: false,
      conflict_detected: false,
      invoice_date: "2024-03-01",
      due_date: "2024-03-31",
      currency: "USD",
    },
  },
  {
    id: "f2-silent-correction",
    expectFixable: true,
    note: "seeded: the vendor's own arithmetic error (items sum 460, printed TOTAL 500) silently 'fixed' to 460",
    content: `From: accounts@brightpath.io
Subject: Invoice BP-2107

Invoice BP-2107, dated 2024-04-05, payment due 2024-05-05, in USD.
Services provided: onboarding workshop one hundred twenty dollars (120.00),
follow-up coaching 150.00, and the materials pack 190.00.

Amount due - TOTAL: 500.00`,
    // The document itself is wrong (460 vs a printed 500). The CORRECT
    // extraction reports stated_total=500 with both flags true. The seeded
    // mistake is the classic silent correction: stated_total rewritten to
    // match the sum, flags false. Internally consistent - only the grounding
    // layer catches it (500.00 is in the document; 460 is not).
    seededFailure: {
      line_items: [
        { description: "Onboarding workshop", amount: 120.0, detected_pattern: "word-form-amount" },
        { description: "Follow-up coaching", amount: 150.0, detected_pattern: "narrative-inline" },
        { description: "Materials pack", amount: 190.0, detected_pattern: "narrative-inline" },
      ],
      calculated_total: 460.0,
      stated_total: 460.0,
      total_discrepancy: false,
      conflict_detected: false,
      invoice_date: "2024-04-05",
      due_date: "2024-05-05",
      currency: "USD",
    },
  },
  {
    id: "u1-no-due-date",
    expectFixable: false,
    note: "unfixable: a paid till receipt states no due date - the information is ABSENT, not hard to find",
    content: `*** RIVERSIDE HARDWARE ***
Receipt R-8843
2024-06-12
Currency: USD
2x paint tin       58.00
brushes            12.50
sandpaper pack      6.50
TOTAL              77.00
PAID IN FULL - CARD`,
  },
  {
    id: "u2-currency-outside-enum",
    expectFixable: false,
    note: "unfixable: the document is in JPY, which the currency enum cannot represent - a schema gap, not an extraction error",
    content: `INVOICE #TK-5501
Sakura Print Co., Tokyo
Invoice date: 2024-05-01, payment due 2024-05-31
All amounts in Japanese Yen (JPY)

Design services   ¥120,000
Printing          ¥85,000
TOTAL             ¥205,000`,
  },
  {
    id: "u3-date-contradiction",
    expectFixable: false,
    note: "unfixable: the document's own due date precedes its invoice date - re-extraction faithfully reproduces the defect",
    content: `INVOICE LM-990
Lumen Maintenance Ltd
Invoice date: 10 May 2024
Payment due by: 1 April 2024
Currency: EUR

Quarterly HVAC service    300.00
Filter replacement         45.50
Credit for missed visit   -25.00
TOTAL                     320.50`,
  },
];

// ---------------------------------------------------------------------------
// Grounding helpers: does an extracted value actually appear in the source?
// ---------------------------------------------------------------------------
// Fixture-scoped: these handle the formats used in the docs above (ISO dates,
// "10 May 2024" narrative dates, plain and comma-grouped amounts). Production
// grounding needs a proper normaliser, but the principle is identical.

function addThousands(s: string): string {
  const [int, frac] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac !== undefined ? `${grouped}.${frac}` : grouped;
}

function amountAppearsInDoc(doc: string, value: number): boolean {
  const fixed = value.toFixed(2);
  const plain = String(value);
  const variants = new Set([fixed, plain, addThousands(fixed), addThousands(plain)]);
  return [...variants].some((v) => doc.includes(v));
}

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

function dateAppearsInDoc(doc: string, isoDate: string): boolean {
  const m = isoDate.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const [, y, mm, dd] = m;
  const monthName = MONTHS[Number(mm) - 1] ?? "";
  const variants = [isoDate, `${Number(dd)} ${monthName} ${y}`, `${monthName} ${Number(dd)}`];
  return variants.some((v) => doc.includes(v));
}

const DUE_DATE_CUE = /\bdue\b|\bpayable\b|\bnet\s*\d+/i;

const CURRENCY_CUES: Record<string, RegExp> = {
  USD: /\$|USD|dollar/i,
  EUR: /€|EUR(?!O)|euro/i,
  GBP: /£|GBP|pound/i,
  JPY: /¥|JPY|yen/i,
};

function detectDocCurrencies(doc: string): string[] {
  return Object.entries(CURRENCY_CUES)
    .filter(([, cue]) => cue.test(doc))
    .map(([code]) => code);
}

// ---------------------------------------------------------------------------
// Step 2: semantic validation + grounding
// ---------------------------------------------------------------------------
// tool_use with a JSON schema eliminates SYNTAX errors (malformed JSON, wrong
// types under strict mode). It cannot catch SEMANTIC errors: sums that do not
// add up, flags contradicting the data, values the document never contained.
// Every error message states expected vs found - "validation failed" gives a
// retry nothing to aim at.

function validateSemantic(result: ExtractionResult): string[] {
  const errors: string[] = [];

  // 1) Field completeness
  const requiredFields: (keyof ExtractionResult)[] = [
    "line_items", "calculated_total", "stated_total", "total_discrepancy",
    "conflict_detected", "invoice_date", "due_date", "currency",
  ];
  for (const field of requiredFields) {
    if (result[field] === null || result[field] === undefined) {
      errors.push(`Required field ${field} is missing or null`);
    }
  }
  if (!Array.isArray(result.line_items) || result.line_items.length === 0) {
    errors.push("line_items must be a non-empty array of extracted line items");
    return errors; // the numeric checks below need items to work with
  }

  // 2) Enum validity (per-finding pattern labels and the currency)
  for (const item of result.line_items) {
    if (typeof item.amount !== "number") {
      errors.push(`Line item "${item.description}": amount must be a number, found ${JSON.stringify(item.amount)}`);
    }
    if (!(PATTERN_ENUM as readonly string[]).includes(item.detected_pattern)) {
      errors.push(
        `Line item "${item.description}": detected_pattern "${item.detected_pattern}" ` +
          `is not one of ${PATTERN_ENUM.join(", ")}`,
      );
    }
  }
  if (result.currency != null && !(CURRENCY_ENUM as readonly string[]).includes(result.currency)) {
    errors.push(`currency "${result.currency}" is not one of ${CURRENCY_ENUM.join(", ")}`);
  }

  // 3) Numerical consistency. The recomputed sum is the ground truth for the
  // ITEMS; stated_total is the ground truth for the DOCUMENT. The flags must
  // reconcile the two - a faithfully reported document discrepancy (sum 460,
  // stated 500, flags true) validates CLEAN.
  const sum = result.line_items.reduce(
    (s, item) => s + (typeof item.amount === "number" ? item.amount : 0), 0,
  );
  const roundedSum = Math.round(sum * 100) / 100;
  if (Math.abs(roundedSum - result.calculated_total) > 0.01) {
    errors.push(
      `calculated_total is ${result.calculated_total} but the line items actually sum to ${roundedSum}`,
    );
  }
  const discrepancyActual = Math.abs(roundedSum - result.stated_total) > 0.01;
  if (result.total_discrepancy !== discrepancyActual) {
    errors.push(
      `total_discrepancy is ${result.total_discrepancy} but line items sum to ${roundedSum} ` +
        `and stated_total is ${result.stated_total} (flag should be ${discrepancyActual})`,
    );
  }
  if (discrepancyActual && !result.conflict_detected) {
    errors.push(
      `conflict_detected is false but must be true: line items sum to ${roundedSum} ` +
        `while the document states ${result.stated_total}`,
    );
  }

  // 4) Date ordering
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (typeof result.invoice_date === "string" && typeof result.due_date === "string") {
    if (iso.test(result.invoice_date) && iso.test(result.due_date) && result.invoice_date > result.due_date) {
      errors.push(
        `invoice_date ${result.invoice_date} is after due_date ${result.due_date} - dates are out of order`,
      );
    }
  }

  return errors;
}

// The grounding layer: internal consistency alone cannot catch a model that
// silently rewrote the document (f2's seeded failure is internally perfect).
function validateGrounding(result: ExtractionResult, doc: string): string[] {
  const errors: string[] = [];

  if (typeof result.stated_total === "number" && !amountAppearsInDoc(doc, result.stated_total)) {
    errors.push(`stated_total ${result.stated_total} not found in source document`);
  }

  if (!DUE_DATE_CUE.test(doc)) {
    // Deterministic regardless of what the model put in the forced field:
    // extraction of a due date requires due-date evidence in the source.
    errors.push("due_date: no due-date information found in source document");
  } else if (typeof result.due_date === "string" && !dateAppearsInDoc(doc, result.due_date)) {
    errors.push(`due_date ${result.due_date} not found in source document`);
  }
  if (typeof result.invoice_date === "string" && !dateAppearsInDoc(doc, result.invoice_date)) {
    errors.push(`invoice_date ${result.invoice_date} not found in source document`);
  }

  const cue = CURRENCY_CUES[result.currency];
  if (cue && !cue.test(doc)) {
    const evidence = detectDocCurrencies(doc);
    const representable = evidence.filter((c) => (CURRENCY_ENUM as readonly string[]).includes(c));
    if (evidence.length > 0 && representable.length === 0) {
      errors.push(
        `document currency appears to be ${evidence.join("/")}, which is not an allowed value ` +
          `(${CURRENCY_ENUM.join(", ")})`,
      );
    } else {
      errors.push(`currency ${result.currency} not found in source document`);
    }
  }

  return errors;
}

function validateExtraction(result: ExtractionResult, doc: string): string[] {
  return [...validateSemantic(result), ...validateGrounding(result, doc)];
}

// ---------------------------------------------------------------------------
// Step 4 (classification, defined before the loop that uses it): fixable vs
// unfixable errors
// ---------------------------------------------------------------------------
// The retry effectiveness boundary: a retry can fix any error whose correct
// answer EXISTS in the source document (misread values, arithmetic, wrong
// flags, mislabelled patterns). It cannot create absent information, represent
// values the schema forbids, or resolve the document's own contradictions -
// those need a human or a schema change, and retrying them just burns tokens
// while pressuring the model to fabricate.

function isFixableError(error: string, doc: string): boolean {
  // Arithmetic, flag, and label errors: re-derivable from the document.
  if (/actually sum to|total_discrepancy is|conflict_detected is/.test(error)) return true;
  if (/detected_pattern|line_items must be a non-empty|amount must be a number/.test(error)) return true;

  // "X not found in source" for stated_total/dates means the model wrote a
  // value the document does not contain - the document still holds the real
  // one, so a retry can recover it.
  if (/^(stated_total|invoice_date) .* not found in source/.test(error)) return true;
  if (/^due_date \S+ not found in source/.test(error)) return true;

  // Absent information: no retry can extract a due date the document never
  // states.
  if (error.includes("no due-date information")) return false;

  // Currency problems: fixable only when the document shows a currency the
  // enum can actually represent.
  if (error.startsWith("currency") || error.includes("not an allowed value")) {
    return detectDocCurrencies(doc).some((c) => (CURRENCY_ENUM as readonly string[]).includes(c));
  }

  // Date ordering: when BOTH dates are grounded in the document, the
  // contradiction is the document's own defect - a faithful re-extraction
  // reproduces it. Only an ungrounded (misread) date makes this fixable.
  if (error.includes("dates are out of order")) {
    const dates = error.match(/\d{4}-\d{2}-\d{2}/g) ?? [];
    return !(dates.length === 2 && dates.every((d) => dateAppearsInDoc(doc, d)));
  }

  // Missing required field: fixable only if the document plausibly contains it.
  const missing = error.match(/^Required field (\w+) is missing/);
  if (missing) return missing[1] === "due_date" ? DUE_DATE_CUE.test(doc) : true;

  return false; // conservative default: unknown error shapes go to a human
}

function flagForHumanReview(docId: string, reasons: string[], lines: string[]): void {
  lines.push(`  -> flagged for HUMAN REVIEW (no retry - the answer is not in the document):`);
  for (const r of reasons) lines.push(`       ${r}`);
}

// ---------------------------------------------------------------------------
// Step 3: extraction call + the retry loop
// ---------------------------------------------------------------------------

async function extract(userText: string): Promise<ExtractionResult> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    tools: [extractionTool],
    // Forced tool_choice: this is a mandatory pipeline step (4_03's ladder) -
    // structured output must be guaranteed on every attempt including retries.
    tool_choice: { type: "tool", name: "extract_invoice", disable_parallel_tool_use: true },
    messages: [{ role: "user", content: userText }],
  });
  const block = response.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
  );
  return (block?.input ?? {}) as ExtractionResult;
}

// All three elements the model needs to target its self-correction: the
// source of truth (document), what it produced (failed extraction), and
// exactly what is wrong with it (specific validation errors).
function buildRetryMessage(doc: string, result: ExtractionResult, errors: string[]): string {
  return (
    `Original document:\n${doc}\n\n` +
    `Your extraction:\n${JSON.stringify(result, null, 2)}\n\n` +
    `Validation errors:\n${errors.map((e) => `- ${e}`).join("\n")}\n\n` +
    `Please re-extract the document with the extract_invoice tool, fixing the identified errors. ` +
    `Extract values exactly as the document states them - report document inconsistencies via ` +
    `total_discrepancy and conflict_detected instead of correcting them.`
  );
}

interface DocOutcome {
  doc: TestDoc;
  attempts: number; // retries actually performed (0 = never retried)
  firstErrors: string[]; // validation errors on the initial attempt
  finalErrors: string[];
  humanReview: boolean;
  unfixableReasons: string[];
  result: ExtractionResult;
  sampleRetryMessage: string | null;
  lines: string[]; // buffered per-doc log (pipelines run in parallel)
}

async function processDocument(doc: TestDoc): Promise<DocOutcome> {
  const lines: string[] = [];
  let result: ExtractionResult;
  if (doc.seededFailure) {
    result = doc.seededFailure;
    lines.push(`  attempt 0: SEEDED failed extraction (${doc.note})`);
  } else {
    result = await extract(`Here is an invoice document to extract:\n\n${doc.content}`);
    lines.push(`  attempt 0: live extraction (${doc.note})`);
  }

  let errors = validateExtraction(result, doc.content);
  const firstErrors = [...errors];
  let attempts = 0;
  let humanReview = false;
  let unfixableReasons: string[] = [];
  let sampleRetryMessage: string | null = null;

  while (errors.length > 0 && attempts < MAX_RETRIES) {
    const unfixable = errors.filter((e) => !isFixableError(e, doc.content));
    for (const e of errors) {
      lines.push(`    [${isFixableError(e, doc.content) ? "fixable" : "UNFIXABLE"}] ${e}`);
    }
    // Classify BEFORE retrying: any unfixable error short-circuits to a human.
    if (unfixable.length > 0) {
      humanReview = true;
      unfixableReasons = unfixable;
      flagForHumanReview(doc.id, unfixable, lines);
      break;
    }
    const retryMessage = buildRetryMessage(doc.content, result, errors);
    sampleRetryMessage = sampleRetryMessage ?? retryMessage;
    result = await extract(retryMessage);
    attempts++;
    errors = validateExtraction(result, doc.content);
    lines.push(
      `  retry ${attempts}: ${errors.length === 0 ? "validation CLEAN" : `${errors.length} error(s) remain`}`,
    );
  }

  if (!humanReview && errors.length > 0) {
    // Fixable-looking errors that survived the retry budget still end at a
    // human - the cap prevents infinite loops on genuinely unfixable cases
    // the classifier missed.
    humanReview = true;
    unfixableReasons = errors;
    lines.push(`  -> retry budget (${MAX_RETRIES}) exhausted; flagged for HUMAN REVIEW`);
  }

  return {
    doc, attempts, firstErrors, finalErrors: errors, humanReview,
    unfixableReasons, result, sampleRetryMessage, lines,
  };
}

// ---------------------------------------------------------------------------
// Step 5: detected_pattern telemetry and dismissal analysis
// ---------------------------------------------------------------------------
// In production, wasDismissed comes from reviewer accept/dismiss actions on
// each finding. Here a deterministic fixture stands in for that telemetry:
// per-pattern historic dismissal rates, applied to the LIVE findings the
// extractions produced. The analysis code is exactly what production runs.

interface Finding {
  docId: string;
  description: string;
  pattern: string;
  wasDismissed: boolean;
}

const SIMULATED_DISMISSAL_RATE: Record<string, number> = {
  "plain-numeric": 0.8, // reviewers overwhelmingly dismiss: flagging ordinary rows is noise
  "narrative-inline": 0.5, // hit-and-miss: prose amounts are sometimes worth a look
  "word-form-amount": 0.0, // consistently accepted: word-form amounts really are error-prone
  "comma-thousands": 0.0, // consistently accepted
  "negative-adjustment": 0.0, // consistently accepted: sign errors are costly
  other: 0.5,
};

function applySimulatedReviewerDecisions(findings: Finding[]): void {
  const byPattern = new Map<string, Finding[]>();
  for (const f of findings) {
    const group = byPattern.get(f.pattern) ?? [];
    group.push(f);
    byPattern.set(f.pattern, group);
  }
  for (const [pattern, group] of byPattern) {
    const rate = SIMULATED_DISMISSAL_RATE[pattern] ?? 0.5;
    const dismissCount = Math.round(rate * group.length);
    group.forEach((f, i) => {
      f.wasDismissed = i < dismissCount;
    });
  }
}

interface PatternPriority {
  pattern: string;
  total: number;
  dismissed: number;
  dismissalRate: number;
  impact: number;
}

function analyseDismissalPatterns(findings: Finding[]): PatternPriority[] {
  const stats: Record<string, { total: number; dismissed: number }> = {};
  for (const f of findings) {
    stats[f.pattern] = stats[f.pattern] ?? { total: 0, dismissed: 0 };
    stats[f.pattern].total++;
    if (f.wasDismissed) stats[f.pattern].dismissed++;
  }
  // Impact = frequency * dismissal rate (i.e. dismissed count): a FREQUENT
  // pattern reviewers keep dismissing is the refinement priority; a rare one
  // with the same rate is not worth the prompt-engineering time.
  return Object.entries(stats)
    .map(([pattern, s]) => ({
      pattern,
      total: s.total,
      dismissed: s.dismissed,
      dismissalRate: s.total === 0 ? 0 : s.dismissed / s.total,
      impact: s.total * (s.total === 0 ? 0 : s.dismissed / s.total),
    }))
    .sort((a, b) => b.impact - a.impact);
}

// ---------------------------------------------------------------------------
// Step 1 verification + shared assertion helper
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

function verifySchema(): boolean {
  const schema = extractionTool.input_schema as unknown as {
    properties: Record<string, { type?: unknown; enum?: unknown; items?: { properties?: Record<string, { enum?: unknown }>; required?: string[] } }>;
    required?: string[];
  };
  const results: boolean[] = [];
  const record = (label: string, ok: boolean): void => {
    results.push(ok);
    check(label, ok);
  };

  record(
    "layer 1+2: calculated_total and stated_total are SEPARATE number fields",
    schema.properties.calculated_total?.type === "number" &&
      schema.properties.stated_total?.type === "number",
  );
  record(
    "total_discrepancy and conflict_detected are boolean fields",
    schema.properties.total_discrepancy?.type === "boolean" &&
      schema.properties.conflict_detected?.type === "boolean",
  );
  const itemProps = schema.properties.line_items?.items?.properties ?? {};
  record(
    "every line-item finding carries a detected_pattern (required, enum-constrained)",
    Array.isArray(itemProps.detected_pattern?.enum) &&
      (schema.properties.line_items?.items?.required ?? []).includes("detected_pattern"),
  );
  record(
    "required includes line_items, both totals, and the discrepancy flag",
    ["line_items", "calculated_total", "stated_total", "total_discrepancy"].every((f) =>
      (schema.required ?? []).includes(f),
    ),
  );
  record(
    "seeded flaw in place: due_date and currency required with no null escape",
    (schema.required ?? []).includes("due_date") &&
      (schema.required ?? []).includes("currency") &&
      schema.properties.due_date?.type === "string" &&
      Array.isArray(schema.properties.currency?.enum),
  );
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function main() {
  console.log("=== Step 1: self-correction schema shape ===");
  const schemaOk = verifySchema();

  // -------------------------------------------------------------------------
  console.log("\n=== Steps 2-4: validate -> classify -> retry or escalate (5 documents) ===");
  const outcomes = await Promise.all(DOCS.map(processDocument));
  for (const o of outcomes) {
    console.log(`\n  --- ${o.doc.id} ---`);
    for (const line of o.lines) console.log(line);
    const finalState = o.humanReview
      ? "HUMAN REVIEW"
      : o.finalErrors.length === 0
        ? "VALID"
        : "INVALID";
    console.log(`  outcome: ${finalState} after ${o.attempts} retr${o.attempts === 1 ? "y" : "ies"}`);
    if (!o.humanReview) {
      const r = o.result;
      console.log(
        `  final extraction: calculated=${r.calculated_total} stated=${r.stated_total} ` +
          `discrepancy=${r.total_discrepancy} conflict=${r.conflict_detected}`,
      );
    }
  }

  const sampleMessage = outcomes.find((o) => o.sampleRetryMessage)?.sampleRetryMessage;
  if (sampleMessage) {
    console.log("\n  --- sample retry message (first retry performed) ---");
    for (const line of sampleMessage.split("\n")) console.log(`  | ${line}`);
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Step 5: detected_pattern dismissal analysis ===");
  const findings: Finding[] = outcomes.flatMap((o) =>
    (Array.isArray(o.result.line_items) ? o.result.line_items : []).map((item) => ({
      docId: o.doc.id,
      description: item.description,
      pattern: item.detected_pattern,
      wasDismissed: false,
    })),
  );
  applySimulatedReviewerDecisions(findings);
  const priorities = analyseDismissalPatterns(findings);

  console.log(`  ${findings.length} findings collected across ${outcomes.length} documents`);
  console.log(`  ${"pattern".padEnd(22)} ${"findings".padEnd(9)} ${"dismissed".padEnd(10)} ${"rate".padEnd(6)} impact`);
  for (const p of priorities) {
    console.log(
      `  ${p.pattern.padEnd(22)} ${String(p.total).padEnd(9)} ${String(p.dismissed).padEnd(10)} ` +
        `${(p.dismissalRate * 100).toFixed(0).padStart(3)}%   ${p.impact.toFixed(1)}`,
    );
  }
  const top = priorities[0];
  if (top && top.impact > 0) {
    console.log(
      `  -> top refinement priority: "${top.pattern}" - frequent AND frequently dismissed ` +
        `(${top.dismissed}/${top.total}); tighten the prompt so this construct stops producing noise findings.`,
    );
    const rareHighRate = priorities.find((p) => p !== top && p.dismissalRate >= 0.5 && p.total <= 2);
    if (rareHighRate) {
      console.log(
        `  -> "${rareHighRate.pattern}" has a high dismissal rate but only ${rareHighRate.total} ` +
          `finding(s) - low impact, not worth prompt-engineering time yet.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  const fixableOutcomes = outcomes.filter((o) => o.doc.expectFixable);
  const unfixableOutcomes = outcomes.filter((o) => !o.doc.expectFixable);

  check("step 1: schema carries both layers (extraction data + self-assessment metadata)", schemaOk);
  check(
    "step 2: every seeded failure produced at least one validation error, each stating expected vs found",
    fixableOutcomes.every((o) => o.firstErrors.length > 0 && o.firstErrors.every((e) => /\d|missing|null/.test(e))),
  );
  check(
    "step 2: the silent-correction failure was caught ONLY by grounding (internally consistent)",
    (() => {
      const f2 = outcomes.find((o) => o.doc.id === "f2-silent-correction");
      return !!f2 && f2.firstErrors.length > 0 && f2.firstErrors.every((e) => e.includes("not found in source"));
    })(),
  );
  check(
    "step 3: retry message contains all three sections (document, extraction, errors)",
    !!sampleMessage &&
      ["Original document:", "Your extraction:", "Validation errors:"].every((s) => sampleMessage.includes(s)),
  );
  check(
    "step 4: both fixable docs converged to a clean extraction within the retry budget",
    fixableOutcomes.every(
      (o) => !o.humanReview && o.finalErrors.length === 0 && o.attempts >= 1 && o.attempts <= MAX_RETRIES,
    ),
  );
  check(
    "step 4: all three unfixable docs went to human review with ZERO retries",
    unfixableOutcomes.every((o) => o.humanReview && o.attempts === 0 && o.unfixableReasons.length > 0),
  );
  check(
    "step 4: f2 final extraction reports the document's discrepancy instead of correcting it",
    (() => {
      const f2 = outcomes.find((o) => o.doc.id === "f2-silent-correction");
      return (
        !!f2 && !f2.humanReview &&
        f2.result.stated_total === 500 && f2.result.calculated_total === 460 &&
        f2.result.total_discrepancy === true && f2.result.conflict_detected === true
      );
    })(),
  );
  check(
    "step 5: priorities table is non-empty and sorted by impact (frequency * dismissal rate)",
    priorities.length > 0 && priorities.every((p, i) => i === 0 || priorities[i - 1].impact >= p.impact),
  );
}

main().catch(console.error);
