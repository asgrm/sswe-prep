// Exercise 03 - Subagent invocation & context passing (Claude Agent SDK)
// Run: npx tsx 1_03-subagent-context-passing.ts
//
// Unlike exercise 02, the coordinator loop is not hand-written: the SDK supplies
// the harness and the coordinator MODEL decides delegation via Task/Agent tool
// calls. Our code = configuration + stream observer + deterministic verification.

import "dotenv/config";
import {
  query,
  type AgentDefinition,
  type Query,
  type SDKAssistantMessage,
} from "@anthropic-ai/claude-agent-sdk";

/** tool_use member of the assistant content-block union (for filter narrowing). */
type SpawnBlock = Extract<
  SDKAssistantMessage["message"]["content"][number],
  { type: "tool_use" }
>;

// ---------------------------------------------------------------------------
// Criterion 3: the Finding contract - content (claim) separated from citation
// metadata. AgentDefinition has no outputFormat field, so the schema is
// prompt-enforced (FINDINGS_FORMAT) and verified by our code afterwards.
// ---------------------------------------------------------------------------

interface Finding {
  claim: string;
  source_url: string | null; // null for document findings
  document_name: string | null; // null for web findings
  page_number: number | null;
  confidence: "high" | "medium" | "low";
  retrieved_by: string;
}

interface ResearchOutput {
  findings: Finding[];
  query: string;
}

/** Shared output-format instruction embedded in both research subagent prompts. */
const FINDINGS_FORMAT = `Return your results as a JSON code block with this exact shape:
                         {"findings": [{"claim": "...", "source_url": "... or null", "document_name": "... or null", "page_number": 14 or null, "confidence": "high|medium|low", "retrieved_by": "<your agent name>"}], "query": "<what you researched>"}
                         Every finding MUST carry its attribution metadata - a claim without a source is useless downstream.`;

// ---------------------------------------------------------------------------
// Criterion 2: AgentDefinitions - description (invocation trigger), prompt,
// tools (least privilege; omitting tools would inherit EVERYTHING).
// ---------------------------------------------------------------------------

const agents: Record<string, AgentDefinition> = {
  "web-search": {
    description:
      "Searches the web for current information and returns structured findings with source URLs and titles",
    prompt: `You are a web research specialist. Search the web for the topic you are given.
             Run AT MOST 2 web searches, then write your findings - 6-10 findings is sufficient. Prefer speed over exhaustiveness.
             ${FINDINGS_FORMAT}
             Use retrieved_by: "web-search". Set source_url for every finding; leave document_name and page_number null.`,
    tools: ["WebSearch"],
    // Speed: the prompt limit above is the primary control; maxTurns is only a safety net
    maxTurns: 8,
    effort: "low",
  },
  "doc-analysis": {
    description:
      "Analyses local documents and returns structured findings with document names and page references",
    prompt: `You are a document analysis specialist. Read and analyse the document(s) you are pointed at.
             ${FINDINGS_FORMAT}
             Use retrieved_by: "doc-analysis". Set document_name (the report title) and page_number (from the page markers) for every finding; leave source_url null.`,
    tools: ["Read", "Grep"],
    maxTurns: 6, // safety net; one Read + findings is the expected shape
    effort: "low",
  },
  synthesis: {
    description:
      "Synthesises structured findings from other agents into a cited research report",
    prompt: `You are a synthesis specialist. You receive structured findings (claims with attribution metadata) and write a research report.
             EVERY factual claim in your report must carry an inline citation: the source_url for web findings, or "document_name, p. N" for document findings.
             You can only cite sources present in the findings you were given - never invent attribution.`,
    tools: [], // writes only; explicit empty list, NOT omission (= inherit all)
  },
};

// ---------------------------------------------------------------------------
// Criterion 1: "Agent" in allowedTools is the binary spawn gate (exam name:
// "Task"). Two distinct mechanisms: allowedTools = session-wide permission
// auto-approval; an agent's tools field = per-subagent capability scoping.
// ---------------------------------------------------------------------------

