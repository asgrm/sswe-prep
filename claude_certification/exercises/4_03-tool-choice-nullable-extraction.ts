// Exercise 4_03 - tool_choice modes and nullable extraction schemas (Task Statement 4.3)
// Run: npx tsx 4_03-tool-choice-nullable-extraction.ts
//
// Steps:
//   1. Define an extraction tool whose JSON schema is designed against
//      fabrication: the required array contains ONLY the 3 fields present in
//      every document, 3 optional fields are nullable (type ["string","null"]),
//      the category enum carries "unclear" and "other" escape values, and
//      category_detail explains the "other" case. Verify the shape in code.
//   2. tool_choice auto: 7 inputs (5 documents + 2 question-shaped baits) -
//      watch stop_reason. "end_turn" means the model answered in TEXT and
//      produced no structured output, so auto cannot feed a pipeline that
//      requires it.
//   3. tool_choice any: same inputs - stop_reason is always "tool_use".
//      Second pass with 3 type-specific tools: any still guarantees a tool
//      call but lets the model choose WHICH tool (right when the document
//      type is unknown). With a single tool, any and forced are equivalent.
//   4. tool_choice {type:"tool", name:"extract_metadata"}: the named tool runs
//      every time, even on documents that suit the other tool better -
//      maximum control, for mandatory pipeline steps.
//   5. Nullable vs all-required schema on 5 documents (3 complete, 2 with
//      genuinely absent fields): the nullable schema returns null for absent
//      data; the all-required variant pressures the model into fabricated
//      values, sentinel strings, or schema-violating nulls.
//
// Deliberate design choices:
//   - Neither schema uses strict:true. Strict mode constrains decoding and
//     would hide the all-required variant's failure modes - here those
//     failures ARE the data. (In production: nullable schema + strict:true
//     is the belt-and-braces combination.)
//   - The user prompt is neutral ("a document from our accounts-payable
//     inbox"), never "extract the fields" - auto must be free to answer in
//     text, because that freedom is exactly the failure mode under study.
//   - The nullable tool's field descriptions say "or null when absent" -
//     schema types and descriptions travel together as one design. The
//     all-required control gets a neutral description because a schema that
//     forbids null cannot honestly promise it.
//
// Empirical note (claude-sonnet-5): on the first run, auto called the tool on
// all six inputs - even the ambiguous note, filling the required fields with
// "<UNKNOWN>" sentinels (step 5's required-field pressure showing up early).
// Anything FRAMED as "a document" gets extracted; the text response surfaces
// when the input is a question to answer rather than a thing to file. Real
// inbox traffic contains both - which is exactly why auto cannot guarantee
// structured output. The bait inputs are therefore question-shaped.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Non-streaming small requests: the SDK's retry layer (429/5xx/connection
// errors with backoff) covers this path; just raise the attempts.
const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------
// Step 1: the extraction tool - schema designed against fabrication
// ---------------------------------------------------------------------------
// Required fields pressure the model to invent values when the information is
// absent; only fields guaranteed to appear in EVERY document belong in
// `required`. Optional fields are nullable so an honest null is structurally
// valid, and the enum has "unclear"/"other" escape values so the model never
// has to force a wrong label.

const REQUIRED_FIELDS = ["invoice_number", "vendor_name", "document_date"] as const;
const NULLABLE_FIELDS = ["payment_terms", "purchase_order", "tax_id"] as const;
const CATEGORY_ENUM = ["invoice", "receipt", "contract", "unclear", "other"] as const;

const extractTool: Anthropic.Tool = {
  name: "extract_document",
  description:
    "Extract structured data from a business document. The required fields are present in every document. " +
    "Optional fields MUST be null when the document does not contain them - never guess or invent a value.",
  input_schema: {
    type: "object",
    properties: {
      invoice_number: {
        type: "string",
        description: "The document's own identifier (invoice or receipt number)",
      },
      vendor_name: {
        type: "string",
        description: "The company or person issuing the document",
      },
      document_date: {
        type: "string",
        description: "Issue date in ISO 8601 format (YYYY-MM-DD)",
      },
      payment_terms: {
        type: ["string", "null"],
        description: "Payment terms as stated in the document, or null when it states none",
      },
      purchase_order: {
        type: ["string", "null"],
        description: "Referenced purchase order number, or null when none is referenced",
      },
      tax_id: {
        type: ["string", "null"],
        description: "The vendor's tax/VAT registration ID, or null when not shown",
      },
      category: {
        type: "string",
        enum: [...CATEGORY_ENUM],
        description:
          'Document type. Use "unclear" when the type cannot be determined, ' +
          '"other" for document types outside the list.',
      },
      category_detail: {
        type: ["string", "null"],
        description: 'When category is "other", what the document actually is; null otherwise',
      },
    },
    // Only the 3 always-present fields - category is derivable but not
    // guaranteed decidable, so it stays optional with its "unclear" escape.
    required: [...REQUIRED_FIELDS],
  },
};

