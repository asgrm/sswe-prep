// Exercise 5_03 - Structured error context and coordinator recovery (Task Statement 5.3)
// Run: npx tsx 5_03-structured-error-recovery-coordinator.ts
//
// Steps:
//   1. StructuredError schema: failureType/attemptedAction/partialResults/
//      alternativeApproaches, with status distinguishing error from partial_failure
//   2. reportSearchAttempt: one raw call, classified as a valid empty result
//      (status success, shouldRetry false) or an access failure (shouldRetry true)
//   3. withRetry: 3 local attempts with exponential backoff, partial results
//      accumulate across attempts before the exhausted error ever reaches the coordinator
//   4. coordinatorRecovery: branches on failureType, using partialResults and
//      alternativeApproaches to choose retry / alternative / proceed / escalate
//   5. addCoverageAnnotations: synthesis output states well-supported/limited/
//      unavailable per topic - a valid empty result is well-supported, never "unavailable"

import "dotenv/config";

// ---------------------------------------------------------------------------
// Step 1: structured error schema
// ---------------------------------------------------------------------------

type FailureType = "transient" | "validation" | "business" | "permission";

interface AttemptedAction {
  tool: string;
  query: string;
  parameters: Record<string, unknown>;
}

interface RetrievedItem {
  title: string;
  source: string;
  retrieved: boolean;
}

// The four elements a coordinator needs to decide retry / alternative /
// proceed-with-partial / escalate - a generic "search failed" string
// supports none of those choices.
interface StructuredError {
  status: "error" | "partial_failure";
  failureType: FailureType;
  attemptedAction: AttemptedAction;
  partialResults: RetrievedItem[];
  alternativeApproaches: string[];
  message: string;
}

interface SearchSuccess {
  status: "success";
  results: RetrievedItem[];
  message: string;
  shouldRetry: false;
}

// One constructor guarantees every StructuredError carries all four elements
// - same idiom as 2_02's buildErrorResponse. status is derived, not passed:
// any partial results at all means partial_failure, otherwise error.
function buildStructuredError(
  failureType: FailureType,
  attemptedAction: AttemptedAction,
  message: string,
  alternativeApproaches: string[],
  partialResults: RetrievedItem[] = [],
): StructuredError {
  return {
    status: partialResults.length > 0 ? "partial_failure" : "error",
    failureType,
    attemptedAction,
    partialResults,
    alternativeApproaches,
    message,
  };
}

// ---------------------------------------------------------------------------
// Mock search backend - controllable failure modes, no live model calls
// ---------------------------------------------------------------------------

class AccessFailure extends Error {
  constructor(message: string, readonly partialResults: RetrievedItem[] = []) {
    super(message);
  }
}

type SearchMode = "success" | "success_fallback" | "empty" | "flaky_recovers" | "down_hard" | "down_no_partial";

interface DateRange {
  start: string;
  end: string;
}

const PRIMARY_RESULTS: RetrievedItem[] = [
  { title: "EU Renewable Energy Directive 2023", source: "EUR-Lex", retrieved: true },
  { title: "IRENA Global Energy Transformation Report", source: "IRENA", retrieved: true },
  { title: "IEA Renewables 2024 Analysis", source: "IEA", retrieved: true },
  { title: "National Grid Decarbonisation Roadmap", source: "National Grid ESO", retrieved: true },
  { title: "Cross-Border Interconnection Capacity Study", source: "ENTSO-E", retrieved: true },
];

const ALTERNATIVE_RESULTS: RetrievedItem[] = [
  { title: "Historical Tariff Digest (cached snapshot)", source: "Internal Research Archive", retrieved: true },
  { title: "19th-Century Trade Policy Compendium", source: "Internal Research Archive", retrieved: true },
];

