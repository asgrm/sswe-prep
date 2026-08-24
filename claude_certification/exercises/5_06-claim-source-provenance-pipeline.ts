// Exercise 5_06 - Claim-source provenance through a multi-agent research pipeline (Task Statement 5.6)
// Run: npx tsx 5_06-claim-source-provenance-pipeline.ts
//
// Steps:
//   1. ClaimSourceMapping schema: five REQUIRED fields (claim, sourceUrl,
//      documentName, relevantExcerpt, publicationDate), each field description
//      saying why it exists in the provenance chain; shape verified in code
//   2. Two research subagents (market data vs regulatory/technology) forced
//      through a report_findings tool over a planted 5-source corpus - so
//      URLs, titles, dates and verbatim excerpts are mechanically checkable
//   3. Synthesis A/B: a naive 250-word executive summary vs an explicit
//      preserve-attribution prompt (inline [n] citations + ## References);
//      verifyProvenance measures how much attribution each arm kept
//   4. Conflict handling: findings grouped by a canonical measure key; when
//      values differ (planted: $495B vs $538B for 2023 renewable investment,
//      published 7 months apart) BOTH are kept with full attribution and a
//      temporal/methodological explanation - never silently adjudicated
//   5. Content-appropriate rendering: financial -> table, news -> prose,
//      technical -> bulleted list, with citation markers in every format

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Non-streaming small requests: the SDK's retry layer (429/5xx/connection
// errors with backoff) covers this path; just raise the attempts (as in 4_03).
const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";

// ---------------------------------------------------------------------------
// Step 1: the claim-source mapping schema
// ---------------------------------------------------------------------------
// Every finding must carry its provenance from the moment it is produced.
// All five fields are REQUIRED: an optional provenance field is a field the
// model may omit, and one missing link breaks the whole chain - a claim with
// no excerpt cannot be checked, a claim with no date cannot be interpreted
// against a newer number.

interface ClaimSourceMapping {
  claim: string; // the specific assertion - the unit of attribution
  sourceUrl: string; // where it was found - the address a reviewer visits to verify
  documentName: string; // title of the source - its human-readable identity in citations
  relevantExcerpt: string; // the verbatim supporting passage - checkable without re-reading the source
  publicationDate: string; // ISO 8601 - what turns "two different numbers" into a revision or a trend
}

// The finding a subagent reports = the mapping plus a canonical grouping key.
// Step 4 needs to know WHICH claims talk about the same quantity; asking the
// researcher to emit that key while it still has the source in front of it is
// reliable, while reconstructing groups later by fuzzy claim matching is
// exactly the kind of lossy inference this exercise exists to avoid.
interface ResearchFinding extends ClaimSourceMapping {
  measure: string;
}

const CLAIM_SOURCE_FIELDS = ["claim", "sourceUrl", "documentName", "relevantExcerpt", "publicationDate"] as const;

const reportFindingsTool: Anthropic.Tool = {
  name: "report_findings",
  description:
    "Report research findings with full provenance. Every finding maps ONE claim to the exact source " +
    "that supports it. The coordinator sees ONLY this payload - any attribution missing here is lost " +
    "for good, and the final report becomes untraceable plausible-sounding text.",
  input_schema: {
    type: "object",
    properties: {
      findings: {
        type: "array",
        description: "One entry per claim - never bundle several claims into one entry.",
        items: {
          type: "object",
          properties: {
            claim: {
              type: "string",
              description:
                "The specific assertion being made - one self-contained sentence naming the year any " +
                "figure refers to. This is the unit of attribution; anything vaguer cannot be traced.",
            },
            sourceUrl: {
              type: "string",
              description:
                "Where the information was found, exactly as printed on the source - the address a " +
                "reviewer visits to verify the claim. Required: a claim without a URL is unverifiable.",
            },
            documentName: {
              type: "string",
              description:
                "Title of the source document, exactly as printed - the human-readable identity of " +
                "the source in citations and reference lists.",
            },
            relevantExcerpt: {
              type: "string",
              description:
                "The specific passage supporting the claim, copied VERBATIM as one contiguous quote " +
                "(no ellipses, at most ~40 words) - lets a reviewer check support without re-reading " +
                "the whole document.",
            },
            publicationDate: {
              type: "string",
              description:
                "ISO 8601 date (YYYY-MM-DD) the source was published or its data collected. Not " +
                "metadata tidiness: when two sources report different numbers for the same measure, " +
                "the dates are what turn a 'contradiction' into a revision or a different reporting period.",
            },
            measure: {
              type: "string",
              description:
                "Canonical key for the quantity or subject the claim reports, e.g. 'global renewable " +
                "energy investment, calendar year 2023'. Use the IDENTICAL key for claims reporting " +
                "the same quantity so conflicting values are detectable downstream.",
            },
          },
          required: ["claim", "sourceUrl", "documentName", "relevantExcerpt", "publicationDate", "measure"],
        },
      },
    },
    required: ["findings"],
  },
};

