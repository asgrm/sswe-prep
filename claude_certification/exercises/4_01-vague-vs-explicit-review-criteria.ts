// Exercise 4_01 - Vague vs explicit review criteria (Task Statement 4.1)
// Run: npx tsx 4_01-vague-vs-explicit-review-criteria.ts
//
// Steps:
//   1. Baseline: a vague system prompt ("Be conservative. Only report
//      high-confidence findings.") against 5 snippets with known bugs,
//      security issues and style nitpicks - observe inconsistent
//      classification and run-to-run instability
//   2. Rewrite with explicit categorical criteria: report bugs / security /
//      logic errors, skip style preferences / naming / formatting, flag
//      comments only when claimed behaviour contradicts actual behaviour
//   3. Add concrete CODE EXAMPLES per severity level (critical/major/minor/
//      style) - examples paraphrase the patterns, never copy the eval set
//   4. Compare all three versions on the same test set, 3 runs each:
//      TP/FP/FN, precision, error rate, run-to-run inconsistency
//   5. Trust recovery: compute per-category error rates on the final
//      version, disable nitpick categories above the 25% FP threshold and
//      document the criteria refinements needed before re-enabling
//
// Terminology used throughout:
//   "bug-tier"      = model classified the snippet critical or major
//   "nitpick-tier"  = minor, style, or none
//   FP = nitpick snippet reported bug-tier (the trust killer)
//   FN = real bug reported nitpick-tier (the silent failure)
//   miscalibration = real bug flagged, but with the wrong severity grade
//
// Empirical note (claude-sonnet-5): on an obvious test set a capable model
// keeps binary FP/FN at zero even under the vague prompt - the vagueness
// surfaces one level down, as severity miscalibration (every real bug
// inflated to "critical", zero discrimination) and run-to-run instability.
// The acceptance checks therefore test all three failure surfaces.

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

// Non-streaming small requests: the SDK's own retry layer (429/5xx/connection
// errors with backoff) fully covers this path - unlike 1_06 there is no
// mid-stream SSE error channel to handle ourselves. Just raise the attempts.
const client = new Anthropic({ maxRetries: 4 });

const MODEL = "claude-sonnet-5";
const RUNS_PER_VERSION = 3;

// ---------------------------------------------------------------------------
// Test set: 5 snippets with KNOWN ground truth
// ---------------------------------------------------------------------------
// Coverage per the task guidance: one SQL injection (critical), one unused
// variable (minor), one naming inconsistency (style), plus a logic error and
// a missing null guard so every severity tier is represented.

type Severity = "critical" | "major" | "minor" | "style" | "none";

interface TestSnippet {
  id: string;
  // Category label used for the per-category trust analysis in Step 5.
  category: string;
  code: string;
  expectedSeverity: Severity;
  // Ground truth for the binary decision the exam cares about: should a
  // reviewer surface this as a bug (critical/major) or stay silent about it?
  reportWorthy: boolean;
}

const TEST_SNIPPETS: TestSnippet[] = [
  {
    id: "sql-injection",
    category: "security_vulnerability",
    code: `query = f"SELECT * FROM users WHERE id = {user_input}"\ncursor.execute(query)`,
    expectedSeverity: "critical",
    reportWorthy: true,
  },
  {
    id: "off-by-one",
    category: "logic_error",
    code: `for (let i = 0; i <= items.length; i++) {\n  items[i].process();\n}`,
    expectedSeverity: "major",
    reportWorthy: true,
  },
  {
    id: "missing-null-guard",
    category: "null_safety",
    code: `// response.data.user can be null for anonymous sessions\nconst name = response.data.user.name;`,
    expectedSeverity: "major",
    reportWorthy: true,
  },
  {
    id: "unused-variable",
    category: "dead_code",
    code: `function totalPrice(items) {\n  const unused_var = 42;\n  return items.reduce((sum, i) => sum + i.price, 0);\n}`,
    expectedSeverity: "minor",
    reportWorthy: false,
  },
  {
    id: "naming-inconsistency",
    category: "naming_convention",
    code: `let userName = getUser();\nlet user_name = userName;\nconsole.log(user_name);`,
    expectedSeverity: "style",
    reportWorthy: false,
  },
];

// ---------------------------------------------------------------------------
// The three prompt versions (Steps 1-3)
// ---------------------------------------------------------------------------
// The severity CRITERIA are the only experimental variable. The output shape
// and the shared instruction are identical across versions, otherwise the
// comparison in Step 4 measures prompt-plumbing differences, not criteria.

