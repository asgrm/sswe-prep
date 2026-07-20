// Exercise 2.03 - Configure tool distribution across a multi-agent system (Task Statement 2.3)
// Run: npx tsx 2_03-tool-distribution-multi-agent.ts
//
// Steps:
//   1. Three agent roles (web search, document analysis, synthesis) with 4-5 tools each
//   2. Scoped cross-role tool: verify_fact on the synthesis agent, simple lookups only
//   3. Forced tool selection: extract_metadata as mandatory first step, then auto
//   4. Least privilege: replace generic fetch_url with constrained load_document
//   5. End-to-end test: no agent calls a tool outside its assigned set

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

// --- Step 1: three agent roles, 4-5 tools each --------------------------------
// Acceptance criteria:
//   - exactly 4-5 tools per agent
//   - no tool appears in more than one role (except the Step 2 cross-role tool)
//   - tool names clearly indicate purpose and scope

// input_schema is snake_case to match the Anthropic Messages API shape -
// these toolsets go straight into client.messages.create in Steps 3 and 5,
// and the API requires a schema on every tool.
type ToolDef = { name: string; description: string; input_schema: Anthropic.Tool.InputSchema };
type AgentName = "webSearch" | "documentAnalysis" | "synthesis";

const objectSchema = (
  properties: Record<string, unknown>,
  required: string[]
): Anthropic.Tool.InputSchema => ({ type: "object", properties, required });

const agentToolsets: Record<AgentName, { role: string; tools: ToolDef[] }> = {
  webSearch: {
    role: "Finds and retrieves web content",
    tools: [
      {
        name: "search_web",
        description: "Searches the web for a query and returns ranked results",
        input_schema: objectSchema({ query: { type: "string", description: "Search query" } }, ["query"])
      },
      {
        name: "fetch_page",
        description: "Fetches the full content of a web page by URL to triage search results",
        input_schema: objectSchema({ url: { type: "string", description: "URL of the page to fetch" } }, ["url"])
      },
      {
        name: "extract_links",
        description: "Extracts all hyperlinks from a web page",
        input_schema: objectSchema({ url: { type: "string", description: "URL of the page to scan" } }, ["url"])
      },
      {
        name: "save_snippet",
        description: "Saves a text snippet with source URL for handoff to the analysis stage",
        input_schema: objectSchema({
          text: { type: "string", description: "The snippet text" },
          sourceUrl: { type: "string", description: "URL the snippet came from" }
        }, ["text", "sourceUrl"])
      }
    ]
  },
  documentAnalysis: {
    role: "Analyses document structure and content",
    tools: [
      {
        name: "extract_metadata",
        description: "Extracts title, author, date, and document type",
        input_schema: objectSchema({ documentText: { type: "string", description: "Full document text" } }, ["documentText"])
      },
      {
        name: "extract_data_points",
        description: "Extracts structured data fields (dates, amounts, names)",
        input_schema: objectSchema({ documentText: { type: "string", description: "Full document text" } }, ["documentText"])
      },
      {
        name: "summarise_content",
        description: "Produces a concise summary of key arguments",
        input_schema: objectSchema({ documentText: { type: "string", description: "Full document text" } }, ["documentText"])
      },
      {
        name: "verify_claim",
        description: "Checks if a claim is supported by the source document",
        input_schema: objectSchema({
          claim: { type: "string", description: "The claim to check" },
          documentText: { type: "string", description: "Source document text" }
        }, ["claim", "documentText"])
      }
    ]
  },
  synthesis: {
    role: "Compiles findings into reports",
    // 3 tools here by design: Step 2 adds the scoped verify_fact, bringing it to 4.
    tools: [
      {
        name: "compile_report",
        description: "Assembles research findings into a structured report",
        input_schema: objectSchema({
          findings: { type: "array", items: { type: "string" }, description: "Research findings to include" }
        }, ["findings"])
      },
      {
        name: "format_citation",
        description: "Formats a source reference in the required citation style",
        input_schema: objectSchema({
          source: { type: "string", description: "Source reference to format" },
          style: { type: "string", description: "Citation style, e.g. APA or Harvard" }
        }, ["source"])
      },
      {
        name: "assess_coverage",
        description: "Evaluates whether all research questions have been addressed",
        input_schema: objectSchema({
          researchQuestions: { type: "array", items: { type: "string" }, description: "The original research questions" },
          report: { type: "string", description: "The compiled report text" }
        }, ["researchQuestions", "report"])
      }
    ]
  }
};

