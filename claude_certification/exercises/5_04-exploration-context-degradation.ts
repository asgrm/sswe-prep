// Exercise 5_04 - Extended exploration without context degradation (Task Statement 5.4)
// Run: npx tsx 5_04-exploration-context-degradation.ts
//
// Target codebase: mock-codebase/ (layered order/refund service, ~16 files)
// Work products land in .exploration/ (gitignored) - inspect them after a run.
//
// Steps:
//   1. Coordinator delegating 3 narrow investigations to subagents that each run
//      in their OWN message array; only a structured report_findings payload
//      crosses back. The point is context ISOLATION, not parallelism - verified
//      by a canary line that exists in every subagent context and in none of the
//      coordinator's. Forced tool_choice guarantees the CALL and not a complete
//      payload, so an over-long report truncated mid-JSON (which arrives as {})
//      is detected and re-asked, never silently accepted as "found nothing"
//   2. Scratchpad file: findings written as `## <task>` sections with class names,
//      exact file paths, dependency chains and critical findings - maintained from
//      the first step, and read back instead of re-derived
//   3. Summary injection: a Phase 1 summary (built from the structured findings,
//      never from raw output) injected into every Phase 2 prompt, with a cold-start
//      control run on the same task and no injection at all
//   4. Crash recovery: a manifest written after EVERY subagent (not per phase), a
//      simulated crash mid-Phase-2, then a resume that runs only nextSteps
//   5. Degradation A/B: one 7-module exploration per arm, identical verbose noise,
//      then "list every class you discovered with its exact file path" asked with
//      the source-read tools removed - the scratchpad arm reads its file, the
//      control has only its context

import "dotenv/config";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const CODEBASE_DIR = path.join(import.meta.dirname, "mock-codebase");
const WORK_DIR = path.join(import.meta.dirname, ".exploration");
const SCRATCHPAD_PATH = path.join(WORK_DIR, "exploration-scratchpad.md");
const MANIFEST_PATH = path.join(WORK_DIR, "exploration-manifest.json");
// The degradation arm gets its OWN scratchpad: reading the phase scratchpad
// would hand it findings it never discovered, and the measurement would be void.
const DEGRADATION_SCRATCHPAD_PATH = path.join(WORK_DIR, "degradation-scratchpad.md");

const SESSION_ID = "explore-shop-orders-001";

// ---------------------------------------------------------------------------
// Ground truth (mirrors mock-codebase/ - keep in sync)
// ---------------------------------------------------------------------------
// Authored deliberately, so Step 5's recall can be machine-scored instead of
// eyeballed. Nothing here is ever put in a prompt.

interface ClassFact {
  className: string;
  filePath: string;
  buildTarget: string; // how the build log refers to the module
}

const EXPECTED_CLASSES: ClassFact[] = [
  { className: "OrderRepository", filePath: "src/repos/order.ts", buildTarget: "@shop/orders-repo" },
  { className: "OrderService", filePath: "src/services/order.ts", buildTarget: "@shop/orders-service" },
  { className: "RefundProcessor", filePath: "src/services/refund.ts", buildTarget: "@shop/refunds-service" },
  { className: "PaymentGateway", filePath: "src/gateways/payment.ts", buildTarget: "@shop/gateway-stripe" },
  { className: "TaxClient", filePath: "src/gateways/tax.ts", buildTarget: "@shop/gateway-avalara" },
  { className: "NotificationClient", filePath: "src/gateways/notification.ts", buildTarget: "@shop/gateway-sendgrid" },
  { className: "QueryCache", filePath: "src/lib/query-cache.ts", buildTarget: "@shop/query-cache" },
];

// A line that exists in exactly one source file and that no summary would ever
// reproduce. Its presence marks raw file content; its absence from the
// coordinator's context is the isolation proof in Step 1.
const RAW_CONTENT_CANARY = "expand[]=balance_transaction";

// ---------------------------------------------------------------------------
// Exploration tools over mock-codebase/ - the verbose half of the system
// ---------------------------------------------------------------------------

/** Every path a tool touches is resolved inside CODEBASE_DIR or rejected. */
function resolveInside(relative: string): string {
  const target = path.resolve(CODEBASE_DIR, relative);
  if (target !== CODEBASE_DIR && !target.startsWith(CODEBASE_DIR + path.sep)) {
    throw new Error(`Path escapes the codebase root: ${relative}`);
  }
  return target;
}

async function listFiles(relativeDir: string): Promise<string[]> {
  const root = resolveInside(relativeDir);
  const collected: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else collected.push(path.relative(CODEBASE_DIR, full).split(path.sep).join("/"));
    }
  }
  await walk(root);
  return collected.sort();
}

async function readSourceFile(relative: string): Promise<string> {
  return fs.readFile(resolveInside(relative), "utf-8");
}

