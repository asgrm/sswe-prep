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
| 3_06 | `3_06-ci-cd-pipeline/` | CI/CD integration (Task Statement 3.6), not a `.ts` script - GitHub Actions workflows + shell scripts: `claude -p` for non-interactive execution (plain `claude` hangs in CI; `CLAUDE_HEADLESS` and `--batch` are exam distractors), `--output-format json` + `--json-schema` for structured findings (file/line/severity/message), `jq` -> `gh api` inline PR comments anchored to file+line, CLAUDE.md as the CI context carrier (testing standards, fixtures, severity criteria), generation/review session isolation (fresh session per `claude -p`; `--continue`/`--resume` opt in to sharing), incremental review via per-PR findings cache so fixed issues are not re-reported |
| 4_01 | `4_01-vague-vs-explicit-review-criteria.ts` | Review-criteria calibration (Task Statement 4.1): vague-prompt baseline ("be conservative" - no decision boundary) vs explicit categorical criteria (report/skip lists + comment flag rule) vs criteria with code examples per severity, 5 ground-truth snippets (SQL injection, off-by-one, missing null guard, unused variable, naming inconsistency) x 3 runs each, TP/FP/FN + precision + error rate + run-to-run inconsistency, trust recovery plan (disable nitpick categories above 25% FP, refine-never-disable for bug categories, edge-case examples as re-enablement criteria) |
| 4_02 | `4_02-few-shot-extraction-consistency.ts` | Few-shot examples for extraction consistency (Task Statement 4.2): detailed-instructions baseline vs the same prompt + 3 reasoning-included examples, 10 ground-truth documents (3 tables / 3 narrative / 4 mixed) with seeded traps (word-dates, word-amounts, comma-thousands, no vendor, no-year date, waived fee, stated-total-vs-sum mismatch), failure log grouped by doc type surfacing the three few-shot triggers, metrics split into lenient ACCURACY vs strict FORMAT consistency (deliberately no structured outputs - the API would hide the format drift under study), technique decision matrix (few-shot vs nullable schema vs structured outputs vs validation loop) |
| 4_03 | `4_03-tool-choice-nullable-extraction.ts` | tool_choice modes and nullable extraction schemas (Task Statement 4.3): anti-fabrication schema design (required = only the 3 always-present fields, `["string","null"]` optionals, "unclear"/"other" enum escapes + `category_detail`), `auto` vs `any` vs forced on the same neutral-prompt documents (`auto` may answer in text - `stop_reason: "end_turn"`, no structured output; `any` guarantees a tool call and picks among 3 type-specific tools; `{type:"tool"}` runs `extract_metadata` even when another tool fits better), nullable vs all-required schema on 5 docs (2 with genuinely absent fields) classifying each absent-field answer as honest null / sentinel string / fabricated value |
| 4_04 | `4_04-validation-retry-loop.ts` | Validation-retry loops and self-correction schemas (Task Statement 4.4): two-layer schema (extraction data + self-assessment metadata: `calculated_total` vs `stated_total`, `total_discrepancy`, `conflict_detected`, per-finding `detected_pattern`), semantic validation (sums, flag consistency, enum validity, date ordering) plus a grounding layer (extracted values must appear in the source - catches silent correction), sectioned retry message (document / extraction / errors) with a 3-attempt cap, fixable-vs-unfixable classification BEFORE retrying on 5 docs (2 seeded fixable failures vs absent due date / JPY outside enum / document's own date contradiction -> human review with zero retries), `detected_pattern` dismissal telemetry prioritised by impact = frequency * dismissal rate |
| 4_05 | `4_05-message-batches-sla-retry.ts` | Message Batches API (Task Statement 4.5): blocking-vs-latency-tolerant classification of 5 workflows (rule: is someone/something WAITING?), live 20-request batch with `doc-<type>-<nnn>` custom_ids (results correlate by custom_id only - any order), failure taxonomy beyond `errored` (seeded invalid model -> errored/not billed; seeded `max_tokens: 20` -> "succeeded" with `stop_reason: "max_tokens"` = truncated-but-billed), targeted retry batch of ONLY the 2 failures (`-retry-1` suffix, increased max_tokens / corrected body), SLA math (30h SLA - 24h window = 6h buffer; latest submission = deadline - 30h; cadence: interval + 24h <= SLA), 3-rung prompt ladder refined on a stratified 5-doc sample run synchronously BEFORE full submission (stop at >= 90%) |
| 4_06 | `4_06-multipass-confidence-routing.ts` | Multi-pass review with confidence routing and calibration (Task Statement 4.6): single-pass baseline over the seeded 10-file `mock-pr/` documenting the three attention-dilution symptoms (per-file finding counts + depth proxy, planted-bug catch rate via a judge model, positional contradictions detected mechanically from duplicate planted patterns - SQL interpolation in files 03+06, inverted time checks in 04+07), parallel per-file passes (`Promise.all`, fresh context each, same review contract), cross-file integration pass over findings + import graph only (data-flow / contradictory-findings / api-contract), confidence (0.0-1.0) + reasoning per finding routed at a 0.80 baseline threshold (`direct_report` vs `human_review`), independent calibration - fresh stateless requests re-judge a stratified sample given code + bare finding only (never the original reasoning), calibration curve per confidence band (0.6-0.7 ... 0.9-1.0) -> lowest threshold meeting a 0.9 measured-precision target |
| 5_01 | `5_01-context-window-case-facts.ts` | Context window management (Task Statement 5.1): case facts extractor pulling ONLY transactional data (customer id, order number, amount, date, status, item) from a raw tool result, persistent `## Active Case Facts (DO NOT SUMMARISE)` block prepended to every prompt OUTSIDE summarised history, tool result trimmer (49-field order lookup -> 5 return-relevant fields, >= 80% smaller before entering history), multi-turn verification via live progressive summarisation (30 -> 15 -> 8 word caps) with a WITH/WITHOUT case-facts A/B on turn 7 ($247.83 / #8891 / March 3rd must survive only where the block exists; anti-guess system prompt so the control cannot fabricate), key findings placement (`## Key Findings Summary` at the TOP of aggregated subagent reports - the structural lost-in-the-middle fix) |
| 5_02 | `5_02-escalation-criteria-ambiguity.ts` | Escalation calibration and ambiguity (Task Statement 5.2): system prompt with the three valid escalation triggers as trigger/description/action (explicit human request, policy gap vs violation, inability to progress) plus the two anti-patterns called out by name (sentiment/frustration, self-reported confidence), few-shot examples demonstrating the frustration-vs-explicit-request distinction, `handleCustomerLookup` that asks for an additional identifier on multiple name matches instead of any heuristic selection (multi-match results withhold candidate details so heuristic selection is structurally impossible, not just discouraged), a small tool-using agent loop (`check_policy`/`customer_lookup`/`resolve_issue`/`escalate_to_human`) driving all four required test scenarios plus a multi-phrasing absolute-rule check that explicit human requests escalate in the first turn with zero investigation |
| 5_03 | `5_03-structured-error-recovery-coordinator.ts` | Structured error context and coordinator recovery (Task Statement 5.3): `StructuredError` schema (failureType/attemptedAction/partialResults/alternativeApproaches, one `buildStructuredError` constructor deriving `status` from whether partials exist), `reportSearchAttempt` classifying one raw call as a valid empty result (`shouldRetry: false`) vs an access failure (`shouldRetry: true`), `withRetry` accumulating partial results across 3 exponential-backoff attempts before ever propagating, `coordinatorRecovery` branching on failureType + partial-result count + alternatives (proceed_partial/try_alternative/retry_modified/fix_query/alert_admin/escalate_human, incl. a no-alternatives fixture for the default branch), an 8-topic research pipeline enacting each recovery action live (alternative-source fallback, single-reformat retry on a bad date range), and `addCoverageAnnotations` marking a valid empty result well-supported (never "unavailable") while every failed topic keeps an explicit reason in the synthesis output |
| 5_04 | `5_04-exploration-context-degradation.ts` | Extended exploration without context degradation (Task Statement 5.4): a coordinator delegating 3 narrow investigations (test coverage / refund flow trace / external API integrations) to subagents that each run in their own message array over `mock-codebase/`, returning a forced `report_findings` payload (class names, exact paths, dependency chains, with an empty-payload repair turn for reports truncated mid-JSON by `max_tokens`) while the verbose reads stay behind - proved by a canary line (`expand[]=balance_transaction`) present in every subagent context and absent from the coordinator's, plus a retained-bytes ratio; a scratchpad file written from the first step and read back by later steps; a Phase 1 summary built from the structured findings only (forced `record_phase1_summary`) and injected into every Phase 2 prompt, with a cold-start control run on the same task and no context at all; a manifest checkpointed after EVERY subagent, a simulated crash mid-Phase-2 and a resume that runs exactly the recorded `nextSteps`; and a 7-module degradation A/B where both arms absorb byte-identical generated build-log noise and the recall question is asked with the source-read tools removed (both arms keep the same `read_scratchpad` surface, so the only difference is whether a file exists behind it) - the scratchpad arm reads its file, the control has only its context |
| 5_05 | `5_05-confidence-calibration-review-routing.ts` | Field-level confidence, calibration and review routing (Task Statement 5.5), pure simulation - no API calls: a seeded mock extractor over 4 document types x 3 fields whose miscalibration is PLANTED per segment (P(correct) = reported confidence + bias, positive on invoices, sharply negative on international documents), a volume-skewed 4000-doc corpus (80% invoices) exposing the aggregate-metrics trap (~90% aggregate vs ~42% worst segment), per-band calibration curves per type-field segment with a reliable-band lookup (n >= 25, nearest-band fallback), stratified sampling across type x confidence strata INCLUDING the automated high-confidence items - proved by a week-2 drift (invoice amounts degrade to 75% accuracy at unchanged ~0.97 confidence) that a low-confidence-only review policy inspects 0 of, and a binary min-heap review queue prioritised by the weakest field's CALIBRATED confidence, dynamically reordering on arrival, with a guaranteed raw-vs-calibrated ordering inversion |
| 5_06 | `5_06-claim-source-provenance-pipeline.ts` | Claim-source provenance through a multi-agent research pipeline (Task Statement 5.6): five-field `ClaimSourceMapping` schema (claim / sourceUrl / documentName / relevantExcerpt / publicationDate, ALL required, per-field descriptions stating each field's role in the provenance chain) enforced at the subagent boundary via a forced `report_findings` tool over a planted 5-document corpus (URLs/titles/dates mechanically verified against the corpus, excerpts by normalised verbatim containment), a synthesis A/B on identical numbered findings (naive 250-word executive summary vs explicit preserve-attribution prompt with inline `[n]` citations + `## References`, both scored mechanically by `verifyProvenance`'s preservation rate), conflict handling that groups findings by a researcher-emitted canonical `measure` key and annotates BOTH values with full attribution plus a temporal/methodological `possibleExplanation` (planted $495B-vs-$538B 2023 investment conflict, sources published ~7 months apart on different methodologies) instead of ever picking one, and content-appropriate rendering (financial -> year/value/source table, news -> prose, technical -> bulleted list; technical vocabulary checked BEFORE numeric presence since specifications cite numeric thresholds too) with citation markers preserved in every format |

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

`mock-pr/` is a second, smaller seeded corpus built for exercise `4_06`: a 10-file mock PR
(a "TicketHub" backend) with 3 planted bugs per file, the blatant SQL injection in file 06
(middle of the review), duplicate planted patterns for mechanical contradiction detection
(SQL interpolation in files 03+06, inverted time checks in 04+07) and seeded cross-file
issues (float dollars from 05 consumed as cents in 09; `getJson`'s null contract violated
in 08). Its `mock-pr/ANSWER-KEY.md` mirrors the `PLANTED_BUGS` list embedded in `4_06` -
keep the two in sync, and keep the key out of reviewer context.

## Codebase exploration target

`mock-codebase/` is an exploration corpus (not a review corpus): a small layered
order/refund service - `RefundController` -> `RefundProcessor` -> `OrderService` ->
`OrderRepository` -> `PostgresPool`, three external gateways (Stripe / Avalara /
SendGrid), a `QueryCache`, a `server.ts` composition root and a `coverage/coverage-summary.json`
with a deliberate 87.5% / 12.0% split between `src/services/order.ts` and
`src/services/refund.ts`. Exercise `5_04` explores it with subagents. Three facts are
planted for its investigations to find: `PaymentGateway.refundCharge` has no retry
(while `NotificationClient` next door has the reference 3-attempt backoff),
`OrderRepository.updateStatus` never invalidates the `order:<id>` cache keys it
staled, and `TaxClient.quote` swallows both attempts' errors behind a zero-tax
fallback. Ground truth lives in `5_04`'s `EXPECTED_CLASSES` - there is deliberately
no answer-key file in the folder, since the exploration tools would read it.

`mock_search/` is a 6-file order-processing fragment (deprecated `processLegacyOrder`
re-exported through a barrel file) used as a search/refactor target.

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
- Vague review instructions like "be conservative" have no decision boundary
  (4_01): conservative about REPORTING (skip nitpicks) and conservative about
  RISK (flag everything suspicious) are opposite behaviours, so classification
  drifts per snippet and per run. Replace with explicit categorical criteria:
  a report list (bugs, security, logic errors), a skip list (style, naming,
  formatting), and a comment rule (flag only when claimed behaviour
  contradicts actual behaviour).
- Code examples beat prose for severity calibration: "issues that could cause
  system failures" forces interpretation, while a named pattern plus a code
  snippet per severity level removes it. Examples must paraphrase the pattern
  (different code, same construct) - never copy the eval set.
- Measure accuracy AND consistency separately: precision = TP/(TP+FP) from
  repeated runs on a ground-truth set; inconsistency = snippets whose label
  changes between identical runs. A prompt can be reliably wrong or
  unreliably right - both need fixing.
- With a capable model the binary flag/skip decision can saturate (FP=FN=0
  even under a vague prompt) while the vagueness surfaces one level down as
  severity MISCALIBRATION - e.g. every real bug inflated to "critical" with
  zero discrimination between injection and off-by-one. Measure exact-label
  calibration on bug-tier snippets as its own metric (measured: vague 67%
  miscalibrated -> prose criteria 22% -> code examples 0%). Judge skip-listed
  nitpicks only at the flag/skip tier: "none" is compliant behaviour under
  explicit criteria, not a wrong label.
- Trust recovery: high FP in ONE category destroys trust in ALL categories
  (developers remember "the bot cried wolf", not per-category rates). Disable
  nitpick categories above ~25% FP while refining their criteria offline
  (2-3 edge-case code examples become the re-enablement bar, target <15%);
  bug categories that under-fire get refined but never disabled - that would
  trade a noisy reviewer for a blind one.
- Three triggers for deploying few-shot examples (4_02): inconsistent
  formatting across document structures, ambiguous judgement calls, and
  empty fields for data that exists in the document. Diagnose BEFORE
  prescribing: group failures by document type and field to find structural
  patterns, then target 2-4 examples at exactly those patterns.
- Few-shot examples need three parts - input, correct output, and REASONING
  explaining how the data was located and why decisions were made. Reasoning
  teaches the decision procedure (generalises to novel documents); bare
  input-output pairs teach surface pattern matching. Examples paraphrase the
  failing patterns, never copy the eval set.
- Match the technique to the problem class: inconsistent formatting /
  structural variety -> few-shot examples; malformed JSON -> structured
  outputs or tool_use with a schema (constrained decoding guarantees syntax,
  examples only encourage it); fabricated values for missing data ->
  optional/nullable schema fields (examples mitigate, schema guarantees);
  sum-vs-total discrepancies -> validation-retry loop (extraction returns
  what the document states; arithmetic checking is post-hoc).
- Keep accuracy and format as separate lenses: score accuracy leniently
  ("£1,250.50" is the right value in the wrong representation) and format
  strictly (a string amount is drift even when numerically correct) -
  conflating them hides which failures few-shot actually fixed.
- Schema design is the root-cause fix for fabricated extraction data (4_03):
  a required field pressures the model to invent a value whenever the data is
  absent, so `required` may contain only fields guaranteed present in EVERY
  document. Optional fields get type `["string","null"]` so the honest answer
  (null) is structurally valid, and enums get "unclear"/"other" escape values
  (plus a detail field for "other") so the model never has to force a wrong
  label.
- tool_choice ladder: `auto` = the model may answer in text (`stop_reason`
  "end_turn" - NO structured output, unsuitable when a pipeline requires it);
  `any` = a tool call is guaranteed but the model picks which tool (right
  when the document type is unknown across several extractors); `{type:
  "tool", name}` = maximum control, the named tool runs regardless of fit
  (mandatory pipeline steps). With a single tool, `any` and forced behave
  identically. Detect the outcome via `stop_reason` ("tool_use" vs
  "end_turn"), never by parsing the text.
- Empirically (claude-sonnet-5), under `auto` anything FRAMED as "a document"
  gets extracted - even an ambiguous note with nothing to extract, with the
  required fields filled by "<UNKNOWN>" sentinels. The text response surfaces
  when the input is a question to answer rather than a thing to file. Real
  inbox traffic contains both shapes, which is exactly why `auto` cannot
  guarantee structured output for a pipeline.
- Under an all-required schema the model escapes three ways, none machine-safe:
  plausible fabricated values (worst - undetectable downstream), sentinel
  strings ("N/A", "unknown" - poison code expecting real values), or
  schema-violating literal nulls (a non-strict schema is encouragement, not
  enforcement). A nullable schema makes the honest answer the valid answer;
  `strict: true` on top makes it the only answer.
- Self-correction fields come in pairs (4_04): separate `calculated_total`
  (the model's own sum) and `stated_total` (the figure printed in the
  document) plus `total_discrepancy`/`conflict_detected` flags let validation
  distinguish "document is wrong, faithfully reported" (flags true -
  validates CLEAN) from "extraction is wrong" (flags contradict the data). A
  single total field cannot represent that difference.
- tool_use eliminates schema SYNTAX errors; semantic errors (wrong sums,
  contradicting flags, out-of-order dates, misplaced values) need explicit
  validation logic returning SPECIFIC expected-vs-found messages ("line items
  sum to 460 but stated_total is 500") - a bare "validation failed" gives the
  retry nothing to aim at.
- Internal-consistency checks alone cannot catch silent correction (the model
  "fixing" the document's own arithmetic error and reporting no discrepancy
  is internally perfect) - add a grounding layer verifying extracted values
  actually appear in the source text.
- Retry-with-error-feedback needs all three sections in the follow-up
  message: the original document, the failed extraction JSON, and the
  specific validation errors - plus a 2-3 attempt cap so genuinely unfixable
  cases cannot loop forever.
- The retry effectiveness boundary (the most exam-tested idea in 4.4):
  retries fix errors whose correct answer EXISTS in the document (misread
  values, arithmetic, wrong flags); they cannot create absent information (no
  due date stated), represent values the schema forbids (currency outside the
  enum - a schema gap), or resolve the document's own contradictions (due
  date before invoice date). Classify each error BEFORE retrying and send
  unfixable ones straight to human review - retrying them burns tokens while
  pressuring the model to fabricate.
- `detected_pattern` per finding + reviewer dismissal telemetry closes the
  improvement loop: prioritise prompt refinement by impact = frequency *
  dismissal rate. A frequent, frequently-dismissed pattern is the top
  priority; a rare pattern with the same dismissal rate is not worth the
  prompt-engineering time.
- Batch-vs-synchronous is decided by ONE question (4_05): is someone or
  something waiting for the result? The batch API's only timing promise is
  "within 24 hours" (most batches finish in under an hour), so a blocked
  developer or a live customer means synchronous no matter how attractive the
  50% batch discount looks. Blocking: pre-merge review, real-time chat.
  Batch-eligible: overnight/weekly reports, nightly test generation,
  overnight extraction - consumed later, nothing waits.
- `custom_id` is the ONLY request-response correlation in a batch: results
  stream back in ANY order, so never match by position. Constraint:
  `^[a-zA-Z0-9_-]{1,64}$`, unique within the batch; encode type + index
  (`doc-billing-003`) so a bare id in a results log is self-describing.
- Batch failure taxonomy goes beyond `result.type === "errored"`: a result
  can be `succeeded` yet useless because `stop_reason` is `"max_tokens"`
  (truncated - and BILLED, unlike errored/canceled/expired which are free).
  Errored splits by error class: invalid-request errors need the BODY fixed
  before resubmitting; server errors can be retried verbatim; expired ->
  resubmit as-is.
- The correct retry pattern is a NEW batch containing only the failed
  custom_ids (suffixed `-retry-1`) with targeted modifications - increased
  `max_tokens` for truncation, corrected body for validation errors, chunking
  for oversized docs. Resubmitting the whole batch pays again for every
  already-successful result.
- SLA math works BACKWARDS from the deadline assuming worst-case processing:
  latest submission = deadline - SLA (30h SLA - 24h max window = 6h buffer;
  Monday 09:00 due -> Sunday 03:00 latest). Steady-state cadence: an item
  waits at most `interval` hours for the next submission, so
  interval + 24h <= SLA -> interval <= buffer; apply margin (submit every
  4-5h for a 6h buffer).
- Refine prompts on a small STRATIFIED sample before submitting the full
  batch: cover every doc type and known edge case, not just easy docs. Run
  the sample synchronously - fast feedback, and it doubles as the docs'
  recommended dry-run of the request shape (batch param validation is
  asynchronous and only reports when the whole batch ends). Stop refining at
  >= 90% and submit; at 90% first-pass success 20 docs cost ~2 resubmissions,
  at 60% they cost ~8.
- Batch + prompt caching discounts STACK, but batch cache hits are
  best-effort (30-98% depending on traffic): identical `cache_control`
  blocks in every request, prefer the 1h TTL, and remember the model's
  minimum cacheable prefix still applies. Not batchable at all: `stream:
  true`, `speed` (fast mode), `max_tokens: 0` (cache pre-warming).
- Attention dilution in a single-pass review has three symptoms (4_06):
  inconsistent depth across files (first/last reviewed deeper), bugs missed
  in MIDDLE files, and contradictory findings - the same pattern flagged in
  one file but passed silently in another. Planting the same pattern twice
  (SQLi in two files, inverted time checks in two files) makes contradictions
  mechanically detectable: caught-in-exactly-one = positional contradiction.
- The fix is decomposition with a division of labour: per-file passes give
  every file a full, fresh attention budget (local bugs); a separate
  integration pass gets FINDINGS + import graph - never file contents, or it
  would dilute the same way - and hunts only cross-cutting issues (data-flow
  unit/nullability mismatches, contradictory findings, API contract
  violations).
- Self-reported confidence is raw and UNCALIBRATED - useful for routing
  (>= threshold -> direct_report, below -> human_review; 0.80 is only a
  starting point) but the threshold must be validated, not trusted. Always
  request a reasoning field next to the score so uncertainty is analysable
  later.
- Calibration method the exam expects: an independent fresh instance (a new
  stateless request, no shared context) re-judges a sample given the code and
  the BARE finding - never the original reasoning or score, or it anchors on
  the first instance's self-assessment. Bucket results into confidence bands
  (0.6-0.7 ... 0.9-1.0), compute per-band confirmation rates, then set the
  routing threshold to the LOWEST band boundary whose measured precision
  meets the target - purely data-driven; high-confidence findings being
  overturned is exactly the calibration gap the exercise exists to surface.
- Empirically (claude-sonnet-5, one run): single-pass caught 23/30 planted
  bugs vs 27/30 per-file, CV 0.31 -> 0.22, and 5 bugs (incl. middle files 05
  and 07) were rescued by decomposition. But BOTH planted duplicate pairs
  were caught on both sides - a strong model saturates the contradiction
  symptom; dilution surfaced instead as depth collapse (file 07: 1 finding
  single-pass vs 3 per-file). And calibration moved the threshold DOWN
  (0.80 -> 0.60), not up: the model was UNDER-confident - every band >= 0.6
  verified at 100%, the only overturn sat at 0.30. Calibration corrects in
  both directions: overturned high-confidence findings raise the threshold,
  confirmed low-confidence findings lower it (routing went 20/50 -> 29/50
  direct_report at the same precision target).
- The integration pass can find issues NO single-file review could state:
  e.g. two retry layers stacking invisibly (postJson's internal retries x
  chargeOrder's own retry loop = up to 6 PSP hits per logical charge) - each
  file's retry logic is locally reasonable; only the findings-level view sees
  the composition.
- Progressive summarisation destroys exactly the data a transactional
  workflow needs first (5_01): amounts, dates, order/reference numbers and
  statuses. A value can survive one compaction round and vanish on the next -
  the erosion is progressive, not all-at-once. The fix is a persistent case
  facts block: structured facts extracted from tool results and prepended to
  EVERY prompt, OUTSIDE the summarised region, delimited with a section
  header ("## Active Case Facts (DO NOT SUMMARISE)").
- The extractor and the trimmer feed DIFFERENT destinations: the trimmed
  tool result enters conversation history (task-relevant fields, may later
  be summarised away); the extracted case facts enter the persistent block
  (facts that must NEVER be summarised). Both run before/as the result
  enters context, e.g. as a PostToolUse hook or in the tool implementation.
- Untrimmed tool results are a silent context budget killer: a 40+-field
  lookup response is re-paid as input tokens on EVERY subsequent turn as
  history grows. Trimming to the task-relevant fields (5 for a refund
  workflow: order_id, order_date, total_amount, return_eligible,
  item_description) cuts 80-90% - and the relevant set is task-scoped, a
  different workflow passes a different field list.
- The lost-in-the-middle fix is STRUCTURAL, not prompt-based: never instruct
  "pay attention to everything" - reorganise the aggregated input so a Key
  Findings Summary (one line per source) sits at the TOP, followed by the
  detailed per-source sections under explicit headers. Models process the
  beginning and end of long inputs reliably; the middle is where unsummarised
  findings go to die.
- When verifying the pattern empirically, the control arm needs an
  anti-guess system prompt ("never invent a value - say so and ask");
  otherwise the WITHOUT-case-facts agent can fabricate a plausible amount
  and masquerade as having remembered it.
- A structured error needs four elements to support informed recovery
  (5_03): failureType (transient/validation/business/permission),
  attemptedAction (tool/query/parameters - not a generic "search failed"),
  partialResults (usable work already done), and alternativeApproaches
  (the subagent's own domain knowledge of what else might work). One
  constructor builds every instance so no path can omit a field.
- Access failure vs valid empty result is the same distinction as 2_02's
  isError, restated at the subagent level: an exception means the query
  never ran (shouldRetry: true, worth retrying); a resolved response with
  zero rows means it ran and found nothing (shouldRetry: false, and that
  IS the answer). Conflating them either wastes retries on a stable "no
  data" or turns a real outage into a confident false negative.
- Retries belong INSIDE the subagent, not the coordinator: 3 attempts with
  exponential backoff (1s, 2s, 4s), accumulating partial results across
  every attempt (2 retrieved before attempt 1's timeout + 1 more before
  attempt 2's = 3 total propagated, not just the last attempt's). Only a
  failure that survives local retry reaches the coordinator at all - a
  transient blip that recovers on attempt 2 never generates a
  StructuredError in the first place.
- The coordinator's decision tree reads failureType first, then
  partialResults/alternativeApproaches for transient specifically:
  >= 3 partial results -> proceed with what's already gathered (retrying
  for full data isn't worth the latency); otherwise an alternative
  approach if the subagent supplied one; only then a modified retry.
  validation -> fix the query (schema/input problem, not a network one);
  permission -> alert an administrator; business -> escalate to a human -
  neither of the latter two is retryable, since repeating the same call
  yields the identical denial.
- The two named anti-patterns from the guide (silent suppression -
  swallowing a timeout as `{results: [], status: "success"}`, so the
  coordinator believes the search legitimately found nothing; workflow
  termination - one subagent's failure crashing the entire pipeline and
  discarding already-completed work) are both avoided by structured
  propagation into a coordinator that decides per-failure, never by a
  blanket "ignore errors" or "abort everything" policy.
- Coverage annotations close the loop at the synthesis layer: a topic that
  failed must appear in the output as "limited" or "unavailable" WITH a
  reason, never silently dropped - an invisible gap reads as "not
  relevant" rather than "data unavailable." The same empty-vs-failure
  distinction applies here too: a topic with a genuine zero-match result
  is annotated well-supported, not unavailable, or the annotation itself
  becomes a second silent-suppression bug one layer up.
- Context degradation (5_04) is NOT a token-limit problem: the observable
  symptom is the model saying "this follows the typical repository pattern"
  instead of "`OrderRepository` at `src/repos/order.ts` implements
  `Repository<Order>`". Verbose output accumulates, earlier precise
  discoveries get buried, attention shifts to the recent noise. A bigger
  window fills with the same output, so every fix is structural:
  scratchpads, delegation, phase summaries, manifests.
- Subagent delegation for exploration is about context ISOLATION, not
  parallelism. In 5_04 each subagent owns its message array; only the
  `report_findings` payload crosses back, and the canary line from
  `src/gateways/payment.ts` proves it - present in the subagent contexts,
  absent from the coordinator's, which ends up holding a few percent of the
  bytes that were actually read. Speed is the side benefit.
- The scratchpad is the primary mitigation, and it is a strategy from the
  FIRST step, not a rescue once symptoms show - by then the precise
  findings you wanted to record are the ones already lost. It stores exact
  identifiers (`- Class: OrderRepository (src/repos/order.ts) implements
  Repository<Order>`), dependency chains and critical findings, never
  prose summaries, because a summary erodes exactly what the file exists to
  preserve. Same move as 5_01's persistent case facts block, one level up:
  facts held outside the conversation entirely, so they also survive
  `/compact`.
- Concurrent scratchpad writers need `appendFile`, not read-modify-write:
  parallel Phase 1 subagents each read the same "existing" content and the
  last write wins, silently dropping a section.
- Summary injection between phases fixes the cold-start problem: subagents
  inherit nothing, so a Phase 2 agent with no injected summary rediscovers
  Phase 1's architecture and asks worse questions for lack of it. The
  injected block carries what was learned (architecture, key chain,
  critical concern) AND the phase objective, plus an explicit
  "do not re-explore" instruction - and it is built from the structured
  findings, never from Phase 1's raw output, or the verbosity just moves
  forward one phase.
- A state manifest is not `--resume`: `--resume` needs a session that
  survived and restores raw history including stale tool results, while a
  manifest is an agent-authored file (sessionId, phase, exploredPaths,
  keyFindings, nextSteps, openQuestions) that survives a crash, holds
  distilled findings, and is consumed by INJECTION into a fresh session.
  Checkpoint after every subagent, not once per phase - that is what
  bounds a crash to one step's work. Scratchpad = in-session recall;
  manifest = cross-session recovery, which is why only the manifest carries
  phase and next steps.
- Restarting a degraded session without persisting state first is the trap:
  it discards everything the session learned. Persist, then inject.
- Forced `tool_choice` guarantees the tool CALL, not a complete payload
  (observed in 5_04): a subagent whose `report_findings` JSON runs past
  `max_tokens` is truncated mid-object, the partial JSON cannot be parsed,
  and the SDK surfaces `input` as `{}` - so every field parses empty and the
  subagent silently reports "nothing found" after a full run of real
  exploration. This is 5_03's silent-suppression trap arriving through the
  serialisation layer instead of the error path. Defences: keep the schema's
  string fields explicitly short ("one sentence per finding"), budget
  `max_tokens` for the report and not just the reasoning, force the report
  with a spare turn left, and treat an empty payload as a repair signal
  (re-ask, shorter) rather than a result. `stop_reason: "max_tokens"` on the
  reporting turn is the tell.
- The aggregate metrics trap (5_05): when one document type dominates volume
  (80% standard invoices), its accuracy IS the aggregate - "97% overall" can
  hide segments running at 40-50%. Validate accuracy per document type AND
  per field segment before automating anything; the revealing comparison is
  aggregate vs worst segment, and the aggregate row belongs at the BOTTOM of
  the table where its masking effect is visible.
- Raw confidence scores are not calibrated, and the miscalibration has both a
  MAGNITUDE and a DIRECTION per segment: the same reported 0.7 band can mean
  ~62% actual accuracy on receipt dates and ~50% on international vendor
  names. Calibrate against a labelled validation set by bucketing each
  type-field segment into confidence bands and measuring actual accuracy per
  band - the output is a lookup table (document type, field, reported
  confidence) -> expected accuracy. One global threshold cannot route what
  varies per segment.
- Calibration lookups need hygiene: ignore bands with too few labelled
  samples (their accuracy estimate is noise) and fall back to the nearest
  reliable band; fall back to the raw score only when a segment has no
  validation data at all.
- High-confidence extractions are the monitoring blind spot: low-confidence
  items already reach humans, but automated items are seen by no one, so a
  novel error pattern arriving at unchanged confidence is invisible to a
  review-the-uncertain-only policy. Stratified random sampling across every
  document type x confidence band stratum - proportional to volume, minimum
  one item per stratum, explicitly INCLUDING the high-confidence strata -
  plus a comparison of observed vs calibration-expected error rate is what
  turns that blind spot into a drift alarm.
- Review routing spends scarce human capacity by uncertainty, never by
  arrival order: a priority queue keyed on CALIBRATED confidence (the
  weakest field's expected accuracy, since one suspect field is reason
  enough for review) that reorders as new extractions arrive. Keyed on raw
  confidence instead, the queue provably reviews some pairs in the wrong
  order - a raw 0.76 international document can be riskier than a raw 0.71
  handwritten receipt.
- Provenance is structural, not stylistic (5_06): a claim-source mapping
  carries five REQUIRED fields - claim, sourceUrl, documentName,
  relevantExcerpt, publicationDate. An optional provenance field is a field
  the model may omit, and one missing link breaks the chain (no excerpt =
  unverifiable, no date = uninterpretable). Enforce the shape at the
  SUBAGENT boundary with a forced tool schema - if subagents return prose,
  attribution is already lost before synthesis begins.
- publicationDate is interpretive data, not metadata tidiness: two sources
  reporting different numbers for the same measure with different dates is
  often a revision, a different reporting period, or a methodological
  change - not a contradiction. Never adjudicate: preserve BOTH values with
  full attribution and a possibleExplanation naming the temporal /
  methodological / scope differences, and let the consumer decide. Picking
  one destroys information and presents false certainty.
- Synthesis is the pipeline's most common attribution failure point: the
  model naturally compresses and paraphrases, and mappings die unless the
  prompt explicitly requires an inline citation [n] per claim plus a
  references section carrying URL + document name + date. Verify
  MECHANICALLY (distinct citations / total findings, URLs present) - given
  identical numbered findings and no instruction, the naive arm drops
  attribution even though it has everything it needs to cite.
- Conflict detection needs a canonical grouping key emitted at research time
  (an identical `measure` key for claims reporting the same quantity, while
  the subagent still has the sources in front of it) - reconstructing groups
  downstream by fuzzy claim matching is lossy inference.
- Rendering is content-typed - numerical comparisons as tables, narrative
  events as prose, specifications as lists - but attribution is
  format-invariant: every rendered claim keeps its citation marker and
  source identity. Classify by the most SPECIFIC signal first (technical
  vocabulary before numeric presence), because specifications cite numeric
  thresholds too ("above 100 MW") and a numbers-first test misroutes them
  into the financial table.
