// Exercise 4_06 - Multi-pass review, confidence routing and independent calibration
// Run: npx tsx 4_06-multipass-confidence-routing.ts
//
// Steps:
//   1. Single-pass baseline: all 10 files of mock-pr/ in ONE prompt; document
//      the three attention dilution symptoms - inconsistent depth per file,
//      planted bugs missed in the middle files, and positional contradictions
//      (the same pattern planted in two files but flagged in only one)
//   2. Per-file local analysis: each file alone in a fresh context, run in
//      parallel with Promise.all; same review contract as the single pass
//   3. Cross-file integration pass: per-file FINDINGS (not file contents) into
//      a dedicated prompt checking data-flow inconsistencies, contradictory
//      findings and API contract violations
//   4. Confidence routing: every finding carries confidence (0.0-1.0) and
//      reasoning; >= 0.80 -> direct_report, below -> human_review
//   5. Independent calibration: a fresh, context-free instance re-judges a
//      stratified sample of findings (code + finding only, NEVER the original
//      reasoning); build a calibration curve per confidence band and derive a
//      data-driven routing threshold from measured precision

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const PR_DIR = path.join(import.meta.dirname, "mock-pr");

const BASELINE_THRESHOLD = 0.8; // the uncalibrated starting point (Step 4)
const TARGET_PRECISION = 0.9; // what "safe to auto-report" means (Step 5)

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

type Severity = "critical" | "major" | "minor";

interface Finding {
  line: number;
  severity: Severity;
  description: string;
  confidence: number; // self-reported, 0.0-1.0 - raw and UNCALIBRATED until Step 5
  reasoning: string; // why the model is confident/uncertain - kept for analysis,
  // and deliberately WITHHELD from the independent verifier
}

interface FileReview {
  fileName: string;
  findings: Finding[];
}

// ---------------------------------------------------------------------------
// Ground truth: the planted bugs (mirrors mock-pr/ANSWER-KEY.md - keep in sync)
// ---------------------------------------------------------------------------
// Embedded here so catch rates are machine-scored. The ANSWER-KEY itself must
// never enter any review prompt.

interface PlantedBug {
  id: string;
  fileName: string;
  summary: string;
}