// ---------------------------------------------------------------------------
// Defensive parsing + shared helpers (same idioms as 5_04 / 4_04 / 5_01)
// ---------------------------------------------------------------------------
// Prompt-shaped schemas are not enforced, so parse defensively - a missing
// field must not crash the coordinator, it must surface as a failed check.

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown, field: string, fallback = ""): string {
  const raw = asRecord(value)[field];
  return typeof raw === "string" ? raw : fallback;
}

function parseFindings(input: unknown): ResearchFinding[] {
  const raw = asRecord(input).findings;
  return (Array.isArray(raw) ? raw : [])
    .map((item) => ({
      claim: stringField(item, "claim"),
      sourceUrl: stringField(item, "sourceUrl"),
      documentName: stringField(item, "documentName"),
      relevantExcerpt: stringField(item, "relevantExcerpt"),
      publicationDate: stringField(item, "publicationDate"),
      measure: stringField(item, "measure"),
    }))
    .filter((f) => f.claim.length > 0);
}

// Content blocks are a union; find the block with a type guard instead of
// indexing blindly (same helpers as 4_03 / 5_01).
function toolUseBlock(response: Anthropic.Message): Anthropic.ToolUseBlock | null {
  return response.content.find((b): b is Anthropic.ToolUseBlock => b.type === "tool_use") ?? null;
}

function textOf(response: Anthropic.Message): string {
  const block = response.content.find((b): b is Anthropic.TextBlock => b.type === "text");
  if (!block) throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
  return block.text;
}

const normText = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

// Verify the schema shape programmatically, like 4_03's verifySchema: all
// five mapping fields required (plus the measure key), and every field
// carrying a non-empty description - the description IS the provenance
// contract the subagent model reads.
function verifyFindingSchema(): boolean {
  const items = asRecord(asRecord(asRecord(asRecord(reportFindingsTool.input_schema).properties).findings).items);
  const required = Array.isArray(items.required) ? items.required : [];
  const properties = asRecord(items.properties);

  const results: boolean[] = [];
  const record = (label: string, ok: boolean): void => {
    results.push(ok);
    check(label, ok);
  };

  for (const field of CLAIM_SOURCE_FIELDS) {
    record(`${field} is REQUIRED (an optional provenance field is a breakable link)`, required.includes(field));
  }
  record("measure (the conflict-grouping key) is also required", required.includes("measure"));
  record(
    "every field carries a description explaining its role in the provenance chain",
    [...CLAIM_SOURCE_FIELDS, "measure"].every((field) => stringField(properties[field], "description").length > 20),
  );
  return results.every(Boolean);
}

// ---------------------------------------------------------------------------
// The planted source corpus
// ---------------------------------------------------------------------------
// Subagents work over supplied documents, not memory or live search: without
// a retrieval corpus the model would invent URLs, and fabricated provenance
// is worse than none. Planted sources make every provenance field
// mechanically verifiable (URL/title/date must match the corpus, excerpts by
// normalised containment) - and let us plant a genuine conflict: the IEA and
// BNEF documents report DIFFERENT totals for the same measure (2023 global
// renewable investment), published 7 months apart on different methodologies.