/** grep -rn, capped so one broad pattern cannot blow a subagent's context. */
async function searchCode(pattern: string, maxMatches = 40): Promise<string> {
  const regex = new RegExp(pattern, "i");
  const matches: string[] = [];
  for (const file of await listFiles(".")) {
    const content = await readSourceFile(file);
    content.split("\n").forEach((line, index) => {
      if (matches.length < maxMatches && regex.test(line)) {
        matches.push(`${file}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  return matches.length > 0 ? matches.join("\n") : `No matches for /${pattern}/`;
}

// ---------------------------------------------------------------------------
// Step 5 noise source: a plausible build log per module
// ---------------------------------------------------------------------------
// Deterministic (no Math.random) so the two arms see byte-identical noise, and
// deliberately free of source paths and class names - it references only build
// targets and dist/ artefacts, so the control arm cannot recover the ground
// truth from the noise itself.

function readBuildLog(buildTarget: string): string {
  const seed = [...buildTarget].reduce((sum, ch) => sum + ch.charCodeAt(0), 0);
  const pick = (i: number, mod: number) => (seed * 31 + i * 17) % mod;
  const hex = (i: number) => (pick(i, 0xffff) + 0x10000).toString(16).slice(1);

  const lines: string[] = [
    `$ pnpm --filter ${buildTarget} run build`,
    `> ${buildTarget}@2.14.0 build /workspace`,
    `> tsc -b tsconfig.build.json && jest --ci --coverage --coverageReporters=json-summary`,
    "",
    `[tsc] project graph resolved in ${300 + pick(0, 400)}ms`,
    `[tsc] incremental cache: ${900 + pick(1, 90)} files tracked, ${800 + pick(2, 80)} hits, ${pick(3, 40)} misses`,
  ];
  for (let i = 0; i < 14; i++) {
    lines.push(`[tsc] emit dist/chunk-${hex(i)}.js  ${20 + pick(i, 180)}.${pick(i, 9)}kb  (map ${10 + pick(i, 90)}.${pick(i + 1, 9)}kb)`);
  }
  lines.push("", `[eslint] ${pick(4, 6)} warnings, 0 errors`);
  for (let i = 0; i < 8; i++) {
    lines.push(`[eslint] dist/__generated__/client-${pick(i, 50)}.d.ts:${1 + pick(i, 200)}:${1 + pick(i, 40)}  warning  prefer-const`);
  }
  lines.push("", `[jest] running 18 suites with ${2 + pick(5, 6)} workers`);
  for (let i = 0; i < 18; i++) {
    lines.push(`[jest] PASS dist/__generated__/fixtures/case-${String(i).padStart(4, "0")}.spec.js (${(pick(i, 900) / 1000).toFixed(3)} s)`);
  }
  lines.push(
    "",
    `[jest] Tests: 18 passed, 18 total`,
    `[bundle] asset dist/index.js ${100 + pick(6, 400)}.${pick(7, 9)}kb  (gzip ${30 + pick(8, 90)}.${pick(9, 9)}kb)`,
    `[bundle] asset dist/index.js.map ${400 + pick(10, 900)}.${pick(11, 9)}kb`,
    `[deprecation] tslib@2.4.0 -> pin to 2.6.x before the next release train`,
    `[deprecation] node-fetch@2 polyfill is no longer required on node >= 20`,
    `[cache] uploaded ${pick(12, 90)}.${pick(13, 9)}mb to turbo remote cache (key ${hex(14)}${hex(15)})`,
    `Done in ${4 + pick(16, 20)}.${pick(17, 9)}s`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Step 2: scratchpad file management
// ---------------------------------------------------------------------------
// The scratchpad holds names and paths, NOT prose summaries: it exists so a
// later step can recover "OrderRepository at src/repos/order.ts implements
// Repository<Order>" verbatim, which is exactly what a summary erodes.

function scratchpadHeader(title: string): string {
  return `# Exploration Scratchpad - ${title}

Maintained from the FIRST exploration step, not after degradation appears.
Class names and file paths are recorded exactly as found on disk.
`;
}

async function initScratchpad(filePath: string, title: string): Promise<void> {
  await fs.writeFile(filePath, scratchpadHeader(title), "utf-8");
}

// appendFile, not read-then-write: Phase 1 subagents run concurrently, and a
// read-modify-write would silently drop whichever section lost the race.
async function appendScratchpad(filePath: string, section: string): Promise<void> {
  await fs.appendFile(filePath, `\n${section}\n`, "utf-8");
}

async function readScratchpad(filePath: string): Promise<string> {
  return fs.readFile(filePath, "utf-8").catch(() => "(scratchpad is empty)");
}

function formatClassLine(cls: KeyClass): string {
  const implementsPart = cls.implements ? ` implements ${cls.implements}` : "";
  // Direct dependencies are a set, so they are comma-joined; only
  // dependencyChains use " -> ", where the ordering carries meaning.
  const dependsPart = cls.dependencies.length > 0 ? `\n  - Depends on: ${cls.dependencies.join(", ")}` : "";
  return `- Class: \`${cls.className}\` (${cls.filePath})${implementsPart}${dependsPart}`;
}

function formatFindings(module: string, findings: StructuredFindings): string {
  const block = (title: string, items: string[]) => (items.length > 0 ? `\n### ${title}\n${items.map((i) => `- ${i}`).join("\n")}` : "");
  return (
    `## ${module}\n${findings.summary ? `${findings.summary}\n\n` : ""}### Key Classes\n${findings.keyClasses.map(formatClassLine).join("\n") || "- (none reported)"}` +
    block("Dependency Chains", findings.dependencyChains) +
    block("Critical Findings", findings.criticalFindings) +
    block("Explored Paths", findings.exploredPaths) +
    block("Open Questions", findings.openQuestions)
  );
}

// ---------------------------------------------------------------------------
// The structured contract every subagent returns
// ---------------------------------------------------------------------------

interface KeyClass {
  className: string;
  filePath: string;
  implements: string | null;
  dependencies: string[];
}

interface StructuredFindings {
  summary: string;
  keyClasses: KeyClass[];
  dependencyChains: string[];
  criticalFindings: string[];
  exploredPaths: string[];
  openQuestions: string[];
}

const REPORT_FINDINGS_TOOL: Anthropic.Tool = {
  name: "report_findings",
  description: `Return your investigation result to the coordinator and end your run. This is
                the ONLY thing the coordinator sees - it never sees the files you read or the
                searches you ran. Report names, paths and conclusions; never file contents.
                Keep it COMPACT: a long report risks being cut off mid-JSON, which loses the
                whole payload. Two or three sentences of summary, one sentence per finding.`,
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "2-3 sentences answering the task. No code." },
      keyClasses: {
        type: "array",
        description: "Every class relevant to the task, with its exact path as found on disk.",
        items: {
          type: "object",
          properties: {
            className: { type: "string" },
            filePath: { type: "string", description: "Repo-relative, e.g. src/repos/order.ts" },
            implements: { type: ["string", "null"], description: "Interface it implements, or null" },
            dependencies: { type: "array", items: { type: "string" }, description: "Class names it depends on" },
          },
          required: ["className", "filePath", "implements", "dependencies"],
        },
      },
      dependencyChains: {
        type: "array",
        items: { type: "string" },
        description: 'Call chains in order, e.g. "RefundController -> RefundProcessor -> OrderService"',
      },
      criticalFindings: {
        type: "array",
        items: { type: "string" },
        description: "Specific problems, ONE SENTENCE each, naming the class/method involved",
      },
      exploredPaths: { type: "array", items: { type: "string" }, description: "Files you actually opened" },
      openQuestions: { type: "array", items: { type: "string" }, description: "What you could not resolve; empty array if none" },
    },
    required: ["summary", "keyClasses", "dependencyChains", "criticalFindings", "exploredPaths", "openQuestions"],
  },
};

// Prompt-shaped schemas are not enforced, so parse defensively - a missing
// array must not crash the coordinator mid-phase (same idiom as 4_04).
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringField(value: unknown, field: string, fallback = ""): string {
  const raw = asRecord(value)[field];
  return typeof raw === "string" ? raw : fallback;
}

function nullableStringField(value: unknown, field: string): string | null {
  const raw = asRecord(value)[field];
  return typeof raw === "string" && raw.length > 0 ? raw : null;
}

function stringArrayField(value: unknown, field: string): string[] {
  const raw = asRecord(value)[field];
  return Array.isArray(raw) ? raw.filter((item): item is string => typeof item === "string") : [];
}

function parseFindings(input: unknown): StructuredFindings {
  const rawClasses = asRecord(input).keyClasses;
  const keyClasses = (Array.isArray(rawClasses) ? rawClasses : [])
    .map((cls) => ({
      className: stringField(cls, "className"),
      filePath: stringField(cls, "filePath"),
      implements: nullableStringField(cls, "implements"),
      dependencies: stringArrayField(cls, "dependencies"),
    }))
    .filter((cls) => cls.className.length > 0);

  return {
    summary: stringField(input, "summary"),
    keyClasses,
    dependencyChains: stringArrayField(input, "dependencyChains"),
    criticalFindings: stringArrayField(input, "criticalFindings"),
    exploredPaths: stringArrayField(input, "exploredPaths"),
    openQuestions: stringArrayField(input, "openQuestions"),
  };
}

// ---------------------------------------------------------------------------
// Tool definitions handed to subagents
// ---------------------------------------------------------------------------

const LIST_FILES_TOOL: Anthropic.Tool = {
  name: "list_files",
  description: "Recursively list files under a repo-relative directory. Use \".\" for the whole repo.",
  input_schema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] },
};

