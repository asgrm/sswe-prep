// Exercise 01 - Agentic loop with multi-tool selection
// Run: npx tsx 1_01-agentic-loop.ts

import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic();

const MODEL = "claude-sonnet-5";
const MAX_ITERATIONS = 20;

const tools: Anthropic.Tool[] = [
  {
    name: "calculator",
    description:
      "Evaluates a mathematical expression and returns the numeric result. Supports +, -, *, /, parentheses and decimal numbers. Use this for any arithmetic instead of computing it yourself.",
    input_schema: {
      type: "object",
      properties: {
        expression: {
          type: "string",
          description: 'The expression to evaluate, e.g. "68000 * 3.5"',
        },
      },
      required: ["expression"],
    },
  },
  {
    name: "web_search",
    description:
      "Searches the web and returns a list of results for the given query. Use this when you need current information you don't know, such as prices, populations, or recent events.",
    input_schema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: 'The search query, e.g. "current price of Bitcoin"',
        },
      },
      required: ["query"],
    },
  },
];

function runCalculator(input: { expression: string }): string {
  const { expression } = input;

  if (!/^[\d\s+\-*/().]+$/.test(expression)) {
    throw new Error(`Unsupported characters in expression: ${expression}`);
  }
  const result: unknown = Function(`"use strict"; return (${expression});`)();
  if (typeof result !== "number" || !Number.isFinite(result)) {
    throw new Error(`Expression did not evaluate to a finite number: ${expression}`);
  }
  return String(result);
}

interface SearchResult {
  title: string;
  snippet: string;
  url: string;
}

function runWebSearch(input: { query: string }): string {
  const { query } = input;
  // Stub: canned results keyed by topic, generic fallback otherwise
  const q = query.toLowerCase();
  let results: SearchResult[];
  if (q.includes("bitcoin")) {
    results = [
      { title: "Bitcoin Price Today", snippet: "Bitcoin (BTC) is trading at $68,250 USD.", url: "https://example.com/btc" },
      { title: "BTC Market Overview", snippet: "24h volume $32B, market cap $1.34T.", url: "https://example.com/btc-market" },
    ];
  } else if (q.includes("population") && q.includes("france")) {
    results = [
      { title: "France Demographics", snippet: "The population of France is approximately 68,200,000.", url: "https://example.com/france" },
    ];
  } else {
    results = [
      { title: `Results for "${query}"`, snippet: "No specific mock data for this query; this is a stubbed search tool.", url: "https://example.com/search" },
    ];
  }
  return JSON.stringify(results);
}

function executeTool(name: string, input: unknown): string {
  switch (name) {
    case "calculator":
      return runCalculator(input as { expression: string });
    case "web_search":
      return runWebSearch(input as { query: string });
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

async function runAgentLoop(
  userPrompt: string,
): Promise<{ result: string; iterations: number }> {
  const messages: Anthropic.MessageParam[] = [{ role: "user", content: userPrompt }];
  let iterations = 0;

  while (true) {
    if (iterations >= MAX_ITERATIONS) {
      console.warn(`Safety cap reached (${MAX_ITERATIONS} iterations) - aborting loop`);
      break;
    }
    iterations++;

    const response = await client.messages.create({
      model: MODEL,
      max_tokens: 1024,
      tools,
      messages,
    });

    console.log(`[iteration ${iterations}] stop_reason: ${response.stop_reason}`);

    // Deterministic branch: stop_reason tells us whether Claude is done
    if (response.stop_reason === "end_turn") {
      const textBlock = response.content.find(
        (b): b is Anthropic.TextBlock => b.type === "text",
      );
      return { result: textBlock?.text ?? "", iterations };
    }

    if (response.stop_reason !== "tool_use") {
      // e.g. max_tokens - nothing sensible to continue with
      console.warn(`Unexpected stop_reason "${response.stop_reason}" - stopping`);
      return { result: "", iterations };
    }

    // Claude requested tools. It may request several in one response -
    // execute all of them and return every tool_result in a SINGLE user message.
    const toolUseBlocks = response.content.filter(
      (b): b is Anthropic.ToolUseBlock => b.type === "tool_use",
    );

    // The assistant turn (including its tool_use blocks) must go back into history
    messages.push({ role: "assistant", content: response.content });

    const toolResults: Anthropic.ToolResultBlockParam[] = toolUseBlocks.map((block) => {
      console.log(`  -> tool: ${block.name}(${JSON.stringify(block.input)})`);
      try {
        const result = executeTool(block.name, block.input);
        // console.log(`  <- result: ${result.slice(0, 120)}${result.length > 120 ? "..." : ""}`);
        console.log(`  <- result: ${result}`);
        return { type: "tool_result", tool_use_id: block.id, content: result };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.log(`  <- error: ${message}`);
        return { type: "tool_result", tool_use_id: block.id, content: `Error: ${message}`, is_error: true };
      }
    });

    messages.push({ role: "user", content: toolResults });
  }

  return { result: "", iterations };
}

const prompt =
  "Search for the current price of Bitcoin and calculate what 3.5 coins would cost.";

console.log(`Prompt: ${prompt}\n`);

const { result, iterations } = await runAgentLoop(prompt);

console.log(`\nIterations: ${iterations}`);
console.log(`Result: ${result}`);