// Step 5 control: same fields, but every one required and nothing nullable.
// This is the seeded flaw under study - it leaves the model no valid way to
// say "this document does not contain that".
const allRequiredTool: Anthropic.Tool = {
  name: "extract_document",
  description: "Extract structured data from a business document.",
  input_schema: {
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      vendor_name: { type: "string" },
      document_date: { type: "string", description: "ISO 8601 format" },
      payment_terms: { type: "string" },
      purchase_order: { type: "string" },
      tax_id: { type: "string" },
      category: { type: "string", enum: ["invoice", "receipt", "contract"] },
      category_detail: { type: "string" },
    },
    required: [
      "invoice_number",
      "vendor_name",
      "document_date",
      "payment_terms",
      "purchase_order",
      "tax_id",
      "category",
      "category_detail",
    ],
  },
};

// ---------------------------------------------------------------------------
// Test set: 5 ground-truth documents (3 complete, 2 with absent fields)
// plus one ambiguous fragment used to bait text responses under auto
// ---------------------------------------------------------------------------
// For nullable fields the truth value is a distinctive TOKEN that must appear
// in the extraction (lenient contains-match after normalisation), or null
// when the document genuinely does not contain the field.

interface TestDoc {
  id: string;
  complete: boolean;
  content: string;
  truth: {
    invoice_number: string;
    vendor_name: string;
    document_date: string; // ISO 8601
    payment_terms: string | null;
    purchase_order: string | null;
    tax_id: string | null;
    category: (typeof CATEGORY_ENUM)[number];
  };
}

const DOCS: TestDoc[] = [
  {
    id: "c1-labelled-invoice",
    complete: true,
    content: `INVOICE
Invoice Number: INV-2024-0117
Vendor: Northwind Traders Ltd
Date: 2024-03-15
Payment Terms: Net 30
Purchase Order: PO-88231
VAT Registration: GB123456789

| Item             | Amount |
|------------------|--------|
| Office chairs x4 | 640.00 |
| Delivery         |  35.00 |
| TOTAL            | 675.00 |`,
    truth: {
      invoice_number: "INV-2024-0117",
      vendor_name: "Northwind Traders",
      document_date: "2024-03-15",
      payment_terms: "30",
      purchase_order: "88231",
      tax_id: "123456789",
      category: "invoice",
    },
  },
  {
    id: "c2-email-invoice",
    complete: true,
    content: `From: billing@meridian-consulting.io
Subject: Invoice MC-556 for April engagement

Hi - please find our invoice MC-556, dated 2024-04-02, for the April
strategy engagement (your purchase order PO-2024-104). Payment is due
within 14 days of receipt. Our tax ID is 94-2404110.

Total due: $12,000.00
Meridian Consulting LLC`,
    truth: {
      invoice_number: "MC-556",
      vendor_name: "Meridian Consulting",
      document_date: "2024-04-02",
      payment_terms: "14",
      purchase_order: "2024104",
      tax_id: "942404110",
      category: "invoice",
    },
  },
  {
    id: "c3-narrative-invoice",
    complete: true,
    content: `Bramley & Sons issued invoice 7719 on 12 May 2024 for garden
landscaping. The order was raised under purchase order BS-PO-451, payment
terms are 50% upfront with the balance due on completion, and their tax
reference is 554-72-9981.`,
    truth: {
      invoice_number: "7719",
      vendor_name: "Bramley",
      document_date: "2024-05-12",
      payment_terms: "50",
      purchase_order: "451",
      tax_id: "554729981",
      category: "invoice",
    },
  },
  {
    id: "m1-till-receipt",
    complete: false,
    content: `*** DAILY GRIND CAFE ***
Receipt #R-5512
2024-06-08 10:22
2x cappuccino     9.00
1x bagel          4.50
TOTAL            13.50
CARD PAYMENT APPROVED`,
    truth: {
      invoice_number: "R-5512",
      vendor_name: "Daily Grind",
      document_date: "2024-06-08",
      payment_terms: null, // a till receipt states no terms
      purchase_order: null, // ...references no PO
      tax_id: null, // ...and shows no tax ID
      category: "receipt",
    },
  },
  {
    id: "m2-brief-invoice",
    complete: false,
    content: `Invoice #1234 from Acme Corp, dated 2024-03-15. Total: $500.00`,
    truth: {
      invoice_number: "1234",
      vendor_name: "Acme",
      document_date: "2024-03-15",
      payment_terms: null,
      purchase_order: null,
      tax_id: null,
      category: "invoice",
    },
  },
];

