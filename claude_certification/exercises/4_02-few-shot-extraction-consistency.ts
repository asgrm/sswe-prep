// Exercise 4_02 - Few-shot examples for extraction consistency (Task Statement 4.2)
// Run: npx tsx 4_02-few-shot-extraction-consistency.ts
//
// Steps:
//   1. Baseline: a detailed extraction prompt WITHOUT examples against 10
//      documents of varied structure (3 tables, 3 narratives, 4 mixed)
//   2. Failure log grouped by document type and field - diagnose the three
//      few-shot triggers: inconsistent formatting, ambiguous judgement
//      calls, empty fields for data that exists in the document
//   3. Three few-shot examples targeting the failing patterns, each with
//      input + correct output + REASONING (reasoning teaches the model to
//      generalise; bare input-output pairs teach surface pattern matching)
//   4. Re-run the same 10 documents with the few-shot prompt and compare:
//      empty-field rate, format consistency, accuracy (overall and per type)
//   5. Decision matrix: which problems few-shot fixed, and which need a
//      different technique (structured outputs for malformed JSON, nullable
//      schema fields for fabrication, validation loops for sum mismatches)
//
// Deliberate design choices:
//   - NO structured outputs (output_config.format) in this exercise. The
//     API would guarantee the output shape, making format inconsistency -
//     the failure under study - unobservable. Free-form JSON is parsed
//     leniently and format drift is measured as data. Enforcing the schema
//     IS one of the "other techniques" in the Step 5 matrix.
//   - The base prompt keeps the seeded flaw "Ensure all fields are
//     populated." - it pressures the model to fabricate values for data
//     the document does not contain. The few-shot examples teach null
//     handling, so examples-vs-instruction conflict becomes measurable
//     (fabrication count per version); a nullable SCHEMA is the guarantee.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Non-streaming small requests: the SDK's retry layer (429/5xx/connection
// errors with backoff) covers this path; just raise the attempts.
const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------
// Test set: 10 documents with ground truth (3 tables, 3 narrative, 4 mixed)
// ---------------------------------------------------------------------------
// Each document carries at least one trap that thorough INSTRUCTIONS alone
// tend to mishandle: dates written in words, amounts written in words,
// comma-thousands, alternative date separators, a genuinely absent vendor,
// a date with no year (ISO impossible), a waived fee mentioned in prose,
// and a stated total that disagrees with the item sum.

interface LineItem {
  description: string;
  amount: number;
}

interface GroundTruth {
  vendor_name: string | null;
  document_date: string | null; // ISO 8601 or null when not constructible
  total_amount: number | null;
  line_items: LineItem[];
}

type DocType = "table" | "narrative" | "mixed";

interface TestDoc {
  id: string;
  type: DocType;
  trap: string;
  content: string;
  truth: GroundTruth;
}

