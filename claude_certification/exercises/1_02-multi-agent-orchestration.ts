// Exercise 02 - Multi-agent orchestration (hub-and-spoke coordinator)
// Run: npx tsx 1_02-multi-agent-orchestration.ts

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

interface AgentDefinition {
  name: string; // "web_search", "doc_analysis" - used to tag findings
  systemPrompt: string;
}

interface Finding {
  subtopic: string;
  agent: string;
  content: string;
}

interface CoverageReport {
  covered: string[];
  gaps: string[];
  completeness: number;
}

interface ResearchReport {
  topic: string;
  subtopics: string[];
  sections: { topic: string; content: string }[];
  coverage: CoverageReport;
  iterations: number;
}

interface CoordinatorOptions {
  client: Anthropic;
  subagents: AgentDefinition[];
  model?: string;
  coverageThreshold?: number;
  maxRefinementIterations?: number;
  minSubtopics?: number;
}


class ResearchCoordinator {
  private static readonly SYSTEM_PROMPT =
    `You are a research coordinator. Decompose topics into comprehensive subtopics,
    delegate to specialist subagents, aggregate results, and identify coverage gaps.`;

  private readonly client: Anthropic;
  private readonly subagents: AgentDefinition[];
  private readonly model: string;
  private readonly coverageThreshold: number;
  private readonly maxRefinementIterations: number;
  private readonly minSubtopics: number;

  // Deliberately NO conversation state on the class (no this.messages, no
  // this.findings): all state is local to a research() call. A second call
  // must remember nothing about the first - same independence rule that
  // applies to subagent invocations.
  constructor(options: CoordinatorOptions) {
    this.client = options.client;
    this.subagents = options.subagents;
    this.model = options.model ?? "claude-sonnet-5";
    this.coverageThreshold = options.coverageThreshold ?? 0.9;
    this.maxRefinementIterations = options.maxRefinementIterations ?? 3;
    this.minSubtopics = options.minSubtopics ?? 5;
  }

  // -------------------------------------------------------------------------
  // Public API - the only entry point. Reads as the four coordinator
  // responsibilities in order: decomposition -> delegation -> aggregation ->
  // iterative refinement.
  // -------------------------------------------------------------------------

  async research(topic: string): Promise<ResearchReport> {
    // Pure orchestration: no API calls, no prompts, no parsing here - just the
    // pipeline sequencing. All state is local; nothing touches `this`.

    // 1. Decomposition
    let subtopics = await this.decompose(topic);
    subtopics = await this.validateBreadth(topic, subtopics);
    // Logged FIRST on purpose: if the final report misses a category, this line
    // answers the root-cause question - decomposition bug vs downstream bug.
    console.log(`[coordinator] subtopics: ${subtopics.join(", ")}`);

    // 2. Delegation - initial fan-out across the roster
    const findings = await this.delegateAll(subtopics, topic);

    // 3. Aggregation - first coverage check
    let coverage = this.evaluateCoverage(subtopics, findings);
    console.log(`[coordinator] initial completeness: ${coverage.completeness}`);

    // 4. Iterative refinement - only runs if there are gaps
    //    refine() owns the loop; the final evaluate here just stamps the
    //    resulting numbers into the report.
    const refined = await this.refine(topic, subtopics, findings);
    coverage = this.evaluateCoverage(subtopics, refined.findings);

    // 5. Assemble and return the structured report
    return this.assembleReport(topic, subtopics, refined.findings, coverage, refined.iterations);
  }

  private static stringArrayOutputConfig(field: string, fieldDescription: string) {
    return {
      format: {
        type: "json_schema" as const,
        schema: {
          type: "object" as const,
          properties: {
            [field]: {
              type: "array",
              items: { type: "string" },
              description: fieldDescription,
            },
          },
          required: [field],
          additionalProperties: false,
        },
      },
    };
  }