// Stateful per-call factory: each searchSubagent invocation gets its own
// attempt counter, so a "flaky" mode can fail N times then recover.
function makeSearchDatabase(mode: SearchMode): () => Promise<SearchSuccess> {
  let attempt = 0;
  return async function searchDatabase(): Promise<SearchSuccess> {
    attempt++;
    switch (mode) {
      case "success":
        return { status: "success", results: PRIMARY_RESULTS, message: `Retrieved ${PRIMARY_RESULTS.length} sources.`, shouldRetry: false };
      case "success_fallback":
        return {
          status: "success",
          results: ALTERNATIVE_RESULTS,
          message: `Retrieved ${ALTERNATIVE_RESULTS.length} sources from the alternative provider.`,
          shouldRetry: false,
        };
      case "empty":
        // Valid empty result - the query executed. This is the answer, not a failure.
        return { status: "success", results: [], message: "Query executed successfully. No matching records found.", shouldRetry: false };
      case "flaky_recovers":
        if (attempt === 1) throw new AccessFailure("Connection reset mid-stream", PRIMARY_RESULTS.slice(0, 2));
        return { status: "success", results: PRIMARY_RESULTS, message: `Retrieved ${PRIMARY_RESULTS.length} sources after one retry.`, shouldRetry: false };
      case "down_hard":
        // 2 partials, then 1 more, then none - proves accumulation across attempts (2+1+0=3).
        if (attempt === 1) throw new AccessFailure("Connection timed out after 30s", PRIMARY_RESULTS.slice(0, 2));
        if (attempt === 2) throw new AccessFailure("Connection timed out after 30s", PRIMARY_RESULTS.slice(2, 3));
        throw new AccessFailure("Connection timed out after 30s", []);
      case "down_no_partial":
        throw new AccessFailure("Connection refused - host unreachable", []);
    }
  };
}

// ---------------------------------------------------------------------------
// Step 2: one raw attempt - access failure vs valid empty result
// ---------------------------------------------------------------------------
// The try/catch boundary is the whole point: an exception means the query
// never ran (shouldRetry: true); a resolved promise with zero rows means it
// ran and found nothing (shouldRetry: false, and it is a final answer).

type AttemptReport = SearchSuccess | (StructuredError & { shouldRetry: boolean });

async function reportSearchAttempt(searchOnce: () => Promise<SearchSuccess>, attemptedAction: AttemptedAction): Promise<AttemptReport> {
  try {
    return await searchOnce();
  } catch (err) {
    if (!(err instanceof AccessFailure)) throw err;
    return {
      ...buildStructuredError(
        "transient",
        attemptedAction,
        `Connection failure: ${err.message}`,
        ["Retry the same query", "Try an alternative data source"],
        err.partialResults,
      ),
      shouldRetry: true,
    };
  }
}

// ---------------------------------------------------------------------------
// Step 3: local retry with exponential backoff before propagating upward
// ---------------------------------------------------------------------------
// Subagents handle their own transient failures locally so the coordinator
// doesn't have to manage retries for every tool. Only a failure that
// survives all local attempts propagates - and it carries every partial
// result gathered along the way, not just the last attempt's.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function withRetry(
  searchOnce: () => Promise<SearchSuccess>,
  attemptedAction: AttemptedAction,
  maxRetries = 3,
): Promise<SearchSuccess | StructuredError> {
  const allPartialResults: RetrievedItem[] = [];
  let lastMessage = "";

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const report = await reportSearchAttempt(searchOnce, attemptedAction);
    if (report.status === "success") return report;

    allPartialResults.push(...report.partialResults);
    lastMessage = report.message;
    if (!report.shouldRetry || attempt === maxRetries - 1) break;

    const delay = 2 ** attempt * 1000; // 1s, 2s
    console.log(`      attempt ${attempt + 1}/${maxRetries} failed - retrying in ${delay}ms (${allPartialResults.length} partial result(s) so far)`);
    await sleep(delay);
  }

  return buildStructuredError(
    "transient",
    attemptedAction,
    `Failed after ${maxRetries} attempts: ${lastMessage}`,
    ["Try an alternative data source", "Proceed with the partial results already retrieved"],
    allPartialResults,
  );
}