interface SourceDocument {
  documentName: string;
  sourceUrl: string;
  publicationDate: string;
  content: string;
}

const MARKET_SOURCES: SourceDocument[] = [
  {
    documentName: "IEA World Energy Investment Report 2024",
    sourceUrl: "https://example.com/iea/world-energy-investment-2024",
    publicationDate: "2024-06-15",
    content:
      "Total investment in renewable energy technologies reached approximately $495 billion in calendar " +
      "year 2023, up 8% on 2022. Solar PV attracted $393 billion of that total, more than all fossil-fuel " +
      "supply investment combined. Grid infrastructure spending remained flat at $310 billion in 2023, " +
      "which the report flags as the main bottleneck for further deployment.",
  },
  {
    documentName: "BloombergNEF Energy Transition Investment Trends 2025",
    sourceUrl: "https://example.com/bnef/energy-transition-trends-2025",
    publicationDate: "2025-01-30",
    content:
      "Under BNEF's revised methodology, which now includes grid-scale battery storage alongside " +
      "generation assets, global renewable energy investment for calendar year 2023 totalled $538 billion. " +
      "On the same revised basis, investment reached $623 billion in 2024, a 16% year-on-year increase " +
      "driven primarily by utility-scale solar in Asia.",
  },
  {
    documentName: "IRENA Renewable Capacity Statistics 2024",
    sourceUrl: "https://example.com/irena/renewable-capacity-statistics-2024",
    publicationDate: "2024-03-27",
    content:
      "The world added a record 473 GW of renewable generating capacity in 2023, of which solar accounted " +
      "for 73%. Renewables made up 86% of all net capacity additions in 2023, but the report notes the " +
      "growth remains concentrated: China alone accounted for nearly 63% of new capacity.",
  },
];

// The regulatory source is written as narrative (no currency, percentages or
// specification vocabulary) and the grid-technology source in specification
// vocabulary (configuration, architecture, pattern) - step 5's content-type
// detector keys on exactly those signals.
const REGULATORY_TECH_SOURCES: SourceDocument[] = [
  {
    documentName: "EU Renewable Energy Directive Revision Enters Into Force",
    sourceUrl: "https://example.com/news/eu-red-iii-in-force",
    publicationDate: "2023-11-20",
    content:
      "The revised EU Renewable Energy Directive entered into force on 20 November 2023, raising the " +
      "bloc's binding 2030 renewables target by more than a third over the previous goal. Member states " +
      "have 18 months to transpose most provisions into national law. The revision also shortens " +
      "permitting deadlines for new wind and solar projects and designates renewable deployment as an " +
      "overriding public interest in planning disputes.",
  },
  {
    documentName: "ERCOT Grid-Forming Inverter Interconnection Requirements",
    sourceUrl: "https://example.com/ercot/grid-forming-inverter-requirements",
    publicationDate: "2024-05-02",
    content:
      "ERCOT's new interconnection requirement mandates grid-forming inverter configuration for all " +
      "battery storage resources above 100 MW. The accompanying reference architecture defines the " +
      "control pattern for autonomous frequency response, and each resource must pass a commissioning " +
      "test against the published specification before energisation. Existing resources have until " +
      "2027 to retrofit.",
  },
];

const TOPIC = "the state of global renewable energy, 2023-2024";

// ---------------------------------------------------------------------------
// Step 2: research subagents with structured provenance output
// ---------------------------------------------------------------------------
// The forced tool_choice is the foundation of end-to-end provenance: if a
// subagent returns prose, attribution is already lost before synthesis
// begins. The prompt also pre-empts step 4 at the research layer - when
// sources disagree, report BOTH values, never merge or choose.