// Step 1 acceptance criteria: 4-5 tools per agent, no tool assigned to more
// than one role. Checked programmatically so later steps can't silently
// break the distribution.
function verifyToolDistribution() {
  console.log("=== Step 1: tool distribution verification ===");
  const owner = new Map<string, string>();
  for (const [agent, config] of Object.entries(agentToolsets)) {
    const count = config.tools.length;
    const sizeOk = count >= 4 && count <= 5;
    console.log(`${agent}: ${count} tools ${sizeOk ? "- OK" : "- OUTSIDE 4-5 GUIDELINE"}`);
    for (const tool of config.tools) {
      if (owner.has(tool.name)) {
        console.log(`  DUPLICATE: ${tool.name} already assigned to ${owner.get(tool.name)}`);
      }
      owner.set(tool.name, agent);
    }
  }
}

// --- Step 2: scoped cross-role tool -------------------------------------------
// Acceptance criteria:
//   - verify_fact added to the synthesis agent
//   - description limits it to simple single-source lookups
//   - description says complex multi-source verification escalates to the coordinator

// The description is the contract: the model never sees the handler, so the
// single-source limit and the escalation boundary must live in the wording.
const scopedVerifyFact: ToolDef = {
  name: "verify_fact",
  description:
    "Verifies a simple factual claim against a single source document. Use for quick checks " +
    "during report compilation. For complex verifications requiring multiple sources or " +
    "cross-referencing, escalate to the coordinator.",
  input_schema: {
    type: "object",
    properties: {
      claim: { type: "string", description: "The factual claim to verify" },
      sourceId: { type: "string", description: "ID of the source document to check against" }
    },
    required: ["claim", "sourceId"]
  }
};
agentToolsets.synthesis.tools.push(scopedVerifyFact);

// Verification runs AFTER the push so it reflects the final distribution -
// synthesis should now report 4 tools.
verifyToolDistribution();

// --- Step 3: forced tool selection on the document analysis agent -------------
// Acceptance criteria:
//   - first call uses tool_choice { type: "tool", name: "extract_metadata" }
//   - subsequent calls switch to tool_choice { type: "auto" }

const sampleDocument = `Quarterly Infrastructure Review
Author: Priya Sharma | Date: 2026-05-14 | Type: internal report

Cloud spend fell 18% quarter on quarter to £142,000 after the migration to spot
instances. Incident count dropped from 31 to 19 over the same period. The report
recommends extending spot coverage to the batch pipeline by Q3 2026.`;

// The tools are definitions without backends, so simulate results - same
// pattern as the customer_lookup handler in exercise 2.02.
function executeDocumentTool(name: string): string {
  switch (name) {
    case "extract_metadata":
      return JSON.stringify({
        title: "Quarterly Infrastructure Review",
        author: "Priya Sharma",
        date: "2026-05-14",
        documentType: "internal report"
      });
    case "extract_data_points":
      return JSON.stringify({ cloudSpend: "£142,000", spendChange: "-18%", incidents: { before: 31, after: 19 } });
    case "summarise_content":
      return JSON.stringify({ summary: "Spot migration cut cloud spend 18% and incidents from 31 to 19; extend to batch pipeline by Q3 2026." });
    case "verify_claim":
      return JSON.stringify({ supported: true });
    default:
      return JSON.stringify({ error: `no stub for tool ${name}` });
  }
}