const PLANTED_BUGS: PlantedBug[] = [
  { id: "B01-no-status-check", fileName: "01_http-client.ts", summary: "getJson parses the body without checking response.ok" },
  { id: "B01-swallowed-error", fileName: "01_http-client.ts", summary: "getJson's catch swallows all failures and returns null" },
  { id: "B01-retry-off-by-one", fileName: "01_http-client.ts", summary: "postJson loops attempt < maxAttempts, so 'up to 3 attempts' is actually 2" },
  { id: "B02-email-regex", fileName: "02_validators.ts", summary: "email regex /.+@.+/ has no anchors and accepts almost anything" },
  { id: "B02-password-or", fileName: "02_validators.ts", summary: "password policy joins criteria with || so any single criterion passes" },
  { id: "B02-age-always-true", fileName: "02_validators.ts", summary: "age >= 18 || age <= 120 is true for every number" },
  { id: "B03-sql-injection", fileName: "03_users-repo.ts", summary: "email interpolated directly into SQL (injection)" },
  { id: "B03-plaintext-password", fileName: "03_users-repo.ts", summary: "raw password compared to password_hash with === (no hashing)" },
  { id: "B03-missing-empty-check", fileName: "03_users-repo.ts", summary: "findByEmail maps rows[0] without checking for an empty result" },
  { id: "B04-weak-token", fileName: "04_sessions.ts", summary: "session token generated with Math.random (not cryptographically secure)" },
  { id: "B04-expiry-inverted", fileName: "04_sessions.ts", summary: "isValid returns expiresAt < now - valid sessions rejected, expired accepted" },
  { id: "B04-session-leak", fileName: "04_sessions.ts", summary: "expired sessions are never evicted from the map (memory leak)" },
  { id: "B05-loose-equality", fileName: "05_tickets-repo.ts", summary: "findTicket compares ticket.id == ticketId with type coercion" },
  { id: "B05-pagination-off-by-one", fileName: "05_tickets-repo.ts", summary: "slice(start, start + pageSize - 1) drops the last item of every page" },
  { id: "B05-float-money", fileName: "05_tickets-repo.ts", summary: "order totals accumulated in binary floating-point dollars" },
  { id: "B06-sql-injection", fileName: "06_reports.ts", summary: "salesByRegion concatenates raw query-string input into SQL (injection)" },
  { id: "B06-sql-injection-dates", fileName: "06_reports.ts", summary: "salesBetween interpolates from/to into SQL (injection)" },
  { id: "B06-csv-unescaped", fileName: "06_reports.ts", summary: "toCsv joins values without quoting/escaping (CSV/formula injection)" },
  { id: "B07-ttl-inverted", fileName: "07_cache.ts", summary: "get returns entries whose expiresAt is in the past and drops fresh ones" },
  { id: "B07-unbounded", fileName: "07_cache.ts", summary: "cache never evicts - unbounded memory growth" },
  { id: "B07-shared-reference", fileName: "07_cache.ts", summary: "values stored/returned by reference so callers can mutate cached state" },
  { id: "B08-null-deref", fileName: "08_notifications.ts", summary: "getJson can return null but order.buyerEmail is dereferenced without a check" },
  { id: "B08-unawaited-send", fileName: "08_notifications.ts", summary: "sendEmail is not awaited - rejections escape the try/catch" },
  { id: "B08-html-injection", fileName: "08_notifications.ts", summary: "displayName/eventName interpolated into HTML unescaped (XSS)" },
  { id: "B09-hardcoded-secret", fileName: "09_payments.ts", summary: "live PSP API key hardcoded in source" },
  { id: "B09-unit-mismatch", fileName: "09_payments.ts", summary: "orderTotal returns dollars but the value is sent as amountCents" },
  { id: "B09-double-charge", fileName: "09_payments.ts", summary: "blind retry after failed POST can re-charge; no idempotency key" },
  { id: "B10-month-off-by-one", fileName: "10_audit.ts", summary: "getMonth() is 0-based and dayOf never adds 1" },
  { id: "B10-mutating-sort", fileName: "10_audit.ts", summary: "sortedByTime mutates the input array despite the doc comment" },
  { id: "B10-unguarded-parse", fileName: "10_audit.ts", summary: "JSON.parse on external input with no error handling" },
];

// The same pattern planted in TWO files. If a pass catches exactly one side,
// that is a positional contradiction - flagged here, approved there - detected
// mechanically, no judge needed.
const CONTRADICTION_PAIRS = [
  { pattern: "SQL built by string interpolation", bugs: ["B03-sql-injection", "B06-sql-injection"] },
  { pattern: "inverted time comparison (expiry/TTL)", bugs: ["B04-expiry-inverted", "B07-ttl-inverted"] },
];

// ---------------------------------------------------------------------------
// Load the mock PR
// ---------------------------------------------------------------------------

function loadPr(dirPath: string): Map<string, string> {
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".ts"))
    // 01_...ts to 10_...ts: sorted order = position in the prompt, so the
    // dilution curve is positional and reruns are comparable.
    .sort();
  if (files.length !== 10) {
    throw new Error(`Expected exactly 10 files in ${dirPath}, found ${files.length}`);
  }
  const pr = new Map<string, string>();
  for (const file of files) {
    pr.set(file, fs.readFileSync(path.join(dirPath, file), "utf-8"));
  }
  return pr;
}

// ---------------------------------------------------------------------------
// Shared review contract (Steps 1 & 2)
// ---------------------------------------------------------------------------
// Criteria and schema are shared VERBATIM by both passes - decomposition must
// be the only experimental variable. Confidence + reasoning are requested from
// the start so Step 4 routes findings without a re-run.

const REVIEW_CRITERIA = `Review the code for bugs, security issues, and logic errors.
For every finding report:
- the line number it occurs on
- a severity: critical, major, or minor
- a specific description of what is wrong and why it matters
- a confidence score between 0.0 and 1.0 that this is a REAL issue (not a
  false positive), where 1.0 means certain
- one sentence of reasoning explaining why you are confident or uncertain`;

const OUTPUT_INSTRUCTIONS = `Report your review as structured output.
Include an entry for EVERY file provided, even when its findings array is empty.`;