// Auto-baits: inputs where the right response is text. a1 is an ambiguous
// note with an explicit question attached; a2 is a pure question with no
// document at all. Under auto the model should answer in text; under any it
// is cornered into a tool call and must put SOMETHING in the required
// fields - a preview of step 5. (Per the empirical note above: without the
// question framing, even the ambiguous note gets extracted.)
const AMBIGUOUS_DOC = {
  id: "a1-ambiguous-note",
  content: `Thanks for meeting on Tuesday - I'll get the paperwork over to you
by the end of next week. Let me know if the numbers we discussed still work
for your side.`,
  userText: `This just landed in the accounts-payable inbox:

Thanks for meeting on Tuesday - I'll get the paperwork over to you
by the end of next week. Let me know if the numbers we discussed still work
for your side.

Is there anything here we need to log?`,
};

const QUESTION_DOC = {
  id: "a2-policy-question",
  content: "",
  userText: `Quick question from the CFO - are our suppliers on Net 30 or
Net 14 terms by default? Nothing to file here, we just need an answer.`,
};

// Contract snippet for the multi-tool selection pass (step 3b) and the
// forced-tool override demo (step 4).
const CONTRACT_DOC = {
  id: "x1-service-agreement",
  content: `SERVICE AGREEMENT SA-2024-07
This agreement is entered into on 1 July 2024 between Keystone Property
Management ("Client") and BrightClean Services Ltd ("Contractor") for
weekly office cleaning at 12 Harbour Way. Term: 12 months. Fee: £850 per
month, invoiced monthly, payment due within 21 days.`,
};

// ---------------------------------------------------------------------------
// Type-specific tools for the tool_choice:any selection pass (step 3b)
// ---------------------------------------------------------------------------

const invoiceTool: Anthropic.Tool = {
  name: "extract_invoice",
  description: "Extract fields from a supplier invoice (a bill requesting payment).",
  input_schema: {
    type: "object",
    properties: {
      invoice_number: { type: "string" },
      vendor_name: { type: "string" },
      total: { type: ["string", "null"] },
    },
    required: ["invoice_number", "vendor_name"],
  },
};

const receiptTool: Anthropic.Tool = {
  name: "extract_receipt",
  description: "Extract fields from a point-of-sale receipt (proof of a completed payment).",
  input_schema: {
    type: "object",
    properties: {
      merchant: { type: "string" },
      receipt_number: { type: ["string", "null"] },
      total: { type: ["string", "null"] },
    },
    required: ["merchant"],
  },
};

const contractTool: Anthropic.Tool = {
  name: "extract_contract",
  description: "Extract fields from a contract or service agreement between parties.",
  input_schema: {
    type: "object",
    properties: {
      parties: { type: "array", items: { type: "string" } },
      effective_date: { type: ["string", "null"] },
      term: { type: ["string", "null"] },
    },
    required: ["parties"],
  },
};

// ---------------------------------------------------------------------------
// Tools for the forced-selection demo (step 4)
// ---------------------------------------------------------------------------

const metadataTool: Anthropic.Tool = {
  name: "extract_metadata",
  description: "Extract high-level metadata: what kind of document this is, its date, and the parties involved.",
  input_schema: {
    type: "object",
    properties: {
      doc_type: { type: "string" },
      date: { type: ["string", "null"] },
      parties: { type: "array", items: { type: "string" } },
    },
    required: ["doc_type"],
  },
};

const detailTool: Anthropic.Tool = {
  name: "extract_detail",
  description:
    "Extract full line-item and clause-level detail from a document: every item, amount, term, and obligation.",
  input_schema: {
    type: "object",
    properties: {
      items: {
        type: "array",
        items: {
          type: "object",
          properties: {
            description: { type: "string" },
            amount: { type: ["string", "null"] },
          },
          required: ["description"],
        },
      },
    },
    required: ["items"],
  },
};