async function runDocumentAnalysis() {
  console.log("\n=== Step 3: forced tool selection (document analysis) ===");
  const messages: Anthropic.MessageParam[] = [
    { role: "user", content: `Analyse this document:\n\n${sampleDocument}` }
  ];

  // Turn 1: forced - the model must call extract_metadata. Forcing guarantees
  // the named tool is called, but with parallel tool use (the default) the
  // model may batch OTHER tools into the same turn; disable_parallel_tool_use
  // caps the turn at the single forced call so the two-phase flow is visible.
  const firstTurn = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    tools: agentToolsets.documentAnalysis.tools,
    tool_choice: { type: "tool", name: "extract_metadata", disable_parallel_tool_use: true },
    messages
  });

  // Parallel tool use is on by default, so even a forced turn can contain
  // SEVERAL tool_use blocks - every one needs a matching tool_result in the
  // single next user message, or the API rejects the follow-up with a 400.
  const forcedCalls = firstTurn.content.filter(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  if (forcedCalls.length === 0) throw new Error("Forced turn produced no tool_use block");
  for (const call of forcedCalls) {
    console.log(`turn 1 (forced): ${call.name} - ${call.name === "extract_metadata" ? "PASS" : "FAIL"}`);
  }

  // Feed all tool_results back, then hand control back to the model with
  // auto selection. Leaving the forced tool_choice in place would compel
  // extract_metadata on every turn and the analysis could never progress.
  messages.push(
    { role: "assistant", content: firstTurn.content },
    {
      role: "user",
      content: forcedCalls.map((call): Anthropic.ToolResultBlockParam => ({
        type: "tool_result",
        tool_use_id: call.id,
        content: executeDocumentTool(call.name)
      }))
    }
  );

  const nextTurn = await client.messages.create({
    model: "claude-sonnet-5",
    max_tokens: 1024,
    tools: agentToolsets.documentAnalysis.tools,
    tool_choice: { type: "auto" },
    messages
  });

  const autoCall = nextTurn.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === "tool_use"
  );
  console.log(
    autoCall
      ? `turn 2 (auto): model chose ${autoCall.name}`
      : `turn 2 (auto): no tool call (stop_reason=${nextTurn.stop_reason})`
  );
}

await runDocumentAnalysis();

// --- Step 4: replace generic fetch_url with constrained load_document ---------
// Acceptance criteria:
//   - load_document validates URLs (document extensions and/or trusted domains)
//   - non-document URLs rejected with a clear error message

// A generic fetch_url would fetch ANY web page - more capability than the
// document analysis role needs. load_document narrows it. Contrast with
// Step 2: verify_fact's boundary lives in its DESCRIPTION (guidance the
// model follows); load_document's lives in the HANDLER (a guarantee even a
// prompt-injected model cannot talk its way past). Allowlists, not blocklists.
const VALID_EXTENSIONS = [".pdf", ".docx", ".md", ".txt", ".html"];
const TRUSTED_DOMAINS = ["docs.internal.com", "wiki.company.com"];

type ToolOutcome = { isError?: boolean; content: { type: "text"; text: string }[] };

// Rejections name what IS accepted so the model can self-correct instead of
// retrying blind - same principle as the validation errors in exercise 2.02.
const rejectUrl = (url: string, reason: string): ToolOutcome => ({
  isError: true,
  content: [{
    type: "text",
    text: `Rejected: ${url} - ${reason}. Accepted: https URLs ending in ` +
      `${VALID_EXTENSIONS.join(", ")} on ${TRUSTED_DOMAINS.join(" or ")}.`
  }]
});

const loadDocumentHandler = async ({ url }: { url: string }): Promise<ToolOutcome> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return rejectUrl(url, "not a parseable URL");
  }
  if (parsed.protocol !== "https:") {
    return rejectUrl(url, `protocol ${parsed.protocol} is not allowed`);
  }
  if (!TRUSTED_DOMAINS.includes(parsed.hostname)) {
    return rejectUrl(url, `${parsed.hostname} is not a trusted domain`);
  }
  // URL lowercases the hostname for us, but NOT the pathname.
  if (!VALID_EXTENSIONS.some(ext => parsed.pathname.toLowerCase().endsWith(ext))) {
    return rejectUrl(url, "not a document file extension");
  }
  return { content: [{ type: "text", text: `Document content from ${url}` }] };
};