// Step 1 - the baseline that demonstrates the false positive problem.
// "Be conservative" has no decision boundary: conservative about REPORTING
// (skip nitpicks) and conservative about RISK (flag everything suspicious)
// are opposite behaviours, and the model has no way to know which is meant.
const VAGUE_PROMPT = `Review this code. Be conservative. Only report high-confidence findings.`;

// Step 2 - explicit categorical criteria, severity defined in PROSE.
// Categories remove the report-vs-skip ambiguity; the prose severity
// definitions still force the model to interpret phrases like "system
// failures" per snippet.
const CATEGORICAL_PROMPT = `You review code snippets.

Report (these are findings):
- bugs and logic errors
- security vulnerabilities

Skip (never report these as findings):
- minor style preferences
- local naming patterns and naming convention inconsistencies
- formatting choices
- unused imports, unless they shadow a used import

Flag comments only when the claimed behaviour contradicts the actual code behaviour.

Severity definitions:
- critical: issues that could cause system failures or security breaches
- major: issues likely to cause incorrect behaviour in production
- minor: real but low-impact issues (e.g. dead code)
- style: preferences with no behavioural impact`;

// Step 3 - same categories, but severity is defined by CODE EXAMPLES with
// the pattern named alongside each one. Examples paraphrase the patterns
// (different code, same construct) - never copy the eval set, or the test
// measures string matching instead of pattern recognition (2_01 lesson).
const EXAMPLES_PROMPT = `You review code snippets.

Report (these are findings):
- bugs and logic errors
- security vulnerabilities

Skip (never report these as findings):
- minor style preferences
- local naming patterns and naming convention inconsistencies
- formatting choices
- unused imports, unless they shadow a used import

Flag comments only when the claimed behaviour contradicts the actual code behaviour.

Severity is defined by these reference patterns:

critical - unsanitised user input reaching an interpreter (SQL/shell injection):
  db.exec("DELETE FROM orders WHERE id = " + req.params.orderId)

major - dereferencing a value that is documented as nullable (missing null guard):
  // profile.address is null until onboarding completes
  const street = profile.address.street;

major - loop bound off by one (reads past the end of the collection):
  for (let i = 0; i <= rows.length; i++) { render(rows[i]); }

minor - dead code, e.g. a local variable that is never referenced:
  const maxRetries = 3; // assigned, never read

style - mixed naming conventions for the same concept in one module:
  fetchAccount() alongside get_account() in the same file`;

// ---------------------------------------------------------------------------
// Classification call (shared by all versions)
// ---------------------------------------------------------------------------

// Shared verbatim across versions - only the criteria above vary.
const SHARED_INSTRUCTIONS = `Classify the single most significant issue in the snippet as structured output.
Use severity "none" when there is nothing worth reporting under your criteria.`;

// Structured outputs constrain the SHAPE (enum keeps labels comparable across
// runs); the prompt under test supplies the MEANING of each label - which is
// exactly the variable this experiment isolates.
const CLASSIFICATION_SCHEMA = {
  type: "object",
  properties: {
    severity: {
      type: "string",
      enum: ["critical", "major", "minor", "style", "none"],
    },
    finding: {
      type: "string",
      description: "One sentence describing the issue, or empty when severity is none",
    },
  },
  required: ["severity", "finding"],
  additionalProperties: false,
} as const;

interface Classification {
  severity: Severity;
  finding: string;
}

// content is a union of block types - find the text block with a type guard
// instead of indexing blindly.
function textOf(response: Anthropic.Message): string {
  const block = response.content.find(
    (b): b is Anthropic.TextBlock => b.type === "text",
  );
  if (!block) throw new Error(`No text block (stop_reason: ${response.stop_reason})`);
  return block.text;
}

async function classify(systemPrompt: string, snippet: TestSnippet): Promise<Classification> {
  const response = await client.messages.create({
    model: MODEL,
    // Adaptive thinking is on by default on claude-sonnet-5 and max_tokens
    // caps thinking + response together - leave headroom well above the tiny
    // JSON answer. Sampling params are rejected on this model, so run-to-run
    // variance is inherent; that variance IS the consistency measurement.
    max_tokens: 8000,
    system: `${systemPrompt}\n\n${SHARED_INSTRUCTIONS}`,
    output_config: { format: { type: "json_schema", schema: CLASSIFICATION_SCHEMA } },
    messages: [{ role: "user", content: `Review this code snippet:\n\n${snippet.code}` }],
  });
  // Structured outputs guarantee schema-valid JSON - no defensive stripping.
  return JSON.parse(textOf(response)) as Classification;
}