async function researchSubagent(topic: string, focus: string, sources: SourceDocument[]): Promise<ResearchFinding[]> {
  const sourceBlock = sources
    .map((s) => `### ${s.documentName}\nURL: ${s.sourceUrl}\nPublished: ${s.publicationDate}\n\n${s.content}`)
    .join("\n\n");

  const response = await client.messages.create({
    model: MODEL,
    // Adaptive thinking shares this cap with the forced report - leave
    // headroom (4_03), because a report truncated mid-JSON arrives as
    // input {} and the subagent silently reports nothing (5_04's lesson).
    max_tokens: 8000,
    tools: [reportFindingsTool],
    tool_choice: { type: "tool", name: "report_findings", disable_parallel_tool_use: true },
    messages: [
      {
        role: "user",
        content:
          `You are a research subagent in a multi-agent research pipeline.\n` +
          `Topic: ${topic}. Your assigned focus: ${focus}.\n\n` +
          `Work ONLY from the retrieved source documents below - take URLs, titles and publication ` +
          `dates exactly as printed on each source, never from memory.\n\n` +
          `Report your findings by calling report_findings, ONE finding per claim:\n` +
          `- Aim for 3 to 6 findings covering the most substantive claims for your focus.\n` +
          `- claim: one self-contained sentence; name the year any figure refers to.\n` +
          `- relevantExcerpt: copy the supporting passage VERBATIM as one contiguous quote - ` +
          `no ellipses, no paraphrase.\n` +
          `- measure: use the IDENTICAL key for claims that report the same quantity.\n` +
          `- If two sources report DIFFERENT values for the same measure, report BOTH as separate ` +
          `findings under that identical measure key - never merge them, average them, or choose ` +
          `between them.\n\n` +
          sourceBlock,
      },
    ],
  });

  const findings = parseFindings(toolUseBlock(response)?.input);
  if (findings.length === 0) {
    throw new Error(`Subagent "${focus}" reported no findings (stop_reason: ${response.stop_reason})`);
  }
  return findings;
}

// A finding with its global citation number - assigned once by the
// coordinator and carried through synthesis, conflict handling and rendering,
// so [n] means the same source everywhere.
interface IndexedFinding extends ResearchFinding {
  ref: number;
}

// ---------------------------------------------------------------------------
// Step 3: synthesis - attribution must be explicitly preserved
// ---------------------------------------------------------------------------
// Synthesis is the pipeline's most common attribution failure point: the
// model naturally compresses and paraphrases, and the mappings die unless the
// prompt explicitly forbids it. Both arms receive the IDENTICAL numbered
// findings - the naive arm has everything it needs to cite and no instruction
// to do so, which is exactly the default pipeline most teams ship first.

function numberedFindings(findings: IndexedFinding[]): string {
  return findings
    .map(
      (f) =>
        `[${f.ref}] ` +
        JSON.stringify({
          claim: f.claim,
          sourceUrl: f.sourceUrl,
          documentName: f.documentName,
          relevantExcerpt: f.relevantExcerpt,
          publicationDate: f.publicationDate,
        }),
    )
    .join("\n");
}

async function synthesiseNaive(findings: IndexedFinding[]): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content:
          `Synthesise the research findings below into one coherent, readable report of about ` +
          `250 words for an executive audience.\n\nFindings:\n${numberedFindings(findings)}`,
      },
    ],
  });
  return textOf(response).trim();
}

async function synthesiseWithProvenance(findings: IndexedFinding[]): Promise<string> {
  const response = await client.messages.create({
    model: MODEL,
    max_tokens: 8000,
    messages: [
      {
        role: "user",
        content:
          `Synthesise the numbered research findings below into a coherent report.\n\n` +
          `CRITICAL: every claim in the body MUST carry an inline citation [n] naming the finding(s) ` +
          `it came from, and every finding must be cited at least once. Do NOT paraphrase away ` +
          `attribution, and never write "research shows" or similar without citing which research.\n\n` +
          `When two findings report different values for the same measure, present BOTH values with ` +
          `their citations and publication dates - never pick one.\n\n` +
          `End with a "## References" section listing every finding as:\n` +
          `[n] documentName (publicationDate) - sourceUrl\n\n` +
          `Body of about 300 words; the references section does not count toward that.\n\n` +
          `Findings:\n${numberedFindings(findings)}`,
      },
    ],
  });
  return textOf(response).trim();
}

