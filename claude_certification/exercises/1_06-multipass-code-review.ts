// Exercise 06 - Multi-pass code review pipeline (task decomposition)
// Run: npx tsx 1_06-multipass-code-review.ts
//
// Steps:
//   1. Load all .ts/.js files from review-target/ into a Map<filename, content>
//      (skip ANSWER-KEY.md and tsconfig.json - source files only)
//   2. Single-pass review: ALL files in ONE prompt; record issues per file and
//      observe attention dilution (early files reviewed deeper than late ones)
//   3. Per-file passes: each file individually with the SAME review prompt;
//      structured output per file (issues: line, severity, description)
//   4. Cross-file integration pass: per-file summaries + file structure into a
//      dedicated prompt; ask about data flow between modules, inconsistent API
//      usage, contradictory pattern evaluation, import chain problems
//   5. Compare: issues per file, totals, standard deviation per approach
//      (lower deviation = more consistent analysis depth)
//   6. Attention dilution artefacts: same pattern flagged in one file but
//      approved in another during the single pass - proof the problem is
//      structural, not random

import "dotenv/config";
import * as fs from "node:fs";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const TARGET_DIR = path.join(import.meta.dirname, "review-target");

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
// One structured shape for BOTH approaches - the comparison in Step 5 is only
// meaningful if single-pass and per-file results are recorded identically.

type Severity = "low" | "medium" | "high" | "critical";

interface Issue {
  line: number;
  severity: Severity;
  description: string;
}

interface FileReview {
  fileName: string;
  issues: Issue[];
}

interface CrossFileIssue {
  // e.g. "data-flow" | "inconsistent-api" | "pattern-contradiction" | "import-chain"
  category: string;
  filesInvolved: string[];
  description: string;
}

// ---------------------------------------------------------------------------
// Step 1: load the codebase
// ---------------------------------------------------------------------------

function loadCodebase(dirPath: string): Map<string, string> {
  const files = fs
    .readdirSync(dirPath)
    .filter((f) => f.endsWith(".ts") || f.endsWith(".js"))
    // Deterministic order: the dilution curve in Step 2 is positional, so
    // reruns must present files in the same sequence to be comparable.
    .sort();

  if (files.length < 10) {
    throw new Error(`Need at least 10 source files, found ${files.length} in ${dirPath}`);
  }

  const codebase = new Map<string, string>();
  for (const file of files) {
    codebase.set(file, fs.readFileSync(path.join(dirPath, file), "utf-8"));
  }
  return codebase;
}

// ---------------------------------------------------------------------------
// Shared review contract (Steps 2 & 3)
// ---------------------------------------------------------------------------
// Criteria and output schema are shared VERBATIM by both approaches: the
// decomposition must be the ONLY variable between the experiments, otherwise
// the comparison measures prompt differences, not attention allocation.
// Deliberately absent: "be equally thorough on every file" - that would be
// prompting against the very phenomenon Step 2 exists to observe.

const REVIEW_CRITERIA = `Review the code for bugs, style issues, and security vulnerabilities.
Provide specific line references for each issue.`;

// The output SHAPE is enforced by structured outputs (output_config.format) -
// the API constrains decoding to the schema, so responses are guaranteed
// parseable. The prompt only carries what a schema cannot express: semantics.
const OUTPUT_INSTRUCTIONS = `Report your review as structured output.
Include an entry for EVERY file provided, even when its issues array is empty.`;

// JSON Schema for FileReview[]. Structured-outputs rules: every object needs
// additionalProperties: false + required; enum is supported, min/max are not.
// Root is wrapped in an object ({reviews: [...]}) rather than a bare array.
const FILE_REVIEWS_SCHEMA = {
  type: "object",
  properties: {
    reviews: {
      type: "array",
      items: {
        type: "object",
        properties: {
          fileName: { type: "string" },
          issues: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line: { type: "integer" },
                severity: {
                  type: "string",
                  enum: ["low", "medium", "high", "critical"],
                },
                description: { type: "string" },
              },
              required: ["line", "severity", "description"],
              additionalProperties: false,
            },
          },
        },
        required: ["fileName", "issues"],
        additionalProperties: false,
      },
    },
  },
  required: ["reviews"],
  additionalProperties: false,
};

// content is a union of block types - the first block is not guaranteed to be
// text, so find it with a type guard instead of indexing blindly.
function textOf(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!block) throw new Error(`No text block in response (stop_reason: ${response.stop_reason})`);
  return block.text;
}

// Transient API failures worth retrying: capacity (529), rate limits (429),
// server errors (5xx). Everything else (400 schema errors, 401 auth) fails
// fast - retrying those wastes time and hides real bugs.
const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
const MAX_ATTEMPTS = 4;