// ---------------------------------------------------------------------------
// Step 4 harness: run each version 3x over the test set, record everything
// ---------------------------------------------------------------------------

interface Observation {
  snippetId: string;
  run: number;
  severity: Severity;
  finding: string;
}

async function runVersion(label: string, systemPrompt: string): Promise<Observation[]> {
  const observations: Observation[] = [];
  for (let run = 1; run <= RUNS_PER_VERSION; run++) {
    // The 5 snippets of one run are independent - classify them in parallel
    // (well inside rate limits); runs stay sequential for readable progress.
    const results = await Promise.all(
      TEST_SNIPPETS.map((snippet) => classify(systemPrompt, snippet)),
    );
    results.forEach((r, i) => {
      observations.push({
        snippetId: TEST_SNIPPETS[i].id,
        run,
        severity: r.severity,
        finding: r.finding,
      });
    });
    console.log(
      `  ${label} run ${run}/${RUNS_PER_VERSION}: ` +
        results.map((r, i) => `${TEST_SNIPPETS[i].id}=${r.severity}`).join("  "),
    );
  }
  return observations;
}

// ---------------------------------------------------------------------------
// Metrics
// ---------------------------------------------------------------------------

const isBugTier = (s: Severity): boolean => s === "critical" || s === "major";

interface Metrics {
  tp: number; // real bug flagged bug-tier
  fp: number; // nitpick flagged bug-tier - the false positive the exam tests
  fn: number; // real bug reported nitpick-tier or none
  precision: number; // TP / (TP + FP)
  errorRate: number; // (FP + FN) / total classifications
  // Severity CALIBRATION, measured on the bug snippets only: a capable model
  // may never cross the bug/nitpick line even under a vague prompt (binary
  // FP/FN saturate at zero on an obvious test set), yet still show zero
  // severity discrimination - e.g. grading every real bug "critical". Exact-
  // label match is judged only on report-worthy snippets because for skip-
  // listed nitpicks "none" is COMPLIANT behaviour under explicit criteria,
  // not a wrong label.
  miscalibrated: number; // bug-snippet classifications whose exact severity != expected
  miscalibrationRate: number; // miscalibrated / bug-snippet classifications
  // Run-to-run stability: fraction of snippets whose severity label differed
  // between runs of the SAME prompt. Accuracy and consistency are separate
  // failure modes - a prompt can be reliably wrong or unreliably right.
  inconsistencyRate: number;
  unstableSnippets: string[];
}

function computeMetrics(observations: Observation[]): Metrics {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let miscalibrated = 0;
  let bugObservations = 0;
  for (const obs of observations) {
    const snippet = TEST_SNIPPETS.find((s) => s.id === obs.snippetId)!;
    const flagged = isBugTier(obs.severity);
    if (snippet.reportWorthy && flagged) tp++;
    else if (!snippet.reportWorthy && flagged) fp++;
    else if (snippet.reportWorthy && !flagged) fn++;
    if (snippet.reportWorthy) {
      bugObservations++;
      if (obs.severity !== snippet.expectedSeverity) miscalibrated++;
    }
  }

  const unstableSnippets = TEST_SNIPPETS.filter((s) => {
    const labels = new Set(
      observations.filter((o) => o.snippetId === s.id).map((o) => o.severity),
    );
    return labels.size > 1;
  }).map((s) => s.id);

  return {
    tp,
    fp,
    fn,
    precision: tp + fp === 0 ? 1 : tp / (tp + fp),
    errorRate: (fp + fn) / observations.length,
    miscalibrated,
    miscalibrationRate: bugObservations === 0 ? 0 : miscalibrated / bugObservations,
    inconsistencyRate: unstableSnippets.length / TEST_SNIPPETS.length,
    unstableSnippets,
  };
}

// ---------------------------------------------------------------------------
// Step 5: trust recovery plan
// ---------------------------------------------------------------------------
// The trust bleed effect: developers do not track FP rates per category -
// they remember "the bot cried wolf". A 40% FP rate in ONE noisy category
// makes them dismiss findings from EVERY category, including the 5%-FP
// security one. Disabling the noisy category restores trust system-wide
// while its criteria are refined offline.
//
// The asymmetry matters: nitpick categories that over-fire get DISABLED
// (an FP there is pure noise); bug categories that under-fire get REFINED
// but never disabled - switching off security detection to fix its recall
// would be trading a noisy reviewer for a blind one.