// ---------------------------------------------------------------------------
// API call + response helpers
// ---------------------------------------------------------------------------

// Docs may override the default document-framing wrapper with their own user
// text (the baits are question-shaped, not document-shaped).
interface ChoiceDoc {
  id: string;
  content: string;
  userText?: string;
}

async function processDoc(
  tools: Anthropic.Tool[],
  toolChoice: Anthropic.ToolChoice,
  userText: string,
): Promise<Anthropic.Message> {
  return client.messages.create({
    model: MODEL,
    // Adaptive thinking is on by default and max_tokens caps thinking +
    // response together - leave headroom above the small tool call.
    // (tool_choice any/tool works with adaptive thinking on the Claude API;
    // only Bedrock requires thinking disabled for forced tool_choice.)
    max_tokens: 8000,
    tools,
    tool_choice: toolChoice,
    messages: [{ role: "user", content: userText }],
  });
}

function toolUseBlock(response: Anthropic.Message): Anthropic.ToolUseBlock | null {
  return (
    response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use") ?? null
  );
}

function firstText(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  return block?.text ?? "";
}

// ---------------------------------------------------------------------------
// Scoring helpers (step 5)
// ---------------------------------------------------------------------------

const normText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const normDate = (s: string): string => s.replace(/\D/g, "");

// A value the model produced for a field the document does NOT contain:
//   "null"       - honest, and only structurally valid under a nullable schema
//   "sentinel"   - "N/A"/"unknown"/"none" strings: an escape attempt that
//                  still poisons downstream code expecting real values
//   "fabricated" - a plausible-looking invented value: the worst outcome,
//                  because nothing downstream can detect it
type MissingOutcome = "null" | "sentinel" | "fabricated";

const SENTINELS = new Set([
  "", "na", "none", "null", "nil", "unknown", "missing", "notprovided",
  "notavailable", "notspecified", "notstated", "notfound", "notapplicable",
]);

function classifyMissing(value: unknown): MissingOutcome {
  if (value === null || value === undefined) return "null";
  const norm = String(value).toLowerCase().replace(/[^a-z]/g, "");
  return SENTINELS.has(norm) ? "sentinel" : "fabricated";
}

type PresentStatus = "ok" | "wrong" | "empty";

function scorePresent(field: string, truthToken: string, value: unknown): PresentStatus {
  if (value === null || value === undefined || value === "") return "empty";
  if (field === "document_date") {
    return typeof value === "string" && normDate(value) === normDate(truthToken) ? "ok" : "wrong";
  }
  return typeof value === "string" && normText(value).includes(normText(truthToken))
    ? "ok"
    : "wrong";
}

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

// ---------------------------------------------------------------------------
// Step 1: verify the schema shape programmatically
// ---------------------------------------------------------------------------