const FINDING_ITEM_SCHEMA = {
  type: "object",
  properties: {
    line: { type: "integer" },
    severity: { type: "string", enum: ["critical", "major", "minor"] },
    description: { type: "string" },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["line", "severity", "description", "confidence", "reasoning"],
  additionalProperties: false,
};

const FILE_REVIEWS_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fileName: { type: "string" },
          findings: { type: "array", items: FINDING_ITEM_SCHEMA },
        },
        required: ["fileName", "findings"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviews"],
  additionalProperties: false,
};

function textOf(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!block) throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
  return block.text;
}

// Same retry policy as 1_06: capacity/rate/server errors retry with jittered
// exponential backoff; schema/auth errors fail fast. Our own loop because
// mid-stream SSE errors bypass the SDK's request-initiation retries.
const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
const MAX_ATTEMPTS = 4;

async function structuredRequest<T>(
  prompt: string,
  schema: Record<string, unknown>,
  label: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Generous budget: max_tokens caps thinking + response together on
      // claude-sonnet-5, and truncated JSON would masquerade as "fewer
      // findings". Streaming is required at this max_tokens level.
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });
      const response = await stream.finalMessage();
      if (response.stop_reason === "max_tokens") {
        console.warn(`  WARNING: ${label} hit max_tokens - results are a floor, not a measurement`);
      }
      return JSON.parse(textOf(response)) as T;
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

async function runReview(code: string, label: string): Promise<FileReview[]> {
  const result = await structuredRequest<{ reviews: FileReview[] }>(
    `${REVIEW_CRITERIA}\n\n${OUTPUT_INSTRUCTIONS}\n\n${code}`,
    FILE_REVIEWS_SCHEMA,
    label,
  );
  return result.reviews;
}

// ---------------------------------------------------------------------------
// Step 1: single-pass baseline
// ---------------------------------------------------------------------------

async function singlePassReview(pr: Map<string, string>): Promise<FileReview[]> {
  const allCode = Array.from(pr.entries())
    .map(([name, content]) => `--- ${name} ---\n${content}`)
    .join("\n\n");
  return runReview(allCode, "single-pass");
}

// ---------------------------------------------------------------------------
// Step 2: per-file local analysis (parallel, fresh context each)
// ---------------------------------------------------------------------------

// Promise.all per the task: 10 concurrent calls are fine against rate limits
// because structuredRequest absorbs 429s with backoff. Trade-off vs 1_06's
// sequential loop: faster wall-clock, but one exhausted-retries failure
// rejects the whole batch (Promise.allSettled would be the resilient upgrade).
async function perFileReview(pr: Map<string, string>): Promise<FileReview[]> {
  const entries = Array.from(pr.entries());
  const reviews = await Promise.all(
    entries.map(async ([name, content]) => {
      const [review] = await runReview(`--- ${name} ---\n${content}`, name);
      // Normalise the key: downstream joins must match on OUR filename.
      return { ...review, fileName: name };
    }),
  );
  return reviews;
}

// ---------------------------------------------------------------------------
// Per-file metrics: findings count, depth proxy, planted-bug catch rate
// ---------------------------------------------------------------------------

interface FileMetrics {
  fileName: string;
  findingCount: number;
  avgDescriptionChars: number;
  depth: "detailed" | "superficial";
  bugsCaught: number;
  bugsPlanted: number;
}

// Depth proxy: enough findings AND substantive descriptions. A heuristic, not
// a measurement - the catch rate below is the hard metric.
function metricsFor(review: FileReview | undefined, caughtIds: Set<string>, fileName: string): FileMetrics {
  const findings = review?.findings ?? [];
  const avgChars =
    findings.length === 0
      ? 0
      : Math.round(findings.reduce((sum, f) => sum + f.description.length, 0) / findings.length);
  const planted = PLANTED_BUGS.filter((b) => b.fileName === fileName);
  const caught = planted.filter((b) => caughtIds.has(b.id));
  return {
    fileName,
    findingCount: findings.length,
    avgDescriptionChars: avgChars,
    depth: findings.length >= 2 && avgChars >= 60 ? "detailed" : "superficial",
    bugsCaught: caught.length,
    bugsPlanted: planted.length,
  };
}