const FP_DISABLE_THRESHOLD = 0.25;

interface CategoryAssessment {
  category: string;
  kind: "nitpick" | "bug";
  // For nitpick categories: fraction of runs flagged bug-tier (FP rate).
  // For bug categories: fraction of runs NOT flagged bug-tier (miss rate).
  badRate: number;
  action: "keep" | "disable" | "refine";
}

function assessCategories(observations: Observation[]): CategoryAssessment[] {
  return TEST_SNIPPETS.map((snippet) => {
    const runs = observations.filter((o) => o.snippetId === snippet.id);
    const kind = snippet.reportWorthy ? "bug" : "nitpick";
    const bad = runs.filter((o) =>
      kind === "nitpick" ? isBugTier(o.severity) : !isBugTier(o.severity),
    ).length;
    const badRate = bad / runs.length;
    const action: CategoryAssessment["action"] =
      badRate <= FP_DISABLE_THRESHOLD ? "keep" : kind === "nitpick" ? "disable" : "refine";
    return { category: snippet.category, kind, badRate, action };
  });
}

// Refinement plans are written per category up front; only the ones whose
// measured rate crosses the threshold get printed. Each plan carries the
// 2-3 concrete edge-case examples that become the refined criteria.
const REFINEMENT_PLANS: Record<string, { issue: string; fix: string; edgeCaseExamples: string[] }> = {
  dead_code: {
    issue: "Unused locals get escalated to bug-tier because 'dead code' reads as 'defect'",
    fix: "Add examples separating harmless dead code from dead code that masks a bug",
    edgeCaseExamples: [
      `minor - plain unused local:\n  const retries = 3; // never read`,
      `major - unused RESULT of a call the author clearly meant to use:\n  const validated = validate(input);\n  save(input); // saves the raw value, validation discarded`,
      `skip - underscore-prefixed intentionally unused parameter:\n  rows.map((_row, i) => i)`,
    ],
  },
  naming_convention: {
    issue: "Naming inconsistencies get flagged bug-tier because 'inconsistency' sounds like 'error'",
    fix: "Add examples distinguishing cosmetic naming drift from naming that causes real confusion",
    edgeCaseExamples: [
      `style - mixed casing for one concept:\n  userName vs user_name in the same module`,
      `major - two near-identical names with DIFFERENT semantics silently swapped:\n  const userId = session.accountId; // accountId is not the user id`,
    ],
  },
  null_safety: {
    issue: "Nullable dereferences are missed when the nullability is stated in a comment, not a type",
    fix: "Add examples where the null contract lives in comments/docs so the model reads them as contracts",
    edgeCaseExamples: [
      `major - comment declares nullability, code ignores it:\n  // getConfig() returns null before init\n  const port = getConfig().port;`,
      `skip - guarded access is fine:\n  const port = getConfig()?.port ?? DEFAULT_PORT;`,
    ],
  },
  logic_error: {
    issue: "Boundary-condition bugs get graded minor because the code 'mostly works'",
    fix: "Add examples pinning loop-bound and comparison-operator mistakes to major",
    edgeCaseExamples: [
      `major - reads one past the end:\n  for (let i = 0; i <= xs.length; i++) use(xs[i]);`,
      `major - assignment where comparison was meant:\n  if (status = "ready") launch();`,
    ],
  },
  security_vulnerability: {
    issue: "Injection findings graded below critical when the tainted value looks 'internal'",
    fix: "Add examples showing taint matters regardless of where the variable appears to come from",
    edgeCaseExamples: [
      `critical - interpolation into SQL, even via an intermediate variable:\n  const clause = "name = '" + form.name + "'";\n  db.query("SELECT * FROM t WHERE " + clause);`,
      `skip - parameterised query is fine:\n  db.query("SELECT * FROM t WHERE name = ?", [form.name]);`,
    ],
  },
};

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

function printMetrics(label: string, m: Metrics): void {
  console.log(
    `  ${label.padEnd(22)} TP=${m.tp} FP=${m.fp} FN=${m.fn}  precision=${m.precision.toFixed(2)}  ` +
      `errorRate=${(m.errorRate * 100).toFixed(0)}%  miscalibration=${(m.miscalibrationRate * 100).toFixed(0)}%  ` +
      `inconsistency=${(m.inconsistencyRate * 100).toFixed(0)}%` +
      (m.unstableSnippets.length ? `  unstable: ${m.unstableSnippets.join(", ")}` : ""),
  );
}