  /** Finds the text block (never content[0] - exercise 01 discipline) and
   *  parses the guaranteed-valid structured-output JSON. */
  private static parseStructuredOutput<T>(response: Anthropic.Message, context: string): T {
    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock) {
      throw new Error(`${context}: no text block in response`);
    }
    return JSON.parse(textBlock.text) as T;
  }

  private static message(
    role: "user" | "assistant",
    content: string,
  ): Anthropic.MessageParam {
    return { role, content };
  }

  private async decompose(topic: string): Promise<string[]> {
    const prompt = `List ALL major subtopics for the research topic: "${topic}".
                    Ensure comprehensive breadth - missing an entire category is a critical failure.
                    Include emerging and boundary categories that are commonly discussed under this topic
                    even when their classification is debated - err on the side of inclusion.
                    Return at least ${this.minSubtopics} subtopics.
                    Each subtopic must be a short noun phrase (2-4 words)
                    naming one distinct category of the topic.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: ResearchCoordinator.SYSTEM_PROMPT,
      output_config: ResearchCoordinator.stringArrayOutputConfig(
        "subtopics",
        "All major subtopics, each a short noun phrase naming one distinct category",
      ),
      messages: [ResearchCoordinator.message("user", prompt)],
    });

    const { subtopics } = ResearchCoordinator.parseStructuredOutput<{
      subtopics: string[];
    }>(response, "decompose");

    if (subtopics.length < this.minSubtopics) {
      console.warn(
        `[coordinator] decomposition produced only ${subtopics.length} subtopics (minimum ${this.minSubtopics}) - breadth check will try to widen it`,
      );
    }
    return subtopics;
  }

  private async validateBreadth(topic: string, subtopics: string[]): Promise<string[]> {
    const prompt = `Research topic: "${topic}".
                    Planned subtopics: ${subtopics.join(", ")}.
                    Name any MAJOR category of this topic that is missing from the planned list -
                    the kind of omission that would make a research report incomplete in scope.
                    Include emerging and boundary categories that are commonly discussed under this topic
                    even when their classification is debated - err on the side of inclusion.
                    Use standard, widely-used category terminology, same style as the existing entries.
                    If the list is already comprehensive, return an empty array.
                    Do not suggest narrower refinements of categories already listed.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: ResearchCoordinator.SYSTEM_PROMPT,
      output_config: ResearchCoordinator.stringArrayOutputConfig(
        "missing",
        "Major categories absent from the list. Empty array if the list is already comprehensive.",
      ),
      messages: [ResearchCoordinator.message("user", prompt)],
    });

    const { missing } = ResearchCoordinator.parseStructuredOutput<{
      missing: string[];
    }>(response, "validateBreadth");

    // Dedupe case-insensitively - the model may restate an existing entry
    const known = new Set(subtopics.map((s) => s.toLowerCase()));
    const additions = missing.filter((m) => !known.has(m.toLowerCase()));

    if (additions.length > 0) {
      console.log(`[coordinator] breadth check added: ${additions.join(", ")}`);
    }
    return [...subtopics, ...additions];
  }

  private async delegate(
    agent: AgentDefinition,
    subtopic: string,
    goal: string,
    priorFindings?: string,
  ): Promise<Finding> {
    // Explicit context passing: the subagent has no access to the coordinator's
    // conversation, other subagents' results, or its own previous invocations -
    // whatever is not in this prompt does not exist for it.
    const priorContext = priorFindings
      ? `Prior findings on this subtopic (do NOT repeat them - fill the gaps they leave): ${priorFindings}`
      : "";
    const prompt = `Research the subtopic: "${subtopic}".
                    Broader research goal (context only - research ONLY your assigned subtopic): "${goal}".
                    ${priorContext}
                    Return structured findings: key facts, figures and trends, each with a source URL and a confidence level (high/medium/low).`;

    // Every delegation is visible at the hub - the observability property
    console.log(`[coordinator] -> ${agent.name}: "${subtopic}"`);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: agent.systemPrompt, // the SUBAGENT's identity, not the coordinator's
      messages: [ResearchCoordinator.message("user", prompt)],
    });

    const textBlock = response.content.find(
      (b): b is Anthropic.TextBlock => b.type === "text",
    );
    if (!textBlock || textBlock.text.trim() === "") {
      // Thrown errors are absorbed by delegateAll's allSettled: the missing
      // finding surfaces as a coverage gap that refine() re-targets.
      throw new Error(`delegate(${agent.name}, "${subtopic}"): empty response`);
    }

    return { subtopic, agent: agent.name, content: textBlock.text };
  }

  private async delegateAll(
    subtopics: string[],
    goal: string,
    priorSource?: Finding[],
  ): Promise<Finding[]> {
    // Cross-product: every subtopic to every roster agent - source-type
    // partitioning, not duplication (each agent is a different lens).
    const tasks = subtopics.flatMap((subtopic) => {
      const partial = priorSource
        ?.filter((f) => f.subtopic === subtopic)
        .map((f) => f.content)
        .join("\n");
      return this.subagents.map((agent) =>
        this.delegate(agent, subtopic, goal, partial || undefined),
      );
    });

    const settled = await Promise.allSettled(tasks);
    const findings = settled
      .filter((r): r is PromiseFulfilledResult<Finding> => r.status === "fulfilled")
      .map((r) => r.value);

    const failed = settled.length - findings.length;
    if (failed > 0) {
      console.warn(`[coordinator] ${failed} delegation(s) failed - will surface as coverage gaps`);
    }
    return findings;
  }

  /** A subtopic counts as covered only if its combined findings are substantive
   *  (above a minimum length) - zero findings and superficial coverage are both
   *  gaps. This threshold is what makes refine()'s priorFindings real: a gap
   *  can carry partial content worth passing back on re-delegation. */
  private static readonly MIN_SUBSTANTIVE_CHARS = 200;

  private evaluateCoverage(subtopics: string[], findings: Finding[]): CoverageReport {
    const covered: string[] = [];
    const gaps: string[] = [];

    for (const subtopic of subtopics) {
      // Exact-match on the tag is safe: the coordinator stamped f.subtopic from
      // this same subtopics array - no fuzzy matching against model output.
      const combinedChars = findings
        .filter((f) => f.subtopic === subtopic)
        .reduce((chars, f) => chars + f.content.length, 0);

      if (combinedChars >= ResearchCoordinator.MIN_SUBSTANTIVE_CHARS) {
        covered.push(subtopic);
      } else {
        gaps.push(subtopic);
      }
    }

    return {
      covered,
      gaps,
      completeness: subtopics.length === 0 ? 1 : covered.length / subtopics.length,
    };
  }

  private async refine(
    topic: string,
    subtopics: string[],
    findings: Finding[],
  ): Promise<{ findings: Finding[]; iterations: number }> {
    const allFindings = [...findings];
    let coverage = this.evaluateCoverage(subtopics, allFindings);
    let iterations = 0;

    while (
      coverage.completeness < this.coverageThreshold &&
      iterations < this.maxRefinementIterations
    ) {
      iterations++;
      console.log(
        `[coordinator] refinement round ${iterations}: targeting gaps - ${coverage.gaps.join(", ")}`,
      );

      // Only the gaps are re-delegated - covered subtopics are never re-run.
      // allFindings as priorSource: gaps with partial (superficial) content
      // get it passed back so the retry fills holes instead of repeating.
      const newFindings = await this.delegateAll(coverage.gaps, topic, allFindings);
      allFindings.push(...newFindings);

      coverage = this.evaluateCoverage(subtopics, allFindings);
    }

    if (coverage.completeness < this.coverageThreshold) {
      console.warn(
        `[coordinator] refinement stopped by safety cap (${this.maxRefinementIterations} rounds) - unresolved gaps: ${coverage.gaps.join(", ")}`,
      );
    }
    return { findings: allFindings, iterations };
  }

  private assembleReport(
    topic: string,
    subtopics: string[],
    findings: Finding[],
    coverage: CoverageReport,
    iterations: number,
  ): ResearchReport {
    // Order follows the decomposition list; both agents' findings merge into
    // one section per subtopic, labeled by source lens.
    const sections = subtopics
      .filter((subtopic) => coverage.covered.includes(subtopic))
      .map((subtopic) => ({
        topic: subtopic,
        content: findings
          .filter((f) => f.subtopic === subtopic)
          .map((f) => `[${f.agent}]\n${f.content}`)
          .join("\n\n"),
      }));

    return { topic, subtopics, sections, coverage, iterations };
  }
}
const webSearchAgent: AgentDefinition = {
  name: "web_search",
  systemPrompt: `You are a web research specialist. For the assigned subtopic, return structured findings with source URLs and confidence levels.`,
};

const docAnalysisAgent: AgentDefinition = {
  name: "doc_analysis",
  systemPrompt: `You are a document analysis specialist. For the assigned subtopic, extract and summarize key facts, figures, and trends as structured findings.`,
};

const coordinator = new ResearchCoordinator({
  client: new Anthropic(),
  subagents: [webSearchAgent, docAnalysisAgent],
});

const report = await coordinator.research("renewable energy technologies");

const required = ["solar", "wind", "geothermal", "tidal", "biomass", "fusion"];
const missing = required.filter(
  (cat) => !report.sections.some((s) => s.topic.toLowerCase().includes(cat)),
);
console.log(`Completeness: ${(report.coverage.completeness * 100).toFixed(0)}%`);
console.log(`Refinement iterations: ${report.iterations}`);
console.log(missing.length === 0 ? "Full coverage" : `Missing: ${missing.join(", ")}`);