const COORDINATOR_SYSTEM_PROMPT = `You are a research coordinator. You do not research anything yourself - you delegate
                                   to specialist subagents and synthesise their output.
                                   Rules:
                                   1. Delegate to the web-search and doc-analysis agents. Their tasks are independent - invoke BOTH in parallel in a single turn, never one after the other. Always invoke subagents with run_in_background: false - you need their full results in the tool result before you can continue.
                                   2. Pass each subagent everything it needs: the topic, where to look, and the expected output format. Subagents see nothing you do not put in their prompt.
                                   3. Pass the COMPLETE structured findings JSON from both research agents to the synthesis agent verbatim - all metadata fields intact. Never strip, summarise, or re-word the findings.
                                   4. State goals and quality criteria in subagent prompts, not step-by-step procedures.
                                   5. Your final message must be the synthesis agent's cited report.`;

const RESEARCH_PROMPT = `Research topic: the current state of solar photovoltaic technology (efficiency, costs, deployment).
                         Use the web-search agent for current information, and the doc-analysis agent on the local file data/solar-industry-report.md.
                         Produce a cited research report.`;

// ---------------------------------------------------------------------------
// Stream observer - the hub's observability point: logs spawns, captures
// findings from Agent tool results, detects parallel spawning, collects the
// final report.
// ---------------------------------------------------------------------------

interface ObservedRun {
  report: string;
  findings: Finding[];
  parallelSpawnDetected: boolean;
}

/** tool_result content arrives as a plain string or an array of content blocks. */
function extractResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: "text"; text: string } =>
          b?.type === "text" && typeof b.text === "string",
      )
      .map((b) => b.text)
      .join("\n");
  }
  return "";
}

/** Parses the findings JSON a research subagent returns. Prompt contracts are
 *  not schema-enforced, so parse defensively - failure = violated contract. */
function parseFindings(text: string, from: string): Finding[] {
  // Prefer a fenced ```json block; fall back to the outermost {...} span.
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)?.[1];
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  const candidate = fenced ?? (start >= 0 && end > start ? text.slice(start, end + 1) : text);

  try {
    const parsed = JSON.parse(candidate) as ResearchOutput;
    if (!Array.isArray(parsed.findings)) {
      console.warn(`[hub] parsed JSON from ${from} has no findings array. Raw text was:\n----------\n${text}\n----------`);
      return [];
    }
    console.log(`[hub] captured ${parsed.findings.length} findings from ${from}`);
    return parsed.findings;
  } catch {
    console.warn(`[hub] could not parse findings JSON from ${from}. Raw text was:\n----------\n${text}\n----------`);
    return [];
  }
}

async function observeStream(run: Query): Promise<ObservedRun> {
  const findings: Finding[] = [];
  let report = "";
  let parallelSpawnDetected = false;
  // spawn tool_use id -> subagent name (attributes results and inner activity)
  const spawns = new Map<string, string>();
  // Spawns per API message id: the SDK may emit one response's blocks as
  // separate stream events, so parallelism must be counted per message id.
  const spawnsPerApiMessage = new Map<string, number>();

  for await (const message of run) {
    if (message.type === "assistant") {
      // parent_tool_use_id set = emitted from INSIDE a subagent - log its tool
      // activity, but exclude it from spawn/parallelism detection.
      if (message.parent_tool_use_id) {
        const agentName = spawns.get(message.parent_tool_use_id) ?? "subagent";
        for (const block of message.message.content) {
          if (block.type === "tool_use") {
            console.log(`  [${agentName}] uses ${block.name}`);
          }
        }
        continue;
      }

      // Current SDK emits "Agent"; older versions emitted "Task" - match both.
      const spawnBlocks = message.message.content.filter(
        (b): b is SpawnBlock =>
          b.type === "tool_use" && (b.name === "Agent" || b.name === "Task"),
      );
      for (const block of spawnBlocks) {
        const input = block.input as { subagent_type?: string; prompt?: string };
        spawns.set(block.id, input.subagent_type ?? "unknown");
        console.log(`[hub] spawn -> ${input.subagent_type}: "${String(input.prompt).slice(0, 120)}..."`);
      }
      // Criterion 6: parallel = 2+ spawns sharing one API message id
      if (spawnBlocks.length > 0) {
        const apiMessageId = message.message.id;
        const total = (spawnsPerApiMessage.get(apiMessageId) ?? 0) + spawnBlocks.length;
        spawnsPerApiMessage.set(apiMessageId, total);
        if (total >= 2 && !parallelSpawnDetected) {
          parallelSpawnDetected = true;
          console.log(`[hub] PARALLEL spawn detected: ${total} Agent calls in one coordinator response`);
        }
      }
    } else if (message.type === "user") {
      // Subagent results come back as tool_result blocks on user messages.
      if (message.parent_tool_use_id) continue;
      const content = message.message.content;
      if (typeof content === "string") continue;
      for (const block of content) {
        if (block.type === "tool_result" && spawns.has(block.tool_use_id)) {
          const agentName = spawns.get(block.tool_use_id)!;
          const text = extractResultText(block.content);
          // Background spawns (SDK default) return a launch ack, not the final
          // message; the coordinator prompt requests foreground - stay defensive.
          if (text.startsWith("Async agent launched")) {
            console.log(`[hub] background launch ack <- ${agentName} (no findings in this result)`);
            continue;
          }
          console.log(`[hub] result <- ${agentName}`);
          // synthesis returns prose, not findings JSON
          if (agentName !== "synthesis") {
            findings.push(...parseFindings(text, agentName));
          }
        }
      }
    } else if (message.type === "result") {
      if (message.subtype === "success") {
        report = message.result;
      } else {
        console.warn(`[hub] run ended without success: ${message.subtype}`);
      }
    }
  }

  return { report, findings, parallelSpawnDetected };
}