async function main() {
  console.log("Test set (ground truth):");
  for (const s of TEST_SNIPPETS) {
    console.log(
      `  ${s.id.padEnd(22)} expected=${s.expectedSeverity.padEnd(8)} ` +
        `${s.reportWorthy ? "REPORT" : "skip  "}  [${s.category}]`,
    );
  }

  console.log("\n=== Step 1: vague prompt baseline ===");
  const vagueObs = await runVersion("vague", VAGUE_PROMPT);

  console.log("\n=== Step 2: explicit categorical criteria (prose severities) ===");
  const categoricalObs = await runVersion("categorical", CATEGORICAL_PROMPT);

  console.log("\n=== Step 3: categorical criteria + code examples per severity ===");
  const examplesObs = await runVersion("examples", EXAMPLES_PROMPT);

  console.log("\n=== Step 4: comparison ===");
  const vague = computeMetrics(vagueObs);
  const categorical = computeMetrics(categoricalObs);
  const examples = computeMetrics(examplesObs);
  printMetrics("vague", vague);
  printMetrics("categorical (prose)", categorical);
  printMetrics("categorical+examples", examples);
  console.log(
    "  (precision = TP/(TP+FP); errorRate = (FP+FN)/all; miscalibration = bug snippets whose exact severity",
  );
  console.log(
    "   grade is wrong; inconsistency = snippets whose label changed between runs of the same prompt)",
  );

  console.log("\n=== Step 5: trust recovery plan (measured on the final version) ===");
  const assessments = assessCategories(examplesObs);
  for (const a of assessments) {
    const rateLabel = a.kind === "nitpick" ? "fpRate" : "missRate";
    console.log(
      `  ${a.category.padEnd(24)} ${rateLabel}=${(a.badRate * 100).toFixed(0).padStart(3)}%  -> ${a.action}`,
    );
  }
  const troubled = assessments.filter((a) => a.action !== "keep");
  if (troubled.length === 0) {
    console.log(`  All categories at or below the ${FP_DISABLE_THRESHOLD * 100}% threshold - nothing to disable.`);
  }
  for (const a of troubled) {
    const plan = REFINEMENT_PLANS[a.category];
    console.log(`\n  --- ${a.action.toUpperCase()}: ${a.category} ---`);
    if (a.action === "disable") {
      console.log(
        `  Trust bleed: at ${(a.badRate * 100).toFixed(0)}% FP this category makes developers` +
          ` dismiss ALL findings - disabling it raises perceived accuracy of every remaining category.`,
      );
    } else {
      console.log(
        `  Bug category - never disabled (that trades a noisy reviewer for a blind one); refine instead.`,
      );
    }
    console.log(`  Issue: ${plan.issue}`);
    console.log(`  Fix:   ${plan.fix}`);
    console.log(`  Refined criteria (edge-case examples for re-enablement):`);
    for (const ex of plan.edgeCaseExamples) {
      console.log(ex.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    console.log(`  Re-enable when FP rate on a held-out set is below 15%.`);
  }

  console.log("\n=== Acceptance criteria ===");
  // The vague prompt's failure can surface at either level. A weaker model
  // flags nitpicks bug-tier (FP/FN); a capable one still shows zero severity
  // discrimination (e.g. every bug graded "critical") or run instability.
  check(
    "vague prompt failed somewhere: FP/FN, severity miscalibration, or instability",
    vague.fp + vague.fn > 0 || vague.miscalibrationRate > 0 || vague.inconsistencyRate > 0,
  );
  check(
    "explicit criteria improved calibration (exact severity on real bugs) vs vague",
    examples.miscalibrationRate < vague.miscalibrationRate ||
      (vague.miscalibrationRate === 0 && examples.miscalibrationRate === 0),
  );
  check(
    "code examples >= prose severities on calibration",
    examples.miscalibrationRate <= categorical.miscalibrationRate,
  );
  check(
    "code examples >= prose severities on precision",
    examples.precision >= categorical.precision,
  );
  check(
    "final version error rate below 15% (task target)",
    examples.errorRate < 0.15,
  );
  check(
    "final version at least as stable as vague across runs",
    examples.inconsistencyRate <= vague.inconsistencyRate,
  );
}

main().catch(console.error);
