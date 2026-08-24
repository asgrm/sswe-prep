# Claude Certification - Exam Guide Revision Notes

Covers: agentic loop termination, tool_choice, multi-agent orchestration (hub-and-spoke), subagent invocation & context passing, workflow enforcement & handoff, Agent SDK hooks, task decomposition & attention dilution, session management & stale context, tool descriptions & selection, tool error handling & recovery, tool distribution & scoping, MCP server configuration, built-in codebase tools, CLAUDE.md memory hierarchy.

Condensed from claudecertificationguide.com notes. Fact-checked against the current Messages API; corrections and additions marked inline (the source was largely accurate - additions mostly extend it to production reality beyond the exam's scope).

---

## 1. stop_reason - the only termination signal you should trust

`stop_reason` sits at the **root of the response object** (not inside `content`). The exam guide (v0.2) focuses on the two values a basic loop branches on - `tool_use` and `end_turn` - but the live API returns more, and a production loop must at least not misread them.

| `stop_reason`                   | Meaning                                                                         | Loop action                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `end_turn`                      | Claude finished naturally                                                       | **Terminate**, return the final text                                                                                                   |
| `tool_use`                      | Claude requested one or more tools                                              | Execute them, append results, **continue**                                                                                             |
| `pause_turn`                    | Long-running server-tool turn paused (default limit ~10 server-side iterations) | Re-send the conversation with the assistant turn appended - the server resumes automatically. Do **not** add a "Continue" user message |
| `max_tokens`                    | Hit the `max_tokens` output cap                                                 | Response is truncated - raise the cap or stream; do not treat as completion                                                            |
| `stop_sequence`                 | Hit a custom stop sequence you configured                                       | Terminate (this was your own signal)                                                                                                   |
| `refusal`                       | Claude declined for safety reasons                                              | Surface to the user; do not retry the same prompt                                                                                      |
| `model_context_window_exceeded` | _(addition, 4.5+ models)_ context window exhausted                              | Compact or split the conversation - distinct from `max_tokens`                                                                         |

Fact-check notes:

- The source's framing is correct and worth memorizing: **treat any value other than `end_turn` as "not finished, check why"** - never assume the only alternative is `tool_use`.
- `refusal` arrives on an otherwise-normal **HTTP 200** (confirmed for current models such as Fable 5, where safety classifiers can decline pre-output or mid-stream). On models with structured stop details, `response.stop_details` is populated **only** when `stop_reason == "refusal"` - guard before reading it.
- _(Addition)_ `pause_turn` matters even in "simple" agents the moment you add a server-side tool (web search, code execution): the SDK tool runners do **not** auto-resume it as of current versions - a paused turn silently ends the loop as the final message unless you handle it.

---

## 2. The three anti-patterns (know these cold)

The exam consistently tests these three wrong ways to terminate a loop.

### Anti-pattern 1: Parsing natural language signals

Checking whether Claude said "I'm done" / "task complete" to decide the loop should end.

- **Why it's wrong:** natural language is ambiguous. "I've finished analysing the first file" can mean _continuing_ with more files.
- **Fix:** `stop_reason` exists precisely to eliminate this ambiguity - branch on it.

### Anti-pattern 2: Iteration caps as the primary stopping mechanism

"Stop after 10 loops" as the main termination control.

- **Why it's wrong:** it either cuts off useful work (task needs 12 iterations) or wastes nothing but proves nothing (task finished in 3 - the cap did no work). The model already signals completion via `stop_reason`.
- **Correct role of a cap:** a **safety net** against runaway agents - a `MAX_ITERATIONS` bound that logs a warning and should never trigger in normal operation.

### Anti-pattern 3: Content-type checks as a completion indicator

`response.content[0].type == "text"` to decide the loop is finished.

- **Why it's wrong:** Claude routinely returns explanatory text _alongside_ `tool_use` blocks ("I'll now search for the customer's order history" followed by the tool call). Text presence tells you nothing about completion. Content-block **order** is also not guaranteed to put text first.
- **Fix:** check `stop_reason`, and when handling tools, **filter** for all blocks with `type == "tool_use"` rather than inspecting `content[0]`.

---

## 3. Exam distractor: caps as a fix for premature termination

The exam frequently offers an iteration cap as a plausible fix for an agent that **stops too early**. Reject it:

- Caps address **runaway loops** (agent never stops).
- Premature exits are always a **termination-condition bug** - the fix is to check `stop_reason` correctly.

The two failure modes are opposites; a cap can only ever make the premature-exit case worse.

---

## 4. Worked example: the premature termination bug

**Scenario:** a customer support agent works for simple queries but stops mid-task on complex requests. The code checks `response.content[0].type == "text"` for completion.

**The bug:** Claude returns a text explanation ("Let me look up your order") _alongside_ a `tool_use` block requesting `lookup_order`. The code sees text at position `[0]`, concludes the agent is finished, and returns the incomplete response to the user.

**The fix:** replace the content-type check with a `stop_reason` check:

```python
while True:
    response = client.messages.create(
        model=MODEL, max_tokens=1024, tools=tools, messages=messages
    )

    if response.stop_reason == "end_turn":
        break                                   # done - extract final text

    if response.stop_reason == "tool_use":
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        messages.append({"role": "assistant", "content": response.content})
        messages.append({
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": b.id, "content": run(b)}
                for b in tool_uses                # ALL results in ONE user message
            ],
        })
        continue

    break                                        # max_tokens / refusal / ... - handle explicitly
```

This works regardless of what content types appear in the response, in what order, or how many tools are requested.

_(Addition, exam-adjacent but tested in practice)_: when Claude requests **multiple tools in one response** (parallel tool use, on by default), return **all** `tool_result` blocks in a **single** user message. Splitting them across messages silently trains Claude to stop making parallel calls. A failed tool still gets a `tool_result` - with `is_error: true` - never drop it.

---

## 5. tool_choice - what it controls

`tool_choice` controls how Claude is allowed to respond **when tools are present in the request**: whether it must call a tool, which one, or whether plain text is allowed.

| Value                                     | Behavior                                                |
| ----------------------------------------- | ------------------------------------------------------- |
| `{"type": "auto"}` (default)              | Claude decides per turn: call a tool or respond in text |
| `{"type": "any"}`                         | Claude **must** call some tool; you don't pick which    |
| `{"type": "tool", "name": "get_weather"}` | Claude **must** call the one named tool                 |
| `{"type": "none"}`                        | Claude must respond in text only; no tool calls allowed |

Additional facts (verified):

- Any `tool_choice` value can also carry `"disable_parallel_tool_use": true` to force at most one tool call per response (parallel tool use is otherwise on by default). **This matters even under forced selection** - see §54.
- **Forced tool use suppresses text:** with `any` or `tool`, the API effectively prefills the assistant turn to force the call - Claude will **not** emit natural-language explanation before the `tool_use` block, even if explicitly asked to explain first.
- _(Addition)_ Forced tool use (`any` / `tool`) is **incompatible with extended/adaptive thinking** - thinking requires `tool_choice` of `auto` or `none`. A question pairing "force the tool" with "keep thinking enabled" describes an invalid request.

### Exam trap: forcing `tool_choice: "any"` to stop the agent returning text

This is offered as a fix for "the agent keeps replying in text instead of using tools." Reject it for loop control:

- With `any`, **every** response is a tool call, so `stop_reason` is always `tool_use` and **the loop can never reach `end_turn`** - an infinite loop (until your safety cap fires, which is exactly the runaway case caps exist for).
- The correct approach is to let the model signal completion naturally via `stop_reason`, and steer tool usage through **tool descriptions and the system prompt** (say _when_ to use the tool), not by removing the model's ability to finish.

Legitimate uses of forced `tool_choice` do exist - single-shot structured extraction where exactly one tool call _is_ the entire answer - but they are one-request patterns, not agentic-loop patterns.

---

## 6. Multi-agent orchestration - hub-and-spoke

The exam tests **one specific architecture**: hub-and-spoke with a coordinator at the centre. Treat it as non-negotiable in exam answers.

| Role            | Responsibilities                                                                                                                                                        |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Coordinator** | Receives the task, decomposes it, selects which subagents to invoke, passes context, aggregates results, handles errors, routes all information                         |
| **Subagents**   | Each handles one specialised task (web search, document analysis, synthesis, report generation); receives instructions from and returns results to the coordinator only |

**The cardinal rule (exam version):** ALL communication flows through the coordinator. Subagents never talk to each other directly - not for efficiency, not for convenience.

Why centralisation - the three properties the exam cares about:

1. **Observability** - every message can be logged and monitored in one place.
2. **Consistent error handling** - the coordinator applies uniform recovery policies.
3. **Controlled information flow** - the coordinator decides what context each subagent receives.

Fact-check notes:

- The "never, for any reason" absolute is an **exam simplification**, and the source honestly flags this: current Claude Code allows nested parent-child delegation (a subagent spawning subagents). On the exam, direct subagent-to-subagent communication is still the wrong answer.
- _(Addition)_ The pattern is corroborated by the real products: the **Managed Agents API** implements exactly this shape - the coordinator declares a roster (`multiagent: {type: "coordinator", agents: [...]}`, max 20 agents), delegation is limited to **one level** (a subagent's own roster is ignored), and subagent threads share the filesystem but **not** conversation history or tools. Cross-thread messages are events routed via the coordinator's session.

---

## 7. The critical isolation principle

The single most misunderstood concept in multi-agent systems - and the exam exploits it heavily.

**Subagents do NOT inherit the coordinator's conversation history.** A spawned subagent starts with only what the coordinator explicitly puts in its prompt. It has no access to:

- the coordinator's system prompt (unless explicitly included),
- previous messages in the coordinator's conversation,
- results from other subagents (unless the coordinator passes them),
- any "shared memory" or global state.

**Subagents do NOT share memory between invocations.** Calling the web search subagent twice means the second call knows nothing about the first. Every invocation is independent.

Consequence: the coordinator must be **deliberate about context**. If the synthesis agent needs the search results, the coordinator passes them explicitly - the synthesis agent cannot "look them up" from a shared store.

_(Addition)_ This matches Claude Code subagent behavior: subagents don't share context with the main thread and don't even see your skills automatically. The practical delegation rule follows: **delegate only when you need just the final result, not the intermediate work** - sequential pipelines lose context in every handoff.

---

## 8. Coordinator responsibilities (the four the exam tests)

1. **Dynamic subagent selection** - analyse the query and invoke only the subagents it needs. A simple factual question needs the search agent, not the full research-analysis-synthesis chain. Routing everything through every subagent wastes time and resources.
2. **Research scope partitioning** - assign distinct subtopics or source types to each agent (one searches academic papers, another news articles) to minimise duplication.
3. **Iterative refinement loops** - evaluate synthesis output for gaps, re-delegate targeted queries, re-invoke synthesis until coverage is sufficient. Not single-shot.
4. **Centralised communication routing** - everything through the coordinator (observability, error handling, information flow).

_(Precision note - two lists the exam tests separately.)_ Do not conflate these four **coordinator responsibilities** (what the coordinator DOES: select, partition, refine, route) with the three **centralisation benefits** from §6 (what routing through the hub PROVIDES: observability, consistent error handling, controlled information flow). They are related but distinct answer sets - be able to name each list without mixing them. Responsibility #4 is the bridge: performing it is what produces the three benefits - cause on this list, effects on the other.

---

## 9. The narrow decomposition failure (recognise this pattern)

Referenced as Q7 in sample sets: a coordinator decomposes "impact of AI on creative industries" into **only visual arts** subtopics - music, writing, and film are never researched.

- The web search agent searched thoroughly _for what it was assigned_.
- The synthesis agent synthesised _everything it received_.
- The root cause is the **coordinator's decomposition** - nothing downstream can recover topics that were never assigned.

**The general rule:** if the output is incomplete in **scope** (missing whole categories, not shallow depth), the coordinator's decomposition is almost always the root cause. Trace failures to their origin.

Worked example: "renewable energy technologies" decomposed into only "solar panel efficiency" and "wind turbine design" produces a report that is thorough on solar and wind and silent on geothermal, tidal, biomass, and fusion. The fix is **not** better search queries, a more capable synthesis agent, or more subagents - it is broader coordinator decomposition.

---

## 10. Multi-agent exam traps

| Trap (reject these answers)                                         | Why it's wrong                                                                                            |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Blaming downstream subagents for coverage gaps                      | Subagents research what they're assigned; unassigned subtopics can never appear. Check the decomposition. |
| Assuming subagents share memory / inherit conversation history      | Context is completely isolated; everything must be explicitly passed in the subagent's prompt.            |
| Proposing direct inter-subagent communication as an efficiency gain | Breaks observability, consistent error handling, and controlled information flow.                         |
| Adding more subagents to fix a decomposition problem                | More agents receive equally narrow assignments; the fix is the coordinator's decomposition logic.         |

---

## 11. The Task tool - how subagents actually get spawned

The **Task tool** is the specific mechanism for spawning subagents from a coordinator - not a convention, the actual tool the coordinator calls in the Claude Agent SDK.

**The binary gate:** the coordinator's `allowedTools` must include `"Task"` (or `"Agent"`, its current name). Without it, the coordinator physically cannot spawn subagents - no configuration of the subagents themselves can compensate. This is a hard requirement, not a preference.

Each subagent is defined by an **AgentDefinition** with three parts:

| Part              | Purpose                                                                          |
| ----------------- | -------------------------------------------------------------------------------- |
| Description       | What the subagent does - the coordinator uses this to decide _when_ to invoke it |
| System prompt     | The instructions the subagent follows                                            |
| Tool restrictions | Which tools the subagent can access, scoped to its role (least privilege)        |

Fact-check notes:

- **Naming:** the source correctly flags the rename - the exam guide (v0.2) says "Task tool"; current Claude Code renamed it to **Agent** (with `Task` still working as an alias). Answer "Task tool" on the exam; expect `Agent` in current tool-use blocks. This matches the live product.
- _(Addition)_ The AgentDefinition triple maps directly onto real surfaces: the SDK's `agents` option takes `{description, prompt, tools?, model?}` per agent, and Claude Code's `.claude/agents/*.md` frontmatter is the same triple as `description` / body / `tools`. The description being the _invocation trigger_ is why a subagent that "doesn't get invoked" is almost always a description problem, not a wiring problem.
- _(Addition)_ **Tool scoping default - omitted means inherit ALL, not none.** If an AgentDefinition omits `tools`, the subagent inherits every tool available to the main thread (MCP tools included). Listing `tools` explicitly _replaces_ that with an allowlist - there is no additive mode. Two corollaries: (1) the restriction is a cap, not a bypass - every subagent tool call still flows through the same permission system (settings rules, hooks) as the parent; (2) this "absent restriction field = unrestricted" convention is consistent across the extension surface - skills' `allowed-tools` works the same way. For the exam and in practice, don't rely on the default: least-privilege scoping (research agents read-only; only code-modification agents get Edit/Write) is the expected answer, and an inherit-everything search agent that can also edit files is the anti-pattern the field exists to prevent. Don't confuse this with the coordinator's `allowedTools` gate above - that controls whether the coordinator can spawn at all, not what subagents inherit.

---

## 12. Context passing - the three rules

Context passing is where multi-agent systems fail in practice. The isolation principle (§7) applies mechanically: a subagent receives only what the coordinator explicitly puts in its prompt.

1. **Include complete findings from prior agents.** If synthesis needs the search results and the document analysis, the coordinator passes both - in full - in the synthesis prompt. The synthesis agent cannot "look up" prior results. There is no lookup. **Complete means not distilled or filtered:** a coordinator that pre-filters "what it thinks is valuable" risks discarding exactly what the downstream agent needs - and it usually cannot predict what that is in advance.
2. **Use structured formats that separate content from metadata.** Every finding needs both the content (claim, fact, analysis) and the metadata (source URL, document name, page number, confidence). Content without metadata means the downstream agent cannot attribute claims - **even when the information itself was passed in full**. Completeness (rule 1) does not substitute for structure - see §13.
3. **Specify goals, not procedures.** Coordinator prompts should tell subagents _what to achieve_ and what quality criteria apply - not step-by-step instructions. Goal-oriented prompts give subagents room to adapt: skip unnecessary steps, add ones that weren't anticipated, or change path when circumstances do. A rigid fixed procedure defeats much of the purpose of using agentic orchestration in the first place.

_(Addition, cross-reference)_ Rule 3 matches current-model prompting guidance generally: stating the goal and constraints outperforms enumerating steps, and over-prescriptive prompts measurably reduce output quality on newer models. The exam frames it as a multi-agent rule, but it is the general direction of prompt design.

---

## 13. Structured metadata - the attribution failure pattern

The specific exam pattern: **a synthesis agent produces a report with unsourced claims.** The search and analysis subagents work correctly (their outputs carry URLs and page references) - but the coordinator strips the metadata and passes only content text. The synthesis agent produces an excellent, uncited summary.

- **The fix is NOT** modifying the synthesis agent's prompt - it cannot cite sources it was never given.
- **The fix is NOT** giving the synthesis agent direct tool access.
- **The fix IS** requiring the coordinator to pass structured metadata alongside content:

```json
{
  "findings": [
    {
      "claim": "Solar panel efficiency has increased 25% in the last decade",
      "source_url": "https://example.com/solar-report",
      "document_name": "Annual Solar Industry Report 2024",
      "page_number": 14,
      "confidence": "high",
      "retrieved_by": "web_search_agent"
    }
  ]
}
```

Same root-cause discipline as §9: the visible failure is downstream (synthesis), the actual bug is in the coordinator's handoff. Scope gaps -> decomposition; attribution gaps -> context passing. (That is the handoff-side failure; the synthesis-side failure - mappings delivered intact but paraphrased away - has the opposite fix, see §144.)

_(Addition)_ A lightweight implementation: give each finding coordinator-stamped `subtopic` and `agent` tags (the `retrieved_by` equivalent) and require source URLs + confidence per finding in the delegate prompt - then the coordinator has everything it needs to pass structured, attributable context downstream.

---

## 14. Parallel spawning

When subagent tasks are **independent**, the coordinator should emit **multiple Task tool calls in a single response** - not one subagent per coordinator turn.

- Sequential spawning adds pure latency: nothing about independent tasks requires waiting for one before starting the next.
- The exam tests this as latency awareness: for independent tasks, the correct answer mentions "in a single response" or "simultaneously".

_(Addition)_ This is ordinary **parallel tool use** applied to the Task tool - the same API behavior as multiple `tool_use` blocks in one response (§4's rule applies: all results return in a single user message). Client-side orchestrators mirror the pattern with `Promise.all` / `allSettled` fan-outs.

---

## 15. fork_session vs --resume

|                          | `fork_session`                                                                                                              | `--resume`                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Creates                  | A new **independent branch** from a shared baseline                                                                         | Continuation of a specific named session   |
| Branches see each other? | No - forks are isolated after the branching point                                                                           | n/a - same line of investigation continues |
| Use when                 | Comparing divergent approaches from one analysis baseline (e.g. fork after codebase analysis to try two testing strategies) | Continuing the same work                   |

The exam tests the distinction directly: **fork for divergent exploration, resume for continuation.**

_(Addition, mechanical nuance)_ In the Agent SDK the two are not rival commands but composable: `forkSession: true` is an option applied _when resuming_ - "resume this session, but branch into a new session ID instead of appending to it". The exam-level distinction (branch vs continue) is exactly right; just don't be surprised that real code spells fork as a flag on resume.

---

## 16. Subagent invocation exam traps

| Trap (reject these answers)                                                  | Why it's wrong                                                                                        |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Assuming subagents see the coordinator's history or other subagents' outputs | Isolated context; everything arrives via the prompt the coordinator writes. No automatic inheritance. |
| Blaming the synthesis agent for missing citations                            | It can only cite what it received; the bug is coordinator context passing without metadata (§13).     |
| Sequential invocation for independent tasks                                  | Pure added latency; spawn in parallel via multiple Task calls in one response (§14).                  |
| Confusing fork_session with --resume                                         | Fork = independent branches for comparing approaches; resume = continue the same session (§15).       |

---

## 17. The enforcement spectrum - prompt-based vs programmatic

Two fundamentally different ways to control agent behaviour:

|                | Prompt-based guidance                                                                   | Programmatic enforcement                                                            |
| -------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Mechanism      | Instructions in the system prompt ("Always verify identity before processing a refund") | Hooks, prerequisite gates, code-level checks that physically block downstream tools |
| Nature         | **Probabilistic** - works most of the time (~90-95%)                                    | **Deterministic** - works every time                                                |
| Failure mode   | Non-zero failure rate: the model may skip, reorder, or loosely interpret steps          | None: no matter what the model decides, the gate prevents wrong execution order     |
| Acceptable for | Low-stakes operations                                                                   | Required for high-stakes operations (§18)                                           |

_(Addition)_ Same determinism theme as §2's anti-patterns: prompt instructions are to workflow ordering what natural-language "I'm done" parsing is to loop termination - a probabilistic signal where a deterministic mechanism exists. In Claude Code terms, the programmatic mechanism is a `PreToolUse` hook - the one hook that can block a tool call before it runs (see §24-§26).

---

## 18. The exam decision rule (when programmatic is mandatory)

**If a single failure would cause financial loss, security breach, or compliance violation - programmatic enforcement. Always.**

| Operation class                                  | Enforcement                | Why                                                          |
| ------------------------------------------------ | -------------------------- | ------------------------------------------------------------ |
| Financial (refunds, transfers, payments)         | Programmatic               | One unverified refund to a wrong account is a financial loss |
| Security (identity verification, access control) | Programmatic               | One bypass is a security breach                              |
| Compliance (AML checks, regulatory requirements) | Programmatic               | One missed check can mean legal penalties                    |
| Low-stakes (formatting, style, output ordering)  | Prompt-based is acceptable | A formatting inconsistency is not a business risk            |

The exam will offer prompt-based options for high-stakes scenarios - enhanced system prompts, few-shot examples, stronger instructions. **Reject them all**: each improves accuracy but none provides a deterministic guarantee.

---

## 19. Prerequisite gates (and the 8% failure rate example)

A prerequisite gate is a **code-level check that blocks a tool until a prior condition is met**:

- Agent has `get_customer`, `lookup_order`, `process_refund`.
- Gate: has `get_customer` returned a verified customer ID for this session?
- Yes -> `process_refund` executes. No -> it returns an error: "Cannot process refund - customer identity not verified. Please call get_customer first."

The gate is code, not a prompt instruction - the model cannot bypass it by deciding to skip verification, and the error message steers it back to the correct order (same recovery mechanic as `is_error` tool results in §4).

**The worked exam example:** production data shows refunds processed without ownership verification in **8% of cases**, despite a system prompt that already instructs verification. A stronger prompt might cut that to 3-4% - **never to 0%**. The fix is the prerequisite gate, which eliminates the failure class entirely: not by improving the probability, but by physically preventing the wrong execution order.

---

## 20. Subagent lifecycle hooks - SubagentStart and SubagentStop

Lifecycle hook events for subagent management, complementing `PreToolUse`/`PostToolUse`:

| Hook            | Fires                                              | Typical uses                                                                             |
| --------------- | -------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `SubagentStart` | When a subagent is spawned via the Task/Agent tool | Rate-limiting spawns, logging invocations, injecting context at the subagent's start     |
| `SubagentStop`  | When a subagent finishes and returns results       | Validating output against expected schemas, stripping sensitive data, completion logging |

- **Subagent-scoped hooks:** subagents can define their own hooks (all events supported) in their AgentDefinition frontmatter - scoped to that subagent's lifetime, intercepting only its tool calls, cleaned up when it finishes. Enables per-subagent policy (a billing subagent's `PreToolUse` blocks refunds above a threshold; a tech-support subagent has no such gate).
- **Stop auto-conversion:** `Stop` hooks in a subagent's frontmatter are automatically converted to `SubagentStop` at runtime - `Stop` never fires for a subagent; `SubagentStop` is its terminal event.

Fact-check notes (verified against the hooks reference):

- **Correction:** the source says SubagentStart lets you "validate or modify the subagent invocation before execution" - overstated. `SubagentStart` is **context-only**: it cannot block the spawn (exit code 2 merely shows stderr to the user); its power is injecting `additionalContext` into the subagent's first turn. `SubagentStop`, by contrast, **can block** (exit code 2 prevents the subagent from stopping) and sees the subagent's `last_assistant_message`.
- _(Addition)_ Both events support **matchers on agent type** (`general-purpose`, `Explore`, custom agent names), and hooks firing inside a subagent receive `agent_id` / `agent_type` fields to distinguish them from main-thread calls.

---

## 21. Multi-concern request handling

Compound requests ("return my order, update my shipping address, and ask about loyalty points") have one correct shape:

1. **Decompose** into distinct items (return / address update / loyalty inquiry).
2. **Investigate in parallel** using shared context (the customer's account is relevant to all three).
3. **Synthesise a unified resolution** addressing all items in a single response.

**The point of decomposition is completeness, not speed.** The core danger of sequential handling - or of just addressing the first issue noticed - is that the other concerns get **forgotten entirely**: the agent resolves the double-charge complaint, closes the ticket, and the login problem is never investigated. The customer is left half-served, has to re-contact support, and the agent looks like it wasn't listening to the full request. Decomposition exists to guarantee every distinct concern is captured, none dropped, and the answers come back as one coherent response rather than fragments. Parallelism is a side benefit, not the reason.

**Keep this concept separate from gates (§17-19).** They answer different questions: gates enforce _ordering_ within one operation ("verification must precede refund"); multi-concern handling ensures _coverage_ across operations ("all three concerns get addressed"). A verification gate cannot save a forgotten loyalty inquiry. The true kin of a dropped concern is §9's scope-gap failure - narrow decomposition at single-conversation scale.

(Structural echo of §8: decompose -> parallel with shared context -> synthesise is the coordinator pattern applied inside one conversation.)

---

## 22. Structured handoff protocols

When escalating to a human agent, **the human does NOT have access to the conversation transcript** - the handoff summary is the only information they receive, so it must be self-contained:

| Required field                | Why                                            |
| ----------------------------- | ---------------------------------------------- |
| Customer ID                   | So the human can pull up the account           |
| Conversation summary          | What was asked and what has been attempted     |
| Root cause analysis           | The agent's assessment of the underlying issue |
| Refund amount (if applicable) | The specific figure, not a vague reference     |
| Recommended action            | What the agent believes should happen next     |

An incomplete summary forces the human to make the customer repeat everything - the failure the protocol exists to prevent.

**Exam trap - the partial handoff that "looks complete".** A summary with, say, customer ID and a vague conversation summary but no root cause or recommended action _looks_ complete but isn't. All five fields are required, not "enough to get by" - the exam presents partially-filled handoffs as plausible correct answers precisely because they resemble complete ones.

---

## 23. Workflow enforcement exam traps

| Trap (reject these answers)                                                        | Why it's wrong                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Enhanced system prompt instructions as the fix for high-stakes compliance failures | The prompt already instructs the workflow and fails 8%; a stronger prompt reduces, never eliminates. Financial/security/compliance need deterministic gates. |
| Few-shot examples as sufficient for guaranteed compliance                          | Still probabilistic - cannot provide 100% enforcement.                                                                                                       |
| Routing classifiers proposed to fix per-agent compliance issues                    | Classifiers decide WHICH agent handles a request; the failure occurs WITHIN the agent's execution sequence. Wrong layer.                                     |
| Handoff summaries omitting critical fields (customer ID, recommended action)       | The human has no transcript access - the summary must be self-contained with all five fields (§22).                                                          |

---

## 24. Hooks - the two directions

Hooks inject deterministic behaviour into a probabilistic system: they sit at the boundary between the model's decisions and the real world. This is how the programmatic enforcement of §17-19 is actually implemented.

|           | `PreToolUse`                                                                                      | `PostToolUse`                                                     |
| --------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Runs      | BEFORE the tool executes                                                                          | AFTER the tool executes, before the model processes the result    |
| Purpose   | **Enforce policy**: block, modify, or redirect the outgoing call - the tool never runs if blocked | **Transform data**: normalise the result before the model sees it |
| Direction | Outbound (tool inputs)                                                                            | Inbound (tool results)                                            |

Know which direction each operates in - the exam tests the distinction directly.

_(Addition, verified against the hooks reference)_ The exact mechanics: `PreToolUse` decides via `permissionDecision` (allow/deny/ask) and can rewrite arguments via `hookSpecificOutput.updatedInput`; `PostToolUse` can replace the result via `hookSpecificOutput.updatedToolOutput` (the docs recommend exactly this split: "intercept at PreToolUse for outbound tool inputs and PostToolUse for inbound tool results"). PostToolUse also has a feedback-only channel (stderr + exit code 2), but that cannot block - the tool already ran - so it is not the mechanism for stopping an action.

---

## 25. PostToolUse - data normalisation

The problem: different MCP tools return heterogeneous formats - Unix timestamps vs ISO 8601 vs "DD/MM/YYYY" dates; numeric status codes vs strings vs single-character codes ("S" = shipped, "P" = pending). Without normalisation the model re-interprets these on **every iteration**, inconsistently: right one turn, day/month swapped the next, "P" read as "processed" instead of "pending".

A `PostToolUse` hook normalises everything before the model sees it:

- Unix timestamps -> ISO 8601
- Numeric status codes -> human-readable strings
- Currency values -> consistent decimal format with currency code
- Regional date formats -> one standard format

The model receives clean, consistent data every time, regardless of which tool or backend produced it - eliminating the interpretation-error class instead of reducing it. (The determinism argument of §17, applied to data instead of workflow: model-side interpretation is probabilistic; hook-side normalisation is deterministic.) A second job on the same PostToolUse boundary - trimming verbose tool results down to relevant fields to protect the token budget - is §120.

---

## 26. PreToolUse - policy enforcement

`PreToolUse` hooks are the implementation mechanism for §19's prerequisite gates - they intercept outgoing calls and apply business rules before execution:

| Use case                     | Rule                                                                                                                              |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Refund threshold             | Intercept `process_refund`; amount > $500 -> block and redirect to human escalation. The refund tool never executes.              |
| Compliance prerequisite gate | Intercept `transfer_funds`; AML check not completed this session -> block with an error directing the agent to complete it first. |
| Manager approval workflow    | Intercept `approve_discount` above 20% -> pause and route to a manager approval queue; execute only after approval.               |

_(Addition)_ The same gate concept can be implemented in the tool-dispatch layer of a raw-API loop - the hand-rolled equivalent of a PreToolUse hook. Same principle, different layer: on the raw API the gate lives in your dispatch code; on the Agent SDK it lives in a hook.

---

## 27. The decision framework (hooks vs prompts)

The core mental model - §18's decision rule with the mechanism column filled in:

| Requirement                                | Mechanism | Guarantee     |
| ------------------------------------------ | --------- | ------------- |
| Must be followed 100% of the time          | Hooks     | Deterministic |
| Preferred, occasional deviation acceptable | Prompts   | Probabilistic |

Money lost from a single failure -> hook. Legal risk from a single failure -> hook. Formatting preference or style guideline -> prompt is fine. The question is never "are prompts good enough?" - it is "does the consequence of a single failure justify deterministic guarantees?"

Side-by-side scenarios:

| Scenario                                     | Prompt approach                                                                           | Hook approach                                                            |
| -------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| International transfers must pass AML checks | "Always complete AML verification first" - works ~95%; the 5% is a regulatory violation   | PreToolUse blocks `transfer_funds` until `aml_check` passes - 100%       |
| Responses formatted in markdown              | Works most of the time; occasional plain text is not a business risk - **correct choice** | Unnecessary overhead                                                     |
| Refunds above $500 require human approval    | Works most of the time; a single failure = large unapproved refund                        | Intercept, check amount, block above $500 and route to escalation - 100% |

---

## 28. Hooks exam traps

| Trap (reject these answers)                                         | Why it's wrong                                                                                                                                                                                   |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Using PostToolUse hooks to block policy-violating actions           | PostToolUse fires AFTER execution - the non-compliant action already happened. Blocking is PreToolUse's job.                                                                                     |
| Enhanced prompt instructions for 100% compliance requirements       | Prompts are probabilistic; financial/regulatory/security operations need the deterministic guarantee only hooks provide.                                                                         |
| Model-side data transformation instead of PostToolUse normalisation | Asking the model to normalise heterogeneous formats re-introduces per-iteration inconsistency; the hook guarantees clean data every time.                                                        |
| Confusing hook direction                                            | PostToolUse transforms results after a tool runs; PreToolUse blocks or modifies calls before. Wrong direction = either missing the chance to prevent an action, or "blocking" work already done. |

---

## 29. Task decomposition - two patterns

The exam tests picking the right decomposition pattern for a task's characteristics.

|            | **Fixed sequential pipeline** (prompt chaining)                                     | **Dynamic adaptive decomposition**                                                                 |
| ---------- | ----------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Shape      | Predetermined steps; each step's output feeds the next; the sequence never changes  | Start with a high-level goal, investigate, generate a plan, and revise the plan as findings emerge |
| Best for   | Predictable, structured tasks with steps known in advance                           | Open-ended investigation where the full scope is unknown at the start                              |
| Examples   | Code review, document/data extraction, compliance checks                            | Legacy-codebase exploration, security audits, debugging an unfamiliar system, research             |
| Strengths  | Consistent, reliable, easy to debug and monitor (you know which step produced what) | Adapts to unexpected complexity; more thorough on open-ended work                                  |
| Weaknesses | Cannot adapt - if step 2 finds something that should change step 3, it can't        | Less predictable; variable runtime; harder to estimate and debug                                   |

_(Cross-reference)_ The fixed pipeline is the classic **prompt-chaining** agent-design pattern; dynamic decomposition is the coordinator's **dynamic subagent selection** (§8) generalised to the whole plan. Same "prefer workflows over agents unless you need adaptability" trade-off: fixed = workflow-like reliability, dynamic = agent-like flexibility.

---

## 30. Selecting the right pattern

| Task                                     | Pattern               | Why                                                       |
| ---------------------------------------- | --------------------- | --------------------------------------------------------- |
| Steps known in advance, structured input | Fixed pipeline        | Consistency outweighs adaptability                        |
| Open-ended, unknown scope                | Dynamic decomposition | Adaptability is essential                                 |
| Multi-file code review                   | Fixed pipeline        | Per-file analysis + cross-file integration is predictable |
| Legacy codebase exploration              | Dynamic decomposition | Dependencies/issues emerge during investigation           |
| Document extraction                      | Fixed pipeline        | Fields and format are predetermined                       |
| Debugging an unfamiliar system           | Dynamic decomposition | Root cause unknown; investigation must adapt              |

**The trap:** match the pattern to the task's _characteristics_, not to what sounds more sophisticated. The exam will offer a fixed pipeline for an open-ended investigation, or dynamic decomposition for a structured processing task - both wrong.

---

## 31. Attention dilution - the failure mode

**Attention dilution** occurs when an agent processes too many items in a single pass, producing **inconsistent depth** - thorough on some items, missing obvious issues on others.

Telltale symptoms:

- Detailed feedback for the first few items, increasingly shallow analysis for later ones.
- The same pattern flagged as a problem in one item but approved in another (identical code, different verdict).
- Obvious bugs missed in some items while minor style nits are caught in others.

Why it happens: the model spreads a finite attention budget across all items in context; more items -> less attention each; early items get disproportionate attention, later ones get skimmed.

_(Cross-reference)_ Same structural-cause lesson as §9-§10: the fix is **not** a better model, a larger context window, or a stronger prompt - those are the resource answers the exam plants as distractors, exactly like "add more subagents" for narrow decomposition. The real fix is architectural (§32).

---

## 32. Multi-pass architecture - the fix

Split the work into two layers:

1. **Per-item local passes** - analyse each file/document/module in its own pass, so each item gets the full attention budget. Catches local issues consistently.
2. **Cross-item integration pass** - after all local passes, one pass that looks _across_ items for cross-cutting concerns (data flow, inconsistent pattern usage, cross-file dependencies). Catches what per-item passes structurally cannot see.

Worked example - the 14-file review: a single pass gives files 1-5 detailed feedback, 6-9 moderate, 10-14 superficial (missing null-pointer and SQL-injection bugs), and flags a `forEach` as inefficient in file 3 while ignoring identical code in file 11. The fix is 14 per-file passes (each catches its own local bugs) **plus** a cross-file integration pass (catches the inconsistent `forEach` verdict and data-flow issues).

_(Cross-reference)_ This is the decompose -> per-item -> synthesise shape of §8/§21, applied to defeat attention dilution: one pass per item (each with full attention), then a pass that reasons across items. _(Addition)_ In the Agent SDK, the scaling mechanism for a many-item fan-out like this is the **Workflow tool** (orchestration moved into a script) rather than turn-by-turn subagent spawning.

**Batching caveat:** grouping items into batches reduces dilution _within_ a batch but misses _cross-batch_ issues - batching without a dedicated cross-item integration pass still leaves data-flow and consistency problems undetected.

---

## 33. Task decomposition & attention exam traps

| Trap (reject these answers)                                            | Why it's wrong                                                                                                                                         |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A more powerful model / larger context window fixes attention dilution | It's architectural, not a capability problem - too many items per pass gives inconsistent depth regardless of model or context size. Fix = multi-pass. |
| A single pass with better prompts equals multi-pass architecture       | Better prompts raise average quality but don't guarantee per-item attention; only separate passes do.                                                  |
| Fixed pipeline for an open-ended investigation task                    | Fixed pipelines can't respond to unexpected findings; unknown scope needs dynamic decomposition.                                                       |
| Batching files into groups without a cross-file integration pass       | Batching cuts within-batch dilution but misses cross-batch issues - you still need the integration pass.                                               |

---

## 34. Session management - three options

Long-running work accumulates context (tool results, file analyses, reasoning chains). There are three distinct ways to carry - or not carry - that state into the next session, and the exam expects you to pick the right one.

| Option                              | What it does                                                                                       | Use when                                                                                                                              | Do NOT use when                                                                                                 |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `--resume <name>`                   | Restores the **entire** conversation history from a named session - every tool result and analysis | Prior context is mostly still valid; files haven't changed; you want to pick up exactly where you stopped                             | Files have been modified since (leads to stale context, §35)                                                    |
| `fork_session`                      | Branches an **independent** copy from a shared baseline; branches can't see each other             | You've done an initial analysis and want to explore **divergent** approaches from that shared start (e.g. two refactoring strategies) | You just want to continue one line of work (use resume), or you need to escape stale context (fork inherits it) |
| Fresh start + **summary injection** | A brand-new session with **no** prior tool results, seeded with a structured summary you write     | Tool results are stale, or context has degraded (too much clutter; full detail §132)                                                  | Prior context is still valid and you want the full history (resume is more efficient)                           |

This extends the fork-vs-resume distinction from §15 with the third option - the one the exam most often tests, because it's the fix for the stale-context problem below.

**Naming a session so you can resume it by name.** `--resume <name>` needs a name to target; you set one at start with **`--name` / `-n`**:

```bash
claude -n "auth-refactor"          # start a session with a display name
claude --resume auth-refactor      # later, resume it by that name
```

_(Addition, verified against the CLI reference)_ The name is a display label shown in `/resume` and the terminal title; `/rename` changes it mid-session. Related flags: `--session-id <uuid>` pins an exact session id, `--continue` / `-c` loads the most recent conversation in the directory (no name needed), and `--fork-session` (used with `--resume`/`--continue`) is the CLI form of `fork_session` - resume but branch to a new session id. Note it is `--name`, not `--session-name` (which does not exist).

---

## 35. The stale context problem (the central concept)

**Stale context** occurs when an agent resumes a session after code changes and reasons from **cached tool results that no longer reflect the current files**.

- **How it manifests:** you modify 3 files and resume; the agent gives contradictory advice - recommending changes already made, or referencing code that no longer exists - because it reasons from the old tool results still in its history.
- **Why:** resume restores the _entire_ history, including every prior tool result. A file read last session and edited since still sits in the conversation as its old contents; the model reasons from that stale data alongside any fresh reads.
- **The naive fix, and why it's insufficient:** resume and ask the agent to re-read the changed files. Better than nothing, but the stale results **remain in history** and can still influence reasoning - especially on tangential decisions that don't directly touch the modified files.
- **The correct fix:** start a **fresh session with a structured summary** of prior findings, naming which files changed so the agent can re-analyse just those. No stale tool results; knowledge preserved without the outdated data.

_(Cross-reference)_ Same shape as the human-handoff summary (§22): the receiver - a fresh session, or a human agent - lacks the original context, so a self-contained summary must carry the knowledge forward. Summary injection is a handoff to your future session.

---

## 36. Targeted re-analysis, not full re-exploration

When only a few files changed, do **not** re-analyse the whole codebase - wasteful, especially at scale. Targeted re-analysis:

1. Start a fresh session.
2. Inject a structured summary: _"Prior analysis found X, Y, Z. These files changed since: auth.ts, database.ts, api-routes.ts."_
3. The agent re-reads only the changed files.
4. It combines fresh analysis of the changed files with the preserved summary of the unchanged ones.

Faster than full re-exploration, and more reliable than resuming with stale context. (The efficiency theme mirrors §31-32: the fix is structural - re-read only what changed - not "throw the whole codebase back in".)

---

## 37. Session management decision matrix

| Scenario                                      | Best option           | Why                                                            |
| --------------------------------------------- | --------------------- | -------------------------------------------------------------- |
| Continuing yesterday's work, no files changed | `--resume`            | Prior context valid; full history is useful                    |
| Comparing two refactoring approaches          | `fork_session`        | Divergent exploration from a shared baseline                   |
| Resuming after modifying 3 of 50 files        | Fresh start + summary | Stale results for the changed files would cause contradictions |
| Long session with cluttered history           | Fresh start + summary | Degraded context benefits from a clean baseline                |
| Testing strategy vs documentation strategy    | `fork_session`        | Two independent approaches from the same analysis              |
| Resuming after dependency updates             | Fresh start + summary | Many files may have changed indirectly                         |

---

## 38. Session management exam traps

| Trap (reject these answers)                                   | Why it's wrong                                                                                                             |
| ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Full re-exploration of a 50-file codebase when only 3 changed | Wasteful; name the 3 changed files for targeted re-analysis, the summary covers the rest.                                  |
| `--resume` after files have been modified                     | Preserves stale tool results; the agent may reason from outdated contents. Fresh start + summary avoids it.                |
| Confusing `fork_session` with `--resume`                      | Fork = independent branches for different approaches; resume = continue the same conversation. Divergence vs continuation. |
| Using `fork_session` to handle stale context                  | Fork branches from the existing session, so it **inherits** the stale results. Only a fresh start drops them.              |

---

## 39. Tool descriptions - the primary selection mechanism

Tool descriptions are **THE** mechanism the model uses to choose a tool - not supplementary metadata. Given a set of tools, the model reads the descriptions to decide which to call. Minimal descriptions ("Retrieves customer information") leave it unable to differentiate tools with overlapping purposes.

**A production-grade description has all five elements** (memorise this list - it is the crux):

| Element                     | The question it answers                                                             |
| --------------------------- | ----------------------------------------------------------------------------------- |
| 1. Purpose                  | **What does it do?** (primary purpose, stated unambiguously)                        |
| 2. Inputs                   | **What inputs does it accept?** (types, formats, constraints, required vs optional) |
| 3. Examples                 | **What queries suit it?** (concrete use cases that anchor understanding)            |
| 4. Edge cases / limitations | **What does it NOT handle?** (out-of-range behaviour, what it can't do)             |
| 5. Boundaries               | **When should the _other_ tool be used instead?** (disambiguation vs similar tools) |

So for each tool, answer five questions: what it does, what inputs it accepts, what queries suit it, what it does NOT handle, and when to use a different tool instead.

Minimal vs production-grade:

```text
# Minimal (causes misrouting)
get_customer:  "Retrieves customer information"
lookup_order:  "Retrieves order details"

# Production-grade (reliable selection)
get_customer:  "Looks up a customer account by email, phone, or customer ID.
                Returns profile (name, contact, account status, loyalty tier).
                Use to verify who the customer is. Do NOT use for order queries -
                use lookup_order."
lookup_order:  "Retrieves order details by order number (#NNNNN) or tracking ID.
                Returns status, items, shipping, refund eligibility. Use for a
                specific order. Do NOT use for identity verification - use
                get_customer."
```

The production version gives explicit disambiguation: which identifiers each accepts, what each returns, and - crucially - **when NOT to use each**. This is the same principle as §11's "description is the invocation trigger" for subagents: selection is driven by the description, whether the thing being selected is a tool or a subagent.

---

## 40. The misrouting problem and the fix hierarchy

Two tools with overlapping/near-identical descriptions cause selection confusion (the exam's Q2: minimal `get_customer` + `lookup_order`, so "check my order #12345" routes to the wrong tool). The exam offers four fixes; only one is the correct **first** step:

| Fix                         | Verdict                    | Why                                                                                            |
| --------------------------- | -------------------------- | ---------------------------------------------------------------------------------------------- |
| **Expand the descriptions** | ✅ Correct                 | Low effort, high leverage, addresses the root cause directly                                   |
| Few-shot examples           | ❌ Wrong                   | Token overhead without fixing _why_ the model is confused - treats the symptom                 |
| Routing classifier          | ❌ Wrong                   | Over-engineered first step; bypasses the LLM's own language understanding, adds infrastructure |
| Tool consolidation          | ❌ Wrong _as a first step_ | A valid long-term architecture choice, but far more effort than editing descriptions           |

**The general exam heuristic: prefer low-effort, high-leverage fixes.** Better descriptions before routing classifiers; scoped access before full access; community MCP servers before custom builds. When a scenario offers a cheap targeted fix and an expensive structural one, the cheap one is usually the intended first answer.

_(Note)_ A routing classifier is wrong here for a _different_ reason than in §23: there it addressed the wrong layer (routing vs in-agent enforcement); here it is simply disproportionate effort for a description problem. Both make it the wrong answer.

---

## 41. Tool splitting and renaming

When one tool is too generic, two structural fixes sharpen selection:

**Splitting** - break a broad tool into purpose-specific tools with defined input/output contracts:

```text
# Before
analyze_document: "Analyses a document and returns results"

# After
extract_data_points:        "Extracts structured fields (dates, amounts, names) from a document"
summarize_content:          "Produces a concise summary of a document's key arguments"
verify_claim_against_source:"Checks whether a claim is supported by the source, returning supporting/contradicting evidence"
```

Each result has a narrow, clearly described purpose, so the model can pick by what the user actually needs.

**Renaming** - when two tools have confusingly similar names, renaming removes overlap at the interface level (e.g. `analyze_content` -> `extract_web_results` with a web-specific description) without changing the implementation.

---

## 42. System-prompt interactions

Keyword-sensitive instructions in the **system prompt** can create unintended tool associations that override well-written descriptions. If the system prompt says "always check customer details before proceeding", the model may associate _any_ customer-related query with `get_customer` regardless of what the descriptions say.

**Always review the system prompt for keyword conflicts after updating tool descriptions** - a subtle failure mode where a good description is silently overridden by prompt wording.

---

## 43. Tool description exam traps

| Trap (reject these answers)                                   | Why it's wrong                                                                                                          |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Few-shot examples to fix misrouting from minimal descriptions | Adds token overhead without addressing the root cause; the descriptions don't differentiate the tools - fix them first. |
| A routing classifier as the first step                        | Over-engineered; bypasses the model's language understanding and adds disproportionate infrastructure.                  |
| Consolidating similar tools as the first step                 | Valid long-term, but more effort than expanding descriptions; the exam favours the low-effort high-leverage fix.        |
| Ignoring system-prompt wording after editing descriptions     | Keyword-sensitive prompt instructions can silently override good descriptions and force the wrong tool.                 |

---

## 44. Tool error responses - `isError` and the four categories

A generic error ("Operation failed") is useless to an LLM - it gives no signal about what went wrong, whether to retry, or what to do instead. MCP's **`isError` flag** tells the model the tool failed, so it reasons about recovery instead of treating error text as a normal result.

Every failure falls into one of four categories, each with a different recovery:

| Category       | Cause                                                                                | Retry?          | Recovery                                  |
| -------------- | ------------------------------------------------------------------------------------ | --------------- | ----------------------------------------- |
| **Transient**  | Timeout, service down, rate limit - request is valid, system temporarily unreachable | Yes (as-is)     | Retry after a brief delay                 |
| **Validation** | Bad input format, missing field, out-of-range value - request is malformed           | Yes (after fix) | Fix the input, then retry                 |
| **Business**   | Policy violation, limit exceeded, rule conflict - valid request, forbidden by a rule | **No**          | Alternative workflow - typically escalate |
| **Permission** | Access denied, insufficient credentials                                              | **No**          | Escalate or use different credentials     |

To act on these, the model needs structured metadata, e.g. for a business error:

```json
{
  "isError": true,
  "content": [{ "type": "text", "text": "Refund exceeds policy limit" }],
  "errorCategory": "business",
  "isRetryable": false,
  "description": "Refund of £750 exceeds the £500 automatic limit. Requires manager approval - escalate to a human agent with the refund details."
}
```

_(Fact-check, verified against the MCP spec)_ `isError` is the real protocol flag on a tool result (alongside `content` and optional `structuredContent`). `errorCategory` / `isRetryable` / `description` are **not** spec-defined top-level fields - they are an application-level convention you add (best placed in `structuredContent`, or within the content text) so the model can distinguish categories. Separately, MCP has **two** error channels: JSON-RPC **protocol errors** (unknown tool, invalid arguments, server error) vs **tool-execution errors** (`isError: true` in an otherwise-successful result) - the four categories above are the tool-execution kind.

_(Cross-reference)_ This is the structured form of §4's `is_error` tool-result recovery, and the business -> escalate path is the §22 handoff again: a customer-friendly `description` lets the agent escalate and explain appropriately.

---

## 45. What `isRetryable` really signals

`isRetryable` answers exactly one question: **is there any path to success through retrying?** It does **not** promise the same request succeeds unchanged.

- **Transient** (`isRetryable: true`): retry **as-is** once the system recovers.
- **Validation** (`isRetryable: true`): retry **only after self-correcting** the input (reformat `order-abc` -> `#12345`).
- **Business** (`isRetryable: false`): no retry helps - the rule blocks it every time; take a different path.
- **Permission** (`isRetryable: false`): no retry helps - needs a different principal, not a reworded call.

So read `isRetryable` as "can a retry _ever_ work", then read `errorCategory` to know **how**: resend, self-correct, escalate, or take an alternative route. The two `true` categories need different actions; the two `false` categories are false for mirror-image reasons.

---

## 46. Access failure vs valid empty result (tested directly)

One of the most critical distinctions in the domain:

|                  | **Access failure**                                                      | **Valid empty result**                                     |
| ---------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------- |
| What happened    | Tool could NOT reach the data source (timeout, auth fail, service down) | Tool successfully queried and found no matches             |
| Data state       | Might exist - the tool couldn't check                                   | Confirmed: nothing matches the criteria                    |
| Correct response | An **error** - decide whether to retry                                  | **Not** an error - accept "no results found", do NOT retry |

Confusing them breaks recovery: a tool returns an empty array, the agent retries 3× then escalates to a human - but the account simply doesn't exist. The tool _succeeded_; retrying just repeats the empty result. The fix is to make a successful-but-empty query look **fundamentally different** from a failed one:

```json
// Valid empty result - NOT an error
{ "isError": false,
  "content": [{ "type": "text", "text": "No customer matching 'john@example.com'. Query ran successfully; no matches." }],
  "resultCount": 0 }

// Access failure - IS an error
{ "isError": true,
  "content": [{ "type": "text", "text": "Could not reach customer database" }],
  "errorCategory": "transient", "isRetryable": true,
  "description": "Connection timed out after 5s. The query did not execute." }
```

The signal is `isError` (plus a `resultCount: 0` on the success side): "found nothing" vs "couldn't look".

---

## 47. Error propagation in multi-agent systems

Errors follow **local recovery with selective propagation**:

- **Subagents recover locally** for transient failures - a search subagent retries a timed-out search before bothering the coordinator.
- **Propagate only what can't be resolved locally** - if all retries fail, report upward.
- **Include partial results and what was attempted** - "searched 3 of 5 sources; 4 and 5 timed out; here are results from the 3 that worked."

This avoids two anti-patterns, both of which destroy the coordinator's ability to decide well:

1. **Silently suppressing errors** (returning empty results as success) - the coordinator can't tell "found nothing" from "couldn't search" (§46 at the multi-agent scale).
2. **Terminating the whole workflow on one failure** - a single timed-out source shouldn't sink the run.

_(Cross-reference)_ This is the concrete form of §6's "consistent error handling" centralisation benefit and §8's coordinator error-handling responsibility: the hub can only apply uniform recovery if subagents report failures honestly with context, rather than hiding them. (Full detail on the required shape of that report, and the exam's formal names for the two anti-patterns: §129-130.)

---

## 48. Tool error handling exam traps

| Trap (reject these answers)                                             | Why it's wrong                                                                                                                               |
| ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Retrying when a successful query returns an empty result                | Empty-from-success means "no data matches"; retrying just repeats it. Accept and respond.                                                    |
| Generic error messages ("Operation failed") without structured metadata | Without category/retryable/description the agent can't tell a transient failure from a business rule violation - it can't choose a recovery. |
| Treating business errors as retryable                                   | The policy violation recurs every time; the agent must take an alternative path (escalate), not retry.                                       |
| Silently suppressing subagent errors as empty success                   | Hides failure from the coordinator, which then can't distinguish "found nothing" from "couldn't search" and produces incomplete output.      |

---

## 49. Tool distribution - the 4-5 rule

The **number** of tools an agent has directly affects how reliably it selects the right one - this is an architectural decision, not an implementation detail. Give one agent 18 tools and selection reliability degrades: every added tool increases decision complexity and error rates climb. **Optimal: 4-5 tools per agent, scoped to that agent's role.**

It's about relevance, not just count. An agent with tools outside its specialisation tends to _misuse_ them: a synthesis agent given `web_search` may run its own searches instead of using the results already provided - duplicating work and wasting context. **The principle: each agent gets only the tools it needs for its role, nothing more.**

_(Cross-reference)_ This is the fleet-level version of §11's least-privilege tool scoping: §11 says scope each subagent's `tools`; this says the _right size_ of that scope is ~4-5 role-relevant tools, and over-provisioning causes misuse, not just risk.

---

## 50. tool_choice - choosing the setting

§5 covers what each `tool_choice` value _does_; this is _when_ to reach for each:

| Setting                        | When to use                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default)               | General operation - the model needs freedom to answer in text when no tool fits                                                                                                                                                                       |
| `any` (must call some tool)    | You need guaranteed structured output but the right schema is unknown - e.g. an extraction pipeline with multiple schemas (invoice / receipt / contract), each a tool; `any` forces the model to pick one and emit structured output instead of prose |
| forced (`{type:"tool", name}`) | Enforce a **mandatory first step** - the model cannot skip or reorder it (e.g. `extract_metadata` before any enrichment). After the forced call, later turns switch back to `auto` for the rest                                                       |

_(Addition)_ For a _single_ known schema, `output_config.format` (structured outputs) is the cleaner guarantee; `any` over multiple tools is the answer when the schema itself is what's being selected. And recall from §5 the constraints: forced/`any` suppress preamble text and are incompatible with extended/adaptive thinking - so "force the tool but keep thinking on" is an invalid request.

---

## 51. Scoped cross-role tools (exam Q9 - know it cold)

Sometimes an agent occasionally needs a capability that belongs to another role. Routing _every_ such request through the coordinator adds 2-3 round trips and can raise latency 40%+.

**The fix - a scoped cross-role tool:** a constrained version of the capability given directly to the agent that needs it, sized to the common case.

Worked example: a synthesis agent frequently verifies simple facts while writing a report. Routing all verifications to the coordinator (which delegates to the search agent and waits) is wasteful for the ~85% that are millisecond lookups. Give synthesis a scoped `verify_fact` that handles simple lookups locally; the ~15% complex verifications (multiple sources, cross-referencing, judgement) still route through the coordinator and the full pipeline.

**The pattern: handle the high-frequency simple case locally with a scoped tool; escalate the rare complex case to the full pipeline.** This does not violate hub-and-spoke's routing rule (§6) - it's a deliberate, constrained exception for a latency-critical common path, not open subagent-to-subagent traffic.

---

## 52. Constrained tools and role-specific scoping

Prefer a **constrained** tool over a generic one: instead of `fetch_url` (fetches anything from anywhere), give `load_document` (validates document URLs only). The constrained tool prevents misuse, makes its purpose clearer in the description, and reduces unintended side effects - least privilege applied to tool design (and complementary to the tool-splitting of §41: split for clarity, constrain for safety).

Role-specific scoping in a well-designed research system - each agent has exactly 4-5 role-relevant tools:

| Agent             | Tools                                                                               |
| ----------------- | ----------------------------------------------------------------------------------- |
| Web Search        | `search_web`, `fetch_page`, `extract_links`, `save_snippet`                         |
| Document Analysis | `extract_metadata`, `extract_data_points`, `summarize_content`, `verify_claim`      |
| Synthesis         | `compile_report`, `verify_fact` (scoped, §51), `format_citation`, `assess_coverage` |
| Coordinator       | `Agent` (spawn subagents; formerly `Task`), `review_output`, `request_revision`     |

Note the coordinator has **no domain tools** - it controls the workflow (spawn / review / revise) and delegates all domain work, matching the hub-and-spoke role split (§6-§8).

---

## 53. Tool distribution & choice exam traps

| Trap (reject these answers)                                                   | Why it's wrong                                                                                               |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Giving an agent 18 tools and expecting reliable selection                     | Reliability degrades as tools grow; scope to ~4-5 role-relevant tools.                                       |
| Routing all simple verifications through the coordinator when 85% are trivial | 2-3 extra hops each; a scoped `verify_fact` on the agent handles the common case, cutting latency up to 40%. |
| `tool_choice: "auto"` when structured output is required                      | `auto` may return prose; use `any` (some tool) or forced (a specific tool) to guarantee a tool call.         |
| A generic `fetch_url` when a constrained `load_document` would do             | Generic tools enable misuse; constrained alternatives enforce least privilege and clarify purpose.           |

---

## 54. Forced tool_choice still allows multiple tool_use blocks (practical finding)

**The misconception:** `tool_choice: {type: "tool", name: "extract_metadata"}` guarantees the model calls that tool - but **not** that it calls it exactly once. **Parallel tool use is on by default**, so even under forced selection Claude may emit **several `tool_use` blocks in one turn** (e.g. calling `extract_metadata` multiple times to chunk the work).

**The bug this causes:** plumbing that answers only the first block - `response.content.find(b => b.type === "tool_use")` - leaves the other `tool_use` ids unanswered. The API then **rejects the next turn**, because every `tool_use` id must have a matching `tool_result` in the immediately following user message.

**The rule (verbatim from the API docs):** execute **all** tool calls from a turn, then return **all** the `tool_result` blocks together in a **single** user message. So:

- **Filter, don't find:** `response.content.filter(b => b.type === "tool_use")` and loop over every block.
- Collect one `tool_result` per block (each with its own `tool_use_id`) and send them all in one user message; a failed tool still gets a `tool_result` with `is_error: true`, never dropped.
- If you genuinely need exactly one call, set `disable_parallel_tool_use: true` (§5) - but the robust habit is to answer every block regardless.

_(Cross-reference)_ Same "all results in a single user message" rule as §14 (parallel spawning) and §4's parallel-tool-use note - the new lesson is that **forced `tool_choice` does not exempt you from it**. Answering only `content[0]` is a cousin of the §4 anti-pattern (inspecting `content[0]` instead of scanning all blocks).

---

## 55. MCP server configuration - scoping and credentials

MCP servers connect Claude to external systems (issue trackers, databases, APIs). Where you configure a server decides whether the team shares one toolset or drifts into config chaos.

The two scopes the exam contrasts:

|                       | Project-level: `.mcp.json`                                       | User-level: `~/.claude.json`                                          |
| --------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------- |
| Location              | Project repository root                                          | User home directory                                                   |
| Version-controlled    | Yes                                                              | No                                                                    |
| Shared with teammates | Yes (on clone/pull)                                              | No                                                                    |
| Use for               | Servers the whole team needs (Jira, GitHub, internal connectors) | Experimental / personal servers, testing before proposing to the team |

**Keep credentials out of version control with `${VAR}` expansion.** `.mcp.json` supports `${VARIABLE_NAME}` in `env`, so the committed file references variable _names_, not values; each developer sets their own tokens locally (shell profile, `.env`, secrets manager). Result: the config is safe to commit, everyone authenticates with their own credentials, token rotation needs no config change, and no secret enters repo history.

**All tools from all configured servers are discovered at connection time and available simultaneously** - there is no manual activation step; if a server is configured and reachable, its tools appear in the toolkit.

_(Fact-check, verified against the Claude Code MCP reference)_ There are actually **three** scopes, not two:

| Scope               | Loads in             | Shared                   | Stored in                                   |
| ------------------- | -------------------- | ------------------------ | ------------------------------------------- |
| **local** (default) | Current project only | No                       | `~/.claude.json` (under the project's path) |
| **project**         | Current project only | Yes, via version control | `.mcp.json` at project root                 |
| **user**            | All your projects    | No                       | `~/.claude.json`                            |

So the exam's "user-level `~/.claude.json`" is really **two** scopes that share that file - the _default_ is `local` (per-project private), while `user` is the all-projects one. Two more real details worth knowing (and prime distractors): older versions renamed the scopes (`local` was called `project`, `user` was called `global`), and project-scoped servers from `.mcp.json` **require approval before use** - a freshly cloned repo's servers sit pending until you trust the workspace, so "commit `.mcp.json` and teammates get the tools automatically" is not quite true.

---

## 56. MCP resources vs tools

**Resources** expose content _catalogs_ to the agent upfront, so it doesn't need exploratory tool calls to discover what data exists. Examples: issue summaries (open Jira tickets + statuses), documentation tables of contents, database schemas (tables, columns, relationships).

The payoff is fewer wasted calls: without a schema resource, an agent might call `list_tables` then `describe_table` for each table just to learn the landscape; with the schema exposed as a resource, that's available immediately.

**Resources give agents visibility into available data; tools let agents act on it.** The combination means fewer exploratory round-trips and more targeted operations. (Efficiency kin of §31-32: eliminate wasted calls structurally rather than hoping the model minimises them.)

---

## 57. Build vs use - community servers first

When integrating an external system: build a custom MCP server, or use an existing community one?

- **Use community servers for standard integrations** - Jira, GitHub, Slack, Linear, Notion all have maintained community servers: tested, updated, zero build/maintenance burden.
- **Build custom only when** the team has workflows community servers can't handle, you need custom business logic in the tool layer, or you must integrate a proprietary internal system with no community server.

**"Evaluate community servers first" is always correct for a standard integration**; "build custom" is right only when the scenario explicitly describes team-specific requirements community servers can't meet. This is the §40 low-effort-high-leverage heuristic ("community MCP servers before custom builds") in its own right.

---

## 58. Enhancing MCP tool descriptions

A subtle failure: when an MCP tool has a **sparse** description, the agent may prefer a **built-in** tool (like `Grep`) even when the MCP tool is more capable - because the model has richer context on the built-ins. The model defaults to what it understands best.

The fix - write descriptions that explain capabilities, outputs, and when to prefer this tool:

```text
# Sparse (loses to built-in Grep)
search_codebase: "Searches code"

# Enhanced (the model can prefer it when genuinely better)
search_codebase: "Semantic code search across the repo using AST-aware indexing.
                  Returns matching functions/classes/methods with file path, line
                  numbers, and surrounding context. More accurate than text grep for
                  finding code by intent. Use instead of Grep when searching by what
                  code does rather than what it contains."
```

_(Cross-reference)_ This is §39's "descriptions are the primary selection mechanism" applied to the built-in-vs-MCP contest: sparse descriptions lose not just between two MCP tools but against well-documented built-ins. The fix even includes an explicit boundary ("use instead of Grep when...") - element 5 of the §39 five.

---

## 59. MCP configuration exam traps

| Trap (reject these answers)                                         | Why it's wrong                                                                                                                 |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Building a custom MCP server for a standard integration (e.g. Jira) | Community servers exist for standard integrations - evaluate them first; custom is only for needs they can't meet.             |
| Putting team-wide server config in `~/.claude.json`                 | That's user/local scope - personal, not version-controlled or shared. Team-wide servers go in `.mcp.json` at the project root. |
| Committing credentials directly in `.mcp.json`                      | Secrets in version control are a security risk; use `${VAR}` expansion so tokens stay local and never enter repo history.      |
| Leaving MCP tool descriptions sparse                                | The agent defaults to better-understood built-in tools; enhance descriptions so a genuinely-more-capable MCP tool is chosen.   |

---

## 60. Built-in codebase tools - Grep vs Glob

Claude Code has six core tools for working with a codebase - **Read, Write, Edit, Bash, Grep, Glob** (there are others - `Task`/`Agent`, `WebSearch`, etc. - but these six do file/search/shell work). Using the wrong one wastes time, context tokens, or both.

**The distinction that matters most:**

|          | **Grep**                                                                  | **Glob**                                                  |
| -------- | ------------------------------------------------------------------------- | --------------------------------------------------------- |
| Searches | File **contents** (patterns _inside_ files)                               | File **paths** (names / extensions / directory structure) |
| Use for  | Function callers, error messages, import statements, variable assignments | Test files, config files, all `.ts` in a directory        |
| Examples | `Grep "processLegacyOrder"`, `Grep "import.*from 'utils/auth'"`           | `Glob "**/*.test.tsx"`, `Glob "content/domains/**/*.mdx"` |

**In one sentence: Grep finds what is INSIDE files; Glob finds files by their NAMES.** The exam plants wrong-tool scenarios: Glob to find function callers _fails_ (it matches paths, not contents); Grep to find test files by naming pattern technically works (the name appears in content) but is the wrong tool - Glob is purpose-built for paths.

---

## 61. Read, Write, Edit - and the Edit recovery ladder

- **Edit** - targeted modification by unique text match: specify the exact `old_string` and its replacement. Fast and precise because it touches only that text.
- **Read / Write** - load the whole file / write the whole file back.

**Why Edit fails, and the correct recovery.** Edit requires a **unique** match; if `old_string` appears in several places it can't tell which you mean, so it fails - a safety mechanism, not a bug. The documented recovery ladder:

1. Try Edit with the shortest anchor that's plausibly unique.
2. On a non-unique match, **widen `old_string`** with surrounding context until it pins one location, **or** set **`replace_all: true`** if you truly want every occurrence changed.
3. Only fall back to **Read + Write** when neither can disambiguate.

**The exam penalises two things:** defaulting to Read + Write for every modification (it burns a whole file's tokens on a one-line change), **and** jumping straight from a non-unique Edit failure to Read + Write. Widening the anchor or `replace_all` is the documented response; Read + Write is the last resort, not the next step.

---

## 62. Incremental codebase understanding

**Never read all files upfront** - loading a 200-file codebase in full swallows the context window, mostly on files irrelevant to the task. No exploration mistake costs more.

**Incremental discovery - start narrow, expand only as needed:**

1. **Grep to find entry points** - the function/class name or error message that anchors the investigation; this tells you which files are relevant.
2. **Read to follow imports and trace flows** - only the files that matter; follow imports to related files.
3. **Grep again to trace usage** - for a wrapper or re-export, Grep the name across the codebase to find all consumers.
4. **Read only what you need** - each Read justified by the previous step's discovery.

Minimal context for maximum understanding: map the codebase progressively, spending tokens only on files that matter. _(Cross-reference)_ Same context-budget discipline as §31-32: the fix for "too much in context" is structural (targeted discovery), not a bigger context window - reading everything upfront is the attention-dilution mistake at the exploration stage.

---

## 63. Tracing usage across wrappers, and the deprecation scenario

**Wrapper modules break a naive Grep.** A function defined in one module, re-exported through a wrapper, and consumed by the wrapper's name is missed by a single Grep for the original name. Correct trace:

1. Grep the function **definition** to find where it's defined.
2. **Read** the defining file to identify the exported names.
3. Grep **each exported name** across the codebase for all consumers.
4. If re-exported through a barrel file (`index.ts`), Grep the barrel's module name for importers.

**The deprecation scenario (common exam item): find every caller of a deprecated function AND the tests that exercise it.** The sequence is **Grep, then Glob, then Grep again** - never Glob first:

1. **Grep the function name** - every file whose contents reference it, including tests that import it directly (content search).
2. **Glob for sibling test files** - `**/OrderProcessor.test.*` etc. pulls the test that pairs with each caller by naming convention, even when the test exercises the function _indirectly_ through the source module (path matching).
3. **Grep again for wrapper names** - if a caller exposes the function under a new name, Grep that wrapper to catch tests covering it transitively.

The order maps to purpose: content search for direct references -> path matching for adjacent tests -> content search for indirect coverage.

---

## 64. Built-in tool exam traps

| Trap (reject these answers)                                        | Why it's wrong                                                                                                                |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Using Glob to find function callers                                | Glob matches paths, not contents; use Grep to search inside files for calls/imports/errors.                                   |
| Using Grep to find files by extension/naming pattern               | Glob is purpose-built for paths (`**/*.test.tsx`, `**/config.*`); don't content-search for filenames.                         |
| Reading all source files upfront                                   | Context-budget killer; go incremental - Grep for entry points, then Read to trace from them.                                  |
| Defaulting to Read + Write for every modification                  | Edit is faster and cheaper (touches only the target text); try Edit first.                                                    |
| Jumping to Read + Write the moment Edit reports a non-unique match | Documented recovery is to widen `old_string` or set `replace_all: true` - both stay on Edit; Read + Write is the last resort. |

---

## 65. CLAUDE.md - the configuration levels

CLAUDE.md files give Claude Code persistent instructions, loaded at the start of every session. They live at several levels, **in load order from broadest to most specific**:

| Level              | Location                                                                                         | Shared with                                     | Use for                                                          |
| ------------------ | ------------------------------------------------------------------------------------------------ | ----------------------------------------------- | ---------------------------------------------------------------- |
| **Managed policy** | OS path (e.g. `/Library/Application Support/ClaudeCode/CLAUDE.md`, `/etc/claude-code/CLAUDE.md`) | All users on the machine (IT/DevOps deploys it) | Org-wide standards, security/compliance - **cannot be excluded** |
| **User**           | `~/.claude/CLAUDE.md`                                                                            | Just you, all projects                          | Personal preferences (verbosity, output style, shortcuts)        |
| **Project**        | `./CLAUDE.md` **or** `./.claude/CLAUDE.md`                                                       | Team, via version control                       | Team standards: naming, error handling, testing, architecture    |
| **Local**          | `./CLAUDE.local.md`                                                                              | Just you, this project (gitignored)             | Personal repo quirks (sandbox URLs, test data)                   |

Plus **directory-level** files: a subdirectory `CLAUDE.md` (e.g. `/packages/api/CLAUDE.md`) for package-specific conventions - loaded on demand when Claude reads files in that directory.

_(Fact-check, verified against the memory docs)_ The exam frames this as a "three-level hierarchy" (user / project / directory) - but there's a **fourth, top level the source omits: managed policy**, org-wide and non-excludable. Both `./CLAUDE.md` and `./.claude/CLAUDE.md` are valid project locations (the exam may show either).

---

## 66. Loading order & conflict handling

CLAUDE.md is **not** a strict-precedence config. Per the docs (verbatim): **"All discovered files are concatenated into context rather than overriding each other."** Every applicable file loads into the same context window; none replaces another.

There is a documented **load order**, not a precedence chain:

- Ordered broadest -> most specific, so a project instruction appears _after_ a user instruction. Across the tree, content runs "from the filesystem root down to your working directory" - instructions closer to launch are read **last**.
- Within a directory, `CLAUDE.local.md` is appended **after** `CLAUDE.md`.

But "read last" is **not** "wins": **"if two rules contradict each other, Claude may pick one arbitrarily."** And crucially, **CLAUDE.md is delivered as a user message _after_ the system prompt, not as part of it - "there's no guarantee of strict compliance."** Treat it as guidance the model usually follows, not a deterministic override layer.

---

## 67. CLAUDE.md is not settings.json (the enforcement line)

The practical consequence of §66: **if a rule must hold on every run - a blocked tool, a required formatter, a permission policy - do not lean on CLAUDE.md.** Encode it in `settings.json` (enforced by the client regardless of what Claude decides) or a **hook** (fires at a fixed lifecycle event). The docs state it directly: _"Settings rules are enforced by the client regardless of what Claude decides to do. CLAUDE.md instructions shape Claude's behavior but are not a hard enforcement layer."_

|                     | `settings.json`                                                               | `CLAUDE.md`                                         |
| ------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------- |
| Conflict resolution | **Strict precedence** (managed > local > project > user; managed always wins) | Concatenated; conflicts may resolve **arbitrarily** |
| Enforcement         | Client-enforced, deterministic                                                | Guidance; no strict-compliance guarantee            |

If asked "which CLAUDE.md wins on a conflict?", the docs-honest answer is **"neither is guaranteed to - move the rule to settings.json or a hook."** _(Cross-reference)_ This is the §17-§19 enforcement spectrum exactly: CLAUDE.md is probabilistic prompt-guidance; settings/hooks are the deterministic mechanism. Watch for distractors claiming "more specific scope wins" or "user overrides project" - the docs never say that about CLAUDE.md.

---

## 68. Modular organisation - @ imports, CLAUDE.local.md, rules

**`@` path imports.** Split a large CLAUDE.md and inline other files with `@` followed by a path (`@./standards/testing.md`). **There is no `@import` keyword** despite what many online docs claim. Relative paths resolve from the importing file; recursive imports allowed (max 4 hops); a path in backticks stays literal. **Imports load eagerly** - the referenced file is inlined at launch, so splitting a 600-line file into six 100-line imports is nicer to maintain but **the context Claude sees is the same size**. To actually shrink per-session context, use path-scoped rules (below), not imports.

**CLAUDE.local.md.** Sits next to CLAUDE.md at any level; appended after it (last word on same-level conflicts); gitignored by convention. It's a project-scoped `~/.claude/CLAUDE.md` - your quirks for this repo. If you reach for it to express a _team_ rule, that rule belongs in CLAUDE.md instead.

**`.claude/rules/`.** Topic-specific files (`testing.md`, `api-conventions.md`, `deployment.md`), each optionally with YAML `paths:` frontmatter (glob patterns). **Rules without `paths` load every session; path-scoped rules load only when Claude works with matching files** - this is the tool for reducing per-session context (imports can't). _(Aside)_ Block-level HTML comments in CLAUDE.md are stripped before load - free space for maintainer notes.

**`.claude/rules/` is the structural alternative to a monolithic CLAUDE.md** - and one big undifferentiated CLAUDE.md is itself a named **anti-pattern**. Split your instructions into topic files instead of cramming everything into one. When to reach for it over a single CLAUDE.md:

- Your instructions **split into distinct topics** (testing / API / deployment) - separate files are easier for a team to maintain than one flat file.
- **Different rules should apply to different parts of the codebase** - `paths:` frontmatter scopes a rule to matching files, finer-grained control than a single file can give (and it loads only when relevant, saving context).

So: monolithic CLAUDE.md for a small, uniform set of always-on rules; `.claude/rules/` once instructions grow into topics or need per-path scoping. This is distinct from `@` imports (§68 above): imports reorganise the _source_ but still load everything eagerly; rules with `paths:` change _what actually loads_ per session.

---

## 69. Rules mechanics - the two kinds and how lazy loading fires

`.claude/rules/` files come in exactly **two kinds**:

1. **Unscoped** (no frontmatter) - loaded in full at session start, same priority as CLAUDE.md. Just a way to split CLAUDE.md into topic files.
2. **Path-scoped** (`paths:` YAML frontmatter with glob patterns) - **not loaded at start**; only the globs are registered. The full file is injected into context the moment Claude **reads/edits a file matching a pattern** - the trigger is touching a matching file, not every tool use. Symlinked paths also trigger matching (since v2.1.198). Costs zero context until needed.

```
.claude/
├── CLAUDE.md                # always loaded
└── rules/
    ├── code-style.md        # no frontmatter -> always loaded
    ├── testing.md           # paths: ["tests/**/*.test.ts"] -> lazy
    └── backend/api-design.md  # subdirectories discovered recursively
```

Example of a path-scoped rule - `.claude/rules/testing.md`:

```markdown
---
paths:
  - "tests/**/*.test.ts"
  - "src/**/*.spec.ts"
---

# Testing rules

- Use vitest, never jest.
- Mock external HTTP with msw, never with manual fetch stubs.
```

Claude reads `src/api/users.ts` -> no pattern matches -> stays out of context. Claude reads `tests/users.test.ts` -> matches `tests/**/*.test.ts` -> full file injected, instructions apply from that point on.

Details worth knowing:

- **User-level rules** exist too: `~/.claude/rules/`, applies to all projects. User rules load **before** project rules, so **project rules take priority on conflict**.
- **Glob syntax**: full glob incl. `**` and brace expansion (`src/**/*.{ts,tsx}`). **Invalid patterns silently match nothing** - a broken glob means the rule never loads, with no error.
- **`@` imports are documented for CLAUDE.md, not for rules** - don't rely on them inside rule files.
- **Best practice**: one topic per file, descriptive filename (`testing.md`, `api-design.md`). Universal instructions -> CLAUDE.md or unscoped rules; anything file-type-specific -> behind `paths:`.

Docs: [Memory - organize rules](https://code.claude.com/docs/en/memory.md), [Large codebases](https://code.claude.com/docs/en/large-codebases.md).

---

## 70. /memory vs /context, and the new-teammate scenario

**The core concept (source and docs agree):** configuration files load **automatically** based on level and location - no command "activates" them.

_(Fact-check correction, verified hands-on)_ The source says `/memory` "shows which files are loaded in your session" - per the current docs that's actually **`/context`** (check the **Memory files** list). **`/memory`** is an _editing entry point, not a diagnostic_: it presents a selection menu of CLAUDE.md / CLAUDE.local.md / auto-memory _locations_ across scopes and opens the chosen one in your editor. It shows locations even for files that **don't exist yet**, so it cannot tell you what actually loaded. So: **`/context` = what actually loaded this session; `/memory` = browse/edit the files.** For troubleshooting _why_ a file didn't load there's also **`/debug-your-config`**. Know all of these - the distinction is distractor material.

Practical caveats (from actually running the source's suggested exercise):

- Correct way to observe directory-level scoping: launch `claude` at the repo root and run `/context` (root CLAUDE.md visible, `packages/api/CLAUDE.md` not); then either ask Claude to read a file under `packages/api/` and re-run `/context` (the directory-level file appears), or relaunch `claude` from `packages/api/` (both load at startup).

**The exam's favourite Task-3.1 trap - new team member not getting instructions:** Developer A's Claude follows all team conventions; Developer B clones the repo and gets inconsistent behaviour. **Root cause: the conventions live in Developer A's user-level `~/.claude/CLAUDE.md`, which git does not share.** Fix: **move them to project-level** (`./CLAUDE.md` or `./.claude/CLAUDE.md`). Diagnose on sight: "new team member" + "inconsistent behaviour" -> check where the config lives. _(Cross-reference)_ Same root-cause family as §59's "team-wide config in `~/.claude.json`" trap - personal-scope config is never shared; team rules belong in the version-controlled project file.

---

## 71. CLAUDE.md exam traps

| Trap (reject these answers)                                                | Why it's wrong                                                                                                                                                               |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New teammate not receiving instructions on the same repo/branch            | Instructions are in user-level `~/.claude/CLAUDE.md` (not shared by git); move to project-level `./CLAUDE.md` or `./.claude/CLAUDE.md`.                                      |
| "The more specific CLAUDE.md wins the conflict" / "user overrides project" | Files are concatenated, not a precedence chain; conflicts may resolve arbitrarily. For a guaranteed rule, use settings.json or a hook.                                       |
| Thinking `/memory` triggers configuration loading                          | Config loads automatically by location; `/memory` browses/edits files and `/context` shows what loaded - neither activates anything.                                         |
| Running `/memory` (or any slash command) from bash or `claude -p`          | Slash commands exist only inside the interactive REPL - not in the shell, not in non-interactive mode.                                                                       |
| `cd`-ing to a subdirectory mid-session to load its CLAUDE.md               | Loading is tied to the launch directory, not the shell cwd; a subdirectory CLAUDE.md loads lazily when Claude reads a file under it (or eagerly if you relaunch from there). |
| Splitting CLAUDE.md into `@` imports to shrink context                     | Imports load eagerly - same context size. Use path-scoped `.claude/rules/` to load instructions only for matching files.                                                     |
| Directory-level CLAUDE.md for conventions spanning many directories        | A subdirectory CLAUDE.md applies to that directory only; for cross-directory conventions use path-scoped rules in `.claude/rules/` with glob patterns.                       |

---

## 72. Custom commands & skills - the unified system

Two paths produce the **same `/command`**:

- `.claude/commands/deploy.md` -> `/deploy` - a **flat file**, filename becomes the command name.
- `.claude/skills/deploy/SKILL.md` -> `/deploy` - **one directory per skill**, named after the command, with **SKILL.md as the required entrypoint** inside it.

**Skills is the canonical, recommended path** - it adds what the commands alias lacks: a supporting-files directory alongside SKILL.md, **automatic discovery** (Claude can load a skill when it matches your intent), and **precedence when a skill and a command share a name (the skill wins)**. Both support the same YAML frontmatter (`context: fork`, `allowed-tools`, `argument-hint`), so existing `.claude/commands/` files keep working unchanged.

**Scoping follows the universal pattern** (memorise - it recurs throughout Domain 3): project-level `.claude/` = shared via git; user-level `~/.claude/` = personal, not shared. Applies identically to CLAUDE.md, commands/skills, and rules.

_(Fact-check, verified against the skills docs)_ There are actually **four skill levels**: Enterprise (managed settings, org-wide), Personal (`~/.claude/skills/`), Project (`.claude/skills/`), Plugin (namespaced `plugin-name:skill-name`, can't clash). On a **same-name clash the ordering is counter-intuitive: enterprise overrides personal, and personal overrides PROJECT** - the opposite of "more specific wins". A skill at any level also **overrides a bundled skill** of the same name (a project `code-review` skill replaces the bundled `/code-review`). Also: nested `.claude/skills/` in subdirectories load on demand (monorepo pattern) under a directory-qualified name like `/apps/web:deploy`.

| Need                                            | Canonical location                    | Also works                     | Scoping                  |
| ----------------------------------------------- | ------------------------------------- | ------------------------------ | ------------------------ |
| Team-wide command (with or without frontmatter) | `.claude/skills/<name>/SKILL.md`      | `.claude/commands/<name>.md`   | Project (shared via git) |
| Personal command                                | `~/.claude/skills/<name>/SKILL.md`    | `~/.claude/commands/<name>.md` | User (not shared)        |
| Universal standards                             | `.claude/CLAUDE.md` or root CLAUDE.md | -                              | Project (always loaded)  |
| Personal preferences                            | `~/.claude/CLAUDE.md`                 | -                              | User (not shared)        |

**Keep the file shapes straight:** a skill is a _directory containing SKILL.md_; a command is a _flat .md file_. A loose `.md` dropped straight into `.claude/skills/` is **not picked up**.

---

## 73. Skills frontmatter - context: fork, allowed-tools, argument-hint

Optional YAML frontmatter at the top of SKILL.md (also works in commands files; skills is the canonical home). For a skill invoked as `/analyse-feature`, the file is `.claude/skills/analyse-feature/SKILL.md`:

```yaml
---
context: fork
allowed-tools:
  - Read
  - Grep
  - Glob
argument-hint: "Provide a feature description or area of the codebase to analyse"
---
```

- **`context: fork`** - runs the skill in an **isolated sub-agent context**; verbose output stays in the fork and the main conversation stays clean. Essential for codebase analysis, brainstorming, and any noisy exploratory task. Without it, skill output flows into the main conversation, consumes context tokens, and degrades subsequent responses. _(Docs detail)_ The SKILL.md content **becomes the subagent's prompt** and the fork has **no access to conversation history** - so it only makes sense for skills with explicit task instructions, not guideline-only content. An optional `agent:` field picks the subagent type (`Explore`, `Plan`, custom; default `general-purpose`).
- **`allowed-tools`** - **pre-approves** the listed tools (no permission prompt). It does **NOT restrict** anything: every other tool stays callable under your normal permission settings. To actually remove tools - the real security boundary - use **`disallowed-tools`** or deny rules in permission settings. _(Docs detail)_ The grant lasts only **the turn that invokes the skill and clears when you send your next message** - even though the skill's instructions stay in context for the rest of the session; both `allowed-tools` and `disallowed-tools` clear this way.
- **`argument-hint`** - _(fact-check correction)_ a **hint shown during autocomplete** to indicate expected arguments (e.g. `[issue-number]`, `[filename] [format]`) - it does _not_ prompt for missing parameters. Arguments reach the skill body via `$ARGUMENTS` (or `$0`, `$1`, ... by position); without a `$ARGUMENTS` placeholder they're appended as `ARGUMENTS: <value>`.

---

## 74. Skills vs CLAUDE.md - the critical distinction (tested directly)

- **Skills = on-demand, task-specific workflows.** Their _descriptions_ are always in context (so Claude knows they exist), but the **full body loads only on invocation**. Invocation can be explicit (`/skill-name`) or automatic: Claude picks up a skill whose description matches your intent, or a skill with a `paths` frontmatter field when you work on matching files.
- **CLAUDE.md = always-loaded, universal standards.** Applied to every session, no invocation step.

Invocation control - two frontmatter fields, know the table:

| Frontmatter                      | You invoke | Claude invokes | Loading                                                                 |
| -------------------------------- | ---------- | -------------- | ----------------------------------------------------------------------- |
| (default)                        | Yes        | Yes            | Description always in context; full body loads on invocation            |
| `disable-model-invocation: true` | Yes        | No             | **Description NOT in context at all**; body loads when you invoke       |
| `user-invocable: false`          | No         | Yes            | Description in context; hidden from the `/` menu (background knowledge) |

_(Docs detail)_ Once invoked, the rendered skill content **stays in context for the rest of the session** (it is not re-read on later turns) - only the `allowed-tools` grant is per-turn.

**The rule: no task-specific procedures in CLAUDE.md; no always-on reference material in skills.** API naming conventions for every code-gen task -> CLAUDE.md (or `.claude/rules/`). An occasional multi-step analysis workflow -> a skill. Conventions tied to a file type (e.g. test files) -> **path-scoped `.claude/rules/`**, which load as always-on context alongside matching files.

**Personal customisation:** want a variant of a team skill? Create it in `~/.claude/skills/` under a **different name** (`/deep-analyse` next to the team's `/analyse`) - it doesn't override or conflict with the team version. _(Fact-check nuance)_ The different name matters: with the **same name your personal skill would OVERRIDE the project skill** (personal > project per §72's level ordering).

---

## 75. Commands & skills exam traps

| Trap (reject these answers)                                                 | Why it's wrong                                                                                                                                                                                               |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Flat file directly in `.claude/skills/` (e.g. `.claude/skills/review.md`)   | A skill is a directory with a SKILL.md entrypoint (`.claude/skills/review/SKILL.md`); flat files only create commands under `.claude/commands/`. A loose file in skills/ is not picked up.                   |
| Team-shared command in `~/.claude/commands/` or `~/.claude/skills/`         | User-scoped paths are personal, not version-controlled. Team commands go in project-scoped `.claude/skills/` (canonical) or `.claude/commands/` inside the repo.                                             |
| Treating skills as always-on guidance like CLAUDE.md                        | Skills load on demand as invocation-style units (even when auto-invoked by description/paths match). Always-on conventions -> CLAUDE.md or `.claude/rules/`.                                                 |
| Verbose skill (analysis/brainstorming) clutters the main conversation       | Missing `context: fork` - it isolates the noisy output in a sub-agent fork and keeps the main context clean.                                                                                                 |
| Task-specific workflows in CLAUDE.md                                        | CLAUDE.md is for always-loaded universal standards; review workflows, analysis routines, brainstorming templates belong in on-demand skills.                                                                 |
| Thinking `allowed-tools` restricts the skill to those tools                 | It only pre-approves them (skips permission prompts); everything else stays callable. Restriction = `disallowed-tools` or permission deny rules. And the grant is per-turn - it clears on your next message. |
| "A project skill overrides a same-name personal skill (more specific wins)" | The ordering is enterprise > personal > PROJECT - personal beats project. And any level overrides a bundled skill of the same name; skill beats command on a name clash.                                     |
| Expecting `argument-hint` to prompt for missing parameters                  | It's only an autocomplete hint (e.g. `[issue-number]`). Arguments flow into the body via `$ARGUMENTS` / `$0`, `$1`, ...                                                                                      |

---

## 76. Choosing the convention mechanism - the 4-way decision matrix

The four scoping mechanisms from Domain 3 (§65-67 CLAUDE.md levels, §68-69 rules, §72-74 skills) answer four _different_ questions. The exam tests the boundaries between them; memorise this matrix as the single tie-breaker:

| Scenario                                                       | Correct mechanism                                        | Why not the neighbours                                                                                 |
| -------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Universal standards that apply to **all** code                 | **Root CLAUDE.md**                                       | Always-on is the point; scoping it would hide rules that should always apply.                          |
| Conventions for **one specific package directory**             | **Directory-level CLAUDE.md** (`packages/api/CLAUDE.md`) | Root would burn tokens everywhere; a glob rule is overkill when the boundary is exactly one dir.       |
| Conventions for a **file type spread across many directories** | **Path-scoped `.claude/rules/`** (`paths:` glob)         | Root loads always (wastes tokens); directory-level would need a copy in every dir (§71 trap).          |
| **Task-specific workflow** invoked on demand                   | **Skill** (`.claude/skills/<name>/SKILL.md`)             | CLAUDE.md/rules are always-on background; a workflow you run _occasionally_ belongs behind invocation. |

**The co-located-test-files scenario is the exam's signature Task-3.3 item:** test files sit next to their source across dozens of directories, and the answer is _always_ **path-scoped rules with a glob** (`paths: ["**/*.test.ts", "**/*.spec.ts"]`) - one file, one pattern, universal coverage - never a CLAUDE.md dropped into every test-bearing directory.

**The subtle trap - both skills AND rules can carry a `paths:` frontmatter, so which?** They auto-activate on a path match but are _not_ interchangeable:

- **Path-scoped rule** = passive **background guidance**. On a matching-file read it's injected into context and then **shapes every subsequent edit** for the rest of the session (§69). This is the answer whenever the question says "automatic," "always-on," or "convention loading for a file type."
- **Path-triggered skill** = an **on-demand task-style workflow unit**. Even when a `paths` match surfaces it, it's still invocation-style behaviour (a procedure Claude _runs_), not standing guidance (§74).

Rule of thumb: **a _convention_ (how to write code of this type) -> path-scoped rule; a _procedure_ (a multi-step task to perform) -> skill.**

---

## 77. Plan mode vs direct execution - the axis is ambiguity, not difficulty

Claude Code offers two ways to approach a task: **plan mode** (explore and design a strategy _before_ touching files) and **direct execution** (make the change straight away). The exam tests picking the right one, and there are clear criteria - it's not taste.

**The one thing to internalise:** the deciding axis is **ambiguity, not difficulty**. A _hard_ but well-defined bug fix - clear stack trace, single function, known cause - is **direct execution**. A _simple-looking_ feature request that could be built three different ways and touches multiple modules is **plan mode**. Difficulty and ambiguity are orthogonal; only ambiguity chooses the mode.

**Reach for plan mode when:**

- **Large-scale / architectural restructuring** (monolith -> microservices, reorganising a module system, refactoring a core abstraction) - you must understand the existing structure first.
- **Multiple valid approaches exist** - you need to evaluate trade-offs before committing.
- **Architectural decisions are required** - service boundaries, module dependencies, API contracts have downstream consequences; planning prevents costly rework.
- **Multi-file modifications** - a migration across 45+ files needs one consistent strategy or you apply it inconsistently.
- **Codebase exploration is needed** - trace data flows, map dependencies before changing anything.

**Reach for direct execution when:** the change is well-scoped (single-file fix with a clear stack trace, one validation conditional, a config value), the correct approach is **already known** (what/where/how, no design decision), and the scope is limited (one function, one file).

| Task                                       | Mode                                       |
| ------------------------------------------ | ------------------------------------------ |
| Architectural restructuring                | Plan mode                                  |
| Library migration (many files)             | Plan mode -> then direct execution (§80)   |
| Multiple valid implementation approaches   | Plan mode                                  |
| Codebase exploration needed                | Plan mode (with the Explore subagent, §79) |
| Single-file bug fix with clear stack trace | Direct execution                           |
| Adding a validation check to one function  | Direct execution                           |
| Config value update                        | Direct execution                           |
| Known fix, known location, known approach  | Direct execution                           |

---

## 78. Plan mode mechanics - how to enter it and what it actually blocks

_(This whole section is fact-check enrichment - the source describes when to use plan mode but not how it works. Verified against the current permission-modes docs.)_

Plan mode is one of Claude Code's **permission modes**. Enter it three ways: press **`Shift+Tab`** to cycle (`default` -> `acceptEdits` -> `plan`), launch with **`claude --permission-mode plan`**, or prefix a single prompt with **`/plan`**. Make it a project default with `"permissions": { "defaultMode": "plan" }`. The status bar shows **`⏸ plan mode on`** while active.

**What it blocks vs allows** - the common misconception is "nothing runs." Not quite:

- Claude **reads files and runs read-only exploration commands**, and **writes a plan** - but makes **no edits to your source**.
- File-**modifying** shell commands (`touch`, `rm`, etc.) still **prompt** for approval; they aren't silently allowed. Edits to source stay blocked **until you approve the plan**, regardless.

**The approval flow (this is the ExitPlanMode step):** when the plan is ready Claude presents it and asks how to proceed - _approve and use auto mode_ / _approve and manually approve each edit_ / _keep planning_ / _refine in the browser_. **Approving exits plan mode** and switches the session into the chosen execution mode, so Claude starts editing. Press **`Ctrl+G`** to open the proposed plan in your editor and change it before proceeding; press **`Shift+Tab`** again to leave plan mode **without** approving. Approving a plan also auto-names the session from the plan content (unless you already set a name).

_(Terminology)_ **"Direct execution" is the source's conceptual label, not a named CLI mode.** It just means working in any non-plan mode (`default`/Manual, `acceptEdits`, or `auto`) where edits actually happen - as opposed to the read-only, plan-first posture of plan mode.

---

## 79. The Explore subagent - keep verbose discovery out of the main context

On a multi-phase task, the discovery phase is **noisy**: file listings, dependency graphs, code excerpts, analysis notes. If all of that lands in the main conversation it **fills the context window**, degrading the quality of every later response - exactly when you need focus for implementation.

**The Explore subagent** (Claude Code's built-in read-only search agent) solves this: it runs the exploration **in its own isolated context**, and returns only **summaries of its findings** to the main conversation. The main window stays clean for the implementation work. Use it during multi-phase tasks where discovery is verbose but implementation needs focused context. _(Docs framing: "use a subagent to investigate X" - the subagent reads files in its own context window and reports a summary.)_

_(Cross-reference)_ This is the same principle as the delegation rule in §11: **delegate when you need only the final result, not the intermediate work** - a subagent doesn't share the main thread's context, so you keep the conclusion and shed the file-dump. The Explore agent is read-only: it _locates and summarises_, it doesn't edit.

---

## 80. Plan THEN execute - the hybrid pattern, and recognising complexity upfront

The most-tested real-world pattern is **plan mode for investigation, then direct execution for implementation** - "plan THEN direct," not "plan OR direct." The canonical example is a **library migration across ~30 files**:

- **Plan phase:** identify every file importing the old library, map the API differences old -> new, design the one migration pattern, check for edge cases.
- **Execute phase:** switch to direct execution and apply that pattern file by file, strategy already decided.

**Recognising complexity upfront (a favourite trap):** the wrong move is to start in direct execution and switch to plan mode only once complexity _surfaces_. When the requirements **already state** the task is complex ("restructure the monolith into microservices"), reach for plan mode **immediately** - the complexity is right there in the description, not speculative. Waiting for surprises is the error.

| Trap (reject these answers)                                          | Why it's wrong                                                                                                              |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Defaulting to direct execution for multi-file architectural changes  | Multiple valid approaches + many files = plan first; direct risks costly rework when dependencies surface late.             |
| Using plan mode for a single-file fix with a clear stack trace       | Known problem, location, and solution = direct execution; plan mode is pure overhead.                                       |
| Not recognising the plan-then-execute hybrid                         | Library migrations etc. want plan (design the strategy) THEN direct (apply it) - the two combine, they aren't alternatives. |
| Starting direct and switching to plan only when complexity "emerges" | If the requirement already states complexity, choose plan mode upfront - it's known, not speculative.                       |
| Letting verbose exploration flow into the main conversation          | Use the Explore subagent (§79) so only summaries return and the main context stays focused.                                 |

---

## 81. Refinement technique hierarchy - examples, TDD, interview

Working with Claude Code is iterative; the first output is rarely the last. There's a **pecking order** of steering techniques, and the exam tests picking the right one **first** for the situation. Each solves a _different_ problem - they aren't ranked by raw power but by fit:

| Situation                                                  | Technique                          | Why                                                                                                             |
| ---------------------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Prose description is **interpreted differently each time** | **Concrete input/output examples** | Eliminates interpretation. The model generalises from 2-3 before/after pairs more reliably than from any prose. |
| **Complex transformation, many edge cases**                | **Test-driven iteration**          | Test failures are concrete, unambiguous feedback ("Expected X, got Y") - no room for interpretation.            |
| Working in an **unfamiliar domain**                        | **Interview pattern**              | Claude asks questions _before_ implementing, surfacing considerations a non-expert would miss.                  |

**1. Concrete examples** - when prose keeps being read differently, the fix is **not more prose**, it's 2-3 examples showing exact input -> exact expected output (e.g. `Promise<UserData>` -> `Promise<Result<UserData, ApiError>>`). Reach for this **first** on inconsistent interpretation. (Full few-shot detail: triggers §98, construction rules §99.)

**2. Test-driven iteration** - write the tests first (happy path, edge cases like null/empty/boundaries, performance if relevant), then share the **failures** with Claude. `FAIL: ... Expected: null preserved / Actual: null replaced with ""` tells Claude exactly what to fix, no prose explanation.

**3. Interview pattern** - instead of prescribing ("Build me a caching layer"), ask Claude to **interview you first**: "Before implementing, ask me questions about the requirements, edge cases, and constraints." Claude surfaces cache invalidation, TTL, consistency, failure modes - things an expert addresses and you might overlook. _(Cross-reference)_ Same spirit as plan mode (§77): understand before committing - but here Claude interrogates _you_ to fill a knowledge gap, rather than exploring the codebase.

**The distinction the exam probes directly:** the **interview pattern** is for **unfamiliar domains** (you might miss considerations); **examples** are for when **you know the exact transformation** but the model misapplies it. Different problems - never swap them.

---

## 82. Example-based communication in practice

When prose produces inconsistent results, the switch to examples follows a fixed loop:

1. **Observe inconsistency** - you describe a transformation, Claude does it differently each run.
2. **Switch to examples** - give 2-3 concrete before/after pairs showing the exact transformation.
3. **Verify generalisation** - test on a **new** case to confirm the model extracted the pattern (not just memorised your samples).
4. **Add edge-case examples if needed** - if it nails the standard case but misses edges (nulls, empties), add examples that specifically show the edge handling.

**It's not "pile on more examples."** Two or three **well-chosen** ones covering the standard case plus a key edge case are enough - the model generalises the pattern; you don't hand it every possible case. More examples past that point add tokens, not accuracy. (The exam's tested bound is 2-4 targeted examples - §99.)

---

## 83. Batch vs sequential feedback - the interaction test

_How_ you deliver multiple pieces of feedback matters, and the deciding question is **do the fixes interact?**

- **Batch (one message) when fixes interact.** If changing the error-handling pattern also affects the logging format and the response structure, put all three in **one** message - the model needs to see the interacting constraints together to produce a coherent fix. Example: (1) error responses add an error-code field, (2) logging must include that code, (3) the client SDK types must reflect it - one message.
- **Sequential (one at a time) when issues are independent.** If the naming-convention fix and the indentation fix don't touch each other, do them one at a time. Batching **independent** issues can confuse the model about which feedback maps to which part of the code.

**One-line rule:** interacting -> batch (coherence); independent -> sequential (clarity).

| Trap (reject these answers)                                      | Why it's wrong                                                                                                                                      |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Refining the _prose_ when the model interprets it inconsistently | More precise prose still relies on interpretation; concrete input/output examples remove it. Inconsistent interpretation -> examples first, always. |
| Confusing the interview pattern with the examples technique      | Interview = unfamiliar domain (you might miss considerations); examples = known transformation the model misreads. Different problems.              |
| Batching independent issues / sequencing interacting ones        | Interacting fixes go in one message (model sees all constraints); independent fixes go sequentially (avoid cross-contamination).                    |
| Adding ever more examples to improve accuracy                    | 2-3 well-chosen pairs (standard + key edge case) suffice; the model generalises. Extra examples cost tokens, not correctness.                       |

---

## 84. The `-p` / `--print` flag - non-interactive mode for CI

This is the **single most directly tested fact in Domain 3** (it's Question 10 in the official sample set). Memorise it.

Claude Code defaults to **interactive mode**: it expects keyboard input and shows a conversational REPL. A CI pipeline has no keyboard, so a bare `claude "..."` invocation **hangs forever** waiting for input that never comes.

```bash
claude "Analyse this PR for security issues"       # WRONG - hangs in CI
claude -p "Analyse this PR for security issues"     # CORRECT - runs non-interactively
```

`-p` (also `--print`) switches to **print mode**: process the prompt, write the result to stdout, exit. No interactive input required.

**The exam scenario:** a CI job hangs, the logs show Claude waiting for input, pick the fix. The answer is always `-p`. **Reject the distractors** - they are fabricated:

| Distractor                      | Verdict                                   |
| ------------------------------- | ----------------------------------------- |
| `CLAUDE_HEADLESS=true`          | Does not exist                            |
| `--batch`                       | Does not exist                            |
| Redirect stdin from `/dev/null` | Doesn't properly address interactive mode |

Remember: slash commands don't exist in `-p` mode either (§ see the config-loading trap table) - print mode is not a REPL.

---

## 85. Structured output for CI - `--output-format json` and `--json-schema`

In CI no human reads the output; automated systems parse it to post inline PR comments, update dashboards, or trigger downstream jobs. So the output must be **machine-parseable**. Two flags work together:

- `--output-format json` - forces JSON (values are `text` | `json` | `stream-json`) instead of human-readable text.
- `--json-schema '<schema>'` - validates the final output against a JSON Schema after the agent completes (print mode only).

```bash
claude -p \
  --output-format json \
  --json-schema '{"type":"object","properties":{"findings":{"type":"array","items":{"type":"object","properties":{"file":{"type":"string"},"line":{"type":"integer"},"severity":{"type":"string"},"message":{"type":"string"}}}}}}' \
  "Review this PR for security issues"
```

Schema-conforming output lets automated systems parse findings, post them as inline comments at the exact file and line, filter by severity for different channels, and track findings across runs.

**Trap - the schema is passed inline, not by file.** `--json-schema` takes the **schema text itself** as its argument (`--json-schema '{...}'`). Unlike the system-prompt flags (§89), there is **no `--json-schema-file` variant** - don't assume one exists by analogy. Passing a path (`--json-schema ./review-schema.json`) does **not** read the file; the path string is treated as the schema, which is invalid, so Claude Code exits with an error (v2.1.205+; before that it silently produced unstructured output). To use a schema stored in a file, expand it into the argument yourself: `--json-schema "$(cat ./review-schema.json)"`. (Separately, `--output-format` also needs its value - the answer is `--output-format json`, not a bare `--output-format`; the `format` keyword inside a schema is accepted as an annotation but not client-side validated.)

---

## 86. Session context isolation - use an independent instance to review

The same Claude session that **generated** code is **less effective at reviewing it**. This is a measurable effect, not a theoretical worry.

**Why self-review is weaker:** while generating, the session accumulates reasoning context - why it chose this approach, what tradeoffs it weighed, what it rejected. Asked to review that same code in the same session, it retains all of that and is **less likely to question decisions it already justified to itself**.

**The fix:** a separate `claude -p` invocation for review, with **no access to the generation session's reasoning context**. The independent reviewer judges the code on its own merits.

```bash
claude -p "Implement the authentication middleware"                                   # session A: generate
claude -p "Review the auth middleware for security issues, error handling, edge cases" # session B: independent review
```

This connects to Domain 4 (multi-instance review architectures) and Domain 5 (context management); the exam tests it in CI/CD specifically. Same principle as fresh-start-plus-summary (§35) and the Explore subagent (§79): isolate context when prior context would **bias** rather than help. (The API-level version of the same rule, and the same-session distractors the exam pairs with it, are in §114.)

---

## 87. Incremental review context - report only new or unaddressed issues

Automated reviews run on **every push**. With no memory of prior runs, each run re-analyses the whole PR from scratch and **re-derives the same findings every time**.

The subtle part: a genuinely **fixed** issue drops out on its own (the changed code no longer triggers it). The ones that keep reappearing are the issues the developer **saw and deliberately chose not to change** - and a context-free re-scan can't tell those from new problems, so it flags them again on every push.

**The fix:** feed prior findings into context and instruct Claude to report **only** new or still-present issues.

```bash
claude -p --output-format json \
  "Review this PR. Previous review findings:
   ${PREVIOUS_FINDINGS}
   Report ONLY: (1) new issues not in the previous findings,
   (2) previous findings still present.
   Do NOT re-report findings the developer already reviewed and chose not to act on."
```

**Why it matters:** duplicate comments erode developer trust. If every push regenerates the same five comments regardless of action, developers stop reading them. Incremental context preserves the signal-to-noise ratio.

---

## 88. CLAUDE.md as the CI context feed

When Claude Code runs in CI it reads the project's CLAUDE.md files **exactly as it does interactively**. So CLAUDE.md is _the_ mechanism for giving a CI-invoked run project-specific context:

- **Testing standards** - what makes a valuable test, patterns to follow/avoid
- **Available fixtures** - which fixtures exist, how to use them, what data they hold
- **Review criteria** - what counts as a critical finding vs a minor style nit
- **Existing coverage** - what's already tested, to avoid suggesting duplicates

Without this, CI-invoked test generation produces low-value boilerplate; with it, generated tests follow team patterns and add genuine coverage. (Providing existing test files in context is the same idea - it lets Claude find coverage **gaps** instead of duplicating scenarios that already exist.)

---

## 89. System-prompt flags - append vs replace (the tested distinction)

Four flags shape the system prompt for a run (interactive or `-p`). The exam tests the **append-versus-replace** distinction:

| Flag                                 | Effect                                              |
| ------------------------------------ | --------------------------------------------------- |
| `--system-prompt "<text>"`           | **Replaces** the entire default system prompt       |
| `--system-prompt-file <path>`        | **Replaces** the default with a file's contents     |
| `--append-system-prompt "<text>"`    | **Appends** text to the default prompt              |
| `--append-system-prompt-file <path>` | **Appends** a file's contents to the default prompt |

**Append** when Claude should stay a coding assistant that _also_ follows your extra rules - appending keeps the default tool guidance, safety instructions, and coding conventions, so you supply only what differs. **Replace** when the identity or permission model differs from Claude Code's - e.g. a non-coding agent in an unwatched pipeline - because replacing drops the entire default prompt, so you now own everything the task still needs.

---

## 90. Headless CLI flags reference - output, limits, tools, startup

`-p` is the headliner, but the exam expects familiarity with the flags that shape a headless run. All work with `claude -p` and (where sensible) interactively.

**Output & limits (print mode):**

| Flag                                      | Effect                                                   |
| ----------------------------------------- | -------------------------------------------------------- |
| `--output-format text\|json\|stream-json` | Output shape; `json`/`stream-json` are machine-parseable |
| `--input-format text\|stream-json`        | Input shape for `-p`                                     |
| `--json-schema '<schema>'`                | Validate the final output against a JSON Schema          |
| `--max-turns <n>`                         | Cap agentic turns, then exit                             |
| `--verbose`                               | Full turn-by-turn output                                 |

**Permissions, tools, context:**

| Flag                          | Effect                                                                                          |
| ----------------------------- | ----------------------------------------------------------------------------------------------- |
| `--permission-mode <mode>`    | Start in `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, or `bypassPermissions`            |
| `--allowedTools "<rules>"`    | Tools that run without a prompt, e.g. `"Bash(git diff *)" "Read"`                               |
| `--disallowedTools "<rules>"` | Deny rules; a **bare tool name removes the tool from context entirely**                         |
| `--tools "Bash,Edit,Read"`    | Restrict which **built-in** tools are available at all                                          |
| `--add-dir <path>`            | Add a dir Claude may read/edit (grants **file access, not config discovery** - full detail §92) |
| `--model <alias\|name>`       | Set the session model (`sonnet`, `opus`, or a full name)                                        |

**Session & startup:** `-c` / `--continue` resumes the most recent conversation in the current directory; `-r` / `--resume <id\|name>` resumes a specific session (§15, §35). `--bare` is **minimal mode**: it skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md, leaving only Bash and file read/edit tools - reach for it when you want a fast, predictable scripted run and don't need project config loaded. (Note: `--bare` skipping CLAUDE.md is in tension with §88 - if your CI run _depends_ on CLAUDE.md context, do **not** use `--bare`.)

---

## 91. Batch API vs real-time for CI workflows

The **Message Batches API** gives **~50% cost savings** but processing takes **up to 24 hours with no latency SLA**. That draws a clean decision boundary around **blocking vs non-blocking** workflows:

| Workflow                         | API choice                  | Reason                                     |
| -------------------------------- | --------------------------- | ------------------------------------------ |
| Pre-merge checks (blocking)      | **Real-time (synchronous)** | Developers wait for results before merging |
| Overnight technical-debt reports | **Batch**                   | Not time-sensitive; 50% savings            |
| Weekly code audit                | **Batch**                   | Scheduled, latency-tolerant                |
| Nightly test generation          | **Batch**                   | Runs overnight, reviewed next morning      |

**The tested trap (Sample Question 11):** using the Batch API for **pre-merge checks**. Pre-merge checks are **blocking** - you can't merge until they finish - and the Batch API gives no latency guarantee. Rule: **blocking -> real-time; non-blocking overnight/weekly analysis -> batch.** (Full batch mechanics: custom_id and result types §110, SLA buffer calculation §111, failure handling §112, tool-calling limitation §113.)

---

## 92. `--add-dir` - file access, NOT configuration discovery

By default Claude Code can only touch files under the directory you launched from. `--add-dir` adds **additional working directories** it may read and edit (it validates each path exists as a directory; paths may be relative to cwd or absolute; multiple paths are accepted, e.g. `claude --add-dir ../apps ../lib`).

**What "access" means:** files in additional directories follow the **same permission rules** as the original working directory - readable without prompts, and edits follow the current permission mode. It's not a blanket yes: in `default` mode Claude still asks before editing there; in `acceptEdits` mode edits and common filesystem commands (`mkdir`, `touch`, `mv`, `cp`) auto-accept for paths in the working or additional directories; a read-only `cd` into such a path won't prompt.

**The exam-critical caveat** - this is _why_ §90 says "file access, not configuration discovery." Adding a directory does **not** make it a full configuration root. Most `.claude/` config is **not** discovered from an added directory; only a few types are exceptions:

| Config type                                      | Loaded from an `--add-dir` directory?                                                                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| Skills in `.claude/skills/`                      | **Yes**, with live reload                                                                                                             |
| Subagents in `.claude/agents/`                   | **Yes**                                                                                                                               |
| `.claude/settings.json` / `settings.local.json`  | **`enabledPlugins` and `extraKnownMarketplaces` keys only**                                                                           |
| `CLAUDE.md`, `.claude/rules/`, `CLAUDE.local.md` | **Only when `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`** (CLAUDE.local.md also needs the `local` setting source, on by default) |

Everything else - **commands, output styles, hooks, and the rest of `settings.json`** - comes only from your cwd chain, `~/.claude/`, and managed settings. **Practical consequence:** `--add-dir ../backend` lets Claude edit backend code but, by default, it **won't follow the coding conventions in `../backend/CLAUDE.md`**.

**Two more distinctions the exam can probe:**

- These config exceptions apply **only** to directories added via the `--add-dir` flag or the `/add-dir` command. Directories listed in **`permissions.additionalDirectories`** in a settings file grant **file access only** - they load **none** of the config above.
- Because `permissions.allow` rules and `permissions.additionalDirectories` grant capability, Claude Code applies them only after you accept the **workspace trust dialog** for that folder.

---

## 93. Three ways to add a directory, and `--add-dir` vs `/cd`

**Three mechanisms:**

- **At startup:** `--add-dir <path>` (multiple paths allowed). Also accepted by `claude agents`, alongside `--settings`, `--plugin-dir`, `--mcp-config`.
- **Mid-session:** the `/add-dir` slash command.
- **Persistently:** `permissions.additionalDirectories` in a settings file - put it in `.claude/settings.json` so the whole team inherits it: `{ "permissions": { "additionalDirectories": ["../packages/ui", "~/shared-libs"] } }`. (Remember: the persistent form grants **file access only**, per §92.)

**`--add-dir` vs `/cd`** (easy to confuse):

- `--add-dir` / `/add-dir` **widens** the workspace - adds a directory while keeping the original as primary.
- `/cd` **relocates** the session: the new directory's `CLAUDE.md` is loaded and `--resume` finds the session from there. Use `--add-dir` to widen, `/cd` to move. (`/cd` targets are themselves governed by `Cd` permission rules.)

**`--continue` interaction:** `-c` loads the most recent conversation in the current directory, **including sessions that added this directory with `/add-dir`** - so a session started in `frontend/` that added `backend/` is resumable from either.

**Practical guidance (monorepo):** the classic case is starting in `apps/web` while imports resolve into `packages/ui` and `packages/db`. Without `--add-dir`, Claude guesses type signatures or asks you to paste code. The cost is **context**: every added directory widens the Glob/Grep search space, so add only what the current task needs - not the whole repo root.

---

## 94. Explicit categorical criteria vs vague instructions - "be conservative" is a distractor

The single biggest mistake in production prompt engineering is relying on vague instructions: "be conservative", "only report high-confidence findings", "use your best judgement". They sound like good engineering, which is exactly why the exam uses them as distractors - none of them gives the model an actionable decision boundary.

The correct approach is **explicit categorical criteria**: define precisely what to flag and what to skip. Compare, for a CI/CD review pipeline (§86-§88):

- **Wrong:** `Review this code. Be conservative. Only report high-confidence findings.`
- **Correct:** `Flag comments only when claimed behaviour contradicts actual code behaviour. Report bugs and security vulnerabilities. Skip minor style preferences and local patterns.`

The first gives no criteria to apply - "conservative" means different things in different contexts, and "high-confidence" is a subjective threshold the model cannot calibrate. The second provides concrete categories: what to report (bugs, security), what to skip (style, local patterns), and a specific trigger for comment flags (claimed vs actual behaviour contradiction).

| Exam trap                                                                                         | Why it's wrong                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choosing "be conservative" or "only report high-confidence findings" as valid prompt improvements | Vague instructions do not improve precision - the model has no actionable interpretation of "conservative". Specific categorical criteria defining exactly what to flag and what to skip are the correct answer. |

---

## 95. The false-positive trust problem - disable, fix, re-enable

**High false positive rates in one category destroy developer trust in ALL categories.** The exam leans on this hard. If "documentation mismatch" findings are wrong 40% of the time, developers stop reading the "security vulnerability" findings too - even when those run at 98% accuracy. Trust is not category-specific; it bleeds across the whole output. (Same trust dynamic as duplicate re-reported findings in §87.)

The fix feels backwards: **temporarily disable** the high false-positive categories while you rework their prompts. Trust in the categories that already work comes back straight away. Then iterate on the broken category with concrete code examples (§96), re-enabling it only once precision improves. You are not abandoning the category - you are putting system-wide trust ahead of category completeness.

| Exam trap                                                              | Why it's wrong                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Keeping all review categories active while iterating on the broken one | The bad category keeps poisoning trust in every other category during the iteration. Disable it first, fix, then re-enable. |

---

## 96. Severity calibration needs code examples, not prose

Defining severity levels requires **concrete code examples**, not prose descriptions:

- **Prose (insufficient):** `Critical: issues that could cause system failures or data loss. Minor: issues that affect code readability but not functionality.`
- **Code examples (correct):** Critical - unsanitised user input in a SQL query: `query = f"SELECT * FROM users WHERE id = {user_input}"`. Minor - inconsistent variable naming: `userName` vs `user_name` in the same module.

Prose forces the model to interpret what "could cause system failures" means. A code example removes the ambiguity entirely: when the model sees actual code patterns classified at each severity level, it produces **consistent classification across invocations**. This is the same example-based communication principle as §81-§82, applied to severity rubrics - and it feeds the severity field your CI pipeline filters on (§85).

---

## 97. Why confidence-based filtering fails - criteria first, routing second

"Only report high-confidence findings" is a tempting exam answer: filter by confidence, keep the strong signals. It fails because **LLM self-reported confidence is poorly calibrated** - the model is often sure about wrong findings and hesitant about right ones.

Confidence scores do have a legitimate job: **routing**, e.g. sending low-confidence findings to human review (the exam files this under Task Statement 4.6; how to calibrate the threshold: §115). But routing is no substitute for explicit criteria (§94) that define what counts as a valid finding in the first place.

**The hierarchy: explicit criteria first, confidence-based routing second. Never skip the first step.**

| Exam trap                                          | Why it's wrong                                                                                                                                                                                                   |
| -------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Assuming confidence thresholds fix false positives | Self-reported confidence is poorly calibrated; explicit criteria with concrete code examples (§96) produce better results than confidence filters. Confidence routing is useful only AFTER criteria are defined. |

---

## 98. Few-shot examples first for consistency - the three deployment triggers

**Few-shot examples are the most effective technique for achieving consistent, well-formatted output.** Not more instructions, not confidence thresholds (§97), not temperature adjustments. The exam presents scenarios where detailed instructions produce inconsistent results and tests whether you choose "add more instructions" or "add few-shot examples" - the correct answer is almost always the latter. (This extends the §81-§82 examples technique; scope note: few-shot improves **consistency**, it still cannot **guarantee** compliance - §18, §23.)

Three specific triggers tell you few-shot examples are needed:

1. **Detailed instructions alone produce inconsistent formatting** - the prompt specifies the format, yet output varies across invocations (sometimes a list, sometimes a table, sometimes prose). More instructions will not fix this; examples showing the exact format will.
2. **Inconsistent judgement calls on ambiguous cases** - e.g. variable shadowing flagged "critical" in one file, "minor" in another; or "check my order" routed to different tools depending on phrasing. These need examples demonstrating the correct judgement, **with reasoning** (§99).
3. **Extraction produces empty/null fields for information that exists** - the data is present but in an unexpected format (narrative text instead of a table, split across paragraphs). Examples showing extraction from varied document structures resolve this.

| Exam trap                                                                 | Why it's wrong                                                                                                                                                       |
| ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Choosing "add more detailed instructions" when formatting is inconsistent | If detailed instructions already exist and output is still inconsistent, more instructions won't fix it - examples of the exact desired format will.                 |
| Using confidence thresholds to fix inconsistent judgement calls           | Poorly calibrated (§97) and doesn't address the root cause; few-shot examples showing the correct judgement for ambiguous cases directly teach consistent decisions. |

---

## 99. Constructing effective examples - 2-4, with reasoning, aimed at the failures

The construction rules are tight:

- **Use 2-4 targeted examples.** Fewer than 2 doesn't establish a pattern; more than 4 wastes tokens without proportional benefit. Point them at the specific ambiguous scenarios causing problems.
- **Each example must show reasoning**, not just an input-output pair. Reasoning is what teaches the model to **generalise** its judgement to novel patterns instead of literally matching the sampled cases. E.g. for input "check my order #12345" -> tool `lookup_order`, the reasoning "the specific order identifier makes lookup*order correct over get_customer" teaches the general principle \_specific identifiers route to specific lookup tools*; without it the model learns only "order numbers -> lookup_order".
- **Cover the failing scenarios.** If extraction works on tables but fails on narrative text, the examples must show correct extraction from narrative text. If review is inconsistent on variable shadowing, the examples must classify shadowing scenarios at different severity levels with reasoning (same code-examples-for-severity principle as §96).

**Trap:** thinking few-shot examples only teach literal pattern-matching. When examples include the reasoning behind the decision, the model learns the decision principle and generalises to novel patterns - that's the whole point of including reasoning.

---

## 100. Few-shot side effects - hallucination reduction and false-positive reduction

Beyond consistency, few-shot examples pull double duty in two tested ways:

**Hallucination reduction in extraction.** When the model sees correct extraction from **varied document structures** - inline citations vs bibliographies, narrative descriptions vs structured tables, headers vs embedded text - it learns to handle structural variety without inventing data. This matters most for inconsistently formatted documents (a financial report with expenses in a table on one page, buried in a paragraph on the next): without examples the model nails the table but returns empty fields for the narrative section, or worse fabricates values. Show it both structures and extraction quality climbs.

**False-positive reduction in review.** Examples can show both **what to flag and what to ignore**. An example that classifies benign variable shadowing (inner variable shadows outer within a limited arrow-function scope, no bug, still readable) as `minor - style preference, not a defect` teaches the model to distinguish genuine bugs from acceptable patterns - cutting false positives (the §95 trust problem) while preserving generalisation to genuinely problematic shadowing.

---

## 101. Few-shot vs other techniques - the problem -> technique table

The exam tests distinguishing when few-shot is the right solution versus when another technique applies:

| Problem                                    | Correct technique                                           |
| ------------------------------------------ | ----------------------------------------------------------- |
| Inconsistent output formatting             | Few-shot examples (§98)                                     |
| Malformed JSON output                      | `tool_use` with JSON schemas (§50; mechanism §102)          |
| Fabricated values for missing fields       | Optional/nullable schema fields                             |
| Wrong tool selection                       | Better tool descriptions **first** (§39-§40), then few-shot |
| Model misses information in narrative text | Few-shot examples showing narrative extraction (§100)       |
| Extraction sum does not match total        | Validation-retry loop (§103; retry anatomy §106)            |

Two rows deserve emphasis. **Wrong tool selection** is the one place few-shot is explicitly second: fix the tool descriptions first (§40's fix hierarchy - few-shot there is token overhead treating the symptom); few-shot only helps after descriptions differentiate the tools. **Fabricated values** are a schema problem, not an examples problem: if a field is required, the model invents a value to satisfy the schema - make it optional/nullable so "absent" is expressible.

---

## 102. tool_use as a structured-output mechanism - not just tool selection

`tool_use` (function calling) is **not only** for routing between external tools. Its second, equally established job is **structured output**: define a "tool" with an `input_schema` (JSON Schema), and when Claude "calls" it, Claude doesn't write free-form text - it produces a `tool_use` content block whose `input` field is **validated against your schema**. You can exploit this even when you have no intention of calling a tool in the traditional sense - no API request, no database lookup, the tool is never executed. **The tool call IS the output.**

**The pattern:**

```typescript
const extractClausesTool: Anthropic.Tool = {
  name: "record_extracted_clauses", // never executed - a schema carrier
  description: "Records the clauses extracted from a legal contract.",
  input_schema: {
    type: "object",
    properties: {
      clauses: {
        type: "array",
        items: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: [
                "termination",
                "indemnification",
                "confidentiality",
                "liability_cap",
              ],
            },
            summary: { type: "string" },
            sourceQuote: { type: "string" },
            effectiveDate: {
              type: ["string", "null"], // nullable - no fabrication (the §101 fix)
              description:
                "ISO 8601 date if explicitly stated, otherwise null.",
            },
          },
          required: ["type", "summary", "sourceQuote", "effectiveDate"],
        },
      },
    },
    required: ["clauses"],
  },
};

const response = await anthropic.messages.create({
  model: "claude-sonnet-4-6",
  max_tokens: 2000,
  tools: [extractClausesTool],
  tool_choice: { type: "tool", name: "record_extracted_clauses" }, // forced - no prose escape hatch
  messages: [
    { role: "user", content: `Extract the clauses from:\n\n${contractText}` },
  ],
});

const toolUseBlock = response.content.find((b) => b.type === "tool_use");
return toolUseBlock.input as ExtractionResult; // already a parsed, schema-validated object
```

**Why this fixes malformed JSON specifically.** The naive alternative - "respond only in JSON" in a text prompt - gambles on free-text generation: Claude may wrap the JSON in code fences, add a preamble ("Here's the extracted data: {...}"), or drop a closing brace, so you defensively strip and `JSON.parse()` and it can still throw. With tool_use, the API layer itself constrains generation against the schema, so `.input` arrives as a **genuine parsed object**, not a string you have to parse and hope is valid. There is no free text to malform. That is the mechanistic reason it's the exam answer for "malformed JSON output" (§101).

Supporting pieces:

- **Force the call** with `tool_choice: {"type": "tool", "name": ...}` so the model can't answer in prose (§50); this is the "single-shot structured extraction" case flagged as the legitimate forced-`tool_choice` use.
- _(Fact-check enrichment)_ Add `strict: true` to the tool definition (**strict tool use**) and schema conformance becomes a hard guarantee via grammar-constrained sampling, not just strong steering.
- _(Fact-check enrichment)_ The API also has a **native** structured-output parameter: `output_config.format` with `type: "json_schema"` (formerly beta `output_format`; beta header no longer required, GA for Claude 4.5+). The docs' division of labour: JSON outputs control **what Claude says** (response text); strict tool use validates **how Claude calls your functions** (tool inputs). For the exam's "malformed JSON" scenario the tested answer remains tool_use with JSON schemas.

**Discriminators to keep straight** (all "tool"-flavoured, which is why the exam pairs them):

| Problem                        | Technique and why                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------- |
| Malformed JSON syntax          | tool_use with a schema - constrains **how output is serialised** (this section)                         |
| Inconsistent content/judgement | Few-shot examples - shape **content and judgement**, not syntax (§98-§99)                               |
| Fabricated missing values      | Optional/nullable schema fields - shape **whether a value is required**, not how it's serialised (§101) |
| Wrong tool selected            | Better tool descriptions first - a **selection** problem, not an output-shape problem (§39-§40)         |

(Claude Code's CLI analogue of schema-validated output is `--json-schema`, §85. What tool_use does NOT prevent - semantic errors that survive a valid schema - is §103.)

---

## 103. What tool_use does NOT prevent - syntax vs semantic errors

§102 explains why tool_use with a JSON schema eliminates **syntax** errors (missing brackets, trailing commas, unquoted keys - there is no free text to malform). The exam's sneaky follow-up: the schema guarantees **structure, not correctness**. Three semantic error classes survive a perfectly valid tool_use response:

| Semantic error class   | Example                                                                                                                                                 |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sum discrepancies      | Extracted line items that do not sum to the stated total                                                                                                |
| Field placement errors | A value in the wrong field - e.g. a date in an amount field; when both fields are strings, the schema cannot object                                     |
| Fabrication            | The model invents values for required fields when the source document lacks the information (fix: nullable fields, §101-§102; escape-route enums, §104) |

Semantic validation needs **additional logic outside the schema** - e.g. the validation-retry loop from §101's table: recompute the sum from the extracted line items, compare against the stated total, re-prompt on mismatch. The exam files semantic validation under Task Statement 4.4. (What the retry message must contain: §106. When a retry can and cannot work: §107.)

**Exam trap:** "tool_use with JSON schemas prevents all extraction errors." It eliminates JSON syntax errors only; sum mismatches, wrong-field placement, and fabricated values still occur and require separate validation. Commit the hierarchy: tool_use with JSON schemas eliminates syntax errors entirely; prompt-based JSON gives no structural guarantee and will periodically produce unparseable output in production (mechanism in §102).

---

## 104. Schema enum design - "unclear" and "other" + detail string

Two enum-design patterns that prevent error classes at the structural level, companions to the optional/nullable defence against fabrication (§101-§102):

- **"unclear" enum value** - for cases where the source is genuinely ambiguous, add an explicit `"unclear"` option to enum fields. Without it, the model is forced to pick a confident classification even when the evidence does not support one.
- **"other" + freeform detail string** - for extensible categorisation, pair an `"other"` enum value with a nullable freeform detail field. This captures edge cases your predefined categories do not cover, instead of shoehorning them into the nearest wrong category.

```json
{
  "category": {
    "type": "string",
    "enum": ["invoice", "receipt", "contract", "unclear", "other"]
  },
  "category_detail": {
    "type": ["string", "null"],
    "description": "Freeform detail when category is 'other'"
  }
}
```

The shared principle across all three patterns (nullable, "unclear", "other"+detail): **give the model an honest escape route**. A schema that only offers confident, complete answers pressures the model into plausible-looking wrong ones - the same mechanism by which required fields pressure fabrication (§101). Honest null / "unclear" / "other" is always preferable to fabricated confidence.

---

## 105. Format normalisation rules belong in the prompt - schema enforces structure, prompt enforces formatting

The schema constrains shape (types, enums, required vs nullable); it does not standardise how values are written _within_ a valid type. "2026-07-27", "27/07/2026", and "July 27, 2026" are all valid strings, and 19.99 vs "USD 19.99" both fit loose typing. The fix is to include **format normalisation instructions in the prompt alongside the schema** - e.g. "All dates in ISO 8601 format", "All currency amounts as decimal numbers without currency symbols".

Division of labour: **the schema enforces structure; the prompt enforces formatting consistency.** (Field `description` strings inside the schema can carry format hints too - §102's example does exactly that on its `effectiveDate` field - but the tested statement is that normalisation rules accompany the schema in the prompt.)

Do not confuse this with §25's PostToolUse normalisation: that hook normalises **inbound tool results** before the model reads them; this section is about the model's own **extracted output**, steered at generation time. Different direction of data flow, same goal of one consistent format.

---

## 106. Retry-with-error-feedback - the three-component retry message

§101 and §103 name the validation-retry loop as the fix for semantic errors; this section is the anatomy of the retry itself. A correct retry sends **three pieces of information** back to the model:

1. **The original document** - so the model has the source to re-examine.
2. **The failed extraction** - so the model can see what it produced.
3. **The specific validation error** - so the model knows exactly what went wrong.

```typescript
const retryMessages = [
  {
    role: "user",
    content:
      `Original document:\n${originalDocument}\n\n` +
      `Your extraction:\n${JSON.stringify(failedExtraction)}\n\n` +
      `Validation error: Line items sum to £450 but stated_total is £500. ` +
      `Please re-extract, ensuring all line items are captured.`,
  },
];
```

This beats a naive retry by a wide margin. Without the specific error, the model has no guidance for what to fix and usually **reproduces the same mistake**. With it, self-correction is targeted: re-examine the document for missed line items, check field placement, recalculate the total.

**Exam trap:** implementing retries without including the specific validation error. Naive retries produce the same mistakes; the model needs to see exactly what went wrong (e.g. "line items sum to £450 but stated total is £500") to self-correct effectively.

(Whether a retry can work at all is a separate, harder-tested question - §107.)

---

## 107. The retry effectiveness boundary - fixable vs unfixable failures

Flagged by the source material as the concept the exam tests **most aggressively** in this task statement (Task Statement 4.4): retries have a clear effectiveness boundary, and the exam presents both fixable and unfixable scenarios expecting you to identify which is which.

| Retries ARE effective for                                                  | Retries are NOT effective for                                        |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| Format mismatches (wrong date format, inconsistent currency notation)      | Information genuinely absent from the source document                |
| Structural output errors (values in wrong fields, incorrect nesting)       | Data that exists only in an external document not given to the model |
| Misplaced values (data present in the document but put in the wrong field) | Fields requiring knowledge the model does not have                   |
| Mathematical errors (a missed line item affecting the total)               |                                                                      |

The dividing line: **retries fix how existing information was extracted; they cannot create information absent from the source.** If a document genuinely does not contain a department name, no amount of retrying (§106) produces a correct value. Instead, flag the extraction for **human review** (confidence-based routing's legitimate job, §97) or **return null** if the schema allows it (the nullable / escape-route patterns, §101-§104). Always identify whether a failure is fixable before retrying.

**Exam trap:** assuming retries always work for extraction failures. Retries fix format mismatches, structural errors, and misplaced values - they cannot produce information the source lacks.

---

## 108. Self-correcting schema design - calculated_total vs stated_total, conflict_detected

Rather than relying solely on external validation logic (§103's outside-the-schema checks), you can build discrepancy detection **into the extraction schema itself**:

- **calculated_total vs stated_total** - extract BOTH the sum the model computes from the individual line items and the total the document states. When they differ, you get an automatic discrepancy flag with no external logic:

```json
{
  "line_items": [
    { "description": "Widget A", "amount": 150.0 },
    { "description": "Widget B", "amount": 300.0 }
  ],
  "calculated_total": 450.0,
  "stated_total": 500.0,
  "total_discrepancy": true
}
```

- **conflict_detected booleans** - boolean fields that flag when the source document contradicts itself. If one section says "payment due: 30 days" and another says "payment terms: net 60", the model extracts **both** and sets `conflict_detected: true` rather than silently picking one.

Same spirit as §104's escape routes - the schema gives the model an honest way to surface a problem instead of papering over it - but a different target: §104's patterns (nullable, "unclear", "other"+detail) handle ambiguity or absence in a **single field**; these handle **internal inconsistency** across fields or document sections. (Cross-source conflicts between different documents in research synthesis get the same annotate-don't-resolve treatment: §145.)

---

## 109. detected_pattern fields - dismissal analysis and the improvement loop

For code-review and analysis pipelines, add a **`detected_pattern`** field to each structured finding, recording which specific code construct triggered it:

```json
{
  "finding": "Potential SQL injection vulnerability",
  "severity": "critical",
  "detected_pattern": "string concatenation in SQL query",
  "file": "user_service.py",
  "line": 42
}
```

The payoff comes when developers dismiss findings (the dismissed-issues context §87 already feeds back into review runs): you can analyse dismissals **by detected_pattern**. If developers consistently dismiss findings triggered by "variable shadowing in nested scope", that specific pattern needs prompt refinement (the §94-§96 toolbox) - not the whole review category. This creates a systematic improvement loop: **extract -> validate -> collect dismissal data -> refine prompts -> repeat.** It is the data-collection half of §95's disable-fix-re-enable cycle: `detected_pattern` tells you precisely which pattern is generating the false positives worth fixing.

---

## 110. Batch mechanics - custom_id matching, result types, and batch limits

The mechanics behind the §91 decision rule:

- **`custom_id` is the correlation key, not optional bookkeeping.** Every request in a batch carries a unique `custom_id`, and **batch results can be returned in ANY order** - they may not match submission order - so `custom_id` is the only reliable way to match a response back to its request. Matching by position in the results file is a bug. (Fact-check enrichment: the any-order behaviour and the format constraint - 1 to 64 characters, only alphanumerics, hyphens and underscores - come from the official docs.)
- **Four result types per request** (results stream as JSONL, one result object per line):

| Result type | Meaning                                                        | Billed? |
| ----------- | -------------------------------------------------------------- | ------- |
| `succeeded` | Completed; includes the message result                         | Yes     |
| `errored`   | Invalid request or internal server error; no message created   | No      |
| `canceled`  | User canceled the batch before this request ran                | No      |
| `expired`   | Batch hit its 24-hour expiry before this request could be sent | No      |

- **Batch size limits:** at most **100,000 requests or 256 MB**, whichever is reached first (fact-check enrichment). Most batches actually finish in under an hour - but that is best-effort, never a guarantee (§111).
- **SDK path:** batches live under the Messages namespace - `client.messages.batches.create(...)` and `client.messages.batches.results(...)` in both Python and TypeScript. (Fact-check correction: exam-prep material sometimes shows a bare `client.batches.create` / `client.batches.results`, which is not the real SDK path.)

---

## 111. Working backwards from the 24-hour window - SLA buffer calculation

The Batch API guarantees only that processing **ends within 24 hours**; requests still unprocessed at that point come back as `expired` and are not billed (§110). The exam presents scheduling questions where you back-calculate a submission schedule from an external SLA:

- If a report must be delivered within a **30-hour SLA**, the final batch must be submitted **no later than 24 hours before the deadline**.
- That leaves **30 - 24 = 6 hours of buffer** for collecting requests, validating inputs, or absorbing operational delays.
- Within the buffer, submit batches **every 4-6 hours** so a fresh batch is always in flight.

**Trap: designing around best-case timing.** Batch results often arrive within minutes to an hour, but there is **no latency SLA** - any deadline-bound design must assume the 24-hour maximum, never the typical case. This is the same discipline as §91's blocking-vs-non-blocking rule, applied to scheduling maths.

---

## 112. Batch failure handling - resubmit only failures, refine on a sample set first

Not every request in a batch succeeds. The tested failure-handling pattern has three steps:

1. **Identify failures by `custom_id`** (§110). Parse the batch results and collect the `custom_id` values whose result type is not `succeeded`.
2. **Resubmit ONLY the failures, with targeted modifications** - never the entire batch. Typical modifications: chunk oversized documents that exceeded context limits, simplify the extraction prompt for unusually structured documents, add format-specific few-shot examples (§98-§99) where structural variety caused the failure.
3. **Refine prompts on a sample set BEFORE the full batch.** Test against 5-10 representative documents covering the range of formats and edge cases in the corpus, iterate on prompts / few-shot examples / schema design until the sample extracts accurately, and only then submit the full volume.

Step 3 is the proactive, cost-dominant one: on 1,000 documents, a 90% first-pass success rate means 100 retries; a 60% rate means 400 retries - four times the resubmission cost on top of the wasted first pass. Sample-set refinement maximises first-pass success and is what the exam expects you to name as the step that "slashes total cost".

| Trap                                        | Why it's wrong                                                                                              |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Resubmitting the whole batch after failures | You pay again for everything that already succeeded; identify failures by custom_id and retry only those.   |
| Resubmitting failures unchanged             | The same input with the same prompt fails the same way; modify (chunk / simplify / add examples) first.     |
| Skipping sample-set testing to "save time"  | A low first-pass rate multiplies retry cost; refinement before submission is the cheapest step in the flow. |

---

## 113. Tool use in batches - single model turn, no agentic loop within a batch item

Each batch item is **one Messages API call** - one model turn. Consequences for tools:

- **Tool use IS supported inside batch requests.** (Fact-check nuance: the official docs list vision, tool use - including server tools such as web search and code execution - system messages, multi-turn conversation _history_, and extended thinking as all batchable.) The model can emit `tool_use` blocks; the request then simply ends with that as its result.
- **What is impossible is the agentic loop within a single batch item:** you cannot execute a client-side tool, return the `tool_result`, and have the model continue processing - the follow-up turn would be a new request, and batch items are processed independently.

Rule: if a workflow needs the model to **execute tools mid-processing and continue with their results** (an agentic loop, §1-style), that step must use the **synchronous API**. This is a direct exam test point, and the exam states the limitation broadly as "no multi-turn tool calling within a single batch request" - answer with that framing. (The server-tool subtlety above is doc-accurate background, not what the exam probes.)

---

## 114. Independent review at the API level - fresh messages.create, NOT extended thinking

§86 states the self-review rule at the CLI level (`claude -p` session A generates, session B reviews). The exam also tests the same rule at the **API level**, with two specific same-session distractors.

**The anti-pattern:** appending a "now review your code for bugs" user turn to the **same messages array** that contains the generation turn. The prior assistant turn carries the model's reasoning chain - why it chose each approach, classified each finding at a given severity, selected certain values - so it tends to **confirm rather than challenge** those decisions.

**The correct pattern:** a **new `messages.create` call** whose input is only the artifact plus the review criteria - a fresh instance with no prior reasoning context, judging the output on what it sees alone.

| Exam trap (same-session "fixes")                                        | Why it's wrong                                                                                                                  |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Adding "please review carefully" instructions to the generating session | Politeness/emphasis does not remove the retained reasoning chain - the bias is structural, not effort-related.                  |
| Relying on extended thinking within the generating session              | More thinking over the same biased context is still self-review; the model reasons harder about decisions it already justified. |

The correct exam answer is always the **separate model instance**. Same context-isolation principle as §35, §79, §86: isolate when prior context would bias rather than help.

---

## 115. Calibrating confidence thresholds - labelled validation sets, raw vs calibrated

§97 establishes that raw self-reported confidence is poorly calibrated and that routing (low-confidence findings -> human review) is confidence's legitimate job. This section adds the mechanics the exam tests: **how a confidence score becomes usable for automated routing**.

A confidence score is **not self-reported accuracy** - it is the model's read on its own certainty, e.g.:

```json
{
  "finding": "Potential race condition in order processing",
  "severity": "major",
  "confidence": 0.65,
  "reasoning": "The lock acquisition pattern appears correct but the unlock timing depends on an async callback whose ordering I cannot fully verify.",
  "route": "human_review"
}
```

**Calibration procedure:** run **labelled validation examples** (cases where you already know the correct answer) through the system, measure how reported confidence tracks **actual accuracy**, then set the routing thresholds from that data. Once calibrated: high-confidence findings report directly to developers; low-confidence findings route to human review.

The exam distinguishes two states of a confidence score:

| State                         | Suitable for automated decisions? | Why                                                                |
| ----------------------------- | --------------------------------- | ------------------------------------------------------------------ |
| Raw / uncalibrated confidence | No - anti-pattern                 | Nothing ties the number to real accuracy (§97).                    |
| Calibrated threshold          | Yes - for routing                 | Validated against labelled sets, so the threshold tracks accuracy. |

Trap: using uncalibrated confidence scores for automated review routing. Calibrate against labelled validation sets first - and remember the §97 hierarchy still applies: explicit criteria first, routing second. Calibration is also **per field and per segment**, not one global curve (full detail §141).

---

## 116. Production multi-instance review architecture - five stages and when the cost is worth it

The full production review pipeline combines §32 (multi-pass), §86/§114 (independent instances), and §115 (calibrated routing) into five stages:

1. **Generation** - a first instance generates the code, extraction, or analysis.
2. **Per-unit review** - independent instances review each output unit (file, document) individually, for consistent depth (§32).
3. **Integration review** - a separate instance checks cross-unit consistency (§32's cross-file pass).
4. **Confidence routing** - low-confidence findings go to human review (§115).
5. **Calibration loop** - labelled validation sets **continuously** recalibrate the confidence thresholds (§115).

This architecture is **more expensive than single-pass review** - that is the deliberate trade-off. It is worth it when review quality directly affects **production reliability**: CI/CD pipelines, financial extraction, compliance analysis, and any system where missed issues have downstream consequences. For low-stakes review, single-pass may be the right economic choice - the exam tests whether you can match the architecture to the stakes, not apply the heaviest pipeline everywhere.

---

## 117. Progressive summarisation destroys transactional data - the persistent case facts block

Context window management is the foundation of reliable multi-turn systems, and the most tempting long-conversation strategy is a trap: summarising earlier turns to free token budget **systematically destroys the most critical information** in customer-facing and data-processing systems - numerical values, dates, percentages, order numbers, and customer-stated expectations. "I'd like a refund of $247.83 for order #8891 placed on March 3rd" becomes, after summarisation, "Customer wants a refund for a recent order" - the amount, order number, and date the agent needs to process the refund are gone. That is not a fringe case; it is what summarisation does to transactional data by default.

The fix - flagged by the source as **the single most important pattern in context window management** - is the **persistent case facts block**: extract transactional facts (amounts, dates, order numbers, statuses) into a structured block that is included in **every prompt, outside the summarised history**. The block is never summarised and persists across every turn regardless of what happens to the conversation history.

```json
{
  "caseFactsBlock": {
    "customerId": "C-4421",
    "issues": [
      {
        "orderId": "#8891",
        "orderDate": "2024-03-03",
        "refundAmount": "$247.83",
        "status": "pending_refund",
        "itemDescription": "Wireless headphones - defective"
      }
    ]
  }
}
```

For **multi-issue sessions** (a customer raises several problems in one conversation), extract and persist structured issue data into a separate context layer, one entry per issue with its own order IDs, amounts, and statuses - this prevents cross-contamination between issues during summarisation.

Trap: thinking progressive summarisation is safe for transactional data. It is not - the case facts block must hold those facts outside the summarised history.

---

## 118. The Messages API is stateless - full history every request, truncation is not the answer

The Claude API keeps **no session state server-side**. Each request must carry the complete conversation history; omit earlier messages and the model loses conversational coherence, because every turn has to contain everything the model needs to follow the conversation.

This creates the central tension of context management: coherence needs the full history, but the history grows with every turn. The resolution is the split §117 makes - separate **critical facts** from **summarisable narrative**: summarise the conversational flow, while the persistent case facts block preserves every transactional detail outside the summary.

Trap: believing conversation history can be **selectively truncated** without consequences. Selective truncation breaks conversational coherence - the correct combination is case facts blocks plus summarisation of the narrative, not truncation.

---

## 119. The "lost in the middle" effect - the fix is structural, NOT prompt-based

Models process information at the **beginning and end** of long inputs reliably; findings buried in the **middle** of a long context may be missed or given less weight. This is a well-documented LLM phenomenon and it directly affects aggregated inputs - e.g. feeding a synthesis agent the outputs of three research subagents.

The fix is **structural, not prompt-based**: place a key findings summary at the **beginning** of the aggregated input, then organise the detailed results with **explicit section headers** throughout:

```markdown
## Key Findings Summary

- Source A: 12% market growth in renewable sector (2023)
- Source B: Patent filings increased 34% year-on-year
- Source C: Regulatory framework delayed until Q3 2025

## Detailed Findings

### Source A: Market Analysis Report

[Full details here...]

### Source B: Patent Database Analysis

[Full details here...]
```

Trap: assuming the effect is solved by telling the model to "pay attention to everything". Prompt-based reminders are unreliable for position effects - restructure the input instead.

---

## 120. Tool result trimming - cut verbose results BEFORE they enter the history

Tool results are a silent context budget killer. An order lookup can return 40+ fields - internal audit timestamps, warehouse codes, carrier IDs, fulfilment centre identifiers - when the refund request needs 5. Every irrelevant field consumes tokens **in every subsequent turn** as the history grows; skip trimming and multi-turn systems slowly drown in stale tool output. It is not a nice-to-have.

```python
def trim_order_result(raw_result, relevant_fields=None):
    if relevant_fields is None:
        relevant_fields = [
            "order_id", "order_date", "total_amount",
            "return_eligible", "item_description"
        ]
    return {k: v for k, v in raw_result.items() if k in relevant_fields}
```

The trimming must happen in a **PostToolUse hook or in the tool implementation itself**, before the result enters the conversation history - once verbose data is in the context, it stays there for every subsequent turn. (Same boundary as §25, different job: §25 normalises formats for interpretation consistency; this trims fields for token budget.)

Trap: keeping full tool results in context because "the model might need them later". Untrimmed 40-field lookups exhaust the token budget across turns - trim to relevant fields before results enter the history.

---

## 121. Upstream agent optimisation - structured findings, not reasoning chains

In multi-agent systems, upstream agents often return verbose reasoning chains and raw content that downstream agents cannot use. A research subagent that sends its full thought process to a synthesis agent with a limited context budget wastes that agent's tokens on unusable reasoning.

The fix: modify **upstream** agents to return **structured data** - key facts, citations, relevance scores - instead of verbose content and reasoning chains, and **require metadata** (dates, source locations, methodological context) in the structured outputs to support accurate downstream synthesis:

```json
{
  "findings": [
    {
      "claim": "Renewable energy investment grew 12% in 2023",
      "source": "IEA World Energy Report 2024",
      "sourceUrl": "https://example.com/report",
      "relevanceScore": 0.92,
      "publicationDate": "2024-01-15"
    }
  ]
}
```

Tokens are not the only win: structured outputs let downstream agents process findings without re-parsing verbose prose. (Same principle as the delegation rule in §11 - pass on the final result, not the intermediate work - and the structured findings slot directly into the §119 "key findings first" aggregation layout.)

---

## 122. Prompt caching - cache_control breakpoints and static-first ordering

Prompt caching is the other half of context economics: instead of trimming what the model sees (§120), you avoid paying to **reprocess the parts that don't change**. Mark a stable prefix with a `cache_control` breakpoint (`{"type": "ephemeral"}`) and the API stores that processed prefix and reuses it on subsequent requests at a fraction of the input cost (§123 for the exact numbers).

Caching matches **from the start of the prompt, prefix by prefix**, so layout decides whether you get a hit. Put the content that stays constant **first** - system instructions, tool definitions, long reference documents - place the breakpoint at the **end of the static block**, and put volatile content (the user's latest message, anything per-request) **after** it. _(Fact-check enrichment)_ The cache prefix is built in a fixed hierarchy: `tools` -> `system` -> `messages`.

```python
response = client.messages.create(
    model="claude-sonnet-5",
    system=[
        {"type": "text", "text": LONG_STATIC_INSTRUCTIONS},
        {"type": "text", "text": REFERENCE_DOC,
         "cache_control": {"type": "ephemeral"}},
    ],
    messages=[{"role": "user", "content": dynamic_user_message}],
)
```

_(Correction to the source)_ The source sample placed a `{"role": "system"}` message inside the `messages` array; in the Messages API, `system` is a **top-level request parameter** holding an array of content blocks (that is where the `cache_control` block goes), not a message role.

Get the order wrong and you lose the benefit entirely: if dynamic content sits before the static block, the prefix changes on every request, nothing matches, and every call pays full price.

---

## 123. Prompt caching lifetime, pricing, and limits

The economics and constraints behind §122, verified against the prompt caching docs:

| Fact             | Value                                                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Default TTL      | 5 minutes since last use - the cache is **refreshed at no extra cost** each time the cached content is used                                                                                       |
| Longer TTL       | `{"type": "ephemeral", "ttl": "1h"}` buys a 1-hour lifetime                                                                                                                                       |
| Cache write cost | 1.25x base input price (5-minute TTL); 2x base input price (1-hour TTL)                                                                                                                           |
| Cache read cost  | 0.1x base input price                                                                                                                                                                             |
| Breakpoints      | Up to 4 per request; the breakpoints themselves cost nothing                                                                                                                                      |
| Minimum length   | Model-dependent (commonly 1,024 tokens; some models 2,048 or 4,096). Below the minimum the request silently processes **without caching - no error**                                              |
| Invalidation     | Cascades down the `tools` -> `system` -> `messages` hierarchy: a change at one level invalidates that level **and everything after it** (changing a tool definition invalidates the entire cache) |

The practical consequence of the 5-minute refresh-on-use TTL: caching pays off for **bursts of related requests**, not for content reused hours apart - an hours-apart workload either pays the 2x one-hour write or re-pays the full input price.

---

## 124. Escalation calibration - the three valid triggers (customer support)

Escalation calibration is a distinct skill from workflow enforcement (§17-19) or handoff formatting (§22): it decides **whether** to hand off at all, not how the handoff is structured once the decision is made. Exactly three triggers justify escalating a support case to a human - the exam treats this as an exhaustive list, not a sample:

1. **Explicit human request.** "I want to speak to a person" -> escalate immediately. Do not attempt to resolve the issue first, and do not say "let me see if I can help with that first." This is an absolute rule with no exceptions.
2. **Policy exceptions or gaps.** The request falls outside documented policy - e.g. a customer asks for competitor price-matching when policy only covers same-site price adjustments. The agent cannot make policy on the fly; this needs human judgement.
3. **Inability to make meaningful progress**, after a genuine attempt. Tool errors local retry logic can't resolve, missing system access, or a technical bug needing engineering intervention. The catch-all, but only after the agent has actually tried and failed - "I might not be able to handle this" is not sufficient on its own.

**Gap vs violation is the tested distinction inside trigger 2:**

| Term             | Definition                                    | Escalate?                                              |
| ---------------- | --------------------------------------------- | ------------------------------------------------------ |
| Policy gap       | Policy is silent on this specific situation   | Yes - needs human judgement                            |
| Policy violation | Policy has a documented answer (usually "no") | No - apply the documented answer, resolve autonomously |

Whichever of the three triggers fires, the escalation itself must use the five-field structured handoff from §22 - customer ID, conversation summary, root cause, refund amount if applicable, recommended action.

---

## 125. Two unreliable escalation triggers - sentiment and self-reported confidence

Two commonly proposed triggers sound reasonable and are the exam's anti-patterns for this topic:

- **Sentiment-based escalation** (frustration detection, negative sentiment score, escalate when it crosses a threshold): fails because **frustration does not correlate with case complexity**. A furious customer with a simple late delivery is easy to resolve - apologise, offer compensation, reship. A calm, polite customer asking about competitor price-matching has a genuine policy gap that needs escalation regardless of tone. Sentiment measures emotional state, not case difficulty.
- **Self-reported confidence scores** (the model outputs a 1-10 confidence rating, escalate below a threshold): fails for the same calibration reason established in §97 - **LLM self-reported confidence is poorly calibrated**. The model is often incorrectly confident on hard cases (it does not know what it does not know) and unnecessarily hedges on straightforward ones. A confidence-threshold escalation policy therefore produces the exact failure mode the exam describes: it escalates simple cases while attempting to resolve complex ones itself - backwards from the intended routing.

This is the §97 hierarchy re-applied to a new domain: explicit criteria (the three §124 triggers) come first; neither sentiment nor self-reported confidence is a substitute for them.

| Exam trap                                                | Why it's wrong                                                                                                                          |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Escalating based on a sentiment/frustration score        | Sentiment does not equal complexity - a furious customer can have a trivial case, a calm customer can have a genuine policy gap         |
| Escalating based on a self-reported confidence threshold | Confidence is poorly calibrated (§97) - confidently wrong on hard cases, hedges on easy ones; produces the opposite of intended routing |

---

## 126. The frustration nuance - resolvable-but-upset vs wants-a-human

A tested decision rule that sits on top of §124-125: frustration alone is never the escalation signal, but what the customer says about wanting a human is.

| Situation                                                    | Correct response                                                                                                                                       |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Issue is straightforward, customer is frustrated             | Acknowledge the frustration, then resolve it directly - "I understand this is frustrating. I can process your replacement right now." Do NOT escalate. |
| Customer reiterates wanting a human after being offered help | Escalate now - they were given the opportunity to accept agent resolution and declined it                                                              |
| Customer says "I want a human" from the very start           | Escalate immediately - no investigation, no offer to help first (§124 trigger 1)                                                                       |

The distinction the exam tests: "frustrated customer with a resolvable issue" (resolve it) and "customer who explicitly wants a human" (escalate) are two different situations requiring two different responses - do not conflate emotional tone with an explicit request for a human.

---

## 127. Ambiguous customer matching - ask, never guess

When a lookup tool returns multiple matching customer records - e.g. three "John Smith" entries for a name search - the agent must ask the customer for an additional identifier: email address, phone number, order number, or similar.

The agent must **not** resolve the ambiguity itself by selecting the most recent record, the most active record, or any other heuristic. This is not just a UX nicety: guessing wrong can expose one customer's data to another (a privacy violation) or perform an action - such as a refund - against the wrong account. Ambiguous matches have exactly one safe response: ask for clarification.

This is a narrower, data-integrity-specific instance of the same "don't guess, get a human decision" instinct behind §124's triggers - except here the clarifying step is a question back to the customer, not an escalation to a human agent.

---

## 128. Explicit escalation criteria in system prompts - the proportionate first response

The most effective way to calibrate escalation is to put **explicit escalation criteria with few-shot examples** (§98-99) directly in the system prompt, covering:

- When to escalate (the three §124 triggers, with the gap-vs-violation distinction spelled out)
- When to resolve autonomously (straightforward case, frustrated-but-resolvable per §126)
- The exact format of the escalation (the five-field structured handoff, §22)

This is the same "prompt optimisation before architecture" principle used elsewhere in the guide (§17-18, §94, §98): reaching for a sentiment classifier or a confidence-scoring layer is adding infrastructure before the explicit-criteria-in-the-prompt approach has even been tried. Explicit criteria plus examples is the proportionate first response; escalate the _implementation_ to more infrastructure only if that genuinely proves insufficient.

---

## 129. Structured error context - the four required elements

Building on §47's "include partial results and what was attempted," the exam expects a specific four-part shape for what a failing subagent reports upward - each element answers a distinct recovery question the coordinator needs:

1. **Failure type** - transient, validation, business, or permission (the same four categories as §44's tool-error taxonomy, now applied at the subagent-report level rather than a single tool call).
2. **What was attempted** - the specific query, parameters, and target system ("searched academic database for 'renewable energy policy', date range 2022-2024"), not a generic "search failed."
3. **Partial results gathered before failure** - if 3 of 5 sources were retrieved before a timeout, those 3 results are usable; discarding them because the overall operation failed wastes completed work.
4. **Potential alternative approaches** - the subagent's domain knowledge of what else might work (a different database, broader search terms, cached results), so the coordinator isn't guessing at recovery options blind.

```json
{
  "status": "partial_failure",
  "failureType": "transient",
  "attemptedAction": {
    "tool": "search_academic_db",
    "query": "renewable energy policy",
    "dateRange": "2022-2024"
  },
  "partialResults": [
    {
      "title": "EU Renewable Energy Directive 2023",
      "source": "EUR-Lex",
      "retrieved": true
    }
  ],
  "alternativeApproaches": [
    "Retry with narrower date range (2023-2024)",
    "Search alternative database: government_publications",
    "Use cached results from previous research session"
  ]
}
```

With this, the coordinator can choose among retry, try-alternative, proceed-with-partial, or escalate - a generic `{"status": "error"}` supports none of those choices.

---

## 130. The two named anti-patterns - silent suppression and workflow termination

§47 already describes both failure modes; the exam names them explicitly and expects you to recognise each by name and by symptom:

| Anti-pattern             | What it looks like                                                                                                        | Why it's catastrophic                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Silent suppression**   | A subagent catches a timeout and returns `{"results": [], "status": "success"}`                                           | The coordinator believes the search ran and legitimately found nothing (§46's "valid empty result"), so it never retries or tries alternatives. The final synthesis looks complete but silently omits an entire research area - and the gap is invisible because nothing signals it. This is the worse of the two anti-patterns precisely because it can't be detected downstream. |
| **Workflow termination** | One subagent times out and the entire pipeline crashes, discarding results from the four subagents that already succeeded | A disproportionate response: it destroys completed work to punish one localised failure, and leaves the coordinator with no partial output to recover from.                                                                                                                                                                                                                        |

The correct middle ground is structured error propagation (§129) into the coordinator, which then decides on targeted recovery - it neither hides the failure (suppression) nor treats it as fatal to everything else (termination).

_(Trap)_ In a customer support context, silent suppression is what makes an agent tell a customer "no orders found" when the order-lookup system was actually down - the two look identical to the customer, but only one is true, and conflating them is a §46-style access-failure-vs-valid-empty-result error surfacing at the application layer.

---

## 131. Coverage annotations - flagging synthesis gaps instead of silently omitting them

When a synthesis agent combines findings from several subagents and one of them failed or returned only partial results, the synthesis should explicitly state which areas are well-supported and which have known gaps - e.g. "Section on geothermal energy is limited due to unavailable journal access during research" - rather than quietly leaving the topic out.

Without a coverage annotation, a gap in the final report is indistinguishable from "this topic wasn't relevant" - the reader has no way to tell a scoping decision from a data-availability failure. This is the synthesis-output-facing counterpart to §130's silent-suppression trap: suppression hides the failure inside the pipeline; missing coverage annotations hide it in the final deliverable even when the pipeline itself reported the failure correctly upstream.

---

## 132. Context degradation - the failure mode, and why a bigger window does not fix it

Large-codebase exploration (an unfamiliar repository, tracing dependency chains, understanding a legacy system) is one of the most context-intensive things an agent does, and extended sessions fail in a specific, **observable** way: **context degradation**. The model stops referencing the concrete classes, methods and dependency chains it discovered earlier and starts reaching for generic language instead.

- **Degraded:** "this follows the typical repository pattern".
- **Intact:** "the `OrderRepository` class at `src/repos/order.ts` implements the base `Repository<T>` interface with custom caching in the `findById` method".

The mechanism, step by step:

1. Each exploration step generates verbose output - file contents, search results, directory listings.
2. That output accumulates in the conversation context.
3. Earlier, precise discoveries get pushed further back while recent verbose output dominates.
4. The model's attention shifts to the recent output and it loses the specific references from earlier.

**The critical insight the exam tests: context degradation is NOT a token-limit problem.** The model is not running out of space; it is losing its grip on specific details as they get buried. Increasing the context window does not fix it - a larger window still fills with the same verbose output. _(Fact-check note: this distractor is more tempting than it used to be, because 1M-token windows are genuinely available - Fable 5, Sonnet 5, Opus 4.6 and later, and Sonnet 4.6 - and the docs state that compaction "works the same way at the larger limit". Bigger window, same failure mode.)_

_(Cross-reference)_ Structurally identical lesson to **attention dilution** (§31-§32): the fix is architectural, never "a better model, a bigger window, or a stronger prompt". Related context-quality effects: "lost in the middle" (§119, also fixed structurally), stale context (§35), and never-read-all-files-upfront (§62).

**Traps from this domain, and where each is answered:**

| Trap                                                               | Why it's wrong                                                                                                                                                         |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Increasing the context window to solve context degradation         | It is not about running out of tokens; it is about losing track of specific details as verbose output accumulates. A larger window fills with the same verbose output. |
| Assuming subagent delegation is only about parallelisation         | The primary benefit for exploration is **context isolation** - keeping the main agent's context clean while subagents absorb the verbose work (§134).                  |
| Restarting a session to fix degradation without saving state first | Restarting discards all accumulated knowledge. Persist findings first (scratchpad §133, state manifest §138), then inject them into the new session (§35, §135).       |
| Using `/compact` only when you hit the context limit               | `/compact` protects context **quality**, not just quantity - run it proactively during extended sessions (§136).                                                       |

---

## 133. Scratchpad files - persisting findings outside the conversation context

The **primary mitigation** for context degradation: the agent writes key findings to a file and reads that file back when it needs them later. Knowledge held in a file lives **outside** the conversation context, so it is structurally immune to being buried by newer verbose output.

```markdown
# Exploration Scratchpad - Order Service

## Key Classes

- `OrderRepository` (src/repos/order.ts) - implements Repository<T>, custom findById caching
- `OrderService` (src/services/order.ts) - orchestrates OrderRepository + PaymentGateway
- `RefundProcessor` (src/services/refund.ts) - depends on OrderService.getOrderWithItems()

## Dependency Chain

RefundProcessor -> OrderService -> OrderRepository -> PostgreSQL
RefundProcessor -> PaymentGateway -> Stripe API

## Critical Findings

- RefundProcessor has no retry logic for Stripe API failures
- OrderRepository caches by orderId but cache invalidation on status change is missing
- Test coverage: OrderService has 87% coverage, RefundProcessor has 12%
```

**The timing rule is itself tested:** the scratchpad is a **deliberate strategy from the outset**, not a rescue move once degradation shows. Instruct the agent to maintain one from the start of any extended exploration session - by the time the symptoms appear, the precise findings you wanted to record are already the ones that got lost.

_(Cross-reference)_ Same "hold the durable facts outside the summarisable stream" move as the **persistent case facts block** (§117), one level up: §117 keeps transactional facts out of the summarised history within a conversation; a scratchpad keeps discovery facts out of the conversation entirely. It also survives `/compact` (§136), which a mid-conversation finding does not.

---

## 134. Subagent delegation for exploration - context isolation, NOT parallelisation

The second major mitigation: instead of the main agent doing all the exploration itself (and filling its own context with the verbose output of every read and search), delegate **specific investigation questions** to subagents:

- "Find all test files for the order service and report their coverage status"
- "Trace the refund flow from API endpoint to database and list all intermediate services"
- "Identify all external API integrations and their error handling patterns"

Each subagent runs in its **own isolated context**. It can explore as verbosely as it likes without polluting the coordinator's context, and it returns a **structured summary**; the coordinator keeps only the key findings.

**Parallelisation is the obvious read and the wrong one.** The primary value for codebase exploration is **context isolation** - the main agent's context stays clean for high-level coordination while subagents absorb the verbose work. Speed is a side benefit. _(Fact-check enrichment: the docs frame subagents exactly this way - "use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary", and list "delegate verbose operations to subagents" as a token-reduction strategy in its own right.)_

_(Cross-reference)_ Same principle, three earlier framings: the delegation rule in §11 (delegate when you need only the final result, not the intermediate work), the **Explore** subagent in §79 (read-only discovery that returns summaries), and `context: fork` on a skill in §72 (verbose skill output isolated in a sub-agent fork). Note the deliberate echo of §12: there too, parallelism is a side benefit and completeness is the real reason. Contrast §14, where parallel spawning genuinely **is** about latency.

---

## 135. Summary injection between exploration phases - the cold-start problem

When exploration runs in phases (Phase 1: understand the architecture; Phase 2: investigate specific components), summarise Phase 1's key findings and **inject that summary into the initial prompt of every Phase 2 subagent**.

Without it you get the **cold-start problem**: Phase 2 subagents, having no access to Phase 1's context, redo Phase 1's exploration from scratch - and, worse, ask the wrong questions, because they lack the architectural understanding that would have told them where to look.

```
Phase 1 Summary (injected into Phase 2 subagent prompts):
- The system follows a layered architecture: Controllers -> Services -> Repositories -> Database
- The refund flow passes through: RefundController -> RefundProcessor -> OrderService -> PaymentGateway
- Key concern: RefundProcessor has no retry logic for external API failures
- Phase 2 objective: Investigate error handling in RefundProcessor and PaymentGateway
```

_(Cross-reference)_ This is **summary injection** (§35) applied across phases instead of across sessions, and it follows directly from the isolation property in §134/§11: isolation is what keeps the coordinator's context clean, and it is also why nothing reaches a subagent that the coordinator did not put in its prompt (§12 - no automatic inheritance). Note the objective line in the example: a phase summary should carry both **what was learned** and **what this phase is for**.

---

## 136. `/compact` - proactive summarisation, and what survives it

`/compact` reduces context usage during an extended session by replacing the conversation so far with a structured summary while preserving key information. Use it **proactively** during long exploration sessions - it is there to protect context **quality**, not only quantity. Waiting until you hit the limit is the trap.

Verified mechanics _(fact-check enrichment - the source mentions only the basic behaviour)_:

| Fact                                      | Detail                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Signature is `/compact [instructions]`    | The argument is **optional focus instructions** for the summary, e.g. `/compact Focus on code samples and API usage`            |
| Default focus can be set in `CLAUDE.md`   | A `# Compact instructions` section tells compaction what to preserve by default                                                 |
| Auto-compaction exists                    | Claude Code compacts automatically as you approach the limit, using the same mechanism - a full window does not end the session |
| Compaction is itself an expensive request | It reads the conversation it summarises, so compacting a huge context costs real tokens. `/clear` costs nothing                 |
| Fresh session                             | `/compact` prints `Not enough messages to compact.` when there is no history yet                                                |
| `/context`                                | Visualises current context usage as a colored grid, with optimisation suggestions - use it to decide **when** to compact        |

**What survives compaction** (verified table - this is the part people get wrong):

| Mechanism                                   | After compaction                                                                            |
| ------------------------------------------- | ------------------------------------------------------------------------------------------- |
| System prompt and output style              | Unchanged; not part of message history                                                      |
| Project-root `CLAUDE.md` and unscoped rules | Re-injected from disk                                                                       |
| Auto memory                                 | Re-injected from disk                                                                       |
| Rules with `paths:` frontmatter             | **Lost** until a matching file is read again                                                |
| Nested `CLAUDE.md` in subdirectories        | **Lost** until a file in that subdirectory is read again                                    |
| Invoked skill bodies                        | Re-injected, capped at 5,000 tokens per skill and 25,000 tokens total; oldest dropped first |
| Hooks                                       | Not applicable - hooks run as code, not context                                             |

The startup **skill listing** is the one auto-loaded item that is _not_ re-injected after `/compact`; only skills you actually invoked are preserved. If a path-scoped rule must survive compaction, drop its `paths:` frontmatter or move it into the project-root `CLAUDE.md` (§71). And because compaction summarises the conversation, anything you need verbatim afterwards belongs in a scratchpad file (§133), not in the transcript.

---

## 137. Choosing the context remedy - compact vs clear vs fresh start vs delegate

The exam pairs these as distractors for each other, so map the symptom to the remedy rather than reaching for whichever is most familiar.

| Situation                                                               | Remedy                                             | Why not the others                                                             |
| ----------------------------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Context filling with verbose output, but the current task must continue | `/compact`, ideally with focus instructions (§136) | `/clear` throws away work you still need                                       |
| Switching to unrelated work                                             | `/clear`                                           | `/compact` on a huge context is itself a large, paid request; clearing is free |
| Tool results are stale because files changed since                      | Fresh start + summary injection (§35)              | Resume and fork both carry the stale tool results forward                      |
| Discovery is about to be noisy and you know it                          | Delegate to a subagent up front (§134, §79)        | Prevention beats remedy - the output never enters the main context at all      |
| You will need earlier precise findings much later                       | Scratchpad file (§133)                             | Summaries, compaction, and restarts all erode specifics                        |
| The session may crash, or the work spans sessions                       | Structured state manifest (§138)                   | Nothing in-context survives a crash                                            |
| Comparing two divergent approaches from a shared baseline               | `fork_session` (§15)                               | This is not a context-pressure problem at all                                  |

The through-line: **`/compact` and `/clear` manage context that already exists; delegation, scratchpads and manifests stop it from existing or keep it outside the context in the first place.** Prefer the structural options for anything you expect to be long-running.

---

## 138. Crash recovery via structured state manifests

Extended exploration sessions can die from a session crash, a network interruption, or context exhaustion. Without a recovery mechanism, every finding is lost.

The fix is **structured state persistence**: each agent exports its current state to a known file location - a **manifest** - covering four things:

1. **What has been explored** - files read, searches performed.
2. **Key findings** discovered so far.
3. **Current phase and next steps.**
4. **Pending questions or unresolved issues.**

```json
{
  "sessionId": "explore-order-service-001",
  "phase": 2,
  "exploredPaths": [
    "src/repos/order.ts",
    "src/services/order.ts",
    "src/services/refund.ts"
  ],
  "keyFindings": {
    "architecture": "Layered: Controllers -> Services -> Repositories -> DB",
    "criticalIssue": "RefundProcessor has no retry logic for Stripe API failures",
    "testCoverage": { "OrderService": "87%", "RefundProcessor": "12%" }
  },
  "nextSteps": [
    "Investigate PaymentGateway error handling",
    "Review RefundProcessor test files",
    "Check cache invalidation logic in OrderRepository"
  ]
}
```

On resume, the coordinator **loads the manifest and injects it into the agent prompts**, and the agent continues from where it stopped instead of re-exploring.

Note the distinction the exam can exploit: a manifest is **not** `--resume`. `--resume` restores the conversation history - including stale tool results (§35) - and only works if a session actually survived. A manifest is an agent-authored artefact on disk: it survives a crash, it contains distilled findings rather than raw transcripts, and it is consumed by **injection** into a fresh session (§35, §135). A scratchpad (§133) is the same idea aimed at in-session recall; a manifest is aimed at cross-session recovery, which is why it also carries phase, next steps and open questions.

---

## 139. The aggregate metrics trap - validate by document type AND field segment

The most dangerous misconception in production extraction systems: a system reports **97% overall accuracy**, the team celebrates, and management approves full automation for all high-confidence extractions. The aggregate hides catastrophic failure rates on specific document types:

| Document type         | Date accuracy | Amount accuracy | Name accuracy |
| --------------------- | ------------- | --------------- | ------------- |
| Standard invoices     | 99.5%         | 98.2%           | 97.8%         |
| Handwritten receipts  | 60.1%         | 55.3%           | 71.2%         |
| Scanned PDFs          | 72.4%         | 69.8%           | 80.1%         |
| International formats | 45.2%         | 52.1%           | 63.4%         |
| **Aggregate**         | **97.0%**     | **96.1%**       | **95.8%**     |

The aggregate looks excellent only because standard invoices dominate the volume - it is a **volume-weighted average**, and three document types with unacceptable accuracy are hidden inside it. Worse, the failing segments are often the ones where errors have the highest business impact (handwritten receipts from field staff, international invoices from new suppliers, scanned historical documents for compliance audits).

The rule: **always validate accuracy by document type AND field segment before automating.** Never make automation decisions from aggregate metrics alone. This is why calibration is per field and per segment (§141) and why the automation sequence starts with segmented measurement (§143).

| Trap                                                                                        | Why it is wrong                                                                                                                              |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Using aggregate accuracy (e.g. 97%) to justify automating all high-confidence extractions   | Aggregate metrics hide per-type performance - 97% overall can coexist with 45-60% accuracy on specific document types. Validate by document type and field segment first. |

---

## 140. Stratified random sampling - sample the HIGH-confidence extractions too

Even after segmented validation (§139), you need ongoing verification. **Stratified random sampling** selects a representative sample from each stratum - document type, confidence band, field type - and has humans verify it.

The critical, exam-tested insight: **you must sample high-confidence extractions, not just low-confidence ones.** Low-confidence items are already routed to human review (§97, §115); high-confidence items are automated. If the model develops a **novel error pattern** that affects high-confidence extractions - e.g. a systematic error on a new document format - only stratified sampling of the automated stream will catch it before downstream business processes fail.

Stratified sampling serves two purposes:

1. **Ongoing accuracy measurement** - confirm each segment maintains its validated accuracy rate.
2. **Novel error pattern detection** - discover failure modes that did not exist in the original validation set.

| Trap                                                       | Why it is wrong                                                                                                                       |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Only sampling low-confidence extractions for human review  | Low-confidence items already get review via routing. Novel errors in the automated high-confidence stream are invisible without stratified sampling of high-confidence items. |

---

## 141. Field-level confidence calibration - per field and per segment, not one global curve

§115 gives the calibration procedure (labelled validation sets, raw vs calibrated). This section adds the granularity the exam tests: **calibration curves differ by field type and segment**, so one global threshold is wrong.

The model can output confidence per field:

```json
{
  "vendorName": { "value": "Acme Corp", "confidence": 0.98 },
  "invoiceDate": { "value": "2024-03-15", "confidence": 0.95 },
  "totalAmount": { "value": "$1,247.83", "confidence": 0.72 },
  "lineItems": { "value": ["..."], "confidence": 0.61 }
}
```

But raw scores are **relative, not absolute**: a reported 0.90 might correspond to 94% actual accuracy on date fields and only 82% on amount fields. Building a **calibration curve** per field type - run documents with known correct extractions, compare reported confidence to actual accuracy (§115's procedure) - converts the relative number into a usable one.

Calibrated **per-field thresholds** then drive three-zone routing:

| Zone                                | Routing                                          |
| ----------------------------------- | ------------------------------------------------ |
| Above the calibrated threshold      | Automated - with stratified sampling (§140)      |
| Below the calibrated threshold      | Human review                                     |
| In the ambiguous zone (near threshold) | **Prioritised** human review (§142)           |

Trap: applying one global confidence threshold across all fields and document types. The same raw score means different actual accuracy per field type, so thresholds must be calibrated per field and per segment (§139).

---

## 142. Reviewer capacity prioritisation - dynamic uncertainty ordering, not even spread

Human reviewers are expensive and limited; the exam tests whether you allocate their capacity to maximise accuracy per reviewer-hour. The rule: **route the highest-uncertainty items to reviewers first.** Uncertainty signals include:

- Low calibrated model confidence on a field (§141)
- Ambiguous or contradictory source documents
- Document types with historically poor accuracy (§139)
- The model expressing uncertainty (e.g. multiple possible interpretations)

Do **NOT** spread reviewer capacity evenly across all extractions - an even distribution wastes time re-checking high-confidence items the model handles well, while leaving insufficient capacity for the uncertain items where human judgement actually adds value.

Prioritisation must also be **dynamic, not static**: the review queue is ordered by uncertainty, and when a reviewer finishes an item, the next item served is the highest-uncertainty item remaining - **not the next in chronological order**.

| Trap                                                  | Why it is wrong                                                                                                     |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Spreading reviewer capacity evenly across all extractions | Wastes capacity on high-confidence items; prioritise the highest-uncertainty items where human judgement adds the most value. |
| Serving the review queue in chronological order       | Static ordering ignores uncertainty; the queue should always surface the highest-uncertainty item remaining.          |

---

## 143. Validation before automation - the five-step sequence

The steps of §139-§142 have a mandatory order; each exists to prevent a specific failure mode, and the exam trap is jumping straight to the last step:

1. **Measure accuracy by document type and field segment** - not aggregate (§139).
2. **Calibrate confidence scores** using labelled validation sets (§115, §141).
3. **Set calibrated thresholds** for automation vs human review (§141).
4. **Implement stratified random sampling** for ongoing verification of automated extractions (§140).
5. **Only then** reduce human review on segments that demonstrate consistent, validated accuracy.

Skipping to step 5 based on aggregate metrics is the trap (§139): automation gets approved on a volume-weighted 97% while specific segments fail at 45-60%, and without steps 2-4 there is no calibrated routing and no sampling to catch it.

---

## 144. Claim-source mappings - attribution must survive synthesis itself, not just the handoff

Every finding in a multi-agent research system must carry its provenance as a **structured claim-source mapping**. This is not optional metadata - it is the structural guarantee that the final output can be traced back to specific sources. Each finding carries five fields: the claim, the source URL, the document name, the relevant excerpt, and the publication date:

```json
{
  "claim": "Global renewable energy investment reached $495 billion in 2023",
  "sourceUrl": "https://example.com/iea-report-2024",
  "documentName": "IEA World Energy Investment Report 2024",
  "relevantExcerpt": "Total investment in renewable energy technologies reached approximately $495 billion in calendar year 2023, representing a 17% increase over 2022.",
  "publicationDate": "2024-06-15"
}
```

(This extends §13's structure with two fields the exam expects: the **relevant excerpt** - the specific passage that supports the claim - and the **publication date**, whose role §146 explains.)

The critical failure mode: **attribution dies during summarisation.** A synthesis agent naturally compresses and paraphrases when combining findings from multiple subagents; without explicit instructions to preserve the mappings, it produces statements like "investment in renewable energy has grown significantly" - no amount, no source, no date. Three requirements defeat this:

1. Subagents output findings in the structured claim-source format.
2. The synthesis agent is **explicitly instructed to maintain the mappings** when combining findings.
3. The final output includes inline citations or a structured reference section tracing each claim to its source.

In the full pipeline - research subagent collects findings with mappings -> analysis subagent adds assessment while preserving the original mappings -> synthesis subagent merges mappings from multiple agents -> report generation emits inline citations - every step risks attribution loss, but **the most common failure point is the synthesis step**, where findings get combined and paraphrased without the mappings carried forward. The synthesis agent's prompt must explicitly require that every claim in its output is traceable to a specific source.

Diagnostic discriminator vs §13 - same symptom (an uncited report), two different bugs:

| Where the mappings were lost                          | Fix                                                                                       |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Coordinator stripped metadata before synthesis (§13)  | Coordinator context passing - the synthesis prompt cannot help; it never saw the sources    |
| Metadata arrived intact but synthesis paraphrased it away (this section) | The synthesis prompt - explicitly require preservation and merging of claim-source mappings |

Diagnose which link failed before choosing the fix.

---

## 145. Cross-source conflicts - annotate both values with attribution, never pick one

When two credible sources report different statistics for the same measure, the wrong approach - and the one the exam tests for - is to **arbitrarily select one value**. Selecting the more recent source, averaging the values, and preferring the more authoritative publisher are ALL wrong: each destroys information and presents a false certainty. The correct approach is to annotate with both values and full source attribution, and let the consumer decide:

```markdown
Market growth estimates vary by source:
- **12% growth** - IEA World Energy Report (published June 2024, using 2023 calendar year data)
- **8% growth** - Bloomberg NEF Annual Review (published March 2024, using July 2022 - June 2023 data)

The difference may reflect different reporting periods and methodological approaches.
```

The same rule applies one step earlier, at the analysis agent: when document analysis encounters conflicting values, it must **complete its work with the conflicts included and explicitly annotated** - it should not resolve them. That decision belongs to the coordinator or the consumer, who can present both values, investigate further, or escalate to a human analyst:

```json
{
  "field": "annualRevenue",
  "conflictDetected": true,
  "values": [
    {
      "value": "$4.2M",
      "source": "Annual Report 2023",
      "context": "Audited financial statements, fiscal year ending December 2023"
    },
    {
      "value": "$3.8M",
      "source": "SEC Filing Q4 2023",
      "context": "Preliminary unaudited figures, calendar year 2023"
    }
  ],
  "possibleExplanation": "Difference may reflect audited vs preliminary figures and fiscal vs calendar year reporting periods"
}
```

(§108 is the within-document counterpart - conflict_detected booleans when one document contradicts itself; this section is the cross-source version in research synthesis, with the same annotate-don't-hide spirit as §131's coverage annotations.)

Reports should also include explicit sections distinguishing **well-established findings from contested ones**, preserving original source characterisations and methodological context: a finding supported by three independent sources is different from one based on a single report, even if the prose would otherwise present both with equal confidence.

---

## 146. Temporal awareness - different publication dates explain different numbers

Different publication dates explain different numbers. That is not a contradiction - it is **temporal context**, and it must be preserved. Source A (published 2023) reports 8% growth; Source B (published 2024) reports 12%. Without publication dates these look contradictory; with dates they tell a story: growth accelerated from 8% to 12% over the measured period. The "conflict" is actually a trend.

The rule: **require publication or data-collection dates in all structured outputs.** Subagents must include the dates in their structured outputs, the synthesis agent must preserve them through merging, and the final output must present them alongside the data they describe. This is not housekeeping - without temporal context, valid trends get misread as data quality issues, and the synthesis agent may incorrectly flag or suppress findings that are actually consistent.

This is why `publicationDate` is a required field in §144's claim-source mapping, and why the §145 conflict annotation includes dates and reporting periods for both values (§121 already requires dates in upstream structured outputs; this section is the reason).

Trap: assuming different numbers from different sources are contradictions - check the dates before treating a difference as a conflict.

---

## 147. Content-appropriate rendering - tables, prose, lists by content type

Different types of content demand different presentation formats; synthesis should NOT flatten everything into a uniform format:

| Content type            | Render as        | Why                                                                                  |
| ----------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| Financial data          | Tables           | Numbers, comparisons and trends are most readable tabularly; prose hides patterns     |
| News / current events   | Prose            | Narrative context, cause-and-effect and chronology read naturally as paragraphs       |
| Technical findings      | Structured lists | Architectural patterns, API specs and config options need clear bulleted hierarchy    |

Forcing all content into a single format - all tables, all prose, or all lists - degrades readability and comprehension. The synthesis agent should select the rendering format based on the content type.

---

## Quick self-test

<details>
<summary>1. Where does stop_reason live in the response?</summary>
At the root of the response object, not inside content.
</details><br>

<details>
<summary>2. Loop continues on which value, terminates on which?</summary>
Continues on tool_use, terminates on end_turn; anything else means "not finished, check why".
</details><br>

<details>
<summary>3. Why is content[0].type == "text" wrong as a completion check?</summary>
Text and tool_use blocks coexist in one response; text presence and position prove nothing.
</details><br>

<details>
<summary>4. When is an iteration cap acceptable?</summary>
Only as a safety net against runaway loops - never as the primary stopping mechanism, and never as a fix for premature termination.
</details><br>

<details>
<summary>5. What goes wrong with tool_choice: "any" in a loop?</summary>
stop_reason can never be end_turn; the loop runs forever.
</details><br>

<details>
<summary>6. What does forcing tool_choice do to Claude's text output?</summary>
Suppresses it - no explanation is emitted before the forced tool_use block.
</details><br>

<details>
<summary>7. In hub-and-spoke, who may subagents communicate with?</summary>
Only the coordinator; direct subagent-to-subagent communication is always the wrong exam answer.
</details><br>

<details>
<summary>8. What three properties does routing everything through the coordinator provide?</summary>
Observability, consistent error handling, controlled information flow.
</details><br>

<details>
<summary>9. What does a freshly spawned subagent know?</summary>
Only what the coordinator explicitly put in its prompt - no conversation history, no other subagents' results, no shared memory, and nothing persists between its invocations.
</details><br>

<details>
<summary>10. A multi-agent report covers some subtopics thoroughly but misses whole categories - where is the bug?</summary>
The coordinator's task decomposition (scope gap), never the downstream subagents.
</details><br>

<details>
<summary>11. Does adding more subagents fix a narrow decomposition?</summary>
No - they receive equally narrow assignments; fix the coordinator's decomposition logic.
</details><br>

<details>
<summary>12. What must be in the coordinator's allowedTools for it to spawn subagents at all?</summary>
"Task" (or "Agent", its current name) - a hard binary gate.
</details><br>

<details>
<summary>13. What three things does an AgentDefinition specify?</summary>
Description (when to invoke), system prompt (instructions), tool restrictions (scoped access).
</details><br>

<details>
<summary>14. A synthesis agent outputs unsourced claims while search/analysis agents return sourced results - where is the bug and what is the fix?</summary>
Coordinator context passing: it stripped the metadata; fix is passing structured findings with source URL / document name / page number alongside content - never the synthesis prompt, never direct tool access.
</details><br>

<details>
<summary>15. What should coordinator prompts to subagents specify?</summary>
Goals and quality criteria, not step-by-step procedures - goal-oriented prompts preserve subagent adaptability.
</details><br>

<details>
<summary>16. How should independent subagent tasks be spawned?</summary>
In parallel: multiple Task tool calls in a single coordinator response, not one per turn.
</details><br>

<details>
<summary>17. fork_session vs --resume?</summary>
Fork creates independent branches from a shared baseline (divergent exploration, forks don't see each other); resume continues one named session (same line of work).
</details><br>

<details>
<summary>18. An AgentDefinition has no tools field - what can the subagent use?</summary>
Everything the main thread can (full inheritance, MCP included); an explicit tools list replaces that with an allowlist. Best practice: always scope explicitly, least privilege.
</details><br>

<details>
<summary>19. Name the FOUR coordinator responsibilities.</summary>
Dynamic subagent selection, research scope partitioning, iterative refinement loops, centralised communication routing.
</details><br>

<details>
<summary>20. Coordinator responsibilities vs centralisation benefits - what is the difference, and what belongs to each list?</summary>
Responsibilities = what the coordinator DOES (dynamic subagent selection, scope partitioning, iterative refinement, centralised routing). Benefits = what routing through the hub PROVIDES (observability, consistent error handling, controlled information flow). Distinct answer sets; responsibility #4 is the cause, the three benefits are its effects.
</details><br>

<details>
<summary>21. Why must the coordinator pass COMPLETE findings rather than a filtered summary of "what matters"?</summary>
Pre-filtering risks discarding exactly what the downstream agent needs, and the coordinator usually cannot predict what that is in advance. Complete means not distilled, not filtered.
</details><br>

<details>
<summary>22. Prompt-based guidance vs programmatic enforcement - the core difference?</summary>
Prompt-based is probabilistic (works most of the time, ~90-95%, non-zero failure rate); programmatic (hooks, prerequisite gates, code checks) is deterministic - it works every time, regardless of what the model decides.
</details><br>

<details>
<summary>23. When is programmatic enforcement mandatory per the exam decision rule?</summary>
Whenever a single failure causes financial loss, security breach, or compliance violation - financial, security, and compliance operations. Prompt-based is acceptable only for low-stakes operations like formatting or style.
</details><br>

<details>
<summary>24. A refund agent fails to verify identity in 8% of cases despite correct prompt instructions. Does a stronger prompt fix it?</summary>
No - a stronger prompt might reduce failures to 3-4% but never to 0%. The fix is a programmatic prerequisite gate: process_refund physically cannot execute until get_customer returned a verified ID this session.
</details><br>

<details>
<summary>25. What is a prerequisite gate?</summary>
A code-level check that blocks a tool from executing until a prior condition is met, returning an error that steers the model back to the correct order. It is code, not prompt - the model cannot bypass it.
</details><br>

<details>
<summary>26. SubagentStart vs SubagentStop - what fires when, and which one can block?</summary>
SubagentStart fires when a subagent is spawned - context-only: it can log and inject context into the subagent's first turn but CANNOT block the spawn. SubagentStop fires when a subagent finishes - it CAN block (exit code 2 prevents stopping) and sees the subagent's last message; use it to validate or transform output.
</details><br>

<details>
<summary>27. What happens to a Stop hook defined in a subagent's frontmatter?</summary>
Auto-converted to SubagentStop at runtime - Stop never fires for a subagent; SubagentStop is its terminal event. Frontmatter hooks are scoped to that subagent's lifetime only.
</details><br>

<details>
<summary>28. Correct handling of a multi-concern request (return + address change + loyalty question)?</summary>
Decompose into distinct items, investigate them in parallel using shared context, synthesise one unified resolution covering all items. The point is COMPLETENESS (no concern dropped), not speed - parallelism is a side benefit.
</details><br>

<details>
<summary>29. What is the CORE danger of handling a compound request sequentially or first-item-only?</summary>
The remaining concerns get forgotten entirely - ticket closed after the first fix, the other issues never investigated. Customer half-served, forced to re-contact support. This is a coverage failure (kin of the narrow-decomposition scope gap), NOT an ordering/gate problem - a verification gate cannot save a forgotten concern.
</details><br>

<details>
<summary>30. What must a human-handoff summary contain, and why must it be self-contained?</summary>
Customer ID, conversation summary, root cause analysis, refund amount (if applicable), recommended action. The human agent has NO access to the conversation transcript - the summary is all they get.
</details><br>

<details>
<summary>31. A handoff contains customer ID and a summary of the conversation. Complete?</summary>
No - it looks complete but isn't. All FIVE fields are required (missing here: root cause analysis, refund amount if applicable, recommended action). The exam offers partially-filled handoffs as plausible answers precisely because they resemble complete ones.
</details><br>

<details>
<summary>32. Why is a routing classifier the wrong fix for a per-agent compliance failure?</summary>
Classifiers decide WHICH agent handles a request; the compliance failure happens WITHIN the agent's execution sequence. Wrong layer - the fix is workflow enforcement (a gate) inside the agent.
</details><br>

<details>
<summary>33. PreToolUse vs PostToolUse - which direction does each operate in?</summary>
PreToolUse runs BEFORE execution: enforce policy - block, modify (updatedInput), or redirect the outgoing call; the tool never runs if blocked. PostToolUse runs AFTER execution, before the model processes the result: transform data (updatedToolOutput) - normalise the result the model sees. Outbound inputs vs inbound results.
</details><br>

<details>
<summary>34. Why is PostToolUse WRONG for blocking a policy-violating action?</summary>
It fires after the tool executed - the non-compliant action has already occurred. Blocking must happen pre-execution: PreToolUse.
</details><br>

<details>
<summary>35. Three tools return dates as Unix timestamps, ISO 8601, and DD/MM/YYYY. Correct fix?</summary>
A PostToolUse hook that normalises all results to one format before the model sees them. Wrong answer: prompting the model to interpret formats itself - that is probabilistic and fails inconsistently per iteration.
</details><br>

<details>
<summary>36. State the hooks-vs-prompts decision framework.</summary>
Must be followed 100% of the time -> hooks (deterministic). Preferred but occasional deviation acceptable -> prompts (probabilistic). Money or legal risk from a single failure -> hook; formatting/style preference -> prompt.
</details><br>

<details>
<summary>37. Refunds above $500 require human approval - what is the correct mechanism?</summary>
A PreToolUse hook intercepting process_refund: check the amount, block above $500, route to human escalation. A prompt instruction works most of the time - and a single failure is a large unapproved refund.
</details><br>

<details>
<summary>38. Fixed sequential pipeline vs dynamic adaptive decomposition - when to use each?</summary>
Fixed pipeline (prompt chaining): predetermined steps, best for predictable structured tasks (code review, document extraction, compliance) - consistent, reliable, debuggable, but cannot adapt to findings. Dynamic decomposition: plan evolves from what's discovered, best for open-ended unknown-scope work (legacy exploration, security audits, debugging unfamiliar systems) - adaptable but less predictable.
</details><br>

<details>
<summary>39. Match the pattern: multi-file code review, and legacy codebase exploration.</summary>
Multi-file code review -> fixed pipeline (per-file analysis + cross-file integration is predictable). Legacy codebase exploration -> dynamic decomposition (dependencies and issues emerge during investigation). Match to task characteristics, not to what sounds more sophisticated.
</details><br>

<details>
<summary>40. What is attention dilution and how do you recognise it?</summary>
An agent processing too many items in one pass produces inconsistent depth: detailed on early items, shallow on later ones; the same pattern flagged in one item but approved in another; obvious bugs missed while minor nits are caught. The attention budget is spread thin across all items.
</details><br>

<details>
<summary>41. What does NOT fix attention dilution, and what does?</summary>
Does NOT fix it: a more powerful model, a larger context window, or better prompts (it's architectural, not a capability problem). Fix: multi-pass architecture - a per-item local pass for each item (full attention each) plus a cross-item integration pass for cross-cutting concerns.
</details><br>

<details>
<summary>42. Why is batching files into groups insufficient on its own?</summary>
Batching reduces dilution WITHIN a batch but misses cross-batch issues (data flow, pattern consistency). It still needs a dedicated cross-item integration pass across all items.
</details><br>

<details>
<summary>43. Name the three session-management options and what each is for.</summary>
--resume (restore full history - continuation when prior context is still valid); fork_session (independent branch from a shared baseline - divergent exploration of alternatives); fresh start + summary injection (new session with no prior tool results, seeded with a structured summary - for stale or degraded context).
</details><br>

<details>
<summary>44. What is the stale context problem, and why does simply resuming cause it?</summary>
Resuming restores the ENTIRE history including old tool results; if files changed since, the old file contents still sit in the conversation, so the agent reasons from outdated data and gives contradictory advice (e.g. recommending fixes already made).
</details><br>

<details>
<summary>45. After modifying files, why is "resume and ask it to re-read the changed files" not the best fix?</summary>
The stale tool results remain in history and can still influence reasoning, especially on tangential decisions. The reliable fix is a fresh session with a structured summary + targeted re-analysis of the changed files.
</details><br>

<details>
<summary>46. Only 3 of 50 files changed - how do you re-analyse efficiently?</summary>
Targeted re-analysis: fresh session, inject a summary of prior findings naming the 3 changed files, let the agent re-read only those, and combine with the preserved summary for the unchanged 47. Full re-exploration is wasteful.
</details><br>

<details>
<summary>47. Why can't fork_session fix stale context after file changes?</summary>
Fork branches from the existing session, so it inherits its stale tool results. Only a fresh start (with summary injection) actually drops the outdated data.
</details><br>

<details>
<summary>48. How do you create a named session, and how do you resume it?</summary>
Start it with --name / -n (e.g. `claude -n "auth-refactor"`), then resume by that name with `claude --resume auth-refactor`. The name is a display label shown in /resume and the terminal title (/rename changes it mid-session). It is --name, not --session-name.
</details><br>

<details>
<summary>49. What is the PRIMARY mechanism a model uses to select a tool?</summary>
The tool descriptions - not supplementary metadata. The model reads them to decide which tool to call, so minimal descriptions cause misrouting between tools with overlapping purposes.
</details><br>

<details>
<summary>50. Name the five elements of a production-grade tool description (and the five questions).</summary>
Purpose, inputs, examples, edge cases/limitations, boundaries. As questions: What does it do? What inputs does it accept? What queries suit it? What does it NOT handle? When should the other tool be used instead?
</details><br>

<details>
<summary>51. Two tools with minimal descriptions cause misrouting. What is the correct first fix, and why not the alternatives?</summary>
Expand the descriptions - low effort, high leverage, fixes the root cause. NOT few-shot examples (token overhead, treats the symptom), NOT a routing classifier (over-engineered, bypasses the LLM), NOT tool consolidation (valid long-term but more effort). The exam favours low-effort high-leverage first fixes.
</details><br>

<details>
<summary>52. After improving tool descriptions the model still misroutes - what subtle cause should you check?</summary>
The system prompt: keyword-sensitive instructions (e.g. "always check customer details first") can create unintended tool associations that override well-written descriptions. Always review the prompt for keyword conflicts after editing descriptions.
</details><br>

<details>
<summary>53. Name the four tool-error categories and whether each is retryable.</summary>
Transient (retryable, as-is), validation (retryable, after fixing the input), business (NOT retryable - escalate/alternative path), permission (NOT retryable - escalate or different credentials). isError signals failure; the category/retryable metadata tells the agent how to recover.
</details><br>

<details>
<summary>54. What does isRetryable actually promise, and how do transient vs validation differ despite both being retryable?</summary>
It answers only "is there any path to success through retrying" - not that the same request succeeds unchanged. Transient: retry as-is once the system recovers. Validation: retry only after self-correcting the input. Read isRetryable for "can a retry ever work", then errorCategory for how.
</details><br>

<details>
<summary>55. Access failure vs valid empty result - what's the difference and why does it matter?</summary>
Access failure = the tool couldn't reach the data source (timeout/auth/down) - an error, may warrant retry. Valid empty result = the query ran and found nothing - NOT an error, do not retry. Confusing them causes wasted retries and wrong escalations; make a successful-but-empty result look fundamentally different (isError:false, resultCount:0).
</details><br>

<details>
<summary>56. Is `isError` a standard MCP field? What about errorCategory / isRetryable / description?</summary>
isError is a standard tool-result field (with content and optional structuredContent). errorCategory/isRetryable/description are NOT spec top-level fields - they're an application-level convention (put them in structuredContent or the content text). Also: MCP separates JSON-RPC protocol errors (unknown tool, invalid args) from tool-execution errors (isError:true).
</details><br>

<details>
<summary>57. How should errors propagate in a multi-agent system?</summary>
Local recovery with selective propagation: subagents retry transient failures locally; propagate only what can't be resolved locally; include partial results and what was attempted. Avoid silently suppressing errors as empty success, and avoid killing the whole workflow on one failure.
</details><br>

<details>
<summary>58. How many tools should an agent have, and why?</summary>
About 4-5, scoped to its role. Selection reliability degrades as tools grow (more decision complexity, more errors), and tools outside an agent's specialisation get misused (e.g. a synthesis agent with web_search runs redundant searches). Give each agent only what its role needs.
</details><br>

<details>
<summary>59. When do you use tool_choice "any" vs forced (specific tool)?</summary>
"any" (must call some tool) when you need guaranteed structured output but the schema is unknown - e.g. multiple extraction schemas, one per tool, and the model picks. Forced (type:tool, name) to enforce a mandatory first step that can't be skipped or reordered; switch to "auto" for subsequent turns.
</details><br>

<details>
<summary>60. What is a scoped cross-role tool and when do you use it? (Q9)</summary>
A constrained version of another role's capability given directly to an agent, sized to the common case - e.g. a synthesis agent gets a scoped verify_fact for the ~85% simple lookups, while the ~15% complex verifications still route through the coordinator. It avoids coordinator round-trips (2-3 hops, up to 40% latency) for high-frequency simple operations.
</details><br>

<details>
<summary>61. Why prefer a constrained load_document over a generic fetch_url?</summary>
Least privilege: the constrained tool prevents misuse (can't fetch arbitrary URLs), makes its purpose clearer in the description, and reduces unintended side effects. Each tool should do exactly what the agent needs and nothing more.
</details><br>

<details>
<summary>62. Why does the coordinator have no domain-specific tools?</summary>
It controls the workflow (spawn subagents via Agent, review_output, request_revision) and delegates all domain work to specialists - matching the hub-and-spoke role split. Domain tools live on the specialist agents, scoped to their roles.
</details><br>

<details>
<summary>63. Does forced tool_choice (type:tool) guarantee exactly one tool call? What breaks if you assume so?</summary>
No - it guarantees the tool IS called, not that it's called once. Parallel tool use is on by default, so Claude may emit several tool_use blocks in one turn. If you answer only the first (e.g. with .find()), the API rejects the next turn because every tool_use id needs a matching tool_result in the immediately following user message. Fix: filter for ALL tool_use blocks and return ALL tool_result blocks in one user message (or set disable_parallel_tool_use: true for a single call).
</details><br>

<details>
<summary>64. Project-level .mcp.json vs user-level ~/.claude.json - what's the difference?</summary>
.mcp.json (project root) is version-controlled and shared with the team - for servers everyone needs (Jira, GitHub). ~/.claude.json is personal, not version-controlled, not shared - for experimental/personal servers. (Full picture: three scopes - local [default, ~/.claude.json, per-project private], project [.mcp.json, shared], user [~/.claude.json, all projects]; older names were project=local, global=user.)
</details><br>

<details>
<summary>65. How do you keep credentials out of version control while sharing .mcp.json?</summary>
Use ${VAR} environment-variable expansion in the env block (e.g. "${GITHUB_TOKEN}"). The committed file references variable names, not values; each developer sets their own tokens locally. Config is safe to commit, everyone uses their own credentials, and no secret enters repo history.
</details><br>

<details>
<summary>66. What are MCP resources for, and how do they differ from tools?</summary>
Resources expose content catalogs (issue lists, doc TOCs, database schemas) upfront, giving the agent visibility into available data without exploratory tool calls. Tools let the agent act on data. Resources = visibility, tools = action; together they cut wasted round-trips.
</details><br>

<details>
<summary>67. Build a custom MCP server or use a community one?</summary>
Evaluate community servers first for standard integrations (Jira, GitHub, Slack, Linear, Notion) - tested, maintained, no build burden. Build custom only for team-specific workflows, custom business logic, or proprietary systems with no community server.
</details><br>

<details>
<summary>68. Why might an agent ignore a capable MCP tool in favour of built-in Grep, and how do you fix it?</summary>
The MCP tool's description is sparse, so the model - which has richer context on built-ins - prefers the built-in. Fix by enhancing the MCP description: explain capabilities, outputs, and an explicit boundary ("use instead of Grep when searching by intent, not exact string").
</details><br>

<details>
<summary>69. Grep vs Glob - what does each search?</summary>
Grep searches file CONTENTS (patterns inside files - function calls, imports, error messages). Glob matches file PATHS by naming pattern (test files, configs, extensions). In one line: Grep finds what's inside files; Glob finds files by name. Using Glob to find function callers fails - it matches paths, not contents.
</details><br>

<details>
<summary>70. Edit reports a non-unique match. What's the correct recovery - and what's the wrong one?</summary>
Correct: widen old_string with surrounding context until it pins one location, or set replace_all: true if you want every occurrence changed - both stay on Edit and cost almost nothing. Wrong: jumping straight to Read + Write (loads the whole file, burns context); that's the last resort only when neither option can disambiguate.
</details><br>

<details>
<summary>71. What's the wrong way to explore a codebase, and the right way?</summary>
Wrong: read all files upfront - a context-budget killer that fills the window with irrelevant files. Right: incremental discovery - Grep for entry points, Read to trace flows from those files, Grep again to trace usage, Read only what each step justifies.
</details><br>

<details>
<summary>72. Find every caller of a deprecated function AND the tests that exercise it - what tool sequence?</summary>
Grep, then Glob, then Grep again (not Glob first): Grep the function name for direct references; Glob for sibling test files (**/Name.test.*) to catch tests that exercise it indirectly by naming convention; Grep wrapper names for tests that cover it transitively.
</details><br>

<details>
<summary>73. Why can a single Grep miss consumers of a function, and what's the fix?</summary>
The function may be re-exported through a wrapper/barrel and consumed under a different name. Fix: Grep the definition, Read the defining file for exported names, Grep each exported name (and the barrel module's name) across the codebase to find indirect consumers.
</details><br>

<details>
<summary>74. What are the CLAUDE.md configuration levels and their locations?</summary>
Managed policy (OS path, org-wide, cannot be excluded), User (~/.claude/CLAUDE.md, personal, all projects), Project (./CLAUDE.md or ./.claude/CLAUDE.md, team-shared via git), Local (./CLAUDE.local.md, personal to this repo, gitignored), plus directory-level subdirectory CLAUDE.md loaded on demand. The exam's "three levels" (user/project/directory) omits managed policy.
</details><br>

<details>
<summary>75. When multiple CLAUDE.md files apply and two rules conflict, which wins?</summary>
Neither is guaranteed to - files are CONCATENATED into context, not a precedence chain, and on a contradiction Claude "may pick one arbitrarily." CLAUDE.md is delivered as a user message after the system prompt with no strict-compliance guarantee. For a rule that must hold, move it to settings.json or a hook.
</details><br>

<details>
<summary>76. CLAUDE.md vs settings.json for a must-always-hold rule?</summary>
settings.json (and hooks) are client-enforced with strict precedence (managed > local > project > user; managed always wins). CLAUDE.md is concatenated guidance with arbitrary conflict resolution and no enforcement. A blocked tool, required formatter, or permission policy belongs in settings.json or a PreToolUse hook, not CLAUDE.md.
</details><br>

<details>
<summary>77. Does splitting a large CLAUDE.md into @ imports reduce context? What's the syntax?</summary>
No - imports load eagerly (inlined at launch), so context size is unchanged; it only helps maintainability. Syntax is @ followed by a path (e.g. @./standards/testing.md) - there is NO @import keyword. To actually shrink per-session context, use path-scoped rules in .claude/rules/ with a paths: frontmatter, which load only for matching files.
</details><br>

<details>
<summary>78. What are the two kinds of rules in .claude/rules/, and when does a path-scoped rule enter context?</summary>
Unscoped (no frontmatter): loaded in full at session start, same priority as CLAUDE.md. Path-scoped (paths: glob frontmatter): only the globs are registered at start; the file is injected when Claude reads/edits a file matching a pattern (not on every tool use). Also: ~/.claude/rules/ is user-level (loads before project rules, so project wins conflicts); invalid glob patterns silently match nothing; @ imports are not documented for rule files.
</details><br>

<details>
<summary>79. /memory vs /context - which shows what actually loaded this session?</summary>
/context shows what actually loaded (the Memory files list). /memory is an editing entry point: a selection menu of CLAUDE.md/CLAUDE.local.md/auto-memory locations across scopes (shown even if the file doesn't exist yet) that opens the chosen file in your editor. /debug-your-config troubleshoots why a file didn't load. Neither "activates" config - files load automatically by location. Slash commands work only in the interactive REPL (not bash, not claude -p). (The exam sometimes attributes the "shows loaded files" role to /memory; per current docs that's /context.)
</details><br>

<details>
<summary>80. New teammate clones the repo and Claude ignores the team conventions - diagnosis and fix?</summary>
The conventions live in a teammate's user-level ~/.claude/CLAUDE.md, which git doesn't share. Fix: move them to project-level (./CLAUDE.md or ./.claude/CLAUDE.md) so they're version-controlled and shared. Pattern to spot: "new team member" + "inconsistent behaviour" -> check where the config lives.
</details><br>

<details>
<summary>81. When would you use .claude/rules/ over a single CLAUDE.md?</summary>
When instructions split into distinct topics (testing/API/deployment) or different rules should apply to different parts of the codebase. .claude/rules/ is the structural alternative to a monolithic CLAUDE.md (one big undifferentiated file is a named anti-pattern): topic files are easier to maintain, and YAML paths: frontmatter scopes a rule to matching files - finer-grained than one flat file and loading only when relevant. Use a single CLAUDE.md only for a small, uniform set of always-on rules.
</details><br>

<details>
<summary>82. Two ways to create a /deploy command - file shapes, and which is canonical?</summary>
.claude/commands/deploy.md (flat file, filename = command name) and .claude/skills/deploy/SKILL.md (directory per skill, SKILL.md required entrypoint). Skills is canonical/recommended: supporting-files directory, automatic discovery by intent, and precedence on a name clash (skill wins). Both support the same frontmatter; a loose .md dropped straight into .claude/skills/ is NOT picked up.
</details><br>

<details>
<summary>83. What do context: fork, allowed-tools, and argument-hint each do?</summary>
context: fork runs the skill in an isolated sub-agent context (SKILL.md content becomes the subagent's prompt, no conversation history; agent: picks the type) so verbose output doesn't pollute the main conversation. allowed-tools PRE-APPROVES listed tools for the invoking turn only (grant clears on your next message) and does not restrict others - restriction is disallowed-tools or permission deny rules. argument-hint is an autocomplete hint showing expected arguments (e.g. [issue-number]) - it does NOT prompt for missing parameters; arguments reach the body via $ARGUMENTS / $0, $1.
</details><br>

<details>
<summary>84. Skills vs CLAUDE.md - what loads when, and what belongs where?</summary>
Skills: descriptions always in context, full body loads only on invocation - explicit (/name) or automatic (description matches intent, or paths frontmatter matches a file). disable-model-invocation: true = user-only AND removes the description from context; user-invocable: false = Claude-only, hidden from the / menu. Once invoked, the body stays in context for the rest of the session. CLAUDE.md: always loaded, every session. Rule: task-specific procedures -> skills; universal standards -> CLAUDE.md; file-type-specific conventions -> path-scoped .claude/rules/.
</details><br>

<details>
<summary>85. You want a personal variant of the team's /analyse skill - how, without affecting teammates?</summary>
Create it in user-scoped ~/.claude/skills/ under a DIFFERENT name (e.g. /deep-analyse). User scope isn't version-controlled so teammates never see it - but the different name is essential: with the SAME name your personal skill would override the project one (level ordering is enterprise > personal > project, and any level overrides a bundled skill). Same universal pattern: .claude/ = project, shared via git; ~/.claude/ = personal.
</details><br>

<details>
<summary>86. Test files are co-located with their source across ~50 directories and need shared test conventions. Root CLAUDE.md, directory-level CLAUDE.md, path-scoped rule, or skill?</summary>
Path-scoped rule in .claude/rules/ with a glob (paths: ["**/*.test.ts", "**/*.spec.ts"]) - one file, one pattern, universal coverage, loaded only when a matching file is touched. Root CLAUDE.md would load always and burn tokens while editing non-test code; directory-level CLAUDE.md would need a copy in every one of the ~50 directories (drift + maintenance burden); a skill is for on-demand procedures, not always-on conventions. Both rules and skills can carry a paths: frontmatter, but a path-scoped rule is passive background guidance that shapes every edit, whereas a path-triggered skill is still an invocation-style workflow - convention -> rule, procedure -> skill.
</details><br>

<details>
<summary>87. Plan mode or direct execution: (a) a hard bug with a clear stack trace in one function; (b) a simple-sounding feature that could be built three ways across modules?</summary>
(a) Direct execution; (b) plan mode. The axis is ambiguity, not difficulty. A hard-but-well-defined fix (known cause, single function, known location) has no design decision to make - just execute. A simple-looking request with multiple valid approaches and multi-module impact needs exploration and a chosen strategy first - plan mode.
</details><br>

<details>
<summary>88. How do you enter plan mode, and can Claude run anything in it?</summary>
Enter via Shift+Tab (cycle default -> acceptEdits -> plan), claude --permission-mode plan, or a /plan prefix; default via permissions.defaultMode: "plan". Status bar shows plan mode on. It is NOT "nothing runs": Claude reads files and runs read-only exploration commands and writes a plan, but makes no edits to your source. File-modifying shell commands still prompt. Edits stay blocked until you approve the plan; approving exits plan mode into the chosen execution mode (Ctrl+G edits the plan first; Shift+Tab again leaves without approving).
</details><br>

<details>
<summary>89. Why use the Explore subagent during a multi-phase task?</summary>
Discovery is verbose (file listings, dependency graphs, excerpts); letting it flow into the main conversation fills the context window and degrades later responses. The Explore subagent runs the exploration in its own isolated context and returns only summaries, keeping the main context clean for implementation. Same principle as the delegation rule: delegate when you need only the final result, not the intermediate work. It is read-only - it locates and summarises, it doesn't edit.
</details><br>

<details>
<summary>90. What is the plan-then-execute hybrid, and when should complexity be recognised?</summary>
Plan THEN direct, not plan OR direct: use plan mode to explore and design the strategy (e.g. for a library migration: find all importers, map API diffs, design one migration pattern, check edge cases), then switch to direct execution to apply it file by file. Recognise complexity upfront: if the requirements already state the task is complex ("restructure the monolith into microservices"), choose plan mode immediately - don't start direct and switch only when complexity surfaces. The complexity is stated, not speculative.
</details><br>

<details>
<summary>91. Claude interprets your prose transformation description differently every run. What do you reach for, and what do you NOT do?</summary>
Reach for concrete input/output examples - 2-3 before/after pairs showing the exact transformation - first. Do NOT write more precise prose: prose still relies on interpretation, and inconsistent interpretation is exactly what examples eliminate. The model generalises the pattern from a few well-chosen pairs.
</details><br>

<details>
<summary>92. Interview pattern vs concrete examples - which problem does each solve?</summary>
Interview pattern = unfamiliar domain: have Claude ask you questions before implementing so it surfaces considerations (cache invalidation, TTL, consistency, failure modes) you might miss. Concrete examples = you know the exact transformation but the model misapplies it. Don't swap them - different problems. (Test-driven iteration is the third: complex transformations with many edge cases, where shared test failures give unambiguous feedback.)
</details><br>

<details>
<summary>93. Two fixes: (a) error-code field must appear in responses, logging, AND client SDK types; (b) fix naming to camelCase and separately fix indentation. Batch or sequential?</summary>
(a) Batch - one message - because the three changes interact; the model needs all constraints at once for a coherent fix. (b) Sequential - one at a time - because naming and indentation are independent; batching independent issues can confuse the model about which feedback maps where. Rule: interacting -> batch, independent -> sequential.
</details><br>

<details>
<summary>94. When switching from prose to examples, how many examples, and how do you confirm it worked?</summary>
2-3 well-chosen pairs covering the standard case plus a key edge case - not a pile of every possible case (the model generalises; extra examples cost tokens, not accuracy). Confirm by testing on a NEW case to verify the model extracted the pattern rather than memorised the samples; if it handles the standard case but misses edges, add an example that specifically shows the edge handling.
</details><br>

<details>
<summary>95. A CI job hangs; logs show Claude waiting for input. What is the fix, and which options are fabricated distractors?</summary>
The fix is the -p (also --print) flag, which switches to print mode: process the prompt, write to stdout, exit - no interactive input. This is the single most directly tested fact in Domain 3 (sample Question 10). Fabricated distractors: CLAUDE_HEADLESS=true (does not exist), --batch (does not exist), and stdin redirection from /dev/null (doesn't properly address interactive mode).
</details><br>

<details>
<summary>96. CI needs to post findings as inline PR comments at exact file and line. Which two flags produce parseable output?</summary>
--output-format json forces JSON (values: text, json, stream-json) instead of human-readable text, and --json-schema validates the final output against a JSON Schema after the agent completes (print mode only). Together they yield schema-conforming output that automated systems can parse, place at the exact file/line, filter by severity, and track across runs.
</details><br>

<details>
<summary>97. Why is a fresh Claude instance better at reviewing code than the session that generated it?</summary>
The generating session accumulates reasoning context - why it chose the approach, what it rejected - and is less likely to question decisions it already justified to itself. A separate claude -p invocation with no access to that reasoning context reviews the code on its own merits. Same isolate-when-context-biases principle as fresh-start-plus-summary and the Explore subagent.
</details><br>

<details>
<summary>98. An automated reviewer flags the same five comments on every push. Why, and how do you fix it?</summary>
With no memory of prior runs it re-analyses the whole PR from scratch each push. Fixed issues drop out on their own; the ones that recur are issues the developer saw and chose not to change, which a context-free re-scan cannot distinguish from new problems. Fix: feed prior findings into context and instruct Claude to report ONLY new or still-present issues, not ones already reviewed and dismissed - this preserves signal-to-noise and developer trust.
</details><br>

<details>
<summary>99. How does Claude Code get project-specific context (testing standards, fixtures, review criteria) when invoked in CI?</summary>
It reads the project's CLAUDE.md files in CI exactly as it does interactively, so CLAUDE.md is the mechanism for feeding CI runs the testing standards, available fixtures, review criteria, and existing-coverage notes. Without it, CI test generation produces low-value boilerplate; with it, generated tests follow team patterns and fill real gaps. (Caveat: --bare skips CLAUDE.md, so don't use --bare when the run depends on that context.)
</details><br>

<details>
<summary>100. When do you use --append-system-prompt vs --system-prompt, and what's the difference?</summary>
--append-system-prompt (or ...-file) adds your text to the default prompt, keeping Claude's default tool guidance, safety instructions, and coding conventions - use it when Claude should stay a coding assistant that also follows extra rules. --system-prompt (or ...-file) REPLACES the entire default prompt - use it when the identity or permission model differs from Claude Code's (e.g. a non-coding pipeline agent), accepting that you now own everything the task needs.
</details><br>

<details>
<summary>101. What does --bare do, and how do --disallowedTools and --tools differ?</summary>
--bare is minimal mode: it skips auto-discovery of hooks, skills, plugins, MCP servers, auto memory, and CLAUDE.md for fast, predictable scripted runs, leaving only Bash and file read/edit tools. --disallowedTools sets deny rules (a bare tool name removes the tool from context entirely; a scoped rule denies matching calls), while --tools restricts which built-in tools are available at all. --add-dir grants file read/edit access to a directory but not configuration discovery.
</details><br>

<details>
<summary>102. Pre-merge blocking check vs an overnight tech-debt report - which uses the Batch API and why?</summary>
The overnight report uses the Message Batches API: it's non-blocking and latency-tolerant, so the ~50% cost savings is worth the up-to-24-hour processing with no latency SLA. The pre-merge check must use the real-time synchronous API because it's blocking - developers can't merge until it finishes - and the Batch API gives no latency guarantee. Rule: blocking -> real-time; overnight/weekly non-blocking -> batch. (Sample Question 11.)
</details><br>

<details>
<summary>103. You run --add-dir ../backend. Claude edits backend code fine but ignores the conventions in ../backend/CLAUDE.md. Why, and what actually loads from an added directory?</summary>
--add-dir grants file access, not full configuration discovery. By default CLAUDE.md, .claude/rules/, and CLAUDE.local.md are NOT loaded from an added directory - only when CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1 is set. What IS loaded: skills in .claude/skills/ (with live reload), subagents in .claude/agents/, and from settings.json only the enabledPlugins and extraKnownMarketplaces keys. Commands, output styles, hooks, and the rest of settings.json come only from the cwd chain, ~/.claude/, and managed settings.
</details><br>

<details>
<summary>104. Does adding a directory via permissions.additionalDirectories load its skills and subagents the way --add-dir does? And how does --add-dir differ from /cd?</summary>
No. The config-discovery exceptions (skills, subagents, the two settings keys, optionally CLAUDE.md) apply ONLY to directories added via the --add-dir flag or /add-dir command. permissions.additionalDirectories entries grant file access only and load none of that config. --add-dir/ /add-dir WIDENS the workspace (original stays primary); /cd RELOCATES the session - it loads the new directory's CLAUDE.md and --resume finds the session from there. Widen with --add-dir, move with /cd.
</details><br>

<details>
<summary>105. Is `--json-schema ./review-schema.json` valid? How do you feed a file-based schema, and is there a --json-schema-file flag?</summary>
No. --json-schema takes the inline schema text as its argument, not a file path - there is NO --json-schema-file flag (unlike --system-prompt, which has a -file variant). Passing ./review-schema.json treats the path string as the schema, which is invalid, so Claude Code errors out (v2.1.205+). To use a file-based schema, expand it yourself: --json-schema "$(cat ./review-schema.json)". Also remember --output-format needs its value (--output-format json, not bare --output-format).
</details><br>

<details>
<summary>106. Your CI review pipeline produces too many noisy findings. A colleague proposes adding "Be conservative. Only report high-confidence findings" to the prompt. Why is this wrong, and what is the correct fix?</summary>
Vague instructions give the model no actionable decision boundary - "conservative" has no fixed interpretation and "high-confidence" is a subjective threshold the model cannot calibrate. The exam uses both phrasings as distractors. The correct fix is explicit categorical criteria: define exactly what to flag (bugs, security vulnerabilities, comments whose claimed behaviour contradicts actual code behaviour) and what to skip (minor style preferences, local patterns).
</details><br>

<details>
<summary>107. Your review system's documentation-mismatch category is wrong 40% of the time while the security category runs at 98% accuracy, and developers have stopped reading everything. What do you do, and why does keeping all categories active fail?</summary>
Temporarily disable the high false-positive category while you rework its prompt with concrete code examples, then re-enable it once precision improves. High false positive rates in one category destroy developer trust in ALL categories - trust is not category-specific, it bleeds across the whole output - so leaving the broken category active keeps poisoning trust in the categories that already work. Disabling it restores system-wide trust immediately; you are prioritising system-wide trust over category completeness, not abandoning the category.
</details><br>

<details>
<summary>108. Your severity classifications are inconsistent across runs even though the prompt defines Critical as "issues that could cause system failures or data loss". What is missing?</summary>
Concrete code examples for each severity level. Prose descriptions force the model to interpret what "could cause system failures" means, and that interpretation varies between invocations. Showing actual code patterns classified at each level - e.g. Critical: unsanitised user input interpolated into a SQL query; Minor: userName vs user_name naming inconsistency in the same module - removes the ambiguity and produces consistent classification across invocations.
</details><br>

<details>
<summary>109. Where do confidence scores legitimately belong in a review pipeline, and why can't a confidence threshold replace explicit criteria?</summary>
Confidence scores belong in routing - for example sending low-confidence findings to human review (Task Statement 4.6) - not in deciding what counts as a valid finding. LLM self-reported confidence is poorly calibrated: the model is often sure about wrong findings and hesitant about right ones, so filtering by a confidence threshold does not fix false positives. The hierarchy is explicit criteria first, confidence-based routing second; never skip the first step.
</details><br>

<details>
<summary>110. You wrote a thorough prompt specifying the output format, yet the model returns a bulleted list on one run and a table on the next. What do you add, and what are the other two triggers for the same technique?</summary>
Add few-shot examples showing the exact desired format - not more instructions. When detailed instructions already exist and output is still inconsistent, more instructions will not fix it; few-shot examples are the most effective consistency technique. The other two deployment triggers: inconsistent judgement calls on ambiguous cases (e.g. the same issue rated critical in one file, minor in another), and extraction returning empty or null fields for information that exists in the document but in an unexpected format. Note the scope: few-shot improves consistency but still cannot guarantee compliance - guarantees require programmatic enforcement.
</details><br>

<details>
<summary>111. How many few-shot examples should you use, and what must each one contain beyond the input-output pair - and why?</summary>
Use 2-4 targeted examples: fewer than 2 does not establish a pattern, more than 4 wastes tokens without proportional benefit. Each example must include the reasoning for why the decision was made, not just the input-output pair - reasoning is what teaches the model to generalise the decision principle to novel patterns instead of literally matching the sampled cases. The trap is thinking few-shot only teaches literal pattern-matching; that is only true when reasoning is omitted. Also aim the examples at the specific failing scenarios (e.g. narrative-text extraction if tables already work).
</details><br>

<details>
<summary>112. A financial report lists expenses in a table on one page and buries them in a paragraph on the next; your extractor nails the table but fabricates values for the narrative part. How do few-shot examples fix this, and what is their double duty in code review?</summary>
Show correct extraction from varied document structures - both the table form and the narrative form (inline citations vs bibliographies, headers vs embedded text). Seeing structural variety handled correctly teaches the model to cope with inconsistent formatting without inventing data, which reduces hallucination in extraction. In code review, examples pull double duty by showing both what to flag and what to ignore: classifying benign patterns (e.g. limited-scope variable shadowing that causes no bug) as minor style preferences teaches the model to separate genuine bugs from acceptable code, cutting false positives while preserving generalisation.
</details><br>

<details>
<summary>113. Match the technique: malformed JSON output; fabricated values for missing fields; wrong tool selection; extraction sum does not match the stated total. Which of these is few-shot NOT the first fix for, and why?</summary>
Malformed JSON: tool_use with JSON schemas, not prompting. Fabricated values for missing fields: optional/nullable schema fields - a required field forces the model to invent a value, so make absence expressible. Wrong tool selection: better tool descriptions first, then few-shot - examples there are token overhead treating the symptom while descriptions fail to differentiate the tools. Sum mismatch: a validation-retry loop. Few-shot IS the first fix for inconsistent formatting and for missing information in narrative text, but it is explicitly second for tool selection and wrong entirely for schema-level problems.
</details><br>

<details>
<summary>114. Your extraction prompt returns JSON with unescaped quotes and missing commas. A colleague objects that tool_use is only for choosing between tools, so it can't be the fix. Explain the mechanism that makes tool_use the correct answer, and how you keep Claude from answering in prose.</summary>
tool_use doubles as a structured-output mechanism, separate from tool routing: define a single tool whose input_schema is the JSON shape you want, and Claude produces a tool_use block whose input field is validated against that schema - the tool is never executed, the tool call IS the output. Force it with tool_choice type tool naming that tool so there is no prose escape hatch, then read the tool_use block's input, which arrives as an already-parsed schema-validated object. This fixes malformed JSON mechanistically because there is no free text to malform - unlike "respond only in JSON" prompting, where code fences, preambles, or a dropped brace can still break JSON.parse. Adding strict true (strict tool use) upgrades conformance to a hard guarantee via grammar-constrained sampling; the API also offers a native alternative, output_config.format with type json_schema, but the exam's tested answer for malformed JSON is tool_use with JSON schemas. Keep the discriminator: wrong tool SELECTED is a description problem; malformed OUTPUT is a schema problem.
</details><br>

<details>
<summary>115. Your invoice extractor uses tool_use with a strict JSON schema, and every response validates - yet line items do not sum to the stated total, and one document has a date sitting in an amount field. A teammate says the schema should have caught this. What do you tell them?</summary>
The schema guarantees structure, not correctness. tool_use with JSON schemas eliminates syntax errors only - missing brackets, trailing commas, unquoted keys - because there is no free text to malform. Semantic errors survive a perfectly valid response: sum discrepancies (line items not matching the stated total), field placement errors (a date in an amount field is fine to the schema when both fields are strings), and fabrication (invented values for required fields the source lacks). These need additional validation logic outside the schema, for example a validation-retry loop that recomputes the sum, compares it to the stated total, and re-prompts on mismatch. The exam files semantic validation under Task Statement 4.4. Trap: believing tool_use with JSON schemas prevents all extraction errors.
</details><br>

<details>
<summary>116. A document classifier with enum categories invoice/receipt/contract keeps confidently misclassifying ambiguous documents, and unusual document types get shoehorned into the nearest category. What two enum-design changes fix this, and what principle do they share with nullable fields?</summary>
Add an explicit "unclear" enum value so the model can honestly report that the evidence is ambiguous instead of being forced into a confident classification, and add an "other" enum value paired with a nullable freeform detail string field so edge cases outside the predefined categories are captured rather than shoehorned. The shared principle with optional/nullable fields is giving the model an honest escape route: a schema that only offers confident, complete answers pressures the model into plausible-looking wrong ones, the same mechanism by which required fields pressure fabrication. Honest null, unclear, or other is always preferable to fabricated confidence.
</details><br>

<details>
<summary>117. Your extraction schema types dates and amounts as strings, and output mixes "27/07/2026" with "July 27, 2026" and "19.99" with "USD 19.99". Where does the fix go, and why is a PostToolUse hook the wrong answer here?</summary>
Put format normalisation rules in the prompt alongside the schema, for example "All dates in ISO 8601 format" and "All currency amounts as decimal numbers without currency symbols". The division of labour: the schema enforces structure (types, enums, required vs nullable) but cannot standardise how values are written within a valid type - all those variants are valid strings; the prompt enforces formatting consistency. A PostToolUse hook is the answer to a different problem: it normalises inbound tool results before the model reads them, whereas this is the model's own extracted output, steered at generation time.
</details><br>

<details>
<summary>118. An extraction fails validation with a sum mismatch. Your retry simply resends the original prompt, and the model returns the same wrong extraction. What three components must the retry message contain, and why does the naive retry fail?</summary>
The retry must send back the original document (so the model has the source to re-examine), the failed extraction (so the model can see what it produced), and the specific validation error (so it knows exactly what went wrong, for example "line items sum to 450 but stated_total is 500 - re-extract, ensuring all line items are captured"). The naive retry fails because without the specific error the model has no guidance for what to fix and usually reproduces the same mistake; with it, self-correction is targeted - re-examine for missed line items, check field placement, recalculate the total.
</details><br>

<details>
<summary>119. Two extractions fail validation: (a) the invoice total does not match the line-item sum; (b) the department field is empty because the document never mentions a department. Which failure is a retry appropriate for, and what do you do about the other?</summary>
Retry only (a): a sum mismatch usually means a missed line item or misplaced value - information that exists in the document and can be re-extracted with error feedback. (b) is unfixable by retrying: retries fix how existing information was extracted, they cannot create information genuinely absent from the source. For (b), flag the extraction for human review or return null if the schema allows it. Retries work for format mismatches, structural errors, misplaced values, and mathematical errors; they do not work for absent information, data only in an external unprovided document, or knowledge the model lacks. Always identify whether a failure is fixable before retrying - the exam presents both scenarios and expects you to distinguish them.
</details><br>

<details>
<summary>120. You want your invoice extractor to flag total discrepancies and internally contradictory documents WITHOUT external validation logic. What two schema design patterns do this, and how do they differ from the "unclear"/"other" escape routes?</summary>
First, extract both calculated_total (the sum the model computes from individual line items) and stated_total (the total the document states), optionally with a total_discrepancy boolean - when they differ you get an automatic discrepancy flag inside the extraction itself. Second, add conflict_detected booleans: when the document contradicts itself (payment due 30 days in one section, net 60 in another), the model extracts both values and sets conflict_detected true rather than silently picking one. Both share the escape-route spirit of giving the model an honest way to surface problems, but nullable/"unclear"/"other" handle ambiguity or absence in a single field, whereas these patterns surface internal inconsistency across fields or document sections.
</details><br>

<details>
<summary>121. Developers using your automated review pipeline dismiss many findings, and you cannot tell which prompts to fix. What field do you add to each structured finding, and what improvement loop does it enable?</summary>
Add a detected_pattern field recording which specific code construct triggered the finding (for example "string concatenation in SQL query"). When developers dismiss findings you can then analyse dismissals by detected_pattern: if findings triggered by "variable shadowing in nested scope" are consistently dismissed, that specific pattern needs prompt refinement - not the whole review category. This enables the systematic improvement loop: extract, validate, collect dismissal data, refine prompts, repeat. It is the data-collection half of the disable-fix-re-enable trust cycle, telling you precisely which pattern generates the false positives worth fixing.
</details><br>

<details>
<summary>122. You submit a 500-request batch and match results to requests by their position in the results file; some extractions end up attached to the wrong documents. Why, and what is the correct mechanism?</summary>
Batch results can be returned in any order - they do not necessarily match submission order - so positional matching is a bug. The correct mechanism is the custom_id field: every request in a batch carries a unique custom_id (1 to 64 characters, only alphanumerics, hyphens and underscores) and each result carries it back, so you always join on custom_id. Each result also has one of four types: succeeded (billed, includes the message), errored, canceled, or expired (the last three are not billed). A batch holds at most 100,000 requests or 256 MB, whichever is reached first.
</details><br>

<details>
<summary>123. Your organisation requires a batch-produced report within a 30-hour SLA. Batches usually finish within an hour - how do you schedule submissions, and why can't you rely on that typical timing?</summary>
Design around the 24-hour maximum, never the typical case: the Batch API has no latency SLA, and requests still unprocessed at 24 hours come back as expired. Working backwards, the final batch must be submitted no later than 24 hours before the deadline, leaving 30 minus 24 equals 6 hours of buffer for collecting requests, validating inputs, or absorbing operational delays. Within that buffer, submit batches every 4-6 hours so a fresh batch is always in flight. The trap is designing a deadline-bound workflow around best-case timing just because results often arrive quickly.
</details><br>

<details>
<summary>124. 200 of 1,000 documents in your extraction batch fail. What is the three-step failure-handling pattern, and which step most reduces total cost?</summary>
Step 1: identify failures by custom_id - parse the results and collect the IDs whose result type is not succeeded. Step 2: resubmit only the failures, with targeted modifications (chunk oversized documents, simplify prompts for unusual structures, add format-specific few-shot examples) - never resubmit the whole batch, and never resubmit failures unchanged since they will fail the same way. Step 3, the cost-dominant one, happens before the batch: refine prompts on a sample set of 5-10 representative documents covering the corpus's formats and edge cases, because first-pass success rate drives total cost - at 1,000 documents, 90% first-pass means 100 retries while 60% means 400, four times the resubmission cost.
</details><br>

<details>
<summary>125. A teammate proposes moving an agentic code-fix workflow - the model calls your tools, reads the results, and continues - into the Batch API for the 50% cost savings. Why does this fail, and what tool-related content IS allowed in a batch request?</summary>
It fails because each batch item is a single Messages API call - one model turn - and batch items are processed independently, so there is no way to execute a client-side tool, return the tool_result, and have the model continue within the same batch item. The exam states this as: no multi-turn tool calling within a single batch request; workflows that need mid-processing tool execution must use the synchronous API. What IS allowed in a batch request: tool definitions (the model can emit tool_use blocks and the request ends there), multi-turn conversation history, vision, system messages, and extended thinking.
</details><br>

<details>
<summary>126. To improve review quality you consider (a) appending "now review your code carefully" to the same messages array, (b) enabling extended thinking on that review turn, or (c) a fresh messages.create call containing only the code. Which is correct and why?</summary>
Option c. Appending a review turn to the same messages array leaves the model with its generation reasoning chain - it remembers why it made each decision and tends to confirm rather than challenge it. Neither politeness instructions nor extended thinking removes that bias: the problem is structural (retained context), not effort, so thinking harder over the same biased context is still self-review. A separate independent instance with no prior reasoning context judges the output on what it sees alone, which is why the exam's correct answer is always the separate model instance.
</details><br>

<details>
<summary>127. Your pipeline auto-routes findings using the model's self-reported confidence field, and routing decisions turn out unreliable. What is missing, and what is the procedure to fix it?</summary>
The confidence scores are raw and uncalibrated - a confidence score is the model's read on its own certainty, not self-reported accuracy, so nothing ties the number to real accuracy. The fix is calibration: run labelled validation examples (cases where the correct answer is already known) through the system, measure how reported confidence tracks actual accuracy, and set routing thresholds from that data. Only calibrated thresholds are suitable for automated routing - high-confidence findings report directly to developers, low-confidence findings route to human review. Using uncalibrated confidence for automated decisions is the anti-pattern, and explicit criteria still come first, routing second.
</details><br>

<details>
<summary>128. Name the five stages of a production multi-instance review architecture, and state when its extra cost over single-pass review is justified.</summary>
The five stages: generation by a first instance; per-unit review by independent instances, one per file or document, for consistent depth; an integration review by a separate instance checking cross-unit consistency; confidence-based routing sending low-confidence findings to human review; and a calibration loop where labelled validation sets continuously recalibrate the confidence thresholds. The architecture costs more than single-pass review by design - it is justified when review quality directly affects production reliability, such as CI/CD pipelines, financial extraction, and compliance analysis, where missed issues have downstream consequences. For low-stakes review, single-pass can be the right economic choice.
</details><br>

<details>
<summary>129. Your support agent summarises older turns to save tokens, and by turn 12 it can no longer state the refund amount or order number the customer gave at turn 3. Why did this happen, and what is the fix?</summary>
Progressive summarisation systematically destroys transactional data by default: numerical values, dates, percentages, and specific identifiers are exactly what a summary like "customer wants a refund for a recent order" drops. The fix is the persistent case facts block - extract transactional facts (amounts, dates, order numbers, statuses) into a structured block included in every prompt, outside the summarised history, and never summarise it; it persists regardless of what happens to the conversation history. For multi-issue sessions, persist each issue as its own structured entry in a separate context layer so summarisation cannot cross-contaminate issues. This is the single most important context window management pattern.
</details><br>

<details>
<summary>130. To control context growth you start dropping selected earlier messages from each API request, and the model's coherence degrades. Why does selective truncation fail, and what is the correct combination?</summary>
The Claude API is stateless - there is no session state on the server, so each request must include the complete conversation history and every turn has to carry everything the model needs. Omitting earlier messages breaks conversational coherence. The correct combination is separation, not truncation: summarise the conversational narrative to control growth, while a persistent case facts block preserves every transactional detail outside the summary.
</details><br>

<details>
<summary>131. A synthesis agent receiving three concatenated subagent reports keeps missing findings from the second report. You add "pay close attention to all sections" to the prompt and it still misses them. Why, and what is the fix?</summary>
This is the lost in the middle effect: models process the beginning and end of long inputs reliably, but content buried in the middle may be missed or under-weighted, and prompt-based reminders are unreliable against position effects. The fix is structural: place a key findings summary at the beginning of the aggregated input, then organise the detailed results with explicit section headers throughout, so every source's key claims appear in the high-reliability start position.
</details><br>

<details>
<summary>132. A multi-turn order-support agent degrades as conversations grow; each order lookup returns 40+ fields of which the task needs 5. What is the pattern, and where must it run?</summary>
Tool result trimming: filter verbose tool outputs down to only the relevant fields (for example order id, date, total, return eligibility, item description) so the other 35 fields do not consume tokens in every subsequent turn. It must run before the result enters the conversation history - in a PostToolUse hook or in the tool implementation itself - because once verbose data is in the context it stays there for every later turn. The trap is keeping full results because the model might need them later; untrimmed lookups exhaust the token budget across turns.
</details><br>

<details>
<summary>133. Research subagents send their full reasoning chains to a synthesis agent with a tight context budget. What change do you make, and what must the new outputs include?</summary>
Modify the upstream agents to return structured data instead of verbose content and reasoning chains: key facts as claims, citations with sources, and relevance scores. Require metadata in the structured outputs - dates, source locations, methodological context - to support accurate downstream synthesis. The wins are twofold: the synthesis agent stops wasting tokens on reasoning it cannot use, and it can process findings directly without re-parsing verbose prose. Same principle as the delegation rule: pass on the final result, not the intermediate work.
</details><br>

<details>
<summary>134. You add a cache_control breakpoint but see zero cache hits; your request puts the user's latest message before the long static reference document. Why no hits, what is the correct layout, and where does system content live in the request?</summary>
Caching matches from the start of the prompt, prefix by prefix, so dynamic content placed before the static block changes the prefix on every request - nothing matches and every call pays full price. Correct layout: constant content first (system instructions, tool definitions, long reference documents), the cache_control breakpoint of type ephemeral at the end of that static block, and volatile per-request content after it; the cache prefix hierarchy is tools, then system, then messages. System content is a top-level system parameter holding an array of content blocks (that is where cache_control goes) - a role system message inside the messages array is not the standard Messages API shape.
</details><br>

<details>
<summary>135. State the prompt cache's default lifetime and refresh behaviour, the write and read cost multipliers, the breakpoint limit, and what happens when the cached block is below the model's minimum token length.</summary>
Default lifetime is 5 minutes since last use, and the cache is refreshed at no extra cost each time the cached content is used - so caching pays off for bursts of related requests, not content reused hours apart; a 1-hour TTL is available via ttl 1h. Writes cost 1.25 times base input price for the 5-minute TTL and 2 times for the 1-hour TTL; reads cost 0.1 times base input price, and breakpoints themselves cost nothing. Up to 4 breakpoints per request. The minimum cacheable length is model-dependent (commonly 1024 tokens, some models 2048 or 4096); below it the request is processed without caching and no error is returned. Invalidation cascades down the tools then system then messages hierarchy - a change at one level invalidates that level and everything after it.
</details><br>

<details>
<summary>136. Name the three valid escalation triggers for a customer support agent, and state which one is an absolute rule with no exceptions.</summary>
Explicit human request, policy exceptions or gaps, and inability to make meaningful progress after a genuine attempt. The explicit human request trigger is the absolute one: the moment a customer asks for a human, escalate immediately with no attempt to resolve first and no "let me see if I can help with that first."
</details><br>

<details>
<summary>137. A customer asks for competitor price-matching, which the documented policy does not address at all. Is this a policy violation or a policy gap, and what follows from the answer?</summary>
It is a policy gap, not a violation - a violation has a documented answer (usually no) that the agent applies directly and does not escalate; a gap means the policy is silent on this exact situation, so it needs human judgement and must be escalated.
</details><br>

<details>
<summary>138. Your team proposes escalating support cases either when a sentiment classifier detects frustration, or when the model's self-reported confidence score falls below a threshold. Why are both unreliable?</summary>
Sentiment fails because frustration does not correlate with case complexity - a furious customer with a simple late delivery is easy to resolve, while a calm customer asking about a policy gap still needs escalation regardless of tone. Self-reported confidence fails because LLM confidence is poorly calibrated - the model is often confidently wrong on hard cases and unnecessarily hedges on easy ones, so a confidence-threshold policy escalates simple cases while attempting complex ones itself, the opposite of the intended routing.
</details><br>

<details>
<summary>139. A frustrated customer has a simple, resolvable issue. Should the agent escalate? What changes if the customer then says they'd still prefer to speak to a person?</summary>
No - acknowledge the frustration and resolve the issue directly; frustration alone with a resolvable issue is not an escalation trigger. If the customer reiterates their preference for a human after being offered help, escalate then - they were given the chance to accept agent resolution and declined it.
</details><br>

<details>
<summary>140. A customer lookup by name returns three "John Smith" records. What must the agent do, and what two heuristics must it NOT use?</summary>
Ask the customer for an additional identifier - email, phone number, or order number - to disambiguate. It must not select the most recent record or the most active record (or any other heuristic); guessing wrong can expose one customer's data to another or perform an action like a refund against the wrong account, so asking for clarification is the only safe response.
</details><br>

<details>
<summary>141. A search subagent times out after retrieving 3 of 5 sources. What four elements must its error report to the coordinator contain, and why is "search failed" insufficient?</summary>
Failure type (transient, validation, business, or permission - the same four categories as the tool-error taxonomy), what was specifically attempted (the query, parameters, and target system), the partial results already gathered before the failure (the 3 retrieved sources, not discarded), and potential alternative approaches the subagent's domain knowledge suggests (a different database, broader terms, cached results). "Search failed" gives the coordinator none of these, so it cannot choose intelligently between retrying, trying an alternative, proceeding with partial results, or escalating.
</details><br>

<details>
<summary>142. A subagent catches a timeout and returns {"results": [], "status": "success"}. Name this anti-pattern and explain why it is considered worse than a subagent crash that takes down the whole pipeline.</summary>
This is silent suppression. It is worse than the other anti-pattern (workflow termination, where one failure kills the entire pipeline and discards other subagents' completed work) because suppression is invisible: the coordinator believes the search legitimately ran and found nothing (a valid empty result), so it never retries, never tries alternatives, and the final synthesis looks complete while silently missing an entire research area. Workflow termination at least makes the failure visible by crashing; silent suppression hides it inside a result that looks like success.
</details><br>

<details>
<summary>143. A synthesis agent combines three subagent reports; one subagent's source access failed partway through. The final report simply omits that topic with no explanation. What is missing, and what should the synthesis say instead?</summary>
A coverage annotation is missing. Without one, a reader cannot distinguish "this topic was out of scope" from "the data source was unavailable" - the gap looks like a deliberate omission rather than a known limitation. The synthesis should explicitly flag the gap, e.g. "Section on geothermal energy is limited due to unavailable journal access during research," so the limitation is visible in the deliverable even though the underlying pipeline already reported the failure correctly.
</details><br>

<details>
<summary>144. Two hours into exploring a large repo, the agent starts saying "this follows the typical repository pattern" instead of naming the actual class and file. Diagnose it, and explain why moving to a 1M-token model does not fix it.</summary>
This is context degradation. Each exploration step emits verbose output (file contents, search results, directory listings) that accumulates in the conversation, pushing the earlier precise discoveries further back, so the model's attention shifts to the recent verbose output and it loses the specific references it had. It is not a token limit problem - the model is not running out of space, it is losing its grip on specific details. A larger context window simply fills with the same verbose output, and compaction behaves the same way at the larger limit, so the fix has to be structural: scratchpad files, subagent delegation, phase summaries, and state manifests. Same class of lesson as attention dilution, where a better model, a bigger window, and a stronger prompt are all planted distractors.
</details><br>

<details>
<summary>145. What is the primary mitigation for context degradation, and when should it be started?</summary>
Scratchpad files: the agent writes key findings (key classes with file paths, the dependency chain, critical findings such as missing retry logic or coverage numbers) to a file and reads that file back when it needs them later, so the knowledge lives outside the conversation context and cannot be buried by newer verbose output. It must be a deliberate strategy from the start of any extended exploration session, not a rescue move once degradation appears - by the time the symptoms show, the precise findings you wanted to record are exactly the ones already lost. It is the same "hold durable facts outside the summarisable stream" move as the persistent case facts block, and unlike an in-conversation finding it also survives /compact.
</details><br>

<details>
<summary>146. An exam option says the main benefit of spawning subagents for codebase exploration is parallel speed. Why is that wrong, and what is the real benefit?</summary>
The real benefit is context isolation. Each subagent runs in its own context window, so it can read files and run searches as verbosely as it likes without any of that output touching the coordinator's context; it returns only a structured summary and the coordinator keeps just the key findings. That keeps the main context clean for high-level coordination, which is what prevents context degradation. Parallelism is a side benefit. Delegate as specific investigation questions ("trace the refund flow from API endpoint to database and list all intermediate services"), and note the same principle appears as the Explore subagent, as the delegate-only-for-the-final-result rule, and as context: fork on a skill.
</details><br>

<details>
<summary>147. Phase 2 subagents keep re-discovering the architecture Phase 1 already mapped. What is this called and what is the fix?</summary>
The cold-start problem. Phase 2 subagents have isolated contexts and inherit nothing automatically, so unless the coordinator puts Phase 1's findings in their prompts they start from zero, duplicate the earlier exploration, and ask worse questions because they lack the architectural understanding needed to know where to look. The fix is summary injection between phases: summarise Phase 1's key findings and inject that summary into the initial prompt of every Phase 2 subagent, including both what was learned (layered architecture, the refund call chain, the missing retry logic) and the Phase 2 objective. It is the same summary-injection technique used for fresh sessions, applied across phases instead of across sessions.
</details><br>

<details>
<summary>148. When should /compact be run, what argument does it take, and name two things that do NOT come back after it.</summary>
Run it proactively during extended sessions, not only when you hit the context limit - it protects context quality, not just quantity. The signature is /compact [instructions], where the optional argument is focus instructions for the summary (e.g. /compact Focus on code samples and API usage); a default focus can be set with a "# Compact instructions" section in CLAUDE.md, and in a fresh session it prints "Not enough messages to compact." Lost after compaction: rules with paths: frontmatter and nested CLAUDE.md files in subdirectories (both reload only when a matching file is read again), plus the startup skill listing, which is the one auto-loaded item not re-injected - only skills actually invoked are preserved, capped at 5,000 tokens per skill and 25,000 total with the oldest dropped first. The system prompt, project-root CLAUDE.md, unscoped rules, and auto memory all come back.
</details><br>

<details>
<summary>149. You are switching to a completely unrelated task in a session with a very large context. Why is /clear the better choice than /compact here?</summary>
/compact reads the conversation it summarises, so compacting a large context is itself a large, paid request - and the summary it produces is of work you are about to stop caring about. /clear starts a new conversation with empty context and costs nothing. Use /compact when you need to free space but continue the same task, /clear when switching to unrelated work, fresh start plus summary injection when tool results are stale after file edits, and subagent delegation up front when you already know discovery will be noisy. /context visualises current usage and is how you decide when to act.
</details><br>

<details>
<summary>150. Your exploration session crashed mid-way. What mechanism should have been in place, what four things does it record, and how does it differ from --resume?</summary>
A structured state manifest: each agent exports its current state to a known file location recording what has been explored (files read, searches performed), key findings so far, the current phase and next steps, and any pending questions or unresolved issues. On resume the coordinator loads the manifest and injects it into the agent prompts, so work continues instead of restarting. It differs from --resume in three ways: --resume needs a session that survived, restores the raw conversation history including stale tool results, and gives you no distilled findings; a manifest is an agent-authored file on disk that survives a crash, holds distilled findings, and is consumed by injection into a fresh session. A scratchpad serves in-session recall; the manifest serves cross-session recovery, which is why it also carries phase, next steps and open questions. Restarting without persisting state first is the trap - it discards everything the session learned.
</details><br>

<details>
<summary>151. Your invoice extraction system reports 97% overall accuracy, and management wants to automate all high-confidence extractions. Why is this decision unsafe, and what must you check first?</summary>
The 97% is a volume-weighted aggregate dominated by the easy, high-volume segment (standard invoices at 99.5%), and it can hide catastrophic failure rates on specific document types - handwritten receipts at 60%, scanned PDFs at 72%, international formats at 45%. Those failing segments often carry the highest business impact. The rule is to validate accuracy by document type AND field segment before automating anything; never make automation decisions from aggregate metrics alone.
</details><br>

<details>
<summary>152. In an extraction pipeline where low-confidence items already go to human review, why must stratified random sampling include HIGH-confidence extractions, and what two purposes does the sampling serve?</summary>
High-confidence extractions are the automated ones - no human ever sees them through routing. If the model develops a novel error pattern that affects high-confidence extractions, such as a systematic error on a new document format, only stratified sampling of the automated stream will catch it before downstream business processes fail. The sampling selects a representative sample from each stratum (document type, confidence band, field type) and serves two purposes: ongoing accuracy measurement, confirming each segment maintains its validated rate, and novel error pattern detection, discovering failure modes absent from the original validation set. Sampling only low-confidence items is the trap - those already get review.
</details><br>

<details>
<summary>153. Your extraction model reports 0.90 confidence on both a date field and an amount field. Why can these not be treated the same, and what routing structure do calibrated per-field thresholds produce?</summary>
Raw confidence scores are relative, not absolute: the same reported 0.90 might correspond to 94% actual accuracy on date fields but only 82% on amount fields, so one global threshold is wrong. You build a calibration curve per field type by running documents with known correct extractions and comparing reported confidence to actual accuracy. Calibrated per-field thresholds then drive three-zone routing: fields above the threshold are automated but still covered by stratified sampling, fields below it go to human review, and fields in the ambiguous zone near the threshold get prioritised human review. Calibration is per field and per segment, never one global curve.
</details><br>

<details>
<summary>154. A team distributes its limited human reviewer capacity evenly across all extractions and serves the review queue in chronological order. What is wrong with both choices?</summary>
Even distribution wastes reviewer time on high-confidence items the model handles well while leaving insufficient capacity for the uncertain items where human judgement actually adds value. Instead, route the highest-uncertainty items to reviewers first: low calibrated confidence fields, ambiguous or contradictory source documents, document types with historically poor accuracy, and cases where the model expresses multiple possible interpretations. Chronological ordering is wrong because prioritisation must be dynamic, not static - when a reviewer finishes an item, the next one served should be the highest-uncertainty item remaining in the queue, not the next in arrival order.
</details><br>

<details>
<summary>155. What is the five-step sequence for safely reducing human review in an extraction system, and which step do teams skip to when they fall for the aggregate metrics trap?</summary>
First, measure accuracy by document type and field segment, not aggregate. Second, calibrate confidence scores using labelled validation sets. Third, set calibrated thresholds for automation versus human review. Fourth, implement stratified random sampling for ongoing verification of automated extractions. Fifth, and only then, reduce human review on segments that demonstrate consistent, validated accuracy. The trap is skipping straight to step five based on aggregate metrics: automation gets approved on a volume-weighted 97% while specific segments fail at 45-60%, and without the calibration and sampling steps there is no mechanism to catch it. Every step in the sequence exists to prevent a specific failure mode.
</details><br>

<details>
<summary>156. Your research subagents return findings with full claim-source mappings (claim, source URL, document name, relevant excerpt, publication date), the coordinator passes them through intact, yet the final report says only "investment has grown significantly" with no sources. What happened, and how does the fix differ from the stripped-metadata case?</summary>
Attribution died during summarisation: the synthesis agent naturally compresses and paraphrases when combining findings, and without explicit instructions it drops the claim-source mappings even though it received them. The fix is the synthesis agent's prompt - explicitly require it to preserve and merge the mappings so every claim in its output is traceable to a specific source, with inline citations or a structured reference section in the final output. This is the opposite diagnosis from the stripped-metadata case, where the coordinator removed the metadata before synthesis and changing the synthesis prompt cannot help because the agent never saw the sources. Same symptom, two different bugs: diagnose whether the mappings reached the synthesis agent before choosing the fix. The most common failure point in the pipeline is the synthesis step, where findings are combined and paraphrased.
</details><br>

<details>
<summary>157. Two credible publications report 12% and 8% market growth for the same measure. The exam offers: take the more recent source, average them, take the more authoritative publisher, or annotate both. Which is correct and why are the others wrong?</summary>
Annotate with both values and full source attribution - publication dates, reporting periods, methodology notes - and let the consumer decide. Selecting the more recent source, averaging the values, and preferring the more authoritative publisher are all forms of arbitrarily resolving the conflict: they destroy information and present a false certainty. The same rule applies at the analysis agent, which must complete its work with conflicts included and explicitly annotated (for example a conflictDetected flag with both values and their contexts) rather than resolving them - resolution belongs to the coordinator or consumer, who can present both, investigate further, or escalate to a human analyst. Reports should also separate well-established findings from contested ones, since a claim backed by three independent sources differs from one based on a single report.
</details><br>

<details>
<summary>158. A source published in 2023 reports 8% growth and a source published in 2024 reports 12%, and your synthesis agent flags them as a data quality conflict. What was missing from the pipeline, and what is the actual relationship between the numbers?</summary>
Temporal context was missing: publication or data-collection dates were not required in the structured outputs, or were not preserved through synthesis. With dates the two numbers are not a contradiction but a trend - growth accelerated from 8% to 12% over the measured period. The rule is to require publication and data-collection dates in all structured outputs, have the synthesis agent preserve them through merging, and present them alongside the data in the final output. Without temporal context, valid trends get misread as data quality issues and the synthesis agent may incorrectly flag or suppress findings that are actually consistent. The trap is assuming different numbers from different sources are contradictions - check the dates first.
</details><br>

<details>
<summary>159. A synthesis agent renders financial comparisons, news developments, and API specifications all as prose paragraphs. What principle is violated, and what should each content type use?</summary>
Content-appropriate rendering: synthesis should not flatten everything into a uniform format, because forcing all content into a single format - all prose, all tables, or all lists - degrades readability and comprehension. Financial data belongs in tables, where numbers, comparisons and trends can be scanned and compared; news and current events belong in prose, where narrative context, cause-and-effect and chronology read naturally; technical findings such as architectural patterns, API specifications and configuration options belong in structured bulleted or numbered lists with clear hierarchy. The synthesis agent should select the rendering format based on the content type.
</details><br>