// ---------------------------------------------------------------------------
// Subagent: fast-fail checks (never retried locally) + retried access path
// ---------------------------------------------------------------------------
// Validation/business/permission failures can't be fixed by repeating the
// SAME input, so they skip withRetry entirely and propagate immediately -
// only genuine access attempts (the mocked "network" call) go through it.

const RESTRICTED_TOPICS = new Set(["internal unreleased product roadmap"]);
const CLASSIFIED_TOPICS = new Set(["classified defense energy infrastructure reports"]);

type SubagentOutcome = SearchSuccess | (StructuredError & { shouldRetry: false });

async function searchSubagent(topic: string, query: string, dateRange: DateRange, mode: SearchMode): Promise<SubagentOutcome> {
  const attemptedAction: AttemptedAction = { tool: "search_database", query, parameters: { dateRange } };

  if (dateRange.start > dateRange.end) {
    return {
      ...buildStructuredError(
        "validation",
        attemptedAction,
        `Invalid date range: start (${dateRange.start}) is after end (${dateRange.end}).`,
        ["Swap the start/end dates", "Provide a corrected date range"],
      ),
      shouldRetry: false,
    };
  }
  if (RESTRICTED_TOPICS.has(topic)) {
    return {
      ...buildStructuredError(
        "business",
        attemptedAction,
        `"${topic}" is restricted by data-sharing policy for automated queries.`,
        ["Escalate to a compliance reviewer for topic-specific approval"],
      ),
      shouldRetry: false,
    };
  }
  if (CLASSIFIED_TOPICS.has(topic)) {
    return {
      ...buildStructuredError(
        "permission",
        attemptedAction,
        `Current service account lacks clearance to query "${topic}".`,
        ["Request elevated clearance", "Route the query to a cleared analyst"],
      ),
      shouldRetry: false,
    };
  }

  const outcome = await withRetry(makeSearchDatabase(mode), attemptedAction);
  if (outcome.status === "success") return outcome;
  return { ...outcome, shouldRetry: false };
}

// ---------------------------------------------------------------------------
// Step 4: coordinator recovery decision
// ---------------------------------------------------------------------------

type CoordinatorDecision =
  | { action: "proceed_partial"; data: RetrievedItem[] }
  | { action: "try_alternative"; approach: string }
  | { action: "retry_modified"; modification: string }
  | { action: "fix_query"; details: string }
  | { action: "alert_admin"; details: AttemptedAction }
  | { action: "escalate_human"; context: StructuredError };

function coordinatorRecovery(error: StructuredError): CoordinatorDecision {
  switch (error.failureType) {
    case "transient":
      if (error.partialResults.length >= 3) {
        return { action: "proceed_partial", data: error.partialResults };
      }
      if (error.alternativeApproaches.length > 0) {
        return { action: "try_alternative", approach: error.alternativeApproaches[0] };
      }
      return { action: "retry_modified", modification: "narrower query" };
    case "validation":
      return { action: "fix_query", details: error.message };
    case "permission":
      return { action: "alert_admin", details: error.attemptedAction };
    case "business":
      return { action: "escalate_human", context: error };
  }
}

// ---------------------------------------------------------------------------
// Pipeline: one topic through the subagent, then (on failure) the coordinator
// ---------------------------------------------------------------------------

interface TopicSpec {
  topic: string;
  query: string;
  dateRange: DateRange;
  mode: SearchMode;
}

interface TopicOutcome {
  topic: string;
  finalStatus: "success" | "partial_failure" | "error";
  results: RetrievedItem[];
  message: string;
  coordinatorAction?: CoordinatorDecision["action"];
  recoveryNote?: string;
}

interface TopicRun {
  spec: TopicSpec;
  raw: SubagentOutcome;
  decision?: CoordinatorDecision;
  final: TopicOutcome;
}

const DEFAULT_RANGE: DateRange = { start: "2022-01-01", end: "2024-12-31" };