function verifySchema(): boolean {
  const schema = extractTool.input_schema as unknown as {
    properties: Record<string, { type?: unknown; enum?: unknown }>;
    required?: string[];
  };
  const results: boolean[] = [];
  const record = (label: string, ok: boolean): void => {
    results.push(ok);
    check(label, ok);
  };

  record(
    "required array contains exactly the 3 always-present fields",
    JSON.stringify([...(schema.required ?? [])].sort()) ===
      JSON.stringify([...REQUIRED_FIELDS].sort()),
  );
  for (const field of [...NULLABLE_FIELDS, "category_detail"]) {
    const t = schema.properties[field]?.type;
    record(
      `${field} is nullable (type ["string","null"])`,
      Array.isArray(t) && t.includes("string") && t.includes("null"),
    );
  }
  const categoryEnum = schema.properties.category?.enum;
  record(
    'category enum includes "unclear" and "other" alongside the standard categories',
    Array.isArray(categoryEnum) &&
      categoryEnum.includes("unclear") &&
      categoryEnum.includes("other") &&
      categoryEnum.includes("invoice"),
  );
  record(
    "category is NOT required (its own escape is the enum, not fabrication)",
    !(schema.required ?? []).includes("category"),
  );
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

interface ChoiceObservation {
  docId: string;
  stopReason: string | null;
  toolName: string | null;
  response: Anthropic.Message;
}

async function runChoice(
  label: string,
  tools: Anthropic.Tool[],
  toolChoice: Anthropic.ToolChoice,
  docs: ChoiceDoc[],
): Promise<ChoiceObservation[]> {
  const responses = await Promise.all(
    docs.map((d) =>
      processDoc(
        tools,
        toolChoice,
        d.userText ?? `Here is a document from our accounts-payable inbox:\n\n${d.content}`,
      ),
    ),
  );
  return responses.map((response, i) => {
    const tool = toolUseBlock(response);
    const obs: ChoiceObservation = {
      docId: docs[i].id,
      stopReason: response.stop_reason,
      toolName: tool?.name ?? null,
      response,
    };
    const outcome = tool
      ? `tool call -> ${tool.name}`
      : `TEXT: "${firstText(response).replace(/\s+/g, " ").slice(0, 70)}..."`;
    console.log(
      `  [${label}] ${obs.docId.padEnd(22)} stop_reason=${String(obs.stopReason).padEnd(9)} ${outcome}`,
    );
    return obs;
  });
}

async function main() {
  console.log("=== Step 1: schema shape (anti-fabrication design) ===");
  const schemaOk = verifySchema();

  // -------------------------------------------------------------------------
  console.log("\n=== Step 2: tool_choice auto - structured output NOT guaranteed ===");
  const autoDocs: ChoiceDoc[] = [...DOCS, AMBIGUOUS_DOC, QUESTION_DOC];
  const autoObs = await runChoice("auto", [extractTool], { type: "auto" }, autoDocs);
  const autoTextCount = autoObs.filter((o) => o.stopReason !== "tool_use").length;
  console.log(
    `  -> ${autoTextCount}/${autoObs.length} responses were text (stop_reason end_turn): ` +
      "those documents produced NO structured output.",
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 3: tool_choice any - a tool call is guaranteed ===");
  const anyObs = await runChoice("any", [extractTool], { type: "any" }, autoDocs);
  console.log(
    "  (single tool: any and forced are equivalent - the guarantee is what changed vs auto)",
  );

  // What did `any` force the model to do with the ambiguous note? It had to
  // call the tool and put SOMETHING in the required fields - a preview of the
  // required-field fabrication pressure measured in step 5.
  const ambiguous = anyObs.find((o) => o.docId === AMBIGUOUS_DOC.id);
  const ambiguousInput = toolUseBlock(ambiguous!.response)?.input as
    | Record<string, unknown>
    | undefined;
  if (ambiguousInput) {
    console.log("  Cornered on the ambiguous note, the required fields became:");
    for (const field of REQUIRED_FIELDS) {
      console.log(`    ${field} = ${JSON.stringify(ambiguousInput[field])}`);
    }
    console.log(`    category = ${JSON.stringify(ambiguousInput.category)} (escape hatch used?)`);
  }

  console.log("\n  --- Step 3b: any with 3 type-specific tools (model picks WHICH) ---");
  const selectionDocs = [DOCS[0], DOCS[3], CONTRACT_DOC]; // invoice, receipt, contract
  const selectionObs = await runChoice(
    "any*3",
    [invoiceTool, receiptTool, contractTool],
    { type: "any" },
    selectionDocs,
  );

  // -------------------------------------------------------------------------
  console.log('\n=== Step 4: tool_choice {type:"tool"} - the named tool always runs ===');
  // Both documents suit extract_detail at least as well as extract_metadata
  // (line items on the receipt, clauses in the agreement) - forcing overrides
  // that preference. disable_parallel_tool_use keeps it a clean single step
  // (without it, parallel tool use may batch other calls into the turn - 2_03).
  const forcedDocs = [DOCS[3], CONTRACT_DOC];
  const forcedObs = await runChoice(
    "forced",
    [metadataTool, detailTool],
    { type: "tool", name: "extract_metadata", disable_parallel_tool_use: true },
    forcedDocs,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Step 5: nullable vs all-required schema on 5 documents ===");
  // 5a - the nullable extractions already happened in step 3 (any + the
  // nullable tool guarantees structured output for every doc); score them.
  console.log("  --- 5a: nullable schema (scored from the step-3 extractions) ---");
  let requiredOk = 0;
  let requiredTotal = 0;
  let presentNullableOk = 0;
  let presentNullableTotal = 0;
  const nullableMissing: MissingOutcome[] = [];

  for (const doc of DOCS) {
    const obs = anyObs.find((o) => o.docId === doc.id)!;
    const input = (toolUseBlock(obs.response)?.input ?? {}) as Record<string, unknown>;
    const cells: string[] = [];

    for (const field of REQUIRED_FIELDS) {
      const status = scorePresent(field, doc.truth[field], input[field]);
      requiredTotal++;
      if (status === "ok") requiredOk++;
      cells.push(`${field.replace("invoice_", "").replace("vendor_", "").replace("document_", "")}=${status}`);
    }
    for (const field of NULLABLE_FIELDS) {
      const truthValue = doc.truth[field];
      if (truthValue === null) {
        const outcome = classifyMissing(input[field]);
        nullableMissing.push(outcome);
        cells.push(`${field}=${outcome === "null" ? "null (honest)" : outcome.toUpperCase()}`);
      } else {
        const status = scorePresent(field, truthValue, input[field]);
        presentNullableTotal++;
        if (status === "ok") presentNullableOk++;
        cells.push(`${field}=${status}`);
      }
    }
    const categoryOk = input.category === doc.truth.category;
    console.log(
      `  ${doc.id.padEnd(22)} ${cells.join("  ")}  category=${categoryOk ? "ok" : `got ${JSON.stringify(input.category)}`}`,
    );
  }

  const nullableFabricated = nullableMissing.filter((o) => o === "fabricated").length;
  const nullableSentinels = nullableMissing.filter((o) => o === "sentinel").length;
  const nullableHonest = nullableMissing.filter((o) => o === "null").length;
  console.log(
    `  Absent fields (${nullableMissing.length} across the 2 incomplete docs): ` +
      `${nullableHonest} honest null, ${nullableSentinels} sentinel, ${nullableFabricated} FABRICATED`,
  );

  // 5b - the all-required control on the 2 incomplete documents, where the
  // fabrication pressure lives. Forced tool_choice guarantees the call.
  console.log("\n  --- 5b: all-required control (2 incomplete docs) ---");
  const incompleteDocs = DOCS.filter((d) => !d.complete);
  const controlResponses = await Promise.all(
    incompleteDocs.map((d) =>
      processDoc([allRequiredTool], { type: "tool", name: allRequiredTool.name }, d.content),
    ),
  );
  const controlMissing: MissingOutcome[] = [];
  controlResponses.forEach((response, i) => {
    const doc = incompleteDocs[i];
    const input = (toolUseBlock(response)?.input ?? {}) as Record<string, unknown>;
    for (const field of NULLABLE_FIELDS) {
      if (doc.truth[field] !== null) continue; // only genuinely absent fields
      const outcome = classifyMissing(input[field]);
      controlMissing.push(outcome);
      console.log(
        `  ${doc.id.padEnd(22)} ${field.padEnd(15)} -> ${JSON.stringify(input[field])}  [${outcome}]`,
      );
    }
  });
  const controlFabricated = controlMissing.filter((o) => o === "fabricated").length;
  const controlSentinels = controlMissing.filter((o) => o === "sentinel").length;
  const controlNulls = controlMissing.filter((o) => o === "null").length;
  console.log(
    `  All-required outcomes: ${controlNulls} schema-VIOLATING null (non-strict schemas ` +
      `are encouragement, not enforcement), ${controlSentinels} sentinel, ${controlFabricated} fabricated`,
  );

  // -------------------------------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  check("step 1: schema shape verified (required trio, nullable types, enum escapes)", schemaOk);
  check(
    "step 2: auto returned at least one text response on the question-shaped baits",
    autoTextCount > 0,
  );
  check(
    'step 3: any -> every response has stop_reason "tool_use"',
    anyObs.every((o) => o.stopReason === "tool_use"),
  );
  check(
    "step 3b: any with 3 tools -> every response is a tool call (model chose which)",
    selectionObs.every((o) => o.stopReason === "tool_use" && o.toolName !== null),
  );
  check(
    "step 4: forced -> extract_metadata called every time, regardless of document fit",
    forcedObs.every((o) => o.toolName === "extract_metadata"),
  );
  check(
    "step 5a: nullable schema fabricated nothing for absent fields",
    nullableFabricated === 0,
  );
  check(
    "step 5a: absent fields came back as honest nulls (not sentinels)",
    nullableHonest === nullableMissing.length,
  );
  check(
    "step 5a: fields that ARE present were still extracted (nullable != lazy)",
    presentNullableOk === presentNullableTotal && requiredOk === requiredTotal,
  );
  check(
    "step 5b: all-required schema produced fabricated or sentinel values under pressure",
    controlFabricated + controlSentinels > 0,
  );
}

main().catch(console.error);