// Mechanical provenance verification - never trust the synthesis prompt to
// have worked. Distinct [n] markers in the BODY (references excluded) over
// total findings is the preservation rate; URL/date presence anywhere in the
// output shows whether the reference data itself survived.
interface ProvenanceReport {
  claimCount: number;
  citationMarks: number;
  distinctCited: number;
  preservationRate: number;
  urlsPreserved: number;
  datesPreserved: number;
}

function verifyProvenance(synthesis: string, findings: IndexedFinding[]): ProvenanceReport {
  const referencesAt = synthesis.indexOf("## References");
  const body = referencesAt === -1 ? synthesis : synthesis.slice(0, referencesAt);
  const marks = body.match(/\[\d+\]/g) ?? [];
  const distinct = new Set(marks.map((m) => Number(m.slice(1, -1))).filter((n) => n >= 1 && n <= findings.length));
  return {
    claimCount: findings.length,
    citationMarks: marks.length,
    distinctCited: distinct.size,
    preservationRate: findings.length === 0 ? 0 : distinct.size / findings.length,
    urlsPreserved: findings.filter((f) => synthesis.includes(f.sourceUrl)).length,
    datesPreserved: findings.filter((f) => synthesis.includes(f.publicationDate)).length,
  };
}

// ---------------------------------------------------------------------------
// Step 4: conflicting sources - annotate both values, never adjudicate
// ---------------------------------------------------------------------------
// Arbitrarily selecting one value destroys information and presents false
// certainty. The handler groups by the measure key, and where values differ
// it keeps EVERY claim with full attribution plus a possibleExplanation that
// leans on the publication dates - different numbers published months apart
// are often revisions or different reporting bases, not contradictions. The
// consumer decides; the pipeline only preserves.

interface ResolvedGroup {
  measure: string;
  claims: IndexedFinding[];
  conflictDetected: boolean;
  possibleExplanation?: string;
}

function monthsApart(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(b) - Date.parse(a)) / (1000 * 60 * 60 * 24 * 30.44));
}

function handleConflicts(findings: IndexedFinding[]): ResolvedGroup[] {
  const byMeasure = new Map<string, IndexedFinding[]>();
  for (const finding of findings) {
    const key = normText(finding.measure);
    const list = byMeasure.get(key);
    if (list) list.push(finding);
    else byMeasure.set(key, [finding]);
  }

  const groups: ResolvedGroup[] = [];
  for (const claims of byMeasure.values()) {
    const distinctValues = new Set(claims.map((c) => normText(c.claim)));
    if (distinctValues.size <= 1) {
      groups.push({ measure: claims[0].measure, claims, conflictDetected: false });
      continue;
    }
    const ordered = [...claims].sort((a, b) => a.publicationDate.localeCompare(b.publicationDate));
    const attributed = ordered
      .map((c) => `${c.documentName} (${c.publicationDate}) [${c.ref}] reports "${c.claim}"`)
      .join(" vs ");
    const gap = monthsApart(ordered[0].publicationDate, ordered[ordered.length - 1].publicationDate);
    groups.push({
      measure: claims[0].measure,
      claims,
      conflictDetected: true,
      possibleExplanation:
        `${attributed}. The sources were published ~${gap} months apart - the difference may reflect ` +
        `different reporting periods, later data revisions, or methodological scope (each excerpt ` +
        `states its basis). Both values are preserved for the consumer to weigh.`,
    });
  }
  return groups;
}

// ---------------------------------------------------------------------------
// Step 5: content-appropriate rendering - format changes, attribution doesn't
// ---------------------------------------------------------------------------
// Flattening everything into one format degrades readability: numerical
// comparisons read best as tables, narrative events as prose, specifications
// as lists. Classification checks the most SPECIFIC signal first - technical
// vocabulary before numeric presence, because specifications cite numeric
// thresholds too ("above 100 MW") and a numbers-first test would misroute
// them into the financial table. The excerpt (verbatim source text) is
// classified alongside the claim so detection anchors on the source's own
// vocabulary, not the model's paraphrase.

type ContentType = "financial" | "news" | "technical";