// ---------------------------------------------------------------------------
// Catch judge: which planted bugs did a pass cover?
// ---------------------------------------------------------------------------
// Judge-model matching, not substring matching: findings are prose, planted
// summaries are prose - deciding "same root cause" is semantic.

const CATCH_SCHEMA = {
  type: "object",
  properties: {
    catches: {
      type: "array",
      items: {
        type: "object",
        properties: {
          bugId: { type: "string" },
          caught: { type: "boolean" },
          matchedFinding: { type: ["string", "null"] },
        },
        required: ["bugId", "caught", "matchedFinding"],
        additionalProperties: false,
      },
    },
  },
  required: ["catches"],
  additionalProperties: false,
};

function renderFindings(reviews: FileReview[]): string {
  return reviews
    .map(
      (r) =>
        `${r.fileName}:\n` +
        (r.findings.map((f) => `  [L${f.line}/${f.severity}] ${f.description}`).join("\n") ||
          "  (no findings)"),
    )
    .join("\n");
}

async function judgeCatches(reviews: FileReview[], label: string): Promise<Set<string>> {
  const prompt = `You are scoring a code review against a list of KNOWN planted bugs.
For each planted bug decide whether the review's findings cover it. A finding
covers a bug when it identifies the SAME root cause in the SAME file - exact
wording does not matter, but a finding that merely touches the same lines while
describing a different problem does not count.

Planted bugs:
${PLANTED_BUGS.map((b) => `- ${b.id} [${b.fileName}]: ${b.summary}`).join("\n")}

Review findings:
${renderFindings(reviews)}

Return one entry per planted bug: caught true/false, and the matched finding
text when caught (null otherwise).`;

  const result = await structuredRequest<{
    catches: { bugId: string; caught: boolean; matchedFinding: string | null }[];
  }>(prompt, CATCH_SCHEMA, `catch-judge (${label})`);
  return new Set(result.catches.filter((c) => c.caught).map((c) => c.bugId));
}

// ---------------------------------------------------------------------------
// Step 3: cross-file integration pass
// ---------------------------------------------------------------------------
// Fed FINDINGS + import graph, not file contents: re-sending all 10 files
// would recreate single-pass conditions. This pass spends a fresh attention
// budget purely on relationships.

interface CrossFileIssue {
  category: "data-flow" | "contradictory-findings" | "api-contract";
  filesInvolved: string[];
  description: string;
}

const CROSS_FILE_SCHEMA = {
  type: "object",
  properties: {
    crossFileIssues: {
      type: "array",
      items: {
        type: "object",
        properties: {
          category: {
            type: "string",
            enum: ["data-flow", "contradictory-findings", "api-contract"],
          },
          filesInvolved: { type: "array", items: { type: "string" } },
          description: { type: "string" },
        },
        required: ["category", "filesInvolved", "description"],
        additionalProperties: false,
      },
    },
  },
  required: ["crossFileIssues"],
  additionalProperties: false,
};