const READ_FILE_TOOL: Anthropic.Tool = {
  name: "read_file",
  description: "Read one file in full, by repo-relative path.",
  input_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
};

const SEARCH_CODE_TOOL: Anthropic.Tool = {
  name: "search_code",
  description: "Case-insensitive regex search across the repo. Returns up to 40 `path:line: text` matches.",
  input_schema: { type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] },
};

const READ_SCRATCHPAD_TOOL: Anthropic.Tool = {
  name: "read_scratchpad",
  description: `Read the shared exploration scratchpad: class names, exact file paths, dependency
                chains and critical findings recorded by earlier steps. Prefer this over
                re-exploring, and use it whenever you need a name or path you saw before.`,
  input_schema: { type: "object", properties: {}, required: [] },
};

const WRITE_SCRATCHPAD_TOOL: Anthropic.Tool = {
  name: "write_scratchpad",
  description: `Append one module's findings to the scratchpad. Record the class name and file
                path EXACTLY as they appear on disk - this file is what you will read back
                later, so a vague entry is a lost finding.`,
  input_schema: {
    type: "object",
    properties: {
      module: { type: "string", description: "Short label for the module, e.g. \"orders repository\"" },
      className: { type: "string" },
      filePath: { type: "string", description: "Repo-relative, e.g. src/repos/order.ts" },
      implements: { type: ["string", "null"] },
      dependencies: { type: "array", items: { type: "string" } },
      criticalFindings: { type: "array", items: { type: "string" } },
    },
    required: ["module", "className", "filePath", "implements", "dependencies", "criticalFindings"],
  },
};

const READ_BUILD_LOG_TOOL: Anthropic.Tool = {
  name: "read_build_log",
  description: "Read the most recent CI build log for a module's build target, e.g. \"@shop/orders-repo\".",
  input_schema: { type: "object", properties: { buildTarget: { type: "string" } }, required: ["buildTarget"] },
};

const EXPLORATION_TOOLS = [LIST_FILES_TOOL, READ_FILE_TOOL, SEARCH_CODE_TOOL];

// ---------------------------------------------------------------------------
// Model plumbing - block narrowing by type guard, retry as in 4_06/5_01/5_02
// ---------------------------------------------------------------------------