const CONTENT_TYPES: ContentType[] = ["financial", "news", "technical"];
const TECHNICAL_PATTERN = /\b(api|architecture|pattern|configuration|config|specification|protocol|interconnection|inverter)\b/i;
const FINANCIAL_PATTERN = /\$|%|\b(trillion|billion|million|gw|mw|twh)\b/i;

function detectContentType(finding: ResearchFinding): ContentType {
  const text = `${finding.claim} ${finding.relevantExcerpt}`;
  if (TECHNICAL_PATTERN.test(text)) return "technical";
  if (FINANCIAL_PATTERN.test(text)) return "financial";
  return "news";
}

function extractValue(claim: string): string {
  const match = claim.match(/\$[\d,.]+\s*(?:trillion|billion|million)?|[\d,.]+\s*(?:%|GW|MW|TWh)/i);
  return match ? match[0] : "(see claim)";
}

// The table's Year column is the year the DATA refers to (first year named in
// the claim), not the publication year - a 2024 report about 2023 investment
// belongs in the 2023 row. Publication date still travels in the Source cell.
function dataYearOf(finding: ResearchFinding): string {
  const match = finding.claim.match(/\b(19|20)\d{2}\b/);
  return match ? match[0] : finding.publicationDate.slice(0, 4);
}

function renderSection(contentType: ContentType, claims: IndexedFinding[], conflictNotes: string[]): string {
  switch (contentType) {
    case "financial": {
      const rows = claims.map(
        (c) => `| ${dataYearOf(c)} | ${extractValue(c.claim)} | ${c.documentName} (${c.publicationDate}) [${c.ref}] |`,
      );
      const table = ["| Year | Value | Source |", "|---|---|---|", ...rows].join("\n");
      const notes = conflictNotes.map((n) => `> Conflict: ${n}`).join("\n");
      return notes.length > 0 ? `${table}\n${notes}` : table;
    }
    case "news":
      return claims.map((c) => `${c.claim.replace(/\.\s*$/, "")} (${c.documentName}, ${c.publicationDate}) [${c.ref}].`).join(" ");
    case "technical":
      return claims.map((c) => `- ${c.claim} [${c.ref}: ${c.documentName}, ${c.publicationDate}]`).join("\n");
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function indent(text: string): string {
  return text.split("\n").map((line) => `  | ${line}`).join("\n");
}

async function main() {
  // --- Step 1 ---------------------------------------------------------------
  console.log("=== Step 1: claim-source mapping schema (all five fields required) ===");
  const schemaOk = verifyFindingSchema();

  // --- Step 2 ---------------------------------------------------------------
  console.log("\n=== Step 2: research subagents with structured provenance output ===");
  const [marketFindings, regulatoryFindings] = await Promise.all([
    researchSubagent(TOPIC, "investment and market data", MARKET_SOURCES),
    researchSubagent(TOPIC, "regulatory developments and grid technology requirements", REGULATORY_TECH_SOURCES),
  ]);

  const allFindings: IndexedFinding[] = [...marketFindings, ...regulatoryFindings].map((f, i) => ({ ...f, ref: i + 1 }));
  const marketRefs = allFindings.slice(0, marketFindings.length);
  const regulatoryRefs = allFindings.slice(marketFindings.length);

  for (const [label, findings] of [["market subagent", marketRefs], ["regulatory/tech subagent", regulatoryRefs]] as const) {
    console.log(`  ${label}: ${findings.length} findings`);
    for (const f of findings) {
      console.log(`    [${f.ref}] (${f.measure}) ${f.claim}`);
      console.log(`        source: ${f.documentName}, ${f.publicationDate}, ${f.sourceUrl}`);
    }
  }

  // Grounding: provenance the corpus can't confirm is fabricated provenance.
  const corpusByUrl = new Map<string, SourceDocument>();
  for (const src of [...MARKET_SOURCES, ...REGULATORY_TECH_SOURCES]) corpusByUrl.set(src.sourceUrl, src);

  const fieldsComplete = allFindings.every((f) =>
    [f.claim, f.sourceUrl, f.documentName, f.relevantExcerpt, f.publicationDate, f.measure].every((v) => v.length > 0),
  );
  const datesIso = allFindings.every((f) => ISO_DATE.test(f.publicationDate));
  const provenanceMatchesCorpus = allFindings.every((f) => {
    const src = corpusByUrl.get(f.sourceUrl);
    return src !== undefined && src.documentName === f.documentName && src.publicationDate === f.publicationDate;
  });
  const groundedExcerpts = allFindings.filter((f) => {
    const src = corpusByUrl.get(f.sourceUrl);
    return src !== undefined && normText(src.content).includes(normText(f.relevantExcerpt));
  });
  console.log(
    `  grounding: ${groundedExcerpts.length}/${allFindings.length} excerpts found verbatim in their named source; ` +
      `corpus match ${provenanceMatchesCorpus ? "exact" : "BROKEN"}`,
  );

  const has495 = allFindings.some((f) => /495/.test(`${f.claim} ${f.relevantExcerpt}`));
  const has538 = allFindings.some((f) => /538/.test(`${f.claim} ${f.relevantExcerpt}`));

  // --- Step 3 ---------------------------------------------------------------
  console.log("\n=== Step 3: synthesis A/B - naive vs explicit attribution preservation ===");
  const [naiveSynthesis, preservedSynthesis] = await Promise.all([
    synthesiseNaive(allFindings),
    synthesiseWithProvenance(allFindings),
  ]);
  const naiveReport = verifyProvenance(naiveSynthesis, allFindings);
  const preservedReport = verifyProvenance(preservedSynthesis, allFindings);

  console.log("  naive synthesis (first lines):");
  console.log(indent(naiveSynthesis.split("\n").slice(0, 5).join("\n")));
  console.log(
    `  -> cites ${naiveReport.distinctCited}/${naiveReport.claimCount} findings inline ` +
      `(${Math.round(naiveReport.preservationRate * 100)}%), ${naiveReport.urlsPreserved} URLs, ` +
      `${naiveReport.datesPreserved} publication dates survive`,
  );
  console.log("\n  attribution-preserving synthesis:");
  console.log(indent(preservedSynthesis));
  console.log(
    `  -> cites ${preservedReport.distinctCited}/${preservedReport.claimCount} findings inline ` +
      `(${Math.round(preservedReport.preservationRate * 100)}%), ${preservedReport.urlsPreserved} URLs, ` +
      `${preservedReport.datesPreserved} publication dates survive`,
  );

  // --- Step 4 ---------------------------------------------------------------
  console.log("\n=== Step 4: conflicting sources - annotate both, never pick one ===");
  const resolved = handleConflicts(allFindings);
  for (const group of resolved) {
    console.log(`  ${group.conflictDetected ? "CONFLICT" : "ok      "} ${group.measure} (${group.claims.length} claim(s))`);
    if (group.possibleExplanation) console.log(`    ${group.possibleExplanation}`);
  }
  const plantedConflict = resolved.find(
    (g) =>
      g.conflictDetected &&
      g.claims.some((c) => /495/.test(`${c.claim} ${c.relevantExcerpt}`)) &&
      g.claims.some((c) => /538/.test(`${c.claim} ${c.relevantExcerpt}`)),
  );
  const claimsSurvivingResolution = resolved.reduce((sum, g) => sum + g.claims.length, 0);

  // --- Step 5 ---------------------------------------------------------------
  console.log("\n=== Step 5: content-appropriate rendering ===");
  const claimsByType = new Map<ContentType, IndexedFinding[]>(CONTENT_TYPES.map((t) => [t, []]));
  for (const finding of allFindings) claimsByType.get(detectContentType(finding))?.push(finding);

  const rendered = new Map<ContentType, string>();
  for (const contentType of CONTENT_TYPES) {
    const claims = claimsByType.get(contentType) ?? [];
    const conflictNotes = resolved
      .filter((g) => g.conflictDetected && detectContentType(g.claims[0]) === contentType)
      .map((g) => g.possibleExplanation ?? "")
      .filter((n) => n.length > 0);
    const section = renderSection(contentType, claims, conflictNotes);
    rendered.set(contentType, section);
    console.log(`\n  --- ${contentType} (${claims.length} claim(s)) ---`);
    console.log(indent(section.length > 0 ? section : "(no claims of this type)"));
  }

  const financial = rendered.get("financial") ?? "";
  const news = rendered.get("news") ?? "";
  const technical = rendered.get("technical") ?? "";

  // --- Acceptance criteria ----------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  check("claim-source mapping schema includes all five required fields, each with a provenance description", schemaOk);
  check(
    `both subagents returned structured findings (market ${marketFindings.length}, regulatory/tech ` +
      `${regulatoryFindings.length}) with every provenance field populated`,
    marketFindings.length >= 2 && regulatoryFindings.length >= 2 && fieldsComplete,
  );
  check("every publicationDate is ISO 8601 (YYYY-MM-DD)", datesIso);
  check("every sourceUrl/documentName/publicationDate matches a corpus source exactly - nothing fabricated", provenanceMatchesCorpus);
  check(
    `every relevantExcerpt appears verbatim in its named source (${groundedExcerpts.length}/${allFindings.length} grounded)`,
    groundedExcerpts.length === allFindings.length,
  );
  check("the planted disagreement was captured: findings carry BOTH the $495B and the $538B figures for 2023", has495 && has538);
  check(
    `naive synthesis loses attribution relative to the explicit prompt (${Math.round(naiveReport.preservationRate * 100)}% ` +
      `vs ${Math.round(preservedReport.preservationRate * 100)}% findings cited) - the failure step 3 exists to prevent`,
    naiveReport.preservationRate < preservedReport.preservationRate,
  );
  check(
    `attribution-preserving synthesis cites >= 80% of findings inline (measured ${Math.round(preservedReport.preservationRate * 100)}%)`,
    preservedReport.preservationRate >= 0.8,
  );
  check(
    "attribution-preserving synthesis keeps every source URL and publication date (references section)",
    preservedReport.urlsPreserved === allFindings.length && preservedReport.datesPreserved === allFindings.length,
  );
  check(
    "conflict handler flags the planted measure, preserving BOTH claims with an explanation naming both documents and dates",
    plantedConflict !== undefined &&
      plantedConflict.claims.length >= 2 &&
      plantedConflict.claims.every(
        (c) =>
          (plantedConflict.possibleExplanation ?? "").includes(c.documentName) &&
          (plantedConflict.possibleExplanation ?? "").includes(c.publicationDate),
      ),
  );
  check(
    "no silent adjudication: every finding survives conflict resolution (nothing dropped, nothing merged)",
    claimsSurvivingResolution === allFindings.length,
  );
  check(
    "only genuinely different values are flagged: at least one measure passes through unflagged, and every flagged group has >= 2 claims",
    resolved.some((g) => !g.conflictDetected) && resolved.filter((g) => g.conflictDetected).every((g) => g.claims.length >= 2),
  );
  check(
    "all three content types were detected in the findings",
    CONTENT_TYPES.every((t) => (claimsByType.get(t) ?? []).length > 0),
  );
  check(
    "financial data renders as a table carrying both conflicting values and per-row citations",
    financial.includes("| Year | Value | Source |") && /495/.test(financial) && /538/.test(financial) && /\[\d+\]/.test(financial),
  );
  check(
    "news renders as prose - no table pipes, no bullet lines, attribution in parentheses",
    news.length > 0 && !news.includes("|") && !news.split("\n").some((l) => l.startsWith("- ")) && news.includes("("),
  );
  check(
    "technical findings render as a bulleted list",
    technical.length > 0 && technical.split("\n").every((l) => l.startsWith("- ")),
  );
  check(
    "the format changes, the attribution does not: every rendered claim keeps its [n] marker and document name",
    CONTENT_TYPES.every((t) =>
      (claimsByType.get(t) ?? []).every((c) => {
        const section = rendered.get(t) ?? "";
        return section.includes(`[${c.ref}`) && section.includes(c.documentName);
      }),
    ),
  );
}

main().catch(console.error);