// Structure is mechanical - extract imports with a regex, never model budget.
function extractImportGraph(pr: Map<string, string>): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const [name, content] of pr) {
    graph[name] = [...content.matchAll(/from\s+["']\.\/([\w./-]+)["']/g)].map(
      (m) => `${m[1]}.ts`,
    );
  }
  return graph;
}

async function crossFilePass(
  pr: Map<string, string>,
  perFile: FileReview[],
): Promise<CrossFileIssue[]> {
  const prompt = `Cross-file integration review of a 10-file pull request. You are
given the per-file review findings and the import graph - NOT the file
contents. Report ONLY cross-cutting issues, in these categories:
1. data-flow: data passed between modules under mismatched assumptions
   (units, formats, nullability)
2. contradictory-findings: essentially the same pattern flagged in one file's
   findings but absent or judged differently in another file where the
   findings imply it also exists
3. api-contract: one module's documented or actual behaviour violated by how
   another module uses it

Per-file findings:
${renderFindings(perFile)}

Import graph (file -> imports):
${JSON.stringify(extractImportGraph(pr), null, 2)}`;

  const result = await structuredRequest<{ crossFileIssues: CrossFileIssue[] }>(
    prompt,
    CROSS_FILE_SCHEMA,
    "cross-file pass",
  );
  return result.crossFileIssues;
}

// ---------------------------------------------------------------------------
// Step 4: confidence routing
// ---------------------------------------------------------------------------

interface RoutedFinding extends Finding {
  fileName: string;
  route: "direct_report" | "human_review";
}

function routeFindings(reviews: FileReview[], threshold: number): RoutedFinding[] {
  return reviews.flatMap((r) =>
    r.findings.map((f) => ({
      ...f,
      fileName: r.fileName,
      route: (f.confidence >= threshold ? "direct_report" : "human_review") as RoutedFinding["route"],
    })),
  );
}

// ---------------------------------------------------------------------------
// Step 5: independent calibration
// ---------------------------------------------------------------------------
// "Separate instance with a fresh session" = a new stateless API request with
// NO shared context. The verifier gets the code and the bare finding - never
// the original confidence or reasoning - so it cannot anchor on the first
// instance's self-assessment.

const BANDS = [
  { min: 0.0, max: 0.6 },
  { min: 0.6, max: 0.7 },
  { min: 0.7, max: 0.8 },
  { min: 0.8, max: 0.9 },
  { min: 0.9, max: 1.01 }, // 1.01 so confidence === 1.0 lands in the top band
];

function bandLabel(band: { min: number; max: number }): string {
  return `${band.min.toFixed(1)}-${Math.min(band.max, 1.0).toFixed(1)}`;
}

// Deterministic stratified sample: up to `cap` findings per band, evenly
// spaced after a stable sort. No Math.random - reruns verify the same sample.
function sampleForCalibration(findings: RoutedFinding[], capPerBand: number): RoutedFinding[] {
  const sample: RoutedFinding[] = [];
  for (const band of BANDS) {
    const inBand = findings
      .filter((f) => f.confidence >= band.min && f.confidence < band.max)
      .sort(
        (a, b) =>
          a.confidence - b.confidence ||
          a.fileName.localeCompare(b.fileName) ||
          a.line - b.line,
      );
    if (inBand.length <= capPerBand) {
      sample.push(...inBand);
    } else {
      const step = inBand.length / capPerBand;
      for (let i = 0; i < capPerBand; i++) sample.push(inBand[Math.floor(i * step)]);
    }
  }
  return sample;
}

const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["confirmed", "rejected"] },
    assessment: { type: "string" },
  },
  required: ["verdict", "assessment"],
  additionalProperties: false,
};

interface VerifiedFinding {
  finding: RoutedFinding;
  confirmed: boolean;
  assessment: string;
}

async function independentVerification(
  pr: Map<string, string>,
  sample: RoutedFinding[],
): Promise<VerifiedFinding[]> {
  return Promise.all(
    sample.map(async (finding) => {
      const code = pr.get(finding.fileName)!;
      // Code + bare finding ONLY. No confidence, no reasoning, no other
      // findings - each verification is its own fresh, unbiased session.
      const prompt = `You are independently auditing a single code-review finding.
Decide whether it is a REAL issue in the code shown. Confirm only findings that
are genuinely wrong or risky at the cited location; reject false positives,
misreadings, and stylistic preferences presented as defects.

File: ${finding.fileName}
\`\`\`typescript
${code}
\`\`\`

Finding (line ${finding.line}, severity ${finding.severity}): ${finding.description}

Is this finding valid? Explain your assessment briefly.`;

      const result = await structuredRequest<{ verdict: "confirmed" | "rejected"; assessment: string }>(
        prompt,
        VERDICT_SCHEMA,
        `verify ${finding.fileName}:L${finding.line}`,
      );
      return { finding, confirmed: result.verdict === "confirmed", assessment: result.assessment };
    }),
  );
}

interface CalibrationPoint {
  band: string;
  sampled: number;
  confirmed: number;
  precision: number | null;
}

function buildCalibrationCurve(verified: VerifiedFinding[]): CalibrationPoint[] {
  return BANDS.map((band) => {
    const inBand = verified.filter(
      (v) => v.finding.confidence >= band.min && v.finding.confidence < band.max,
    );
    const confirmed = inBand.filter((v) => v.confirmed).length;
    return {
      band: bandLabel(band),
      sampled: inBand.length,
      confirmed,
      precision: inBand.length === 0 ? null : confirmed / inBand.length,
    };
  });
}