function textOf(response: Anthropic.Message): string {
  return response.content
    .filter((block): block is Anthropic.TextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function toolUsesOf(response: Anthropic.Message): Anthropic.ToolUseBlock[] {
  return response.content.filter((block): block is Anthropic.ToolUseBlock => block.type === "tool_use");
}

const RETRYABLE_ERROR_TYPES = new Set(["overloaded_error", "rate_limit_error", "api_error"]);
const MAX_ATTEMPTS = 4;

interface ModelCall {
  system: string;
  messages: Anthropic.MessageParam[];
  tools?: Anthropic.Tool[];
  toolChoice?: Anthropic.ToolChoice;
  maxTokens?: number;
}

async function callModel({ system, messages, tools, toolChoice, maxTokens = 1024 }: ModelCall): Promise<Anthropic.Message> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await client.messages.create({
        model: MODEL,
        max_tokens: maxTokens,
        system,
        messages,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      });
    } catch (err) {
      const retryable =
        err instanceof Anthropic.APIConnectionError ||
        (err instanceof Anthropic.APIError && typeof err.type === "string" && RETRYABLE_ERROR_TYPES.has(err.type));
      if (!retryable || attempt >= MAX_ATTEMPTS) throw err;
      const delayMs = 2000 * 2 ** (attempt - 1) + Math.random() * 1000;
      const kind = err instanceof Anthropic.APIError ? err.type : "connection error";
      console.warn(`      callModel: ${kind} - retrying (${attempt}/${MAX_ATTEMPTS - 1}) in ${Math.round(delayMs / 1000)}s`);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

// ---------------------------------------------------------------------------
// Tool execution - per-run accounting of everything the agent absorbed
// ---------------------------------------------------------------------------

interface RunState {
  scratchpadPath: string | null;
  toolSequence: string[];
  pathsRead: string[];
  rawBytesAbsorbed: number;
  scratchpadWrites: number;
  scratchpadReads: number;
  sawCanary: boolean;
}

function newRunState(scratchpadPath: string | null): RunState {
  return { scratchpadPath, toolSequence: [], pathsRead: [], rawBytesAbsorbed: 0, scratchpadWrites: 0, scratchpadReads: 0, sawCanary: false };
}

async function executeTool(name: string, input: unknown, state: RunState): Promise<string> {
  state.toolSequence.push(name);
  switch (name) {
    case "list_files":
      return (await listFiles(stringField(input, "dir", "."))).join("\n");
    case "read_file": {
      const relative = stringField(input, "path");
      state.pathsRead.push(relative);
      return readSourceFile(relative);
    }
    case "search_code":
      return searchCode(stringField(input, "pattern"));
    case "read_build_log":
      return readBuildLog(stringField(input, "buildTarget"));
    case "read_scratchpad": {
      if (!state.scratchpadPath) return "No scratchpad is available in this session.";
      state.scratchpadReads++;
      return readScratchpad(state.scratchpadPath);
    }
    case "write_scratchpad": {
      if (!state.scratchpadPath) return "No scratchpad is available in this session.";
      const section = formatFindings(stringField(input, "module"), {
        summary: "",
        keyClasses: [
          {
            className: stringField(input, "className"),
            filePath: stringField(input, "filePath"),
            implements: nullableStringField(input, "implements"),
            dependencies: stringArrayField(input, "dependencies"),
          },
        ],
        dependencyChains: [],
        criticalFindings: stringArrayField(input, "criticalFindings"),
        exploredPaths: [],
        openQuestions: [],
      });
      await appendScratchpad(state.scratchpadPath, section);
      state.scratchpadWrites++;
      return "Appended to the scratchpad.";
    }
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

/** Runs one turn's tool_use blocks and books the bytes they put into context. */
async function runToolBlocks(blocks: Anthropic.ToolUseBlock[], state: RunState): Promise<Anthropic.ToolResultBlockParam[]> {
  return Promise.all(
    blocks.map(async (block): Promise<Anthropic.ToolResultBlockParam> => {
      try {
        const output = await executeTool(block.name, block.input, state);
        state.rawBytesAbsorbed += output.length;
        if (output.includes(RAW_CONTENT_CANARY)) state.sawCanary = true;
        return { type: "tool_result", tool_use_id: block.id, content: output };
      } catch (err) {
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${String(err)}`, is_error: true };
      }
    }),
  );
}

function messageChars(messages: Anthropic.MessageParam[]): number {
  return messages.reduce((sum, m) => sum + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length), 0);
}

/**
 * Adds a user instruction without ever producing two consecutive user messages:
 * if the previous message is already a user turn (a tool_result batch), the text
 * joins it as another block instead of becoming a second user message.
 */
function appendUserText(messages: Anthropic.MessageParam[], text: string): void {
  const last = messages[messages.length - 1];
  if (last?.role === "user" && Array.isArray(last.content)) {
    last.content.push({ type: "text", text });
    return;
  }
  messages.push({ role: "user", content: text });
}

// ---------------------------------------------------------------------------
// Step 1: the exploration subagent - an isolated context that returns a summary
// ---------------------------------------------------------------------------

const SUBAGENT_SYSTEM = `You are a codebase exploration subagent investigating a TypeScript service.

You run in your OWN isolated context. Nothing you read here reaches the coordinator:
the coordinator sees ONLY the report_findings payload you end with. That is the point -
explore as verbosely as you need, then hand back names and conclusions.

Rules:
1. Investigate ONLY your assigned task. Do not map the whole system.
2. Record exact identifiers as they appear on disk: class names, repo-relative file
   paths, interface names, method names. "the repository class" is a failed report;
   "OrderRepository at src/repos/order.ts" is the deliverable.
3. If a read_scratchpad tool is available, call it BEFORE exploring - earlier steps
   already recorded classes, paths and chains, and re-deriving them wastes the run.
4. Finish by calling report_findings exactly once. Never paste file contents, code
   snippets or search output into it, and keep it compact: 2-3 sentences of summary
   and one sentence per finding. An over-long report gets cut off and arrives empty.`;

/** Sent back when a report arrives empty, i.e. the tool_use JSON was truncated. */
const REPORT_REPAIR_HINT = `Your report_findings payload arrived empty - it was cut off before the JSON
closed. Call report_findings again, much shorter: summary at most 2 sentences, one short sentence
per critical finding, and drop anything not needed to answer the task. Keep every class name and
file path exact.`;

const MAX_REPORT_REPAIRS = 2;

interface SubagentSpec {
  name: string;
  task: string;
  /** Phase 1 summary or manifest state. null = cold start, the control condition. */
  injectedContext: string | null;
  tools: Anthropic.Tool[];
  scratchpadPath: string | null;
  maxTurns?: number;
}

interface SubagentRun {
  name: string;
  prompt: string;
  findings: StructuredFindings;
  state: RunState;
  contextChars: number;
  turnsUsed: number;
}

async function spawnSubagent(spec: SubagentSpec): Promise<SubagentRun> {
  // injectedContext, when present, already embeds the task under its own
  // heading (buildPhase2Prompt / buildResumePrompt) - the task text must sit
  // AFTER the context it depends on, not before it.
  const prompt = spec.injectedContext ?? `## Your Task\n${spec.task}`;
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: prompt }];
  const state = newRunState(spec.scratchpadPath);
  const maxTurns = spec.maxTurns ?? 12;
  let repairs = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    // The last two turns force the report so a run can never end without its
    // contract (the 4_03 ladder: auto while working, forced when the step is
    // mandatory) - two, not one, so a truncated report still has a turn to be
    // re-sent in.
    const forceReport = turn >= maxTurns - 2;
    const response = await callModel({
      system: SUBAGENT_SYSTEM,
      messages,
      tools: spec.tools,
      toolChoice: forceReport ? { type: "tool", name: "report_findings", disable_parallel_tool_use: true } : { type: "auto" },
      maxTokens: 4096,
    });

    const toolUses = toolUsesOf(response);
    if (toolUses.length === 0) {
      messages.push({ role: "assistant", content: response.content });
      appendUserText(messages, "Call report_findings now with what you have.");
      continue;
    }

    messages.push({ role: "assistant", content: response.content });

    const report = toolUses.find((block) => block.name === "report_findings");
    if (report) {
      const findings = parseFindings(report.input);
      // Forced tool_choice guarantees the CALL, not a complete payload: a report
      // that hits max_tokens mid-JSON is unparseable, so `input` arrives as {}
      // and every field parses empty. Accepting that silently is how a subagent
      // reports nothing and the coordinator never notices - so repair it.
      const isEmpty = findings.keyClasses.length === 0 && findings.summary === "";
      // Out of repair budget or out of turns: return what we have (loudly) rather
      // than throwing away a whole run's work on the way out.
      if (!isEmpty || repairs >= MAX_REPORT_REPAIRS || turn >= maxTurns - 1) {
        if (isEmpty) {
          console.warn(`      ${spec.name}: report STILL empty after ${repairs} repair attempt(s) (stop_reason=${response.stop_reason})`);
        }
        return { name: spec.name, prompt, findings, state, contextChars: messageChars(messages), turnsUsed: turn + 1 };
      }

      repairs++;
      console.warn(`      ${spec.name}: empty report (stop_reason=${response.stop_reason}) - re-asking, shorter (repair ${repairs}/${MAX_REPORT_REPAIRS})`);
      const otherResults = await runToolBlocks(
        toolUses.filter((block) => block.name !== "report_findings"),
        state,
      );
      messages.push({
        role: "user",
        content: [...otherResults, { type: "tool_result", tool_use_id: report.id, content: REPORT_REPAIR_HINT, is_error: true }],
      });
      continue;
    }

    messages.push({ role: "user", content: await runToolBlocks(toolUses, state) });
  }

  throw new Error(`Subagent "${spec.name}" never called report_findings within ${maxTurns} turns`);
}

// ---------------------------------------------------------------------------
// The coordinator: holds structured summaries and nothing else
// ---------------------------------------------------------------------------

interface InvestigationTask {
  subagent: string;
  task: string;
}

const PHASE1_TASKS: InvestigationTask[] = [
  {
    subagent: "test-coverage",
    task: `Find every test file in this repo and report the coverage status of the modules on the
           order/refund path. coverage/coverage-summary.json holds the last coverage run. Name the
           best-covered and worst-covered module on that path, with exact paths and percentages.`,
  },
  {
    subagent: "refund-flow",
    task: `Trace the refund flow from the HTTP endpoint down to the database. List every
           intermediate class in call order, with its file path, and identify where the request is
           routed and where the composition root wires it together.`,
  },
  {
    subagent: "external-apis",
    task: `Identify every external API integration in this repo. For each: the class, its file
           path, the provider, and its error handling / retry policy. Say explicitly which
           integrations retry and which do not.`,
  },
];

const PHASE2_TASKS: InvestigationTask[] = [
  {
    subagent: "retry-policy",
    task: `Decide where retry and backoff belong on the refund path so a transient failure at the
           payment provider cannot abort an already-validated refund. Name the exact class and
           method to change, and the existing class in this repo whose retry policy should be
           copied.`,
  },
  {
    subagent: "cache-invalidation",
    task: `Audit cache invalidation for order status changes. Name every cache key affected by a
           status write, the exact method that performs the write, and the method that should be
           invalidating them.`,
  },
  {
    subagent: "coverage-gap",
    task: `For the least-covered module on the refund path, propose the minimum set of new tests.
           Name the test file to add and each case, in terms of the actual methods and error types
           in this repo.`,
  },
];

/** What the coordinator retains: one rendered summary per subagent. */
const coordinatorNotes: string[] = [];

async function delegateToSubagent(task: InvestigationTask, spec: Omit<SubagentSpec, "name" | "task">): Promise<SubagentRun> {
  const run = await spawnSubagent({ name: task.subagent, task: task.task, ...spec });
  const section = formatFindings(task.subagent, run.findings);

  // The findings go two places and the raw exploration goes neither: the
  // scratchpad (durable, outside every context) and the coordinator's notes.
  await appendScratchpad(SCRATCHPAD_PATH, section);
  coordinatorNotes.push(section);

  console.log(
    `    <- ${task.subagent}: ${run.findings.keyClasses.length} class(es), ${run.findings.criticalFindings.length} critical finding(s) | ` +
      `${run.state.toolSequence.length} tool call(s), ${run.state.rawBytesAbsorbed} raw byte(s) absorbed in its own context`,
  );
  return run;
}

const SYNTHESIS_SYSTEM = `You are an exploration coordinator. You never read source files yourself - you
receive structured findings from subagents and write the architecture brief.
Preserve every class name and file path exactly as reported. If a fact is not in
the findings you were given, do not state it.`;

async function synthesiseExplorationReport(notes: string[]): Promise<string> {
  const response = await callModel({
    system: SYNTHESIS_SYSTEM,
    messages: [
      {
        role: "user",
        content: `Write a short architecture brief (max 200 words) from these subagent findings.\n\n${notes.join("\n\n")}`,
      },
    ],
    maxTokens: 1024,
  });
  return textOf(response);
}

// ---------------------------------------------------------------------------
// Step 3: Phase 1 summary + injection into Phase 2
// ---------------------------------------------------------------------------

interface Phase1Summary {
  architecture: string;
  dependencyChain: string;
  criticalIssue: string;
  investigationTargets: string[];
}

const SUMMARY_TOOL: Anthropic.Tool = {
  name: "record_phase1_summary",
  description: "Record the Phase 1 summary that will be injected into every Phase 2 subagent prompt.",
  input_schema: {
    type: "object",
    properties: {
      architecture: { type: "string", description: 'One line, e.g. "Layered: Controllers -> Services -> Repositories -> DB"' },
      dependencyChain: { type: "string", description: "The single most important call chain, with real class names" },
      criticalIssue: { type: "string", description: "The most serious concern found, ONE sentence, naming the class and method" },
      investigationTargets: {
        type: "array",
        items: { type: "string" },
        description: "REQUIRED, 2-4 entries. Each a plain string under 15 words naming a class/method Phase 2 should examine.",
      },
    },
    required: ["architecture", "dependencyChain", "criticalIssue", "investigationTargets"],
  },
};

// Input is the structured findings only - never Phase 1's raw exploration. A
// summary built from verbose output would smuggle the verbosity forward.
async function buildPhase1Summary(notes: string[]): Promise<Phase1Summary> {
  const response = await callModel({
    system: "You compress Phase 1 exploration findings into a Phase 2 briefing. Keep every class name and file path exact.",
    messages: [{ role: "user", content: `Phase 1 findings:\n\n${notes.join("\n\n")}\n\nRecord the Phase 1 summary.` }],
    tools: [SUMMARY_TOOL],
    toolChoice: { type: "tool", name: "record_phase1_summary", disable_parallel_tool_use: true },
    maxTokens: 2048,
  });

  const call = toolUsesOf(response).find((block) => block.name === "record_phase1_summary");
  if (!call) throw new Error("Forced tool_choice did not produce record_phase1_summary");
  const summary: Phase1Summary = {
    architecture: stringField(call.input, "architecture"),
    dependencyChain: stringField(call.input, "dependencyChain"),
    criticalIssue: stringField(call.input, "criticalIssue"),
    investigationTargets: stringArrayField(call.input, "investigationTargets"),
  };
  // A `required` field in a JSON Schema is not a guarantee: an empty array
  // satisfies the type and still injects a dangling "Targets:" label into every
  // Phase 2 prompt. Say so loudly rather than shipping a half-empty briefing.
  if (summary.investigationTargets.length === 0) {
    console.warn("  buildPhase1Summary: investigationTargets came back empty - Phase 2 prompts will omit that line");
  }
  return summary;
}

const NO_REEXPLORE_RULE = "Do NOT re-explore already-discovered architecture";

function buildPhase2Prompt(phase1Summary: Phase1Summary, phase2Task: string): string {
  const targetsLine =
    phase1Summary.investigationTargets.length > 0 ? `Targets identified for Phase 2: ${phase1Summary.investigationTargets.join("; ")}\n` : "";
  return (
    `## Context from Phase 1 Exploration\n` +
    `Architecture: ${phase1Summary.architecture}\n` +
    `Key dependency chain: ${phase1Summary.dependencyChain}\n` +
    `Critical concern: ${phase1Summary.criticalIssue}\n` +
    targetsLine +
    `Full Phase 1 detail (classes, paths, chains) is on disk - call read_scratchpad for it.\n\n` +
    `## Your Phase 2 Task\n${phase2Task}\n\n` +
    `Use the Phase 1 context to guide your investigation. ${NO_REEXPLORE_RULE}: open only the ` +
    `files you must read to answer THIS task.`
  );
}

// ---------------------------------------------------------------------------
// Step 4: crash recovery manifest
// ---------------------------------------------------------------------------

interface Manifest {
  sessionId: string;
  phase: number;
  exploredPaths: string[];
  keyFindings: {
    architecture: string;
    dependencyChain: string;
    criticalIssue: string;
    byTask: Record<string, string>;
  };
  completedTasks: string[];
  nextSteps: string[];
  openQuestions: string[];
  lastUpdated: string;
}

let manifestWrites = 0;

function newManifest(): Manifest {
  return {
    sessionId: SESSION_ID,
    phase: 1,
    exploredPaths: [],
    keyFindings: { architecture: "", dependencyChain: "", criticalIssue: "", byTask: {} },
    completedTasks: [],
    nextSteps: PHASE1_TASKS.map((t) => t.subagent),
    openQuestions: [],
    lastUpdated: "",
  };
}

async function saveManifest(manifest: Manifest): Promise<void> {
  manifestWrites++;
  manifest.lastUpdated = new Date().toISOString();
  await fs.writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2), "utf-8");
}

/** Checkpoint after EVERY subagent, not once per phase - a crash costs one step. */
async function checkpoint(manifest: Manifest, run: SubagentRun): Promise<void> {
  manifest.exploredPaths = [...new Set([...manifest.exploredPaths, ...run.findings.exploredPaths, ...run.state.pathsRead])];
  manifest.keyFindings.byTask[run.name] = run.findings.summary;
  manifest.completedTasks = [...new Set([...manifest.completedTasks, run.name])];
  manifest.nextSteps = manifest.nextSteps.filter((step) => step !== run.name);
  manifest.openQuestions = [...new Set([...manifest.openQuestions, ...run.findings.openQuestions])];
  await saveManifest(manifest);
}

async function resumeFromManifest(): Promise<Manifest> {
  const manifest = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf-8")) as Manifest;
  console.log(`  resuming session ${manifest.sessionId} from phase ${manifest.phase}`);
  console.log(`  already explored: ${manifest.exploredPaths.length} path(s)`);
  console.log(`  completed: ${manifest.completedTasks.join(", ") || "(none)"}`);
  console.log(`  next steps: ${manifest.nextSteps.join(", ") || "(none)"}`);
  return manifest;
}

/** Manifest injection - the same mechanism as summary injection, across sessions. */
function buildResumePrompt(manifest: Manifest, task: string): string {
  return (
    `## Recovered Session State (${manifest.sessionId}, phase ${manifest.phase})\n` +
    `Architecture: ${manifest.keyFindings.architecture}\n` +
    `Key dependency chain: ${manifest.keyFindings.dependencyChain}\n` +
    `Critical concern: ${manifest.keyFindings.criticalIssue}\n` +
    `Completed investigations: ${manifest.completedTasks.join(", ")}\n` +
    `Paths already explored (${manifest.exploredPaths.length}): ${manifest.exploredPaths.join(", ")}\n` +
    `Full detail from before the interruption is on disk - call read_scratchpad for it.\n\n` +
    `## Your Task (resumed)\n${task}\n\n` +
    `${NO_REEXPLORE_RULE}: the paths above were already mapped. Open only what THIS task needs.`
  );
}

class SimulatedCrash extends Error {}

// ---------------------------------------------------------------------------
// Step 5: degradation A/B
// ---------------------------------------------------------------------------

const DEGRADATION_SYSTEM_BASE = `You are exploring an unfamiliar TypeScript service module by module.
Each module has a source file and a CI build log. You must be able to name every class you
discover, with its exact repo-relative file path, at the end of the session.`;

const SCRATCHPAD_CLAUSE = `
You maintain a scratchpad file from the very first module - not as a fallback once you start
losing track, but as the plan. After each module, call write_scratchpad with the class name and
its exact file path. Before starting each later module, call read_scratchpad so you can see what
you have already recorded.`;

const RECALL_QUESTION = `Now list EVERY class you discovered in this session. One line per class, exactly:
\`<ClassName>\` - <exact repo-relative file path> - implements <interface or "none"> - depends on <comma-separated class names>
List nothing you cannot name precisely.`;

interface ArmResult {
  arm: string;
  recallResponse: string;
  state: RunState;
  contextChars: number;
  explorationTurns: number;
  /** Scratchpad reads made DURING exploration, excluding the one at recall time. */
  explorationScratchpadReads: number;
}

/**
 * One long exploration in a SINGLE context, then the recall question with the
 * source-read tools removed. That removal is the experiment: at recall time the
 * control has only its context, and the scratchpad arm has a file. Both arms
 * absorb byte-identical build-log noise.
 */
async function exploreModules(useScratchpad: boolean): Promise<ArmResult> {
  const scratchpadPath = useScratchpad ? DEGRADATION_SCRATCHPAD_PATH : null;
  if (scratchpadPath) await initScratchpad(scratchpadPath, "degradation run");

  const state = newRunState(scratchpadPath);
  const explorationTools = useScratchpad
    ? [READ_FILE_TOOL, READ_BUILD_LOG_TOOL, WRITE_SCRATCHPAD_TOOL, READ_SCRATCHPAD_TOOL]
    : [READ_FILE_TOOL, READ_BUILD_LOG_TOOL];
  const system = DEGRADATION_SYSTEM_BASE + (useScratchpad ? SCRATCHPAD_CLAUSE : "");

  const walkthrough = EXPECTED_CLASSES.map((fact, i) => `${i + 1}. ${fact.filePath} (build target ${fact.buildTarget})`).join("\n");
  // The scratchpad arm gets an explicit per-module protocol: write after every
  // module, and read back before recording the next one. "Keep a scratchpad"
  // alone gets written-once-never-read, which is only half the mechanism.
  const protocol = useScratchpad
    ? `For each module, in order:\n` +
      `  a. call read_file on its source file and read_build_log on its build target (same turn is fine)\n` +
      `  b. in your next turn, call write_scratchpad for that module\n` +
      `  c. from module 2 onwards, call read_scratchpad in that same turn as (b), so you always see\n` +
      `     what you have already recorded before adding to it\n`
    : `For each module, in order: call read_file on its source file and read_build_log on its build target (same turn is fine).\n`;
  const messages: Anthropic.MessageParam[] = [
    {
      role: "user",
      content:
        `Explore these ${EXPECTED_CLASSES.length} modules, in this order:\n${walkthrough}\n\n` +
        `${protocol}\nWhen every module is done, reply with the single word DONE.`,
    },
  ];

  const maxTurns = useScratchpad ? 26 : 18;
  let explorationTurns = 0;

  for (let turn = 0; turn < maxTurns; turn++) {
    const response = await callModel({ system, messages, tools: explorationTools, toolChoice: { type: "auto" }, maxTokens: 1024 });
    explorationTurns = turn + 1;
    const toolUses = toolUsesOf(response);
    messages.push({ role: "assistant", content: response.content });
    if (toolUses.length === 0) break; // reached DONE
    messages.push({ role: "user", content: await runToolBlocks(toolUses, state) });
  }

  const explorationScratchpadReads = state.scratchpadReads;
  console.log(
    `    ${useScratchpad ? "with scratchpad" : "control"}: ${explorationTurns} turn(s), ${state.pathsRead.length} file read(s), ` +
      `${state.rawBytesAbsorbed} byte(s) of tool output in context, ${state.scratchpadWrites} scratchpad write(s), ` +
      `${explorationScratchpadReads} scratchpad read(s) during exploration`,
  );

  // Recall time: read_file and read_build_log are gone, so neither arm can go
  // back to the source. Both arms keep the SAME tool surface - read_scratchpad -
  // so the only difference is whether a scratchpad exists behind it: the
  // treatment's call returns its file, the control's returns nothing.
  appendUserText(messages, RECALL_QUESTION);

  let recallResponse = "";
  for (let turn = 0; turn < 4 && recallResponse === ""; turn++) {
    const response = await callModel({
      system,
      messages,
      tools: [READ_SCRATCHPAD_TOOL],
      toolChoice: { type: "auto" },
      maxTokens: 2048,
    });
    messages.push({ role: "assistant", content: response.content });
    const toolUses = toolUsesOf(response);
    if (toolUses.length === 0) recallResponse = textOf(response);
    else messages.push({ role: "user", content: await runToolBlocks(toolUses, state) });
  }
  if (recallResponse === "") console.warn("    recall turn produced no text answer - recall scores below are vacuous");

  return {
    arm: useScratchpad ? "with-scratchpad" : "control",
    recallResponse,
    state,
    contextChars: messageChars(messages),
    explorationTurns,
    explorationScratchpadReads,
  };
}

function measureSpecificity(response: string): { specificRefs: number; genericRefs: number; ratio: number } {
  const specificRefs = (response.match(/[\w./-]+\.ts\b/g) ?? []).length;
  const genericRefs = (response.match(/typical|standard|common pattern|usual pattern|some kind of|a repository class/gi) ?? []).length;
  return { specificRefs, genericRefs, ratio: specificRefs / (genericRefs + 1) };
}

/** A class counts as recalled only when ONE line carries both its name and its exact path. */
function measureRecall(response: string): { recalled: ClassFact[]; missed: ClassFact[] } {
  const lines = response.split("\n");
  const recalled = EXPECTED_CLASSES.filter((fact) => lines.some((line) => line.includes(fact.className) && line.includes(fact.filePath)));
  return { recalled, missed: EXPECTED_CLASSES.filter((fact) => !recalled.includes(fact)) };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

function check(label: string, ok: boolean): void {
  console.log(`  ${ok ? "PASS" : "FAIL"}: ${label}`);
}

function pairsInScratchpad(scratchpad: string): ClassFact[] {
  const lines = scratchpad.split("\n");
  return EXPECTED_CLASSES.filter((fact) => lines.some((line) => line.includes(fact.className) && line.includes(fact.filePath)));
}

async function main() {
  await fs.rm(WORK_DIR, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  await initScratchpad(SCRATCHPAD_PATH, "shop-orders");

  const manifest = newManifest();
  await saveManifest(manifest);

  // --- Steps 1 & 2 ----------------------------------------------------------
  console.log("=== Steps 1 & 2: coordinator delegates Phase 1, findings land in the scratchpad ===");
  for (const task of PHASE1_TASKS) {
    console.log(`  -> spawn ${task.subagent}`);
  }
  const phase1Runs = await Promise.all(
    PHASE1_TASKS.map((task) =>
      delegateToSubagent(task, {
        injectedContext: null,
        tools: [...EXPLORATION_TOOLS, REPORT_FINDINGS_TOOL],
        scratchpadPath: SCRATCHPAD_PATH,
      }),
    ),
  );
  for (const run of phase1Runs) await checkpoint(manifest, run);

  const phase1RawBytes = Math.max(1, phase1Runs.reduce((sum, run) => sum + run.state.rawBytesAbsorbed, 0));
  const coordinatorChars = coordinatorNotes.join("\n").length;
  console.log(`\n  context isolation:`);
  console.log(`    raw bytes absorbed by subagent contexts: ${phase1RawBytes}`);
  console.log(`    bytes retained in the coordinator context: ${coordinatorChars}`);
  console.log(`    coordinator holds ${((coordinatorChars / phase1RawBytes) * 100).toFixed(1)}% of what was read`);

  console.log("\n  scratchpad after Phase 1:");
  const scratchpadAfterPhase1 = await readScratchpad(SCRATCHPAD_PATH);
  console.log(
    scratchpadAfterPhase1
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
  );

  // --- Step 3 ---------------------------------------------------------------
  console.log("=== Step 3: Phase 1 summary, built from the structured findings only ===");
  const phase1Summary = await buildPhase1Summary(coordinatorNotes);
  console.log(`  architecture:  ${phase1Summary.architecture}`);
  console.log(`  chain:         ${phase1Summary.dependencyChain}`);
  console.log(`  criticalIssue: ${phase1Summary.criticalIssue}`);
  console.log(`  targets:       ${phase1Summary.investigationTargets.join("; ")}`);

  manifest.phase = 2;
  manifest.keyFindings.architecture = phase1Summary.architecture;
  manifest.keyFindings.dependencyChain = phase1Summary.dependencyChain;
  manifest.keyFindings.criticalIssue = phase1Summary.criticalIssue;
  manifest.nextSteps = PHASE2_TASKS.map((t) => t.subagent);
  await saveManifest(manifest);

  // --- Step 4: Phase 2, interrupted after the first subagent ----------------
  console.log("\n=== Step 4: Phase 2 with injection, crashing after the first subagent ===");
  const phase2Runs: SubagentRun[] = [];
  try {
    for (const task of PHASE2_TASKS) {
      console.log(`  -> spawn ${task.subagent} (Phase 1 summary injected)`);
      const run = await delegateToSubagent(task, {
        injectedContext: buildPhase2Prompt(phase1Summary, task.task),
        tools: [...EXPLORATION_TOOLS, READ_SCRATCHPAD_TOOL, REPORT_FINDINGS_TOOL],
        scratchpadPath: SCRATCHPAD_PATH,
      });
      phase2Runs.push(run);
      await checkpoint(manifest, run);
      if (phase2Runs.length === 1) throw new SimulatedCrash("process killed mid-phase-2");
    }
  } catch (err) {
    if (!(err instanceof SimulatedCrash)) throw err;
    console.log(`  !! ${err.message} - in-context state is gone; the manifest on disk is not`);
  }

  const manifestAtCrash = JSON.parse(await fs.readFile(MANIFEST_PATH, "utf-8")) as Manifest;
  const nextStepsAtCrash = [...manifestAtCrash.nextSteps];

  console.log("\n  resume from the manifest (fresh coordinator, nothing in context):");
  const resumed = await resumeFromManifest();
  const remainingTasks = PHASE2_TASKS.filter((task) => resumed.nextSteps.includes(task.subagent));
  const resumedRuns = await Promise.all(
    remainingTasks.map((task) =>
      delegateToSubagent(task, {
        injectedContext: buildResumePrompt(resumed, task.task),
        tools: [...EXPLORATION_TOOLS, READ_SCRATCHPAD_TOOL, REPORT_FINDINGS_TOOL],
        scratchpadPath: SCRATCHPAD_PATH,
      }),
    ),
  );
  for (const run of resumedRuns) await checkpoint(resumed, run);
  resumed.phase = 3;
  await saveManifest(resumed);

  // --- Step 3 control: same task, no Phase 1 context at all -----------------
  console.log("\n=== Step 3 control: the same Phase 2 task cold-started (no injection, no scratchpad) ===");
  const coldStart = await spawnSubagent({
    name: "retry-policy-cold-start",
    task: PHASE2_TASKS[0].task,
    injectedContext: null,
    tools: [...EXPLORATION_TOOLS, REPORT_FINDINGS_TOOL],
    scratchpadPath: null,
  });
  const injected = phase2Runs[0];
  console.log(`    injected:   ${injected.state.toolSequence.length} tool call(s), ${injected.state.pathsRead.length} file read(s), ${injected.state.rawBytesAbsorbed} raw byte(s)`);
  console.log(`    cold start: ${coldStart.state.toolSequence.length} tool call(s), ${coldStart.state.pathsRead.length} file read(s), ${coldStart.state.rawBytesAbsorbed} raw byte(s)`);

  // --- Coordinator synthesis ------------------------------------------------
  console.log("\n=== Coordinator synthesis (from summaries only - it never read a file) ===");
  const brief = await synthesiseExplorationReport(coordinatorNotes);
  console.log(
    brief
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  // --- Step 5 ---------------------------------------------------------------
  console.log(`\n=== Step 5: degradation A/B over ${EXPECTED_CLASSES.length} modules ===`);
  const control = await exploreModules(false);
  const treatment = await exploreModules(true);

  const controlRecall = measureRecall(control.recallResponse);
  const treatmentRecall = measureRecall(treatment.recallResponse);
  const controlSpecificity = measureSpecificity(control.recallResponse);
  const treatmentSpecificity = measureSpecificity(treatment.recallResponse);

  const arms = [
    { arm: "control (no scratchpad)", result: control, recall: controlRecall, specificity: controlSpecificity },
    { arm: "with scratchpad", result: treatment, recall: treatmentRecall, specificity: treatmentSpecificity },
  ];
  for (const { arm, result, recall, specificity } of arms) {
    console.log(`\n  -- ${arm} --`);
    console.log(`    class+path recall: ${recall.recalled.length}/${EXPECTED_CLASSES.length}`);
    if (recall.missed.length > 0) {
      console.log(`    missed: ${recall.missed.map((f) => `${f.className} (${f.filePath})`).join(", ")}`);
    }
    console.log(`    specificity: ${specificity.specificRefs} .ts reference(s), ${specificity.genericRefs} generic phrase(s), ratio ${specificity.ratio.toFixed(2)}`);
    console.log(`    ${result.explorationTurns} exploration turn(s), ${result.contextChars} char(s) of context at recall time`);
    console.log(
      result.recallResponse
        .split("\n")
        .map((line) => `      ${line}`)
        .join("\n"),
    );
  }

  // --- Acceptance criteria --------------------------------------------------
  console.log("\n=== Acceptance criteria ===");

  check(
    "every Phase 1 subagent returned structured findings with exact class names and file paths",
    phase1Runs.every((run) => run.findings.keyClasses.length > 0 && run.findings.keyClasses.every((c) => c.className.length > 0 && c.filePath.includes("/"))),
  );
  check(
    "the canary line was really absorbed by a subagent context, so the coordinator check below is not vacuous",
    phase1Runs.some((run) => run.state.sawCanary),
  );
  check(
    "no raw file content crossed into the coordinator - canary absent from notes, summary and brief",
    ![...coordinatorNotes, JSON.stringify(phase1Summary), brief].some((text) => text.includes(RAW_CONTENT_CANARY)),
  );
  check(
    `coordinator retained under 25% of the bytes its subagents read (${((coordinatorChars / phase1RawBytes) * 100).toFixed(1)}%)`,
    coordinatorChars < phase1RawBytes * 0.25,
  );

  const scratchpad = await readScratchpad(SCRATCHPAD_PATH);
  const scratchpadPairs = pairsInScratchpad(scratchpad);
  check(
    `scratchpad pairs class names with exact file paths (${scratchpadPairs.length}/${EXPECTED_CLASSES.length} ground-truth classes; >= 4 required)`,
    scratchpadPairs.length >= 4,
  );
  check(
    "scratchpad records dependency chains and critical findings as sections, not prose",
    scratchpad.includes("### Dependency Chains") && scratchpad.includes("### Critical Findings") && /->/.test(scratchpad),
  );
  check(
    "the scratchpad was written from the first step, before any degradation could appear",
    scratchpad.includes(`## ${PHASE1_TASKS[0].subagent}`) || scratchpad.includes(`## ${PHASE1_TASKS[1].subagent}`),
  );

  check(
    "the Phase 2 prompt carries architecture, dependency chain, critical concern and the do-not-re-explore rule",
    [phase1Summary.architecture, phase1Summary.dependencyChain, phase1Summary.criticalIssue, NO_REEXPLORE_RULE].every((fragment) =>
      injected.prompt.includes(fragment),
    ),
  );
  check(
    "the Phase 1 summary was derived from structured findings, and names real classes from this repo",
    EXPECTED_CLASSES.some((fact) => phase1Summary.dependencyChain.includes(fact.className) || phase1Summary.criticalIssue.includes(fact.className)),
  );
  // Directional, not absolute: a Phase 2 agent still opens the files it must
  // change. What injection removes is the rediscovery of the architecture.
  check(
    `injected Phase 2 agent explored no more than the cold-start control (${injected.state.toolSequence.length} vs ${coldStart.state.toolSequence.length} tool calls)`,
    injected.state.toolSequence.length <= coldStart.state.toolSequence.length,
  );
  check(
    "the cold-start control had to rediscover the architecture it was never told (>= 3 files read)",
    coldStart.state.pathsRead.length >= 3,
  );

  check(
    `manifest checkpointed after every subagent, not once per phase (${manifestWrites} writes for ${phase1Runs.length + phase2Runs.length + resumedRuns.length} subagents)`,
    manifestWrites >= phase1Runs.length + phase2Runs.length + resumedRuns.length,
  );
  check(
    "the manifest carried session id, phase, explored paths, key findings and next steps across the crash",
    manifestAtCrash.sessionId === SESSION_ID &&
      manifestAtCrash.phase === 2 &&
      manifestAtCrash.exploredPaths.length > 0 &&
      manifestAtCrash.keyFindings.architecture.length > 0 &&
      manifestAtCrash.nextSteps.length > 0,
  );
  check(
    `the resumed session ran exactly the pre-crash nextSteps and re-ran nothing (${resumedRuns.map((r) => r.name).join(", ")})`,
    resumedRuns.length === nextStepsAtCrash.length &&
      resumedRuns.every((run) => nextStepsAtCrash.includes(run.name)) &&
      !resumedRuns.some((run) => manifestAtCrash.completedTasks.includes(run.name)),
  );
  check(
    "resumed subagents received the recovered state, not a blank prompt",
    resumedRuns.every((run) => run.prompt.includes(SESSION_ID) && run.prompt.includes(NO_REEXPLORE_RULE)),
  );
  check(
    "every Phase 1 and Phase 2 task appears in the final manifest with no open next steps",
    resumed.nextSteps.length === 0 &&
      [...PHASE1_TASKS, ...PHASE2_TASKS].every((task) => resumed.completedTasks.includes(task.subagent)),
  );

  const degradationScratchpad = await readScratchpad(DEGRADATION_SCRATCHPAD_PATH);
  check(
    `the degradation-run scratchpad holds specific class+path pairs (${pairsInScratchpad(degradationScratchpad).length}/${EXPECTED_CLASSES.length}; >= 6 required)`,
    pairsInScratchpad(degradationScratchpad).length >= 6,
  );
  check(
    `the scratchpad arm wrote after each module (${treatment.state.scratchpadWrites} writes; >= ${EXPECTED_CLASSES.length - 1} required)`,
    treatment.state.scratchpadWrites >= EXPECTED_CLASSES.length - 1,
  );
  check(
    `the scratchpad arm read it back DURING exploration, not only at recall ` +
      `(${treatment.explorationScratchpadReads} of ${EXPECTED_CLASSES.length - 1} possible pre-module reads; >= 3 required)`,
    treatment.explorationScratchpadReads >= 3,
  );
  check("the control never touched a scratchpad, in exploration or at recall", control.state.scratchpadReads === 0 && control.state.scratchpadWrites === 0);
  const readEveryModule = (state: RunState) => EXPECTED_CLASSES.every((fact) => state.pathsRead.includes(fact.filePath));
  check(
    "both arms walked all 7 modules and absorbed the same build-log noise, so the scratchpad is the only variable",
    readEveryModule(control.state) && readEveryModule(treatment.state),
  );
  check(
    `the scratchpad arm named ${treatmentRecall.recalled.length}/${EXPECTED_CLASSES.length} classes with exact paths (>= 6 required)`,
    treatmentRecall.recalled.length >= 6,
  );
  // Directional by design: at 7 small modules the control may still hold on.
  // The claim under test is that the file-backed arm never does worse, because
  // its recall does not depend on context at all.
  check(
    `the scratchpad arm recalled at least as many class+path pairs as the control (${treatmentRecall.recalled.length} vs ${controlRecall.recalled.length})`,
    treatmentRecall.recalled.length >= controlRecall.recalled.length,
  );

  console.log("\n  Note on Step 5: a 7-module run is short enough that the control arm may still");
  console.log("  recall everything. Degradation is a function of accumulated verbose output, so a");
  console.log("  real session degrades much later than this - what the A/B fixes in place is that");
  console.log("  the scratchpad arm's recall does not depend on context at all. Raise the module");
  console.log("  count or the build-log size to push the control past its limit.");
  console.log(`\n  Work products: ${path.relative(import.meta.dirname, SCRATCHPAD_PATH)}, ${path.relative(import.meta.dirname, MANIFEST_PATH)}, ${path.relative(import.meta.dirname, DEGRADATION_SCRATCHPAD_PATH)}`);
}

main().catch(console.error);