const loadDocument: ToolDef & { handler: typeof loadDocumentHandler } = {
  name: "load_document",
  description:
    "Loads a document from a validated URL. Only accepts https URLs ending in .pdf, .docx, " +
    ".md, .txt, or .html from trusted domains. Use instead of a generic fetch for document retrieval.",
  input_schema: objectSchema({ url: { type: "string", description: "URL of the document to load" } }, ["url"]),
  handler: loadDocumentHandler
};

// Document loading belongs to the document analysis role - 5 tools, still
// within the 4-5 guideline.
agentToolsets.documentAnalysis.tools.push(loadDocument);
verifyToolDistribution();

// Step 4 acceptance criteria: one accepted URL, and every rejection path
// returns a structured error (never a thrown exception).
console.log("\n=== Step 4: constrained load_document ===");
for (const url of [
  "https://docs.internal.com/reports/Q2-Review.PDF", // valid (case-insensitive ext)
  "https://evil.com/report.pdf",                     // untrusted domain
  "https://docs.internal.com/index.php",             // not a document extension
  "http://docs.internal.com/report.pdf",             // protocol not https
  "file:///etc/passwd.txt",                          // protocol not https
  "not a url"                                        // unparseable
]) {
  const result = await loadDocument.handler({ url });
  console.log(`${result.isError ? "REJECTED" : "ACCEPTED"}: ${url}`);
  if (result.isError) console.log(`  ${result.content[0].text}`);
}

// --- Step 5: test for cross-role misuse ----------------------------------------
// Acceptance criteria:
//   - a query that exercises all three agents
//   - log of { agent, tool } for every tool call
//   - every logged call belongs to that agent's assigned toolset

// Single-turn probe per agent: we log tool INTENTIONS without executing
// them, which is all the assertion needs. The violation check can only fail
// through configuration drift (merged toolsets, wrong array passed) - the
// API cannot return a tool_use for a tool absent from the request. Tool
// scoping is structural prevention, not behavioural instruction: an agent
// cannot misuse a tool it never sees.
async function runMultiAgentQuery(query: string) {
  const log: Array<{ agent: AgentName; tool: string }> = [];

  // Simulate the coordinator dispatching the task to each agent in turn,
  // each with ONLY its own toolset.
  const agents = Object.entries(agentToolsets) as [AgentName, typeof agentToolsets[AgentName]][];
  for (const [agentName, config] of agents) {
    // Document analysis keeps its Step 3 configuration: extract_metadata
    // is the forced, single first step. The other agents choose freely.
    const toolChoice: Anthropic.ToolChoice =
      agentName === "documentAnalysis"
        ? { type: "tool", name: "extract_metadata", disable_parallel_tool_use: true }
        : { type: "auto" };

    // Role-specific framing so each agent exercises its own tools; the
    // synthesis prompt includes findings plus one simple single-source
    // claim, the intended trigger for its scoped verify_fact.
    const prompt =
      agentName === "synthesis"
        ? `You are the synthesis agent: ${config.role}. Task: ${query} ` +
          `Findings so far: "MCP added a tool_search capability" (source doc-1); ` +
          `"the 2026 spec revised the auth flow" (source doc-2). Verify the ` +
          `tool_search claim against doc-1, then compile the report.`
        : `You are the ${agentName} agent: ${config.role}. Task: ${query}`;

    const response = await client.messages.create({
      model: "claude-sonnet-5",
      max_tokens: 1024,
      tools: config.tools, // only this agent's tools
      tool_choice: toolChoice,
      messages: [{ role: "user", content: prompt }]
    });

    for (const block of response.content) {
      if (block.type === "tool_use") {
        log.push({ agent: agentName, tool: block.name });
      }
    }
  }

  // Verify: every logged call must belong to the calling agent's toolset.
  for (const entry of log) {
    const agentTools = agentToolsets[entry.agent].tools.map(t => t.name);
    console.log(`${entry.agent}: ${entry.tool} - ${agentTools.includes(entry.tool) ? "VALID" : "CROSS-ROLE VIOLATION"}`);
  }
}

console.log("\n=== Step 5: cross-role misuse test ===");
await runMultiAgentQuery(
  "Research the latest MCP specification changes and compile a summary report."
);
