# Claude Certification Exercises

Hands-on TypeScript exercises for Claude certification preparation. All exercises
share this folder's `package.json`, `tsconfig.json` and `.env`. Scripts run
directly as `.ts` files via [tsx](https://tsx.is) (no build step), e.g.
`npx tsx 1_01-agentic-loop.ts`. Each script loads `.env` itself via
`import "dotenv/config"`.

File naming: `<domain>_<nn>-topic.ts`, where the leading digit is the exam
domain / task-statement group (e.g. `2_01` covers Task Statement 2.1) and
`nn` numbers the exercise within it.

## Setup

1. `npm install`
2. Put your Anthropic API key into `.env` (`ANTHROPIC_API_KEY=sk-ant-...`).
   The `.env` file is gitignored.

## Running an exercise

Every exercise runs directly with tsx:

```bash
npx tsx <filename>
# e.g.
npx tsx 1_01-agentic-loop.ts
```

## Exercises

| # | File | Topic |
|---|------|-------|
| 1_01 | `1_01-agentic-loop.ts` | Multi-tool agentic loop: tool definitions with JSON Schema, `stop_reason`-driven loop, `tool_use`/`tool_result` handling, sequential tool chaining, safety iteration cap |
| 1_02 | `1_02-multi-agent-orchestration.ts` | Hub-and-spoke coordinator: two-phase task decomposition (structured outputs), parallel delegation with explicit context passing, coverage evaluation with substantive-content threshold, iterative refinement loop over gaps |
| 1_03 | `1_03-subagent-context-passing.ts` | Claude Agent SDK coordinator: Task/Agent tool spawn gate (`allowedTools`), scoped AgentDefinitions, structured findings with attribution metadata, full-context passing to a synthesis subagent, parallel spawn detection, citation verification (fixture: `data/solar-industry-report.md`) |
| 1_04 | `1_04-prerequisite-gate-handoff.ts` | Workflow enforcement: programmatic prerequisite gate in the tool dispatch layer (session-scoped verification state blocks `process_refund`), gate scope as a risk decision, structured handoff via `escalate_to_human` (5 required fields, required-but-nullable `refund_amount`), multi-concern decomposition (resolve what tools allow, escalate the rest) |
| 1_05 | `1_05-hooks-normalisation-policy.ts` | Hooks: PostToolUse normalisation of three tools with inconsistent formats (Unix/ISO/DD-MM dates, numeric/string/single-char statuses -> ISO 8601 + readable statuses), PreToolUse policy gates (refund amount cap, session-scoped AML prerequisite before `transfer_funds`), blocked tools never execute |
| 1_06 | `1_06-multipass-code-review.ts` | Multi-pass code review over `review-target/`: single-pass attention dilution vs per-file passes vs cross-file integration pass, structured per-file findings, consistency measured by issue-count deviation per approach |
| 2_01 | `2_01-tool-description-misrouting.ts` | Tool descriptions as routing logic (Task Statement 2.1): in-process `McpServer` + client via `InMemoryTransport`, 10-query selection eval, five-element production descriptions (purpose with return fields, input formats, example queries, edge cases, boundaries), live re-description via `RegisteredTool.update()`, system prompt keyword-conflict A/B (6/10 -> 10/10 -> 8/10 -> 10/10) |
| 2_02 | `2_02-structured-error-responses.ts` | Structured error responses (Task Statement 2.2): one `customer_lookup` tool with a `mode` enum simulating six outcomes, four error categories (transient/validation/business/permission) carrying `errorCategory` + `isRetryable` + `description` as JSON in content text, single `buildErrorResponse` constructor, valid empty result (`isError: false`, `resultCount: 0`) vs access failure (`isError: true`), agent recovery loop that owns the callTool retries (exponential backoff capped at 3, single-reformat guard for validation, `isRetryable`-first branching) |
| 2_03 | `2_03-tool-distribution-multi-agent.ts` | Tool distribution in a multi-agent system (Task Statement 2.3): three roles with 4-5 disjoint tools each (programmatically verified), scoped cross-role `verify_fact` (single-source limit + coordinator escalation in the description), forced tool selection (`tool_choice: {type: "tool"}` with `disable_parallel_tool_use`, then back to `auto`), least-privilege `load_document` (https + trusted-domain + extension allowlists in the handler, structured rejections that name what IS accepted), cross-role misuse probe (scoping as structural prevention - an agent cannot call a tool it never sees) |
| 2_04 | `2_04-mcp-resources-and-descriptions.ts` | MCP resources and enhanced tool descriptions (Task Statement 2.4): `registerResource` schema catalogue at `db://schema/main` (description + `mimeType` at discovery and on content, column types + key relationships to spare exploratory calls), `registerTool` with a 5-sentence description (what it does, what it returns, when to use it, when Grep wins - the converse boundary), in-process client harness printing PASS/FAIL per acceptance criterion; companion `.mcp.json` covers the config half of the task statement |

Type-check everything: `npm run typecheck`

## Project-scoped MCP config (`.mcp.json`)

This folder's `.mcp.json` is the config-side artefact of exercise 2_04: a
project-scoped MCP server entry (`npx -y @modelcontextprotocol/server-github`)
using `${GITHUB_TOKEN}` env expansion so no secret is committed - each
developer exports their own token locally. It is only discovered when Claude
Code is launched FROM this folder (discovery is anchored to the project root),
which is deliberate: launching from here vs the repo root demonstrates the
scoping rule. User-scoped servers live in `~/.claude.json` instead - same
format, personal, never committed; the promotion path is user scope for
experiments, then project scope once worth sharing with the team.

## Code-review practice target

`review-target/` is a separate, deliberately flawed 15-file TypeScript project (a "TinyShop"
order backend) used to practise **code-review** agents/skills - point a reviewer at its `.ts`
files and see how many seeded defects it finds (correctness bugs, inefficiencies, code smells,
bad practices, security issues), obvious and subtle. Exercise `1_06` also uses it as its review
corpus. It has its own loose `tsconfig.json` and is excluded from the root `npm run typecheck`
above, so it never breaks the exercises.
`review-target/ANSWER-KEY.md` is the scoring key - **keep it out of the reviewing agent's context.**

## Key takeaways (exam-relevant)

- A tool definition needs `name`, `description`, and `input_schema` (JSON Schema
  object with `type`, `properties`, `required`).
- The loop terminates on `response.stop_reason` (`"end_turn"` = done,
  `"tool_use"` = execute tools and continue). Never branch on `content[0].type`
  or parse natural language.
- After executing tools: append the assistant response (with its `tool_use`
  blocks) to history, then append a user message containing `tool_result` blocks
  with matching `tool_use_id`. Multiple tool calls in one response get all their
  results in a single user message.
- An iteration cap (`MAX_ITERATIONS`) is a safety fallback that should never
  trigger in normal operation - `stop_reason` is the primary stopping mechanism.
- Tool descriptions ARE the routing logic (2_01): a production-grade description
  has five elements - purpose naming the returned fields, accepted input
  formats with examples, example queries (paraphrase intents, never copy the
  eval set), an edge-case rule for missing identifiers, and an explicit
  boundary ("Do NOT use for X - use <other tool>") whose exclusions mirror the
  other tool's purpose vocabulary.
- Ambiguity's failure mode is often *no* tool call (clarifying question)
  rather than the wrong tool - score abstentions as routing failures.
- A system prompt can override good descriptions: unconditional imperatives
  ("always ... before proceeding") and phrases matching one tool's vocabulary
  drag or stall routing. Scope conditions, avoid tool-domain keywords, and
  re-run the selection eval after any prompt change.
- MCP standardises only `isError` and `content` (2_02): error metadata
  (`errorCategory`, `isRetryable`, `description`) is a convention carried as
  JSON inside the text content. Build every error through one helper so no
  path can omit a field - a missing field silently kills the agent's branch.
- Retryability matrix: transient -> retry SAME input with backoff; validation
  -> retry with CHANGED input; business/permission -> not retryable (human
  decision / credential change). Mnemonic: retryable = "the agent can succeed
  without a human or a privilege change".
- Branch on `isRetryable` before `errorCategory`: the boolean gives a sane
  default for categories the agent has never seen (unknown non-retryable ->
  escalate, unknown retryable -> backoff).
- `isError` separates "the answer is nothing" (`resultCount: 0` - a final
  answer, never retry) from "there is no answer yet" (query never executed -
  retry). Collapsing them fails both ways: empty-as-failure wastes retries and
  invites hallucinated answers; failure-as-empty turns a timeout into a
  confident false "customer doesn't exist".
- Recovery logic must OWN the tool-call loop (a handler that only receives a
  finished result can log intentions but cannot retry), and every recovery
  path needs a bounded exit: retry cap for transient, single-reformat guard
  for validation.
- Tool scoping is structural prevention, not behavioural instruction (2_03):
  the API cannot return a `tool_use` for a tool absent from the request, so an
  agent cannot misuse a tool it never sees. Guidance boundaries live in
  descriptions (the model may follow them); guarantees live in handlers and
  toolset assignment (even a prompt-injected model cannot talk past them).
- Forcing a tool (`tool_choice: {type: "tool", name}`) guarantees that call but
  parallel tool use may batch others into the same turn - add
  `disable_parallel_tool_use` for a clean single step, and switch back to
  `auto` afterwards or the forced tool repeats every turn.
- Least-privilege handlers validate with allowlists (protocol, domain,
  extension), never blocklists, and rejections should name what IS accepted so
  the model can self-correct instead of retrying blind.
- MCP config scoping (2_04): `.mcp.json` at the project root is committed and
  team-shared; `~/.claude.json` is user scope, personal, never committed.
  Secrets stay out of git via `${VAR}` env expansion - the file holds only the
  reference, each developer exports the value locally. Discovery is anchored
  to the directory Claude Code is launched from.
- Resources are read-only catalogues answering "what data is available?" -
  tools then act on it. Exposing a schema or table of contents up front (with
  types and key relationships) eliminates exploratory tool calls, e.g. a
  correct JOIN written without probing the database.
- MCP tool descriptions compete with built-in tool descriptions: a sparse one
  loses to Grep even when the tool is more capable. Cover what it does, what
  it returns, when to use it, AND when the built-in wins - the converse
  boundary prevents over-routing through the custom tool.
- Current SDK API is `registerResource`/`registerTool` (with zod input
  schemas); `server.resource()`/`server.tool()` are the deprecated older forms.