const TOPICS: TopicSpec[] = [
  { topic: "renewable energy adoption rates", query: "renewable energy adoption rates 2022-2024", dateRange: DEFAULT_RANGE, mode: "success" },
  { topic: "geothermal energy uptake", query: "geothermal energy uptake", dateRange: DEFAULT_RANGE, mode: "empty" },
  { topic: "grid resilience during transient outages", query: "grid resilience transient outages", dateRange: DEFAULT_RANGE, mode: "flaky_recovers" },
  { topic: "EU cross-border energy policy comparisons", query: "EU cross-border energy policy", dateRange: DEFAULT_RANGE, mode: "down_hard" },
  { topic: "historical tariff structures", query: "19th century tariff structures", dateRange: DEFAULT_RANGE, mode: "down_no_partial" },
  {
    topic: "energy policy timeline sanity check",
    query: "energy policy timeline",
    dateRange: { start: "2025-01-01", end: "2020-01-01" }, // deliberately invalid: start after end
    mode: "success",
  },
  { topic: "internal unreleased product roadmap", query: "unreleased product roadmap", dateRange: DEFAULT_RANGE, mode: "success" },
  {
    topic: "classified defense energy infrastructure reports",
    query: "classified defense energy infrastructure",
    dateRange: DEFAULT_RANGE,
    mode: "success",
  },
];

async function resolveTopic(spec: TopicSpec): Promise<TopicRun> {
  const raw = await searchSubagent(spec.topic, spec.query, spec.dateRange, spec.mode);

  if (raw.status === "success") {
    return { spec, raw, final: { topic: spec.topic, finalStatus: "success", results: raw.results, message: raw.message } };
  }

  console.log(`    subagent reported ${raw.status} (${raw.failureType}): ${raw.message}`);
  const decision = coordinatorRecovery(raw);
  console.log(`    coordinator decision: ${decision.action}`);

  switch (decision.action) {
    case "proceed_partial":
      return {
        spec,
        raw,
        decision,
        final: { topic: spec.topic, finalStatus: "partial_failure", results: decision.data, message: raw.message, coordinatorAction: decision.action },
      };

    case "try_alternative": {
      const fallback = await searchSubagent(spec.topic, spec.query, spec.dateRange, "success_fallback");
      if (fallback.status === "success") {
        return {
          spec,
          raw,
          decision,
          final: {
            topic: spec.topic,
            finalStatus: "success",
            results: fallback.results,
            message: fallback.message,
            coordinatorAction: decision.action,
            recoveryNote: `primary source failed - recovered via alternative source ("${decision.approach}")`,
          },
        };
      }
      return {
        spec,
        raw,
        decision,
        final: { topic: spec.topic, finalStatus: "error", results: [], message: raw.message, coordinatorAction: decision.action },
      };
    }

    case "fix_query": {
      // Single reformat attempt, never a loop - if the corrected query still
      // fails, that's a genuinely different problem, not a formatting slip.
      const corrected: DateRange = { start: spec.dateRange.end, end: spec.dateRange.start };
      const retried = await searchSubagent(spec.topic, spec.query, corrected, spec.mode);
      if (retried.status === "success") {
        return {
          spec,
          raw,
          decision,
          final: {
            topic: spec.topic,
            finalStatus: "success",
            results: retried.results,
            message: retried.message,
            coordinatorAction: decision.action,
            recoveryNote: `date range corrected (${corrected.start} to ${corrected.end}) and re-queried`,
          },
        };
      }
      return {
        spec,
        raw,
        decision,
        final: {
          topic: spec.topic,
          finalStatus: "error",
          results: [],
          message: `Corrected query still failed: ${retried.message}`,
          coordinatorAction: decision.action,
        },
      };
    }

    case "alert_admin":
      return {
        spec,
        raw,
        decision,
        final: {
          topic: spec.topic,
          finalStatus: "error",
          results: [],
          message: `Escalated to administrator: ${raw.message}`,
          coordinatorAction: decision.action,
        },
      };

    case "escalate_human":
      return {
        spec,
        raw,
        decision,
        final: {
          topic: spec.topic,
          finalStatus: "error",
          results: [],
          message: `Escalated to human/compliance review: ${raw.message}`,
          coordinatorAction: decision.action,
        },
      };

    case "retry_modified":
      return {
        spec,
        raw,
        decision,
        final: { topic: spec.topic, finalStatus: "error", results: [], message: raw.message, coordinatorAction: decision.action },
      };
  }
}