const TEST_DOCS: TestDoc[] = [
  {
    id: "t1-labelled-invoice",
    type: "table",
    trap: "clean labelled table (control - should always work)",
    content: `INVOICE
Vendor: Acme Supplies Ltd
Date: 2024-03-14

| Item            | Amount |
|-----------------|--------|
| Copper wire 5m  | 120.00 |
| Wall anchors    |  53.40 |
| TOTAL           | 173.40 |`,
    truth: {
      vendor_name: "Acme Supplies Ltd",
      document_date: "2024-03-14",
      total_amount: 173.4,
      line_items: [
        { description: "Copper wire 5m", amount: 120 },
        { description: "Wall anchors", amount: 53.4 },
      ],
    },
  },
  {
    id: "t2-currency-ddmm",
    type: "table",
    trap: "currency symbols in cells + DD/MM/YYYY date",
    content: `Birch & Co - Statement
Issued: 14/02/2024

| Description       | Price   |
|-------------------|---------|
| Oak shelf         | £240.00 |
| Delivery          | £18.50  |
| Assembly service  | £35.00  |

Amount due: £293.50`,
    truth: {
      vendor_name: "Birch & Co",
      document_date: "2024-02-14",
      total_amount: 293.5,
      line_items: [
        { description: "Oak shelf", amount: 240 },
        { description: "Delivery", amount: 18.5 },
        { description: "Assembly service", amount: 35 },
      ],
    },
  },
  {
    id: "t3-receipt-table",
    type: "table",
    trap: "quantities in a separate column",
    content: `RECEIPT - Datafix Solutions
2024-11-02

| Qty | Item      | Line total |
|-----|-----------|------------|
| 2   | SSD 1TB   | 180.00     |
| 1   | RAM 16GB  | 64.00      |

Total paid: 244.00`,
    truth: {
      vendor_name: "Datafix Solutions",
      document_date: "2024-11-02",
      total_amount: 244,
      line_items: [
        { description: "SSD 1TB", amount: 180 },
        { description: "RAM 16GB", amount: 64 },
      ],
    },
  },
  {
    id: "n1-words-date-amount",
    type: "narrative",
    trap: "date and unit price written in words; total must be computed",
    content: `We purchased forty garden slabs at five pounds each from Corner Hardware on the third of March 2024. Payment settled the same day.`,
    truth: {
      vendor_name: "Corner Hardware",
      document_date: "2024-03-03",
      total_amount: 200,
      line_items: [{ description: "garden slabs", amount: 200 }],
    },
  },
  {
    id: "n2-no-vendor",
    type: "narrative",
    trap: "amount in words + NO vendor named (fabrication bait)",
    content: `Payment of one hundred and twenty euros was made on 12 June 2024 to renew the annual web hosting plan. No other services were included.`,
    truth: {
      vendor_name: null,
      document_date: "2024-06-12",
      total_amount: 120,
      line_items: [{ description: "annual web hosting plan", amount: 120 }],
    },
  },
  {
    id: "n3-no-year",
    type: "narrative",
    trap: "date has no year - a valid ISO 8601 date is not constructible",
    content: `Orchard Farms delivered two crates of apples on September 9th; we owe them thirty dollars in total.`,
    truth: {
      vendor_name: "Orchard Farms",
      document_date: null,
      total_amount: 30,
      line_items: [{ description: "crates of apples", amount: 30 }],
    },
  },
  {
    id: "m1-waived-fee",
    type: "mixed",
    trap: "prose mentions a WAIVED fee that must not become a line item",
    content: `Invoice #2231 - Lumen Electrics
Work completed 2024-07-19. Items as agreed:

| Item              | Amount |
|-------------------|--------|
| Rewire kitchen    | 850.00 |
| Replace fuse box  | 310.00 |

As discussed, the call-out fee of forty pounds is waived.`,
    truth: {
      vendor_name: "Lumen Electrics",
      document_date: "2024-07-19",
      total_amount: 1160,
      line_items: [
        { description: "Rewire kitchen", amount: 850 },
        { description: "Replace fuse box", amount: 310 },
      ],
    },
  },
  {
    id: "m2-sum-mismatch",
    type: "mixed",
    trap: "stated total (95.00) disagrees with the item sum (90.00)",
    content: `Order confirmation - Paper Trail Ltd
Date: 2024-05-30
Goods: archive boxes 60.00, label rolls 30.00
Total due: 95.00`,
    truth: {
      vendor_name: "Paper Trail Ltd",
      document_date: "2024-05-30",
      // Extraction ground truth is what the document STATES. Detecting the
      // 90-vs-95 discrepancy is a validation-loop job, not an extraction job.
      total_amount: 95,
      line_items: [
        { description: "archive boxes", amount: 60 },
        { description: "label rolls", amount: 30 },
      ],
    },
  },
  {
    id: "m3-email-thousands",
    type: "mixed",
    trap: "email format + comma-thousands amount (1,250.50)",
    content: `From: accounts@brightpath.io
Subject: Consulting fee

Hi - confirming the consulting engagement with BrightPath Advisory has
been billed at £1,250.50, dated 2024-08-01. Single line item: strategy
workshop facilitation.`,
    truth: {
      vendor_name: "BrightPath Advisory",
      document_date: "2024-08-01",
      total_amount: 1250.5,
      line_items: [{ description: "strategy workshop facilitation", amount: 1250.5 }],
    },
  },
  {
    id: "m4-receipt-altdate",
    type: "mixed",
    trap: "till receipt with 2024/03/05 date separators",
    content: `*** CORNER CAFE ***
2024/03/05 09:41
2x flat white      7.00
1x banana bread    3.25
TOTAL             10.25
CARD PAYMENT APPROVED`,
    truth: {
      vendor_name: "Corner Cafe",
      document_date: "2024-03-05",
      total_amount: 10.25,
      line_items: [
        { description: "flat white", amount: 7 },
        { description: "banana bread", amount: 3.25 },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// The two prompts (Steps 1 and 3)
// ---------------------------------------------------------------------------

// Step 1 - thorough instructions: every field, its format, where to find it.
// The experiment's point is that even this is insufficient for consistency
// across document STRUCTURES. "Ensure all fields are populated." is the
// seeded fabrication pressure (kept from the task's starter prompt).
const BASE_PROMPT = `You extract structured data from business documents (invoices, receipts, statements, notes).

Extract exactly these fields:
- vendor_name: the company or person issuing the document or being paid. Look in headers, "From:" lines, or the party named as supplier in the text.
- document_date: the date the document was issued or the transaction happened, as an ISO 8601 string (YYYY-MM-DD). Dates may appear in headers, labelled rows, or inside sentences.
- total_amount: the final total as a plain number - no currency symbols, no thousands separators, decimal point notation.
- line_items: array of {description, amount} objects, one per billed item or service. Amounts are plain numbers.

Return as JSON. Ensure all fields are populated.
Respond with a single JSON object and nothing else.`;

// Step 3 - 2-4 targeted examples covering the failing scenarios, each with
// input + output + REASONING. The examples paraphrase the failure patterns
// (different documents, same constructs) - never copy the eval set, or the
// test measures string matching instead of generalisation (2_01 lesson).
interface FewShotExample {
  targets: string;
  input: string;
  output: GroundTruth;
  reasoning: string;
}

const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  {
    targets: "table structure: labelled cells, TOTAL row is not a line item, currency stripped",
    input: `STATEMENT - Nordic Print AS
Date: 2024-01-20

| Service          | Amount |
|------------------|--------|
| Poster printing  | 410.00 |
| Lamination       |  55.00 |
| TOTAL            | 465.00 |`,
    output: {
      vendor_name: "Nordic Print AS",
      document_date: "2024-01-20",
      total_amount: 465,
      line_items: [
        { description: "Poster printing", amount: 410 },
        { description: "Lamination", amount: 55 },
      ],
    },
    reasoning:
      "Every field sits next to a label: the vendor in the title line, the date in a labelled row, amounts in table cells. The TOTAL row is the document's own total, so it becomes total_amount and is NOT repeated as a line item. Currency formatting is stripped and every amount is emitted as a plain number, never a string.",
  },
  {
    targets: "narrative structure: word-dates and word-amounts converted, totals computed from qty x price",
    input: `On the second of May 2024 we paid Green Valley Nursery ninety pounds for three fruit trees at thirty pounds each.`,
    output: {
      vendor_name: "Green Valley Nursery",
      document_date: "2024-05-02",
      total_amount: 90,
      line_items: [{ description: "fruit trees", amount: 90 }],
    },
    reasoning:
      "Nothing is labelled, so each field is located by its role in the sentence: the party being paid is the vendor. 'The second of May 2024' is written in words and converted to ISO 8601. 'Ninety pounds' is written in words and converted to digits. The line item amount is quantity times unit price (3 x 30 = 90), which agrees with the stated total.",
  },
  {
    targets: "missing data: null instead of fabrication, no-year dates are not ISO-constructible",
    input: `Reimbursement note #88
Team lunch on Jan 5 (receipt attached). Amount: $42.10.`,
    output: {
      vendor_name: null,
      document_date: null,
      total_amount: 42.1,
      line_items: [{ description: "Team lunch", amount: 42.1 }],
    },
    reasoning:
      "No issuing company or payee is named anywhere, so vendor_name is null - a field is only populated when the document actually supports it; inventing a value is worse than returning null. The date has no year, so a valid ISO 8601 date cannot be constructed and document_date is null rather than a guessed year. The currency symbol is stripped from the amount.",
  },
];

const FEW_SHOT_PROMPT = `${BASE_PROMPT}

Examples of correct extraction, with the reasoning behind each:

${FEW_SHOT_EXAMPLES.map(
  (e) => `Document:
${e.input}

Extraction:
${JSON.stringify(e.output, null, 2)}

Reasoning: ${e.reasoning}`,
).join("\n\n---\n\n")}`;

// ---------------------------------------------------------------------------
// Extraction call + lenient parsing
// ---------------------------------------------------------------------------

function textOf(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!block) throw new Error(`No text block (stop_reason: ${response.stop_reason})`);
  return block.text;
}

async function extract(systemPrompt: string, doc: TestDoc): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    // Adaptive thinking is on by default and max_tokens caps thinking +
    // response together - leave headroom above the small JSON answer.
    max_tokens: 8000,
    system: systemPrompt,
    messages: [{ role: "user", content: `Extract the fields from this document:\n\n${doc.content}` }],
  });
  return textOf(response);
}