// ---------------------------------------------------------------------------
// Criterion 5: deterministic citation verification - an uncited finding points
// at coordinator context passing, never at the synthesis prompt.
// ---------------------------------------------------------------------------

/** Positive-polarity check: does the report properly attribute this finding? */
function isCited(report: string, normalizedReport: string, finding: Finding): boolean {
  // Web finding: cited when its URL appears in the report (trailing slash tolerated)
  if (finding.source_url) {
    const url = finding.source_url.toLowerCase().replace(/\/+$/, "");
    return normalizedReport.includes(url);
  }
  // Document finding: name must appear, plus a "p. N" reference when captured
  if (finding.document_name) {
    if (!normalizedReport.includes(finding.document_name.toLowerCase())) {
      return false;
    }
    if (finding.page_number != null) {
      const pageRef = new RegExp(`(p\\.?|page)\\s*${finding.page_number}\\b`, "i");
      return pageRef.test(report);
    }
    return true;
  }
  // No attribution anchor at all - can never be cited
  return false;
}

function verifyCitations(report: string, findings: Finding[]): Finding[] {
  // Deliberately naive substring checks - deterministic code verifying LLM
  // output; a production verifier would match semantically.
  const normalizedReport = report.toLowerCase();
  // Returns the UNCITED findings - the single negation lives here
  return findings.filter((finding) => !isCited(report, normalizedReport, finding));
}

// ---------------------------------------------------------------------------
// Test run
// ---------------------------------------------------------------------------

const run = query({
  prompt: RESEARCH_PROMPT,
  options: {
    model: "claude-sonnet-5", // exercises convention; subagents inherit
    systemPrompt: COORDINATOR_SYSTEM_PROMPT,
    agents,
    // "Agent" = spawn gate; the rest auto-approve subagent tools headlessly
    allowedTools: ["Agent", "WebSearch", "Read", "Grep"],
  },
});

/** The anchor verifyCitations looked for - printed per uncited finding. */
function expectedAnchor(f: Finding): string {
  if (f.source_url) return f.source_url;
  if (f.document_name) {
    return f.page_number != null ? `"${f.document_name}", p. ${f.page_number}` : `"${f.document_name}"`;
  }
  return "(no attribution anchor at all)";
}

const observed = await observeStream(run);
const uncited = verifyCitations(observed.report, observed.findings);

console.log(`\n--- Report ---`);
console.log(observed.report);

console.log(`\n--- Results ---`);
console.log(`Findings captured: ${observed.findings.length}`);
if (observed.findings.length === 0) {
  console.warn("No findings captured - the citation check below is vacuous; check the capture pipeline first");
}
console.log(`Parallel spawn detected: ${observed.parallelSpawnDetected ? "YES" : "NO - coordinator spawned sequentially"}`);
console.log(
  uncited.length === 0
    ? "All findings attributed in the report"
    : `Uncited findings (${uncited.length}) - check coordinator context passing, not the synthesis prompt:\n${uncited
        .map((f) => `  - [${f.retrieved_by}] ${f.claim}\n    expected anchor: ${expectedAnchor(f)}`)
        .join("\n")}`,
);