// ---------------------------------------------------------------------------
// Step 5: coverage annotations on the synthesis output
// ---------------------------------------------------------------------------

type CoverageStatus = "well-supported" | "limited" | "unavailable";

interface CoverageEntry {
  topic: string;
  status: CoverageStatus;
  detail: string;
}

function addCoverageAnnotations(topicOutcomes: TopicOutcome[]): { coverageAnnotations: CoverageEntry[]; caveats: string[] } {
  const coverageAnnotations: CoverageEntry[] = topicOutcomes.map((o) => {
    const note = o.recoveryNote ? ` (${o.recoveryNote})` : "";
    if (o.finalStatus === "success") {
      // A valid empty result is well-supported data, not a gap - the query
      // ran and "no matches" is the answer. Annotating it "unavailable"
      // would be silent suppression's mirror image at the synthesis layer.
      const detail =
        o.results.length > 0 ? `${o.results.length} source(s) retrieved${note}` : `query executed successfully; no matching sources exist${note}`;
      return { topic: o.topic, status: "well-supported", detail };
    }
    if (o.finalStatus === "partial_failure") {
      return { topic: o.topic, status: "limited", detail: `only ${o.results.length} source(s) retrieved before a persistent failure - ${o.message}` };
    }
    return { topic: o.topic, status: "unavailable", detail: o.message };
  });

  const caveats = coverageAnnotations
    .filter((c) => c.status !== "well-supported")
    .map((c) => `Section on "${c.topic}" is ${c.status}: ${c.detail}`);

  return { coverageAnnotations, caveats };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

async function main() {
  console.log("=== Step 1: StructuredError schema ===");
  console.log("  fields: status, failureType, attemptedAction{tool,query,parameters}, partialResults[], alternativeApproaches[], message");

  console.log("\n=== Steps 2-4: per-topic subagent run, then coordinator recovery on failure ===");
  const topicRuns: TopicRun[] = [];
  for (const spec of TOPICS) {
    console.log(`\n-- topic: "${spec.topic}" (mode=${spec.mode}) --`);
    topicRuns.push(await resolveTopic(spec));
  }

  const runFor = (topic: string): TopicRun => {
    const run = topicRuns.find((r) => r.spec.topic === topic);
    if (!run) throw new Error(`No run for topic "${topic}"`);
    return run;
  };

  console.log("\n=== Step 4: coordinator branch coverage (fixture for the no-alternatives default) ===");
  // Our own withRetry always attaches alternativeApproaches, so no live topic
  // reaches retry_modified - this fixture models a subagent that didn't, and
  // proves the coordinator still has a sane default for that case.
  const noAlternativesFixture = buildStructuredError(
    "transient",
    { tool: "search_database", query: "obscure 19th-century tariff schedules", parameters: { dateRange: DEFAULT_RANGE } },
    "Failed after 3 attempts: connection refused",
    [],
    [],
  );
  const fixtureDecision = coordinatorRecovery(noAlternativesFixture);
  console.log(`  transient, 0 partials, 0 alternatives -> ${fixtureDecision.action}`);

  console.log("\n=== Step 5: synthesis coverage annotations ===");
  const topicOutcomes = topicRuns.map((r) => r.final);
  const { coverageAnnotations, caveats } = addCoverageAnnotations(topicOutcomes);
  for (const entry of coverageAnnotations) {
    console.log(`  [${entry.status}] ${entry.topic}: ${entry.detail}`);
  }
  console.log("\n  Caveats section (appended to the synthesis output):");
  console.log(caveats.length > 0 ? caveats.map((c) => `    - ${c}`).join("\n") : "    (none)");

  // --- Acceptance criteria --------------------------------------------------
  console.log("\n=== Acceptance criteria ===");

  const restrictedRun = runFor("internal unreleased product roadmap");
  check(
    "StructuredError carries all four required elements plus status/message",
    restrictedRun.raw.status !== "success" &&
      typeof restrictedRun.raw.failureType === "string" &&
      typeof restrictedRun.raw.attemptedAction.tool === "string" &&
      Array.isArray(restrictedRun.raw.partialResults) &&
      Array.isArray(restrictedRun.raw.alternativeApproaches) &&
      typeof restrictedRun.raw.message === "string",
  );

  const emptyRun = runFor("geothermal energy uptake");
  const accessFailureRun = runFor("historical tariff structures");
  check(
    "a valid empty result (status success, 0 results) is structurally distinct from an access failure (status error, failureType set)",
    emptyRun.raw.status === "success" &&
      emptyRun.raw.results.length === 0 &&
      accessFailureRun.raw.status !== "success" &&
      accessFailureRun.raw.failureType === "transient",
  );

  const flakyRun = runFor("grid resilience during transient outages");
  check(
    "a transient failure that recovers within local retries never reaches the coordinator",
    flakyRun.raw.status === "success" && flakyRun.decision === undefined && flakyRun.raw.results.length === PRIMARY_RESULTS.length,
  );

  const downHardRun = runFor("EU cross-border energy policy comparisons");
  check(
    "partial results accumulate across retry attempts before the exhausted error propagates (2 + 1 + 0 = 3)",
    downHardRun.raw.status !== "success" && downHardRun.raw.partialResults.length === 3,
  );
  check("coordinator proceeds with partial results once >= 3 have been gathered", downHardRun.decision?.action === "proceed_partial");

  check("coordinator tries an alternative source when partials are insufficient but alternatives exist", accessFailureRun.decision?.action === "try_alternative");
  check(
    "the alternative source is actually queried and recovers the topic to success",
    accessFailureRun.final.finalStatus === "success" && accessFailureRun.final.recoveryNote !== undefined,
  );

  const validationRun = runFor("energy policy timeline sanity check");
  check("coordinator asks for the query to be fixed on a validation failure", validationRun.decision?.action === "fix_query");
  check(
    "the corrected query is retried exactly once and succeeds",
    validationRun.final.finalStatus === "success" && validationRun.final.recoveryNote !== undefined,
  );

  const businessRun = runFor("internal unreleased product roadmap");
  check("coordinator escalates a business-rule failure to a human", businessRun.decision?.action === "escalate_human");

  const permissionRun = runFor("classified defense energy infrastructure reports");
  check("coordinator alerts an administrator on a permission failure", permissionRun.decision?.action === "alert_admin");

  check("coordinator falls back to retry_modified when a transient failure has no partials and no alternatives", fixtureDecision.action === "retry_modified");

  check("every topic appears in the coverage annotations - none silently dropped", coverageAnnotations.length === TOPICS.length);

  const geothermalCoverage = coverageAnnotations.find((c) => c.topic === "geothermal energy uptake");
  check(
    "a valid empty result is annotated well-supported, never unavailable (the empty-vs-failure trap, applied at synthesis)",
    geothermalCoverage?.status === "well-supported",
  );

  const businessCoverage = coverageAnnotations.find((c) => c.topic === "internal unreleased product roadmap");
  check(
    "a failed topic is annotated limited/unavailable WITH a reason, never silently omitted",
    (businessCoverage?.status === "unavailable" || businessCoverage?.status === "limited") && (businessCoverage?.detail.length ?? 0) > 0,
  );

  check(
    "the caveats section lists every non-well-supported topic",
    caveats.length === coverageAnnotations.filter((c) => c.status !== "well-supported").length,
  );
}

main().catch(console.error);