interface RawExtraction {
  vendor_name?: unknown;
  document_date?: unknown;
  total_amount?: unknown;
  line_items?: unknown;
}

// Lenient on purpose: free-form output may arrive fenced, prefixed with
// prose, or with a trailing Reasoning section (mimicking the examples).
// Parse failures are DATA - they feed the "malformed JSON -> structured
// outputs / tool_use" row of the Step 5 matrix.
function lenientParse(text: string): RawExtraction | null {
  const candidates: string[] = [text.trim()];
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidates.push(fenced[1].trim());
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(text.slice(first, last + 1));
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as RawExtraction;
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Scoring (Step 2 / Step 4)
// ---------------------------------------------------------------------------
// Two separate lenses, never conflated:
//   ACCURACY is lenient about representation ("£1,250.50" scores as 1250.5)
//   FORMAT is strict about representation (a string amount is format drift)
// A result can be accurate but format-inconsistent - that is precisely the
// "different output formats" failure the task describes.

const isEmptyVal = (v: unknown): boolean =>
  v === null || v === undefined || v === "" || (Array.isArray(v) && v.length === 0);

function parseAmount(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const n = Number(v.replace(/[£$€,\s]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

const amountsClose = (a: number, b: number): boolean => Math.abs(a - b) < 0.01;

const normText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

// Digits-only comparison keeps date ACCURACY lenient ("2024/03/05" is the
// right date in the wrong format); the FORMAT check below is what flags it.
const normDate = (s: string): string => s.replace(/\D/g, "");

type FieldStatus = "ok" | "empty" | "wrong" | "fabricated";
const FIELDS = ["vendor_name", "document_date", "total_amount", "line_items"] as const;
type FieldName = (typeof FIELDS)[number];

interface DocScore {
  docId: string;
  docType: DocType;
  parsed: boolean;
  fields: Record<FieldName, FieldStatus>;
  formatConsistent: boolean;
  formatIssues: string[];
}

function scoreField(field: FieldName, truth: GroundTruth, raw: RawExtraction): FieldStatus {
  const value = raw[field];
  const truthValue = truth[field];
  const truthEmpty = truthValue === null || (Array.isArray(truthValue) && truthValue.length === 0);

  if (truthEmpty) return isEmptyVal(value) ? "ok" : "fabricated";
  if (isEmptyVal(value)) return "empty";

  switch (field) {
    case "vendor_name": {
      if (typeof value !== "string") return "wrong";
      const a = normText(value);
      const b = normText(truth.vendor_name!);
      return a.includes(b) || b.includes(a) ? "ok" : "wrong";
    }
    case "document_date": {
      if (typeof value !== "string") return "wrong";
      return normDate(value) === normDate(truth.document_date!) ? "ok" : "wrong";
    }
    case "total_amount": {
      const n = parseAmount(value);
      return n !== null && amountsClose(n, truth.total_amount!) ? "ok" : "wrong";
    }
    case "line_items": {
      if (!Array.isArray(value)) return "wrong";
      if (value.length !== truth.line_items.length) return "wrong";
      const truthSum = truth.line_items.reduce((s, i) => s + i.amount, 0);
      const gotSum = value.reduce((s: number, i: unknown) => {
        const amount = i && typeof i === "object" ? parseAmount((i as Record<string, unknown>).amount) : null;
        return s + (amount ?? NaN);
      }, 0);
      // Lenient on wording, strict on shape: right count + right sum = ok.
      return Number.isFinite(gotSum) && amountsClose(gotSum, truthSum) ? "ok" : "wrong";
    }
  }
}

function checkFormat(raw: RawExtraction): string[] {
  const issues: string[] = [];
  const d = raw.document_date;
  if (!(d === null || d === undefined) && !(typeof d === "string" && /^\d{4}-\d{2}-\d{2}$/.test(d))) {
    issues.push("date not ISO 8601");
  }
  const t = raw.total_amount;
  if (!(t === null || t === undefined) && typeof t !== "number") {
    issues.push("total_amount not a plain number");
  }
  const items = raw.line_items;
  if (!(items === null || items === undefined)) {
    if (!Array.isArray(items)) {
      issues.push("line_items not an array");
    } else if (
      !items.every(
        (i: unknown) =>
          i !== null &&
          typeof i === "object" &&
          typeof (i as Record<string, unknown>).description === "string" &&
          typeof (i as Record<string, unknown>).amount === "number",
      )
    ) {
      issues.push("line_items not {description: string, amount: number}");
    }
  }
  return issues;
}

function scoreDoc(doc: TestDoc, responseText: string): DocScore {
  const raw = lenientParse(responseText);
  if (!raw) {
    return {
      docId: doc.id,
      docType: doc.type,
      parsed: false,
      fields: { vendor_name: "empty", document_date: "empty", total_amount: "empty", line_items: "empty" },
      formatConsistent: false,
      formatIssues: ["response was not parseable JSON"],
    };
  }
  const fields = Object.fromEntries(
    FIELDS.map((f) => [f, scoreField(f, doc.truth, raw)]),
  ) as Record<FieldName, FieldStatus>;
  const formatIssues = checkFormat(raw);
  return {
    docId: doc.id,
    docType: doc.type,
    parsed: true,
    fields,
    formatConsistent: formatIssues.length === 0,
    formatIssues,
  };
}

// ---------------------------------------------------------------------------
// Aggregate metrics (Step 4)
// ---------------------------------------------------------------------------

interface VersionMetrics {
  parseFailures: number;
  // "Empty fields for existing data" - the third few-shot trigger. Only
  // counted where ground truth HAS a value; a null for genuinely absent
  // data is correct behaviour, not an empty-field failure.
  emptyExistingRate: number;
  fabrications: number; // ground truth null, model returned a value
  formatConsistency: number; // docs with zero format issues / all docs
  accuracy: number; // ok fields / all fields
  perTypeAccuracy: Record<DocType, number>;
}

function computeMetrics(scores: DocScore[]): VersionMetrics {
  let ok = 0;
  let emptyExisting = 0;
  let existingTotal = 0;
  let fabrications = 0;
  const perType: Record<DocType, { ok: number; total: number }> = {
    table: { ok: 0, total: 0 },
    narrative: { ok: 0, total: 0 },
    mixed: { ok: 0, total: 0 },
  };

  for (const score of scores) {
    const doc = TEST_DOCS.find((d) => d.id === score.docId)!;
    for (const field of FIELDS) {
      const status = score.fields[field];
      const truthValue = doc.truth[field];
      const truthEmpty = truthValue === null || (Array.isArray(truthValue) && truthValue.length === 0);
      if (!truthEmpty) {
        existingTotal++;
        if (status === "empty") emptyExisting++;
      }
      if (status === "ok") ok++;
      if (status === "fabricated") fabrications++;
      perType[score.docType].ok += status === "ok" ? 1 : 0;
      perType[score.docType].total++;
    }
  }

  return {
    parseFailures: scores.filter((s) => !s.parsed).length,
    emptyExistingRate: emptyExisting / existingTotal,
    fabrications,
    formatConsistency: scores.filter((s) => s.formatConsistent).length / scores.length,
    accuracy: ok / (scores.length * FIELDS.length),
    perTypeAccuracy: Object.fromEntries(
      Object.entries(perType).map(([type, v]) => [type, v.ok / v.total]),
    ) as Record<DocType, number>,
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

async function runVersion(label: string, systemPrompt: string): Promise<DocScore[]> {
  // The 10 documents are independent - extract in parallel (well inside
  // rate limits); one batch per version keeps progress readable.
  const responses = await Promise.all(TEST_DOCS.map((doc) => extract(systemPrompt, doc)));
  const scores = responses.map((text, i) => scoreDoc(TEST_DOCS[i], text));
  console.log(`  ${label}: ${scores.length} documents extracted`);
  return scores;
}

const STATUS_LABEL: Record<FieldStatus, string> = {
  ok: "ok",
  empty: "EMPTY",
  wrong: "WRONG",
  fabricated: "FABRICATED",
};

// Step 2: group by document type and field to spot STRUCTURAL patterns,
// not random failures.
function printFailureLog(scores: DocScore[]): void {
  for (const type of ["table", "narrative", "mixed"] as DocType[]) {
    console.log(`  [${type}]`);
    for (const score of scores.filter((s) => s.docType === type)) {
      const cells = FIELDS.map((f) => `${f.replace("_name", "").replace("document_", "").replace("_amount", "")}=${STATUS_LABEL[score.fields[f]]}`);
      const fmt = score.formatConsistent ? "fmt=OK" : `fmt=BAD (${score.formatIssues.join("; ")})`;
      console.log(`    ${score.docId.padEnd(22)} ${cells.join("  ")}  ${fmt}`);
    }
  }
}

function printTriggers(scores: DocScore[]): void {
  const formatDrift = scores.filter((s) => !s.formatConsistent);
  const emptyExisting: string[] = [];
  const fabricated: string[] = [];
  const wrong: string[] = [];
  for (const score of scores) {
    for (const field of FIELDS) {
      if (score.fields[field] === "empty") emptyExisting.push(`${score.docId}.${field}`);
      if (score.fields[field] === "fabricated") fabricated.push(`${score.docId}.${field}`);
      if (score.fields[field] === "wrong") wrong.push(`${score.docId}.${field}`);
    }
  }
  console.log("  Trigger 1 - inconsistent formatting:");
  console.log(
    formatDrift.length
      ? formatDrift.map((s) => `    ${s.docId}: ${s.formatIssues.join("; ")}`).join("\n")
      : "    (none observed)",
  );
  console.log("  Trigger 2 - ambiguous judgement calls (wrong or fabricated values):");
  console.log(
    wrong.length + fabricated.length
      ? [...wrong.map((f) => `    ${f} (wrong)`), ...fabricated.map((f) => `    ${f} (fabricated)`)].join("\n")
      : "    (none observed)",
  );
  console.log("  Trigger 3 - empty fields for data that exists in the document:");
  console.log(
    emptyExisting.length ? emptyExisting.map((f) => `    ${f}`).join("\n") : "    (none observed)",
  );
}

function printMetrics(label: string, m: VersionMetrics): void {
  console.log(
    `  ${label.padEnd(10)} parseFailures=${m.parseFailures}  emptyExisting=${(m.emptyExistingRate * 100).toFixed(0)}%  ` +
      `fabrications=${m.fabrications}  formatConsistency=${(m.formatConsistency * 100).toFixed(0)}%  accuracy=${(m.accuracy * 100).toFixed(0)}%`,
  );
  console.log(
    `  ${"".padEnd(10)} per-type accuracy: table=${(m.perTypeAccuracy.table * 100).toFixed(0)}%  ` +
      `narrative=${(m.perTypeAccuracy.narrative * 100).toFixed(0)}%  mixed=${(m.perTypeAccuracy.mixed * 100).toFixed(0)}%`,
  );
}

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  console.log("Test set (10 documents):");
  for (const doc of TEST_DOCS) {
    console.log(`  ${doc.id.padEnd(22)} [${doc.type.padEnd(9)}] trap: ${doc.trap}`);
  }

  console.log("\n=== Step 1: baseline - detailed instructions, no examples ===");
  const baselineScores = await runVersion("baseline", BASE_PROMPT);

  console.log("\n=== Step 2: failure log by document type (baseline) ===");
  printFailureLog(baselineScores);
  console.log("\n  Few-shot triggers observed in the baseline:");
  printTriggers(baselineScores);

  console.log("\n=== Step 3: few-shot examples targeting the failure patterns ===");
  for (const [i, example] of FEW_SHOT_EXAMPLES.entries()) {
    console.log(`  example ${i + 1} targets: ${example.targets}`);
  }
  console.log(
    "  (each example = input document + correct extraction + reasoning; reasoning explains HOW",
  );
  console.log(
    "   the data was located and WHY decisions were made, so the model generalises the decision",
  );
  console.log("   procedure instead of memorising surface patterns)");

  console.log("\n=== Step 4: re-run with few-shot prompt and compare ===");
  const fewShotScores = await runVersion("few-shot", FEW_SHOT_PROMPT);
  printFailureLog(fewShotScores);
  console.log();
  const baseline = computeMetrics(baselineScores);
  const fewShot = computeMetrics(fewShotScores);
  printMetrics("baseline", baseline);
  printMetrics("few-shot", fewShot);

  console.log("\n=== Step 5: technique decision matrix ===");
  // Sum-mismatch probe: on m2 the items sum to 90 but the document states
  // 95. Correct EXTRACTION returns 95; noticing the discrepancy is a
  // validation-retry job that no amount of few-shot examples performs.
  const m2 = fewShotScores.find((s) => s.docId === "m2-sum-mismatch")!;
  // Three-state verdicts, not a boolean: "improved" on a metric that never
  // failed at baseline (e.g. 100% -> 100%) would overclaim what few-shot did.
  type Verdict = "improved by few-shot" | "no baseline failure" | "needs other technique";
  const fewShotVerdict = (baselineFailed: boolean, improved: boolean): Verdict =>
    !baselineFailed ? "no baseline failure" : improved ? "improved by few-shot" : "needs other technique";
  const matrix: { problem: string; technique: string; verdict: Verdict; evidence: string }[] = [
    {
      problem: "Inconsistent output formatting across structures",
      technique: "Few-shot examples",
      verdict: fewShotVerdict(
        baseline.formatConsistency < 1,
        fewShot.formatConsistency > baseline.formatConsistency,
      ),
      evidence: `format consistency ${(baseline.formatConsistency * 100).toFixed(0)}% -> ${(fewShot.formatConsistency * 100).toFixed(0)}%`,
    },
    {
      problem: "Empty/wrong fields on narrative text",
      technique: "Few-shot examples",
      verdict: fewShotVerdict(
        baseline.perTypeAccuracy.narrative < 1,
        fewShot.perTypeAccuracy.narrative > baseline.perTypeAccuracy.narrative,
      ),
      evidence: `narrative accuracy ${(baseline.perTypeAccuracy.narrative * 100).toFixed(0)}% -> ${(fewShot.perTypeAccuracy.narrative * 100).toFixed(0)}%`,
    },
    {
      problem: "Fabricated values for missing data",
      technique: "Optional/nullable schema fields (examples mitigate, schema guarantees)",
      verdict: fewShotVerdict(baseline.fabrications > 0, fewShot.fabrications < baseline.fabrications),
      evidence: `fabrications ${baseline.fabrications} -> ${fewShot.fabrications}; the prompt still says "ensure all fields are populated" - only a nullable schema makes null structurally valid`,
    },
    {
      problem: "Malformed JSON output",
      technique: "Structured outputs / tool_use with JSON schema",
      verdict: "needs other technique",
      evidence: `parse failures ${baseline.parseFailures} -> ${fewShot.parseFailures}; examples cannot GUARANTEE syntax - constrained decoding can`,
    },
    {
      problem: "Line-item sum does not match stated total (m2: 90 vs 95)",
      technique: "Validation-retry loop",
      verdict: "needs other technique",
      evidence: `m2 extraction ${m2.fields.total_amount === "ok" ? "returned the stated total (correct extraction)" : "mishandled the total"} - the discrepancy itself is only detectable by post-hoc arithmetic validation`,
    },
  ];
  for (const row of matrix) {
    console.log(`  [${row.verdict}] ${row.problem}`);
    console.log(`      technique: ${row.technique}`);
    console.log(`      evidence:  ${row.evidence}`);
  }

  console.log("\n=== Acceptance criteria ===");
  const baselineHadFailures =
    baseline.emptyExistingRate > 0 ||
    baseline.formatConsistency < 1 ||
    baseline.fabrications > 0 ||
    baseline.accuracy < 1;
  check("baseline exhibited at least one few-shot trigger", baselineHadFailures);
  check(
    "few-shot did not increase empty-field rate on existing data",
    fewShot.emptyExistingRate <= baseline.emptyExistingRate,
  );
  check(
    "few-shot format consistency >= baseline",
    fewShot.formatConsistency >= baseline.formatConsistency,
  );
  check("few-shot overall accuracy >= baseline", fewShot.accuracy >= baseline.accuracy);
  check(
    "few-shot narrative accuracy >= baseline (the targeted failing type)",
    fewShot.perTypeAccuracy.narrative >= baseline.perTypeAccuracy.narrative,
  );
  check(
    "few-shot fabrications <= baseline (reasoning teaches null handling)",
    fewShot.fabrications <= baseline.fabrications,
  );
}

main().catch(console.error);