// The calibrated threshold: the LOWEST candidate where the measured precision
// of everything at or above it still meets the target - lowest because every
// notch down routes more findings to developers without breaking the
// precision promise. Null means no candidate qualifies: route everything to
// human review until the review prompt improves.
function recommendThreshold(verified: VerifiedFinding[]): number | null {
  for (const candidate of [0.6, 0.7, 0.8, 0.9]) {
    const above = verified.filter((v) => v.finding.confidence >= candidate);
    if (above.length === 0) continue;
    const precision = above.filter((v) => v.confirmed).length / above.length;
    if (precision >= TARGET_PRECISION) return candidate;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Comparison helpers (consistency across files)
// ---------------------------------------------------------------------------

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

// Coefficient of variation: scale-free spread, comparable across passes whose
// mean finding counts differ.
function cv(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return mean === 0 ? 0 : stdDev(values) / mean;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

function printMetricsTable(metrics: FileMetrics[]): void {
  console.log("  file                 findings  avg-chars  depth        planted-caught");
  for (const m of metrics) {
    console.log(
      `  ${m.fileName.padEnd(20)} ${String(m.findingCount).padStart(8)}  ${String(m.avgDescriptionChars).padStart(9)}  ${m.depth.padEnd(11)}  ${m.bugsCaught}/${m.bugsPlanted}`,
    );
  }
}

async function main() {
  console.log("=== Load mock PR ===");
  const pr = loadPr(PR_DIR);
  const fileNames = [...pr.keys()];
  console.log(`Loaded ${pr.size} files: ${fileNames.join(", ")}\n`);

  // --- Step 1: single-pass baseline -------------------------------------
  console.log("=== Step 1: single-pass baseline ===");
  const singlePass = await singlePassReview(pr);
  const singleCaught = await judgeCatches(singlePass, "single-pass");
  const singleMetrics = fileNames.map((name) =>
    metricsFor(singlePass.find((r) => r.fileName === name), singleCaught, name),
  );
  printMetricsTable(singleMetrics);

  console.log("\n  Attention dilution artefacts (planted duplicate patterns):");
  let singlePassContradictions = 0;
  for (const pair of CONTRADICTION_PAIRS) {
    const [a, b] = pair.bugs;
    const caughtA = singleCaught.has(a);
    const caughtB = singleCaught.has(b);
    if (caughtA !== caughtB) {
      singlePassContradictions++;
      const flagged = caughtA ? a : b;
      const missed = caughtA ? b : a;
      console.log(`  CONTRADICTION "${pair.pattern}": flagged as ${flagged}, silent on ${missed}`);
    } else {
      console.log(`  consistent on "${pair.pattern}" (${caughtA ? "both caught" : "both missed"})`);
    }
  }

  // --- Step 2: per-file local analysis ----------------------------------
  console.log("\n=== Step 2: per-file local analysis (parallel) ===");
  const perFile = await perFileReview(pr);
  const perFileCaught = await judgeCatches(perFile, "per-file");
  const perFileMetrics = fileNames.map((name) =>
    metricsFor(perFile.find((r) => r.fileName === name), perFileCaught, name),
  );
  printMetricsTable(perFileMetrics);

  const rescued = PLANTED_BUGS.filter((b) => !singleCaught.has(b.id) && perFileCaught.has(b.id));
  console.log(`\n  Bugs missed by single-pass but caught per-file (${rescued.length}):`);
  for (const bug of rescued) console.log(`    ${bug.id} [${bug.fileName}]: ${bug.summary}`);

  const singleCounts = singleMetrics.map((m) => m.findingCount);
  const perFileCounts = perFileMetrics.map((m) => m.findingCount);
  console.log(
    `\n  Catch rate: single-pass ${singleCaught.size}/${PLANTED_BUGS.length}, per-file ${perFileCaught.size}/${PLANTED_BUGS.length}`,
  );
  console.log(
    `  Consistency (CV of findings/file, lower = more even depth): single-pass ${cv(singleCounts).toFixed(2)}, per-file ${cv(perFileCounts).toFixed(2)}`,
  );

  // --- Step 3: cross-file integration pass ------------------------------
  console.log("\n=== Step 3: cross-file integration pass ===");
  const crossFile = await crossFilePass(pr, perFile);
  for (const issue of crossFile) {
    console.log(`  [${issue.category}] ${issue.filesInvolved.join(", ")}`);
    console.log(`    ${issue.description}`);
  }

  // --- Step 4: confidence routing ----------------------------------------
  console.log(`\n=== Step 4: confidence routing (baseline threshold ${BASELINE_THRESHOLD}) ===`);
  const routed = routeFindings(perFile, BASELINE_THRESHOLD);
  const direct = routed.filter((f) => f.route === "direct_report");
  const human = routed.filter((f) => f.route === "human_review");
  console.log(`  ${routed.length} findings: ${direct.length} -> direct_report, ${human.length} -> human_review`);
  console.log("  Sample of human_review queue (lowest confidence first):");
  for (const f of [...human].sort((a, b) => a.confidence - b.confidence).slice(0, 5)) {
    console.log(`    [${f.confidence.toFixed(2)}] ${f.fileName}:L${f.line} ${f.description}`);
    console.log(`      reasoning: ${f.reasoning}`);
  }

  // --- Step 5: independent calibration -----------------------------------
  console.log("\n=== Step 5: independent calibration ===");
  const sample = sampleForCalibration(routed, 4);
  console.log(`  Verifying a stratified sample of ${sample.length}/${routed.length} findings (fresh instance, code + finding only)...`);
  const verified = await independentVerification(pr, sample);

  const overturned = verified.filter((v) => !v.confirmed);
  console.log(`\n  Overturned by independent review (${overturned.length}):`);
  for (const v of overturned) {
    console.log(
      `    [conf ${v.finding.confidence.toFixed(2)}] ${v.finding.fileName}:L${v.finding.line} ${v.finding.description}`,
    );
    console.log(`      verifier: ${v.assessment}`);
  }

  console.log("\n  Calibration curve (self-reported confidence vs independent verification):");
  const curve = buildCalibrationCurve(verified);
  for (const point of curve) {
    const rate = point.precision === null ? "n/a (no samples)" : `${Math.round(point.precision * 100)}% confirmed`;
    console.log(`    band ${point.band}: ${point.confirmed}/${point.sampled} - ${rate}`);
  }

  const recommended = recommendThreshold(verified);
  if (recommended === null) {
    console.log(`\n  No threshold reaches ${TARGET_PRECISION} precision on the sample -`);
    console.log("  route ALL findings to human review until the review prompt improves.");
  } else {
    console.log(`\n  Calibrated threshold for >= ${TARGET_PRECISION} precision: ${recommended.toFixed(2)} (baseline was ${BASELINE_THRESHOLD})`);
    const rerouted = routeFindings(perFile, recommended);
    const changed = rerouted.filter((f, i) => f.route !== routed[i].route).length;
    const newDirect = rerouted.filter((f) => f.route === "direct_report").length;
    console.log(
      `  Re-routing at ${recommended.toFixed(2)}: ${newDirect}/${rerouted.length} direct_report (${changed} findings change route vs baseline)`,
    );
  }

  // --- Acceptance criteria ------------------------------------------------
  console.log("\n=== Acceptance criteria ===");
  const middleFiles = new Set(fileNames.slice(4, 7)); // positions 5-7
  const middleRescued = rescued.filter((b) => middleFiles.has(b.fileName));
  check("per-file catch rate exceeds single-pass", perFileCaught.size > singleCaught.size);
  check(
    "single-pass missed a middle-file bug that per-file caught",
    middleRescued.length > 0,
  );
  check(
    "single-pass produced at least one positional contradiction",
    singlePassContradictions > 0,
  );
  check(
    "per-file depth is more consistent (lower CV)",
    cv(perFileCounts) < cv(singleCounts),
  );
  check("cross-file pass found at least one issue", crossFile.length > 0);
  check(
    "every finding carries a confidence score and a route",
    routed.every((f) => f.confidence >= 0 && f.confidence <= 1 && !!f.route),
  );
  check(
    "independent review overturned at least one finding (calibration gap exists)",
    overturned.length > 0,
  );
}

main().catch(console.error);