// ONE function makes every structured model request. Every pass routes
// through it, so model, streaming, output budget, truncation handling,
// parsing and RETRY policy cannot drift apart between experiments.
//
// Why our own retry loop: the SDK auto-retries 429/5xx only at request
// initiation. On streaming requests the connection opens fine and the error
// can arrive as an SSE event MID-STREAM (status: undefined) - that path
// bypasses the SDK's retry layer entirely, so it is ours to handle.
async function structuredRequest<T>(
  prompt: string,
  schema: Record<string, unknown>,
  label: string,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      // Generous output budget: on claude-sonnet-5 adaptive thinking is ON by
      // default and max_tokens caps thinking + response TOGETHER - a 16k cap
      // was consumed entirely by thinking, yielding zero text. And a tight
      // cap would truncate the JSON mid-array and masquerade as "fewer issues
      // in late files". We measure attention dilution, not truncation.
      // Streaming is required above ~16k max_tokens to avoid HTTP timeouts.
      const stream = client.messages.stream({
        model: MODEL,
        max_tokens: 64000,
        output_config: { format: { type: "json_schema", schema } },
        messages: [{ role: "user", content: prompt }],
      });
      const response = await stream.finalMessage();

      // Truncation must never be silent - it corrupts every downstream step.
      if (response.stop_reason === "max_tokens") {
        console.warn(
          `  WARNING: ${label} hit max_tokens - results are a floor, not a measurement`,
        );
      }

      // Structured outputs guarantee schema-valid JSON - no defensive stripping.
      return JSON.parse(textOf(response)) as T;
    } catch (err) {
      // Typed classification, never string-matching on messages. Connection
      // drops are retryable; API errors only if their type is in the set.
      const retryable =
        err instanceof Anthropic.APIConnectionError ||
        (err instanceof Anthropic.APIError &&
          typeof err.type === "string" &&
          RETRYABLE_ERROR_TYPES.has(err.type));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;

      // Exponential backoff with jitter: 2s, 4s, 8s (+/- randomness) so
      // parallel clients don't re-stampede a recovering service in lockstep.
      const delayMs = 2000 * 2 ** (attempt - 1) + Math.random() * 1000;
      const kind = err instanceof Anthropic.APIError ? err.type : "connection error";
      console.warn(
        `  ${label}: ${kind} - retrying (${attempt}/${MAX_ATTEMPTS - 1}) in ${Math.round(delayMs / 1000)}s`,
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// The shared review call for Steps 2 & 3 - identical criteria, instructions
// and schema; the decomposition stays the only experimental variable.
async function runReview(code: string, label: string): Promise<FileReview[]> {
  const result = await structuredRequest<{ reviews: FileReview[] }>(
    `${REVIEW_CRITERIA}\n\n${OUTPUT_INSTRUCTIONS}\n\n${code}`,
    FILE_REVIEWS_SCHEMA,
    label,
  );
  return result.reviews;
}

// ---------------------------------------------------------------------------
// Step 2: single-pass review (the baseline that demonstrates the problem)
// ---------------------------------------------------------------------------

async function singlePassReview(codebase: Map<string, string>): Promise<FileReview[]> {
  const allCode = Array.from(codebase.entries())
    .map(([name, content]) => `=== ${name} ===\n${content}`)
    .join("\n\n");
  return runReview(allCode, "single-pass");
}

// ---------------------------------------------------------------------------
// Step 3: per-file local passes (full attention budget per file)
// ---------------------------------------------------------------------------

// Sequential on purpose: 15 calls stay well inside rate limits, one failure
// doesn't reject the batch, ordering is deterministic, and progress is
// visible per file. The cost is wall-clock time (~sum of 15 reviews); a
// bounded-concurrency pool (3-4 at a time) is the upgrade if that hurts.
async function perFileReview(codebase: Map<string, string>): Promise<FileReview[]> {
  const reviews: FileReview[] = [];
  for (const [name, content] of codebase) {
    const [review] = await runReview(`=== ${name} ===\n${content}`, name);
    // Normalise the key: joins in Steps 5/6 must match on OUR filename, not
    // whatever spelling the model chose to echo back.
    reviews.push({ ...review, fileName: name });
    const count = review.issues.length;
    console.log(`  ${name.padEnd(16)} ${"#".repeat(count)} (${count})`);
  }
  return reviews;
}

// ---------------------------------------------------------------------------
// Step 4: cross-file integration pass
// ---------------------------------------------------------------------------

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
            enum: ["data-flow", "inconsistent-api", "pattern-contradiction", "import-chain"],
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

// Structure is mechanical - extract it with a regex, never with model budget.
// Matches ESM relative imports: import { x } from "./money"
function extractImportGraph(codebase: Map<string, string>): Record<string, string[]> {
  const graph: Record<string, string[]> = {};
  for (const [name, content] of codebase) {
    graph[name] = [...content.matchAll(/from\s+["']\.\/([\w./-]+)["']/g)].map(
      (m) => `${m[1]}.ts`,
    );
  }
  return graph;
}

// Deliberately fed SUMMARIES + STRUCTURE, not file contents: this pass exists
// to spend a fresh attention budget on relationships between modules.
// Re-sending all 15 files would recreate single-pass conditions and dilute
// the same way - the compression is the point.
async function crossFilePass(
  codebase: Map<string, string>,
  perFileResults: FileReview[],
): Promise<CrossFileIssue[]> {
  const summary = perFileResults
    .map(
      (r) =>
        `${r.fileName} (${r.issues.length} issues):\n` +
        r.issues.map((i) => `  [L${i.line}/${i.severity}] ${i.description}`).join("\n"),
    )
    .join("\n");
  const imports = extractImportGraph(codebase);

  const prompt = `Cross-file integration review of a TypeScript codebase. You are given
per-file review summaries and the import graph - NOT the file contents.
Report ONLY cross-cutting issues, in these categories:
1. data-flow: data passed between modules with mismatched assumptions
2. inconsistent-api: the same API used differently across files
3. pattern-contradiction: the same pattern flagged in one file but not in another
4. import-chain: circular, redundant or suspicious import relationships

Per-file review summaries:
${summary}

Import graph (file -> imports):
${JSON.stringify(imports, null, 2)}`;

  const result = await structuredRequest<{ crossFileIssues: CrossFileIssue[] }>(
    prompt,
    CROSS_FILE_SCHEMA,
    "cross-file pass",
  );
  return result.crossFileIssues;
}

// ---------------------------------------------------------------------------
// Step 5: comparison - totals, per-file counts, standard deviation
// ---------------------------------------------------------------------------

interface Comparison {
  singlePassTotal: number;
  multiPassTotal: number; // per-file + cross-file
  singlePassStdDev: number;
  multiPassStdDev: number;
  // Coefficient of variation (std dev / mean): raw std dev scales with the
  // mean, so comparing spreads across a ~3x difference in issues-per-file is
  // meaningless. CV is the scale-free consistency measure.
  singlePassCV: number;
  multiPassCV: number;
  perFileCounts: { fileName: string; singlePass: number; multiPass: number }[];
}

function stdDev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length);
}

// Pure computation - printing lives in main(). The canonical file list is the
// per-file results (one entry per file by construction); a file the single
// pass stayed SILENT about enters as 0. Mapping over singlePass instead would
// drop those zeros and bias its std dev downwards - hiding the very
// dilution this experiment exists to measure.
function compareResults(
  singlePass: FileReview[],
  multiPass: FileReview[],
  crossFile: CrossFileIssue[],
): Comparison {
  const perFileCounts = multiPass.map((mp) => ({
    fileName: mp.fileName,
    singlePass: singlePass.find((sp) => sp.fileName === mp.fileName)?.issues.length ?? 0,
    multiPass: mp.issues.length,
  }));

  const spCounts = perFileCounts.map((c) => c.singlePass);
  const mpCounts = perFileCounts.map((c) => c.multiPass);
  const spMean = spCounts.reduce((a, b) => a + b, 0) / spCounts.length;
  const mpMean = mpCounts.reduce((a, b) => a + b, 0) / mpCounts.length;

  return {
    singlePassTotal: perFileCounts.reduce((s, c) => s + c.singlePass, 0),
    // Cross-file findings belong to the multi-pass approach's total - they
    // are issues the decomposition made findable.
    multiPassTotal: perFileCounts.reduce((s, c) => s + c.multiPass, 0) + crossFile.length,
    singlePassStdDev: stdDev(spCounts),
    multiPassStdDev: stdDev(mpCounts),
    singlePassCV: spMean === 0 ? 0 : stdDev(spCounts) / spMean,
    multiPassCV: mpMean === 0 ? 0 : stdDev(mpCounts) / mpMean,
    perFileCounts,
  };
}

// ---------------------------------------------------------------------------
// Step 6: attention dilution artefacts (contradictory pattern evaluation)
// ---------------------------------------------------------------------------

interface Contradiction {
  pattern: string;
  flaggedIn: string; // file where the single pass reported it
  approvedIn: string; // file where identical code passed silently
  evidence: string;
}

const CONTRADICTIONS_SCHEMA = {
  type: "object",
  properties: {
    contradictions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          pattern: { type: "string" },
          flaggedIn: { type: "string" },
          approvedIn: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["pattern", "flaggedIn", "approvedIn", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["contradictions"],
  additionalProperties: false,
};

// Judge-model approach, chosen over mechanical matching: reviews are PROSE,
// so substring-matching code patterns against descriptions ~never hits
// ("uses float arithmetic for currency" contains no code). Deciding whether
// two prose findings describe the same pattern is semantic matching - a model
// task. Cost: one extra call and some non-determinism in the detector.
async function findContradictions(
  singlePass: FileReview[],
  multiPass: FileReview[],
): Promise<Contradiction[]> {
  const render = (reviews: FileReview[]) =>
    reviews
      .map(
        (r) =>
          `${r.fileName}:\n` +
          (r.issues.map((i) => `  [L${i.line}/${i.severity}] ${i.description}`).join("\n") ||
            "  (no issues reported)"),
      )
      .join("\n");

  const prompt = `You are auditing a code review experiment for attention dilution artefacts.
Below are two reviews of the SAME codebase: a single-pass review (all files
in one prompt) and a per-file review (each file reviewed individually -
treat this as ground truth for which patterns exist in which files).

Find contradictions in the SINGLE-PASS review: a pattern it flagged in one
file (flaggedIn) while staying silent about essentially the same pattern in
another file (approvedIn), where the per-file review confirms the pattern
exists in both. Cite the relevant findings as evidence. Report only clear
cases - an empty list is a valid answer.

SINGLE-PASS review:
${render(singlePass)}

PER-FILE review (ground truth):
${render(multiPass)}`;

  const result = await structuredRequest<{ contradictions: Contradiction[] }>(
    prompt,
    CONTRADICTIONS_SCHEMA,
    "contradiction detection",
  );
  return result.contradictions;
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  console.log("=== Step 1: load codebase ===");
  const codebase = loadCodebase(TARGET_DIR);
  console.log(`Loaded ${codebase.size} files: ${[...codebase.keys()].join(", ")}\n`);

  console.log("=== Step 2: single-pass review ===");
  const singlePass = await singlePassReview(codebase);
  // Issues per file, in PROMPT ORDER - a file the model stayed silent about
  // counts as 0, and the dilution curve should be visible right here.
  for (const name of codebase.keys()) {
    const review = singlePass.find((r) => r.fileName === name);
    const count = review?.issues.length ?? 0;
    console.log(`  ${name.padEnd(16)} ${"#".repeat(count)} (${count})`);
  }

  console.log("\n=== Step 3: per-file review ===");
  const perFile = await perFileReview(codebase);

  console.log("\n=== Step 4: cross-file integration pass ===");
  const crossFile = await crossFilePass(codebase, perFile);
  for (const issue of crossFile) {
    console.log(`  [${issue.category}] ${issue.filesInvolved.join(", ")}`);
    console.log(`    ${issue.description}`);
  }

  console.log("\n=== Step 5: comparison ===");
  const comparison = compareResults(singlePass, perFile, crossFile);
  for (const c of comparison.perFileCounts) {
    console.log(
      `  ${c.fileName.padEnd(16)} single-pass=${String(c.singlePass).padStart(2)}  multi-pass=${String(c.multiPass).padStart(2)}`,
    );
  }
  console.log(
    `  Totals: single-pass=${comparison.singlePassTotal}, multi-pass=${comparison.multiPassTotal} (incl. ${crossFile.length} cross-file)`,
  );
  console.log(
    `  Std dev (issues/file): single-pass=${comparison.singlePassStdDev.toFixed(2)}, multi-pass=${comparison.multiPassStdDev.toFixed(2)}`,
  );
  console.log(
    `  Coefficient of variation: single-pass=${comparison.singlePassCV.toFixed(2)}, multi-pass=${comparison.multiPassCV.toFixed(2)} (lower = more consistent)`,
  );

  console.log("\n=== Step 6: attention dilution artefacts ===");
  const contradictions = await findContradictions(singlePass, perFile);
  for (const c of contradictions) {
    console.log(`  Pattern: ${c.pattern}`);
    console.log(`    flagged in ${c.flaggedIn}, approved in ${c.approvedIn}`);
    console.log(`    evidence: ${c.evidence}`);
  }

  console.log("\n=== Acceptance criteria ===");
  check("multi-pass found more total issues", comparison.multiPassTotal > comparison.singlePassTotal);
  check(
    "multi-pass has lower relative variance (CV)",
    comparison.multiPassCV < comparison.singlePassCV,
  );
  check("cross-file pass caught issues per-file passes missed", crossFile.length > 0);
  check("at least one attention dilution artefact found", contradictions.length > 0);
}

main().catch(console.error);
