# Claude Certification - Exam Guide Revision Notes

Covers: agentic loop termination, tool_choice, multi-agent orchestration (hub-and-spoke), subagent invocation & context passing, workflow enforcement & handoff, Agent SDK hooks, task decomposition & attention dilution, session management & stale context, tool descriptions & selection, tool error handling & recovery, tool distribution & scoping, MCP server configuration.

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

Same root-cause discipline as §9: the visible failure is downstream (synthesis), the actual bug is in the coordinator's handoff. Scope gaps -> decomposition; attribution gaps -> context passing.

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

| | Prompt-based guidance | Programmatic enforcement |
| --- | --- | --- |
| Mechanism | Instructions in the system prompt ("Always verify identity before processing a refund") | Hooks, prerequisite gates, code-level checks that physically block downstream tools |
| Nature | **Probabilistic** - works most of the time (~90-95%) | **Deterministic** - works every time |
| Failure mode | Non-zero failure rate: the model may skip, reorder, or loosely interpret steps | None: no matter what the model decides, the gate prevents wrong execution order |
| Acceptable for | Low-stakes operations | Required for high-stakes operations (§18) |

_(Addition)_ Same determinism theme as §2's anti-patterns: prompt instructions are to workflow ordering what natural-language "I'm done" parsing is to loop termination - a probabilistic signal where a deterministic mechanism exists. In Claude Code terms, the programmatic mechanism is a `PreToolUse` hook - the one hook that can block a tool call before it runs (see §24-§26).

---

## 18. The exam decision rule (when programmatic is mandatory)

**If a single failure would cause financial loss, security breach, or compliance violation - programmatic enforcement. Always.**

| Operation class | Enforcement | Why |
| --- | --- | --- |
| Financial (refunds, transfers, payments) | Programmatic | One unverified refund to a wrong account is a financial loss |
| Security (identity verification, access control) | Programmatic | One bypass is a security breach |
| Compliance (AML checks, regulatory requirements) | Programmatic | One missed check can mean legal penalties |
| Low-stakes (formatting, style, output ordering) | Prompt-based is acceptable | A formatting inconsistency is not a business risk |

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

| Hook | Fires | Typical uses |
| --- | --- | --- |
| `SubagentStart` | When a subagent is spawned via the Task/Agent tool | Rate-limiting spawns, logging invocations, injecting context at the subagent's start |
| `SubagentStop` | When a subagent finishes and returns results | Validating output against expected schemas, stripping sensitive data, completion logging |

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

**Keep this concept separate from gates (§17-19).** They answer different questions: gates enforce *ordering* within one operation ("verification must precede refund"); multi-concern handling ensures *coverage* across operations ("all three concerns get addressed"). A verification gate cannot save a forgotten loyalty inquiry. The true kin of a dropped concern is §9's scope-gap failure - narrow decomposition at single-conversation scale.

(Structural echo of §8: decompose -> parallel with shared context -> synthesise is the coordinator pattern applied inside one conversation.)

---

## 22. Structured handoff protocols

When escalating to a human agent, **the human does NOT have access to the conversation transcript** - the handoff summary is the only information they receive, so it must be self-contained:

| Required field | Why |
| --- | --- |
| Customer ID | So the human can pull up the account |
| Conversation summary | What was asked and what has been attempted |
| Root cause analysis | The agent's assessment of the underlying issue |
| Refund amount (if applicable) | The specific figure, not a vague reference |
| Recommended action | What the agent believes should happen next |

An incomplete summary forces the human to make the customer repeat everything - the failure the protocol exists to prevent.

**Exam trap - the partial handoff that "looks complete".** A summary with, say, customer ID and a vague conversation summary but no root cause or recommended action *looks* complete but isn't. All five fields are required, not "enough to get by" - the exam presents partially-filled handoffs as plausible correct answers precisely because they resemble complete ones.

---

## 23. Workflow enforcement exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Enhanced system prompt instructions as the fix for high-stakes compliance failures | The prompt already instructs the workflow and fails 8%; a stronger prompt reduces, never eliminates. Financial/security/compliance need deterministic gates. |
| Few-shot examples as sufficient for guaranteed compliance | Still probabilistic - cannot provide 100% enforcement. |
| Routing classifiers proposed to fix per-agent compliance issues | Classifiers decide WHICH agent handles a request; the failure occurs WITHIN the agent's execution sequence. Wrong layer. |
| Handoff summaries omitting critical fields (customer ID, recommended action) | The human has no transcript access - the summary must be self-contained with all five fields (§22). |

---

## 24. Hooks - the two directions

Hooks inject deterministic behaviour into a probabilistic system: they sit at the boundary between the model's decisions and the real world. This is how the programmatic enforcement of §17-19 is actually implemented.

| | `PreToolUse` | `PostToolUse` |
| --- | --- | --- |
| Runs | BEFORE the tool executes | AFTER the tool executes, before the model processes the result |
| Purpose | **Enforce policy**: block, modify, or redirect the outgoing call - the tool never runs if blocked | **Transform data**: normalise the result before the model sees it |
| Direction | Outbound (tool inputs) | Inbound (tool results) |

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

The model receives clean, consistent data every time, regardless of which tool or backend produced it - eliminating the interpretation-error class instead of reducing it. (The determinism argument of §17, applied to data instead of workflow: model-side interpretation is probabilistic; hook-side normalisation is deterministic.)

---

## 26. PreToolUse - policy enforcement

`PreToolUse` hooks are the implementation mechanism for §19's prerequisite gates - they intercept outgoing calls and apply business rules before execution:

| Use case | Rule |
| --- | --- |
| Refund threshold | Intercept `process_refund`; amount > $500 -> block and redirect to human escalation. The refund tool never executes. |
| Compliance prerequisite gate | Intercept `transfer_funds`; AML check not completed this session -> block with an error directing the agent to complete it first. |
| Manager approval workflow | Intercept `approve_discount` above 20% -> pause and route to a manager approval queue; execute only after approval. |

_(Addition)_ The same gate concept can be implemented in the tool-dispatch layer of a raw-API loop - the hand-rolled equivalent of a PreToolUse hook. Same principle, different layer: on the raw API the gate lives in your dispatch code; on the Agent SDK it lives in a hook.

---

## 27. The decision framework (hooks vs prompts)

The core mental model - §18's decision rule with the mechanism column filled in:

| Requirement | Mechanism | Guarantee |
| --- | --- | --- |
| Must be followed 100% of the time | Hooks | Deterministic |
| Preferred, occasional deviation acceptable | Prompts | Probabilistic |

Money lost from a single failure -> hook. Legal risk from a single failure -> hook. Formatting preference or style guideline -> prompt is fine. The question is never "are prompts good enough?" - it is "does the consequence of a single failure justify deterministic guarantees?"

Side-by-side scenarios:

| Scenario | Prompt approach | Hook approach |
| --- | --- | --- |
| International transfers must pass AML checks | "Always complete AML verification first" - works ~95%; the 5% is a regulatory violation | PreToolUse blocks `transfer_funds` until `aml_check` passes - 100% |
| Responses formatted in markdown | Works most of the time; occasional plain text is not a business risk - **correct choice** | Unnecessary overhead |
| Refunds above $500 require human approval | Works most of the time; a single failure = large unapproved refund | Intercept, check amount, block above $500 and route to escalation - 100% |

---

## 28. Hooks exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Using PostToolUse hooks to block policy-violating actions | PostToolUse fires AFTER execution - the non-compliant action already happened. Blocking is PreToolUse's job. |
| Enhanced prompt instructions for 100% compliance requirements | Prompts are probabilistic; financial/regulatory/security operations need the deterministic guarantee only hooks provide. |
| Model-side data transformation instead of PostToolUse normalisation | Asking the model to normalise heterogeneous formats re-introduces per-iteration inconsistency; the hook guarantees clean data every time. |
| Confusing hook direction | PostToolUse transforms results after a tool runs; PreToolUse blocks or modifies calls before. Wrong direction = either missing the chance to prevent an action, or "blocking" work already done. |

---

## 29. Task decomposition - two patterns

The exam tests picking the right decomposition pattern for a task's characteristics.

| | **Fixed sequential pipeline** (prompt chaining) | **Dynamic adaptive decomposition** |
| --- | --- | --- |
| Shape | Predetermined steps; each step's output feeds the next; the sequence never changes | Start with a high-level goal, investigate, generate a plan, and revise the plan as findings emerge |
| Best for | Predictable, structured tasks with steps known in advance | Open-ended investigation where the full scope is unknown at the start |
| Examples | Code review, document/data extraction, compliance checks | Legacy-codebase exploration, security audits, debugging an unfamiliar system, research |
| Strengths | Consistent, reliable, easy to debug and monitor (you know which step produced what) | Adapts to unexpected complexity; more thorough on open-ended work |
| Weaknesses | Cannot adapt - if step 2 finds something that should change step 3, it can't | Less predictable; variable runtime; harder to estimate and debug |

_(Cross-reference)_ The fixed pipeline is the classic **prompt-chaining** agent-design pattern; dynamic decomposition is the coordinator's **dynamic subagent selection** (§8) generalised to the whole plan. Same "prefer workflows over agents unless you need adaptability" trade-off: fixed = workflow-like reliability, dynamic = agent-like flexibility.

---

## 30. Selecting the right pattern

| Task | Pattern | Why |
| --- | --- | --- |
| Steps known in advance, structured input | Fixed pipeline | Consistency outweighs adaptability |
| Open-ended, unknown scope | Dynamic decomposition | Adaptability is essential |
| Multi-file code review | Fixed pipeline | Per-file analysis + cross-file integration is predictable |
| Legacy codebase exploration | Dynamic decomposition | Dependencies/issues emerge during investigation |
| Document extraction | Fixed pipeline | Fields and format are predetermined |
| Debugging an unfamiliar system | Dynamic decomposition | Root cause unknown; investigation must adapt |

**The trap:** match the pattern to the task's *characteristics*, not to what sounds more sophisticated. The exam will offer a fixed pipeline for an open-ended investigation, or dynamic decomposition for a structured processing task - both wrong.

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
2. **Cross-item integration pass** - after all local passes, one pass that looks *across* items for cross-cutting concerns (data flow, inconsistent pattern usage, cross-file dependencies). Catches what per-item passes structurally cannot see.

Worked example - the 14-file review: a single pass gives files 1-5 detailed feedback, 6-9 moderate, 10-14 superficial (missing null-pointer and SQL-injection bugs), and flags a `forEach` as inefficient in file 3 while ignoring identical code in file 11. The fix is 14 per-file passes (each catches its own local bugs) **plus** a cross-file integration pass (catches the inconsistent `forEach` verdict and data-flow issues).

_(Cross-reference)_ This is the decompose -> per-item -> synthesise shape of §8/§21, applied to defeat attention dilution: one pass per item (each with full attention), then a pass that reasons across items. _(Addition)_ In the Agent SDK, the scaling mechanism for a many-item fan-out like this is the **Workflow tool** (orchestration moved into a script) rather than turn-by-turn subagent spawning.

**Batching caveat:** grouping items into batches reduces dilution *within* a batch but misses *cross-batch* issues - batching without a dedicated cross-item integration pass still leaves data-flow and consistency problems undetected.

---

## 33. Task decomposition & attention exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| A more powerful model / larger context window fixes attention dilution | It's architectural, not a capability problem - too many items per pass gives inconsistent depth regardless of model or context size. Fix = multi-pass. |
| A single pass with better prompts equals multi-pass architecture | Better prompts raise average quality but don't guarantee per-item attention; only separate passes do. |
| Fixed pipeline for an open-ended investigation task | Fixed pipelines can't respond to unexpected findings; unknown scope needs dynamic decomposition. |
| Batching files into groups without a cross-file integration pass | Batching cuts within-batch dilution but misses cross-batch issues - you still need the integration pass. |

---

## 34. Session management - three options

Long-running work accumulates context (tool results, file analyses, reasoning chains). There are three distinct ways to carry - or not carry - that state into the next session, and the exam expects you to pick the right one.

| Option | What it does | Use when | Do NOT use when |
| --- | --- | --- | --- |
| `--resume <name>` | Restores the **entire** conversation history from a named session - every tool result and analysis | Prior context is mostly still valid; files haven't changed; you want to pick up exactly where you stopped | Files have been modified since (leads to stale context, §35) |
| `fork_session` | Branches an **independent** copy from a shared baseline; branches can't see each other | You've done an initial analysis and want to explore **divergent** approaches from that shared start (e.g. two refactoring strategies) | You just want to continue one line of work (use resume), or you need to escape stale context (fork inherits it) |
| Fresh start + **summary injection** | A brand-new session with **no** prior tool results, seeded with a structured summary you write | Tool results are stale, or context has degraded (too much clutter); you want a clean baseline that preserves knowledge | Prior context is still valid and you want the full history (resume is more efficient) |

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
- **Why:** resume restores the *entire* history, including every prior tool result. A file read last session and edited since still sits in the conversation as its old contents; the model reasons from that stale data alongside any fresh reads.
- **The naive fix, and why it's insufficient:** resume and ask the agent to re-read the changed files. Better than nothing, but the stale results **remain in history** and can still influence reasoning - especially on tangential decisions that don't directly touch the modified files.
- **The correct fix:** start a **fresh session with a structured summary** of prior findings, naming which files changed so the agent can re-analyse just those. No stale tool results; knowledge preserved without the outdated data.

_(Cross-reference)_ Same shape as the human-handoff summary (§22): the receiver - a fresh session, or a human agent - lacks the original context, so a self-contained summary must carry the knowledge forward. Summary injection is a handoff to your future session.

---

## 36. Targeted re-analysis, not full re-exploration

When only a few files changed, do **not** re-analyse the whole codebase - wasteful, especially at scale. Targeted re-analysis:

1. Start a fresh session.
2. Inject a structured summary: *"Prior analysis found X, Y, Z. These files changed since: auth.ts, database.ts, api-routes.ts."*
3. The agent re-reads only the changed files.
4. It combines fresh analysis of the changed files with the preserved summary of the unchanged ones.

Faster than full re-exploration, and more reliable than resuming with stale context. (The efficiency theme mirrors §31-32: the fix is structural - re-read only what changed - not "throw the whole codebase back in".)

---

## 37. Session management decision matrix

| Scenario | Best option | Why |
| --- | --- | --- |
| Continuing yesterday's work, no files changed | `--resume` | Prior context valid; full history is useful |
| Comparing two refactoring approaches | `fork_session` | Divergent exploration from a shared baseline |
| Resuming after modifying 3 of 50 files | Fresh start + summary | Stale results for the changed files would cause contradictions |
| Long session with cluttered history | Fresh start + summary | Degraded context benefits from a clean baseline |
| Testing strategy vs documentation strategy | `fork_session` | Two independent approaches from the same analysis |
| Resuming after dependency updates | Fresh start + summary | Many files may have changed indirectly |

---

## 38. Session management exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Full re-exploration of a 50-file codebase when only 3 changed | Wasteful; name the 3 changed files for targeted re-analysis, the summary covers the rest. |
| `--resume` after files have been modified | Preserves stale tool results; the agent may reason from outdated contents. Fresh start + summary avoids it. |
| Confusing `fork_session` with `--resume` | Fork = independent branches for different approaches; resume = continue the same conversation. Divergence vs continuation. |
| Using `fork_session` to handle stale context | Fork branches from the existing session, so it **inherits** the stale results. Only a fresh start drops them. |

---

## 39. Tool descriptions - the primary selection mechanism

Tool descriptions are **THE** mechanism the model uses to choose a tool - not supplementary metadata. Given a set of tools, the model reads the descriptions to decide which to call. Minimal descriptions ("Retrieves customer information") leave it unable to differentiate tools with overlapping purposes.

**A production-grade description has all five elements** (memorise this list - it is the crux):

| Element | The question it answers |
| --- | --- |
| 1. Purpose | **What does it do?** (primary purpose, stated unambiguously) |
| 2. Inputs | **What inputs does it accept?** (types, formats, constraints, required vs optional) |
| 3. Examples | **What queries suit it?** (concrete use cases that anchor understanding) |
| 4. Edge cases / limitations | **What does it NOT handle?** (out-of-range behaviour, what it can't do) |
| 5. Boundaries | **When should the *other* tool be used instead?** (disambiguation vs similar tools) |

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

| Fix | Verdict | Why |
| --- | --- | --- |
| **Expand the descriptions** | ✅ Correct | Low effort, high leverage, addresses the root cause directly |
| Few-shot examples | ❌ Wrong | Token overhead without fixing *why* the model is confused - treats the symptom |
| Routing classifier | ❌ Wrong | Over-engineered first step; bypasses the LLM's own language understanding, adds infrastructure |
| Tool consolidation | ❌ Wrong *as a first step* | A valid long-term architecture choice, but far more effort than editing descriptions |

**The general exam heuristic: prefer low-effort, high-leverage fixes.** Better descriptions before routing classifiers; scoped access before full access; community MCP servers before custom builds. When a scenario offers a cheap targeted fix and an expensive structural one, the cheap one is usually the intended first answer.

_(Note)_ A routing classifier is wrong here for a *different* reason than in §23: there it addressed the wrong layer (routing vs in-agent enforcement); here it is simply disproportionate effort for a description problem. Both make it the wrong answer.

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

Keyword-sensitive instructions in the **system prompt** can create unintended tool associations that override well-written descriptions. If the system prompt says "always check customer details before proceeding", the model may associate *any* customer-related query with `get_customer` regardless of what the descriptions say.

**Always review the system prompt for keyword conflicts after updating tool descriptions** - a subtle failure mode where a good description is silently overridden by prompt wording.

---

## 43. Tool description exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Few-shot examples to fix misrouting from minimal descriptions | Adds token overhead without addressing the root cause; the descriptions don't differentiate the tools - fix them first. |
| A routing classifier as the first step | Over-engineered; bypasses the model's language understanding and adds disproportionate infrastructure. |
| Consolidating similar tools as the first step | Valid long-term, but more effort than expanding descriptions; the exam favours the low-effort high-leverage fix. |
| Ignoring system-prompt wording after editing descriptions | Keyword-sensitive prompt instructions can silently override good descriptions and force the wrong tool. |

---

## 44. Tool error responses - `isError` and the four categories

A generic error ("Operation failed") is useless to an LLM - it gives no signal about what went wrong, whether to retry, or what to do instead. MCP's **`isError` flag** tells the model the tool failed, so it reasons about recovery instead of treating error text as a normal result.

Every failure falls into one of four categories, each with a different recovery:

| Category | Cause | Retry? | Recovery |
| --- | --- | --- | --- |
| **Transient** | Timeout, service down, rate limit - request is valid, system temporarily unreachable | Yes (as-is) | Retry after a brief delay |
| **Validation** | Bad input format, missing field, out-of-range value - request is malformed | Yes (after fix) | Fix the input, then retry |
| **Business** | Policy violation, limit exceeded, rule conflict - valid request, forbidden by a rule | **No** | Alternative workflow - typically escalate |
| **Permission** | Access denied, insufficient credentials | **No** | Escalate or use different credentials |

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

So read `isRetryable` as "can a retry *ever* work", then read `errorCategory` to know **how**: resend, self-correct, escalate, or take an alternative route. The two `true` categories need different actions; the two `false` categories are false for mirror-image reasons.

---

## 46. Access failure vs valid empty result (tested directly)

One of the most critical distinctions in the domain:

| | **Access failure** | **Valid empty result** |
| --- | --- | --- |
| What happened | Tool could NOT reach the data source (timeout, auth fail, service down) | Tool successfully queried and found no matches |
| Data state | Might exist - the tool couldn't check | Confirmed: nothing matches the criteria |
| Correct response | An **error** - decide whether to retry | **Not** an error - accept "no results found", do NOT retry |

Confusing them breaks recovery: a tool returns an empty array, the agent retries 3× then escalates to a human - but the account simply doesn't exist. The tool *succeeded*; retrying just repeats the empty result. The fix is to make a successful-but-empty query look **fundamentally different** from a failed one:

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

_(Cross-reference)_ This is the concrete form of §6's "consistent error handling" centralisation benefit and §8's coordinator error-handling responsibility: the hub can only apply uniform recovery if subagents report failures honestly with context, rather than hiding them.

---

## 48. Tool error handling exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Retrying when a successful query returns an empty result | Empty-from-success means "no data matches"; retrying just repeats it. Accept and respond. |
| Generic error messages ("Operation failed") without structured metadata | Without category/retryable/description the agent can't tell a transient failure from a business rule violation - it can't choose a recovery. |
| Treating business errors as retryable | The policy violation recurs every time; the agent must take an alternative path (escalate), not retry. |
| Silently suppressing subagent errors as empty success | Hides failure from the coordinator, which then can't distinguish "found nothing" from "couldn't search" and produces incomplete output. |

---

## 49. Tool distribution - the 4-5 rule

The **number** of tools an agent has directly affects how reliably it selects the right one - this is an architectural decision, not an implementation detail. Give one agent 18 tools and selection reliability degrades: every added tool increases decision complexity and error rates climb. **Optimal: 4-5 tools per agent, scoped to that agent's role.**

It's about relevance, not just count. An agent with tools outside its specialisation tends to *misuse* them: a synthesis agent given `web_search` may run its own searches instead of using the results already provided - duplicating work and wasting context. **The principle: each agent gets only the tools it needs for its role, nothing more.**

_(Cross-reference)_ This is the fleet-level version of §11's least-privilege tool scoping: §11 says scope each subagent's `tools`; this says the *right size* of that scope is ~4-5 role-relevant tools, and over-provisioning causes misuse, not just risk.

---

## 50. tool_choice - choosing the setting

§5 covers what each `tool_choice` value *does*; this is *when* to reach for each:

| Setting | When to use |
| --- | --- |
| `auto` (default) | General operation - the model needs freedom to answer in text when no tool fits |
| `any` (must call some tool) | You need guaranteed structured output but the right schema is unknown - e.g. an extraction pipeline with multiple schemas (invoice / receipt / contract), each a tool; `any` forces the model to pick one and emit structured output instead of prose |
| forced (`{type:"tool", name}`) | Enforce a **mandatory first step** - the model cannot skip or reorder it (e.g. `extract_metadata` before any enrichment). After the forced call, later turns switch back to `auto` for the rest |

_(Addition)_ For a *single* known schema, `output_config.format` (structured outputs) is the cleaner guarantee; `any` over multiple tools is the answer when the schema itself is what's being selected. And recall from §5 the constraints: forced/`any` suppress preamble text and are incompatible with extended/adaptive thinking - so "force the tool but keep thinking on" is an invalid request.

---

## 51. Scoped cross-role tools (exam Q9 - know it cold)

Sometimes an agent occasionally needs a capability that belongs to another role. Routing *every* such request through the coordinator adds 2-3 round trips and can raise latency 40%+.

**The fix - a scoped cross-role tool:** a constrained version of the capability given directly to the agent that needs it, sized to the common case.

Worked example: a synthesis agent frequently verifies simple facts while writing a report. Routing all verifications to the coordinator (which delegates to the search agent and waits) is wasteful for the ~85% that are millisecond lookups. Give synthesis a scoped `verify_fact` that handles simple lookups locally; the ~15% complex verifications (multiple sources, cross-referencing, judgement) still route through the coordinator and the full pipeline.

**The pattern: handle the high-frequency simple case locally with a scoped tool; escalate the rare complex case to the full pipeline.** This does not violate hub-and-spoke's routing rule (§6) - it's a deliberate, constrained exception for a latency-critical common path, not open subagent-to-subagent traffic.

---

## 52. Constrained tools and role-specific scoping

Prefer a **constrained** tool over a generic one: instead of `fetch_url` (fetches anything from anywhere), give `load_document` (validates document URLs only). The constrained tool prevents misuse, makes its purpose clearer in the description, and reduces unintended side effects - least privilege applied to tool design (and complementary to the tool-splitting of §41: split for clarity, constrain for safety).

Role-specific scoping in a well-designed research system - each agent has exactly 4-5 role-relevant tools:

| Agent | Tools |
| --- | --- |
| Web Search | `search_web`, `fetch_page`, `extract_links`, `save_snippet` |
| Document Analysis | `extract_metadata`, `extract_data_points`, `summarize_content`, `verify_claim` |
| Synthesis | `compile_report`, `verify_fact` (scoped, §51), `format_citation`, `assess_coverage` |
| Coordinator | `Agent` (spawn subagents; formerly `Task`), `review_output`, `request_revision` |

Note the coordinator has **no domain tools** - it controls the workflow (spawn / review / revise) and delegates all domain work, matching the hub-and-spoke role split (§6-§8).

---

## 53. Tool distribution & choice exam traps

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Giving an agent 18 tools and expecting reliable selection | Reliability degrades as tools grow; scope to ~4-5 role-relevant tools. |
| Routing all simple verifications through the coordinator when 85% are trivial | 2-3 extra hops each; a scoped `verify_fact` on the agent handles the common case, cutting latency up to 40%. |
| `tool_choice: "auto"` when structured output is required | `auto` may return prose; use `any` (some tool) or forced (a specific tool) to guarantee a tool call. |
| A generic `fetch_url` when a constrained `load_document` would do | Generic tools enable misuse; constrained alternatives enforce least privilege and clarify purpose. |

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

| | Project-level: `.mcp.json` | User-level: `~/.claude.json` |
| --- | --- | --- |
| Location | Project repository root | User home directory |
| Version-controlled | Yes | No |
| Shared with teammates | Yes (on clone/pull) | No |
| Use for | Servers the whole team needs (Jira, GitHub, internal connectors) | Experimental / personal servers, testing before proposing to the team |

**Keep credentials out of version control with `${VAR}` expansion.** `.mcp.json` supports `${VARIABLE_NAME}` in `env`, so the committed file references variable *names*, not values; each developer sets their own tokens locally (shell profile, `.env`, secrets manager). Result: the config is safe to commit, everyone authenticates with their own credentials, token rotation needs no config change, and no secret enters repo history.

**All tools from all configured servers are discovered at connection time and available simultaneously** - there is no manual activation step; if a server is configured and reachable, its tools appear in the toolkit.

_(Fact-check, verified against the Claude Code MCP reference)_ There are actually **three** scopes, not two:

| Scope | Loads in | Shared | Stored in |
| --- | --- | --- | --- |
| **local** (default) | Current project only | No | `~/.claude.json` (under the project's path) |
| **project** | Current project only | Yes, via version control | `.mcp.json` at project root |
| **user** | All your projects | No | `~/.claude.json` |

So the exam's "user-level `~/.claude.json`" is really **two** scopes that share that file - the *default* is `local` (per-project private), while `user` is the all-projects one. Two more real details worth knowing (and prime distractors): older versions renamed the scopes (`local` was called `project`, `user` was called `global`), and project-scoped servers from `.mcp.json` **require approval before use** - a freshly cloned repo's servers sit pending until you trust the workspace, so "commit `.mcp.json` and teammates get the tools automatically" is not quite true.

---

## 56. MCP resources vs tools

**Resources** expose content *catalogs* to the agent upfront, so it doesn't need exploratory tool calls to discover what data exists. Examples: issue summaries (open Jira tickets + statuses), documentation tables of contents, database schemas (tables, columns, relationships).

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

| Trap (reject these answers) | Why it's wrong |
| --- | --- |
| Building a custom MCP server for a standard integration (e.g. Jira) | Community servers exist for standard integrations - evaluate them first; custom is only for needs they can't meet. |
| Putting team-wide server config in `~/.claude.json` | That's user/local scope - personal, not version-controlled or shared. Team-wide servers go in `.mcp.json` at the project root. |
| Committing credentials directly in `.mcp.json` | Secrets in version control are a security risk; use `${VAR}` expansion so tokens stay local and never enter repo history. |
| Leaving MCP tool descriptions sparse | The agent defaults to better-understood built-in tools; enhance descriptions so a genuinely-more-capable MCP tool is chosen. |

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
<summary>28a. What is the CORE danger of handling a compound request sequentially or first-item-only?</summary>
The remaining concerns get forgotten entirely - ticket closed after the first fix, the other issues never investigated. Customer half-served, forced to re-contact support. This is a coverage failure (kin of the narrow-decomposition scope gap), NOT an ordering/gate problem - a verification gate cannot save a forgotten concern.
</details><br>

<details>
<summary>29. What must a human-handoff summary contain, and why must it be self-contained?</summary>
Customer ID, conversation summary, root cause analysis, refund amount (if applicable), recommended action. The human agent has NO access to the conversation transcript - the summary is all they get.
</details><br>

<details>
<summary>29a. A handoff contains customer ID and a summary of the conversation. Complete?</summary>
No - it looks complete but isn't. All FIVE fields are required (missing here: root cause analysis, refund amount if applicable, recommended action). The exam offers partially-filled handoffs as plausible answers precisely because they resemble complete ones.
</details><br>

<details>
<summary>30. Why is a routing classifier the wrong fix for a per-agent compliance failure?</summary>
Classifiers decide WHICH agent handles a request; the compliance failure happens WITHIN the agent's execution sequence. Wrong layer - the fix is workflow enforcement (a gate) inside the agent.
</details><br>

<details>
<summary>31. PreToolUse vs PostToolUse - which direction does each operate in?</summary>
PreToolUse runs BEFORE execution: enforce policy - block, modify (updatedInput), or redirect the outgoing call; the tool never runs if blocked. PostToolUse runs AFTER execution, before the model processes the result: transform data (updatedToolOutput) - normalise the result the model sees. Outbound inputs vs inbound results.
</details><br>

<details>
<summary>32. Why is PostToolUse WRONG for blocking a policy-violating action?</summary>
It fires after the tool executed - the non-compliant action has already occurred. Blocking must happen pre-execution: PreToolUse.
</details><br>

<details>
<summary>33. Three tools return dates as Unix timestamps, ISO 8601, and DD/MM/YYYY. Correct fix?</summary>
A PostToolUse hook that normalises all results to one format before the model sees them. Wrong answer: prompting the model to interpret formats itself - that is probabilistic and fails inconsistently per iteration.
</details><br>

<details>
<summary>34. State the hooks-vs-prompts decision framework.</summary>
Must be followed 100% of the time -> hooks (deterministic). Preferred but occasional deviation acceptable -> prompts (probabilistic). Money or legal risk from a single failure -> hook; formatting/style preference -> prompt.
</details><br>

<details>
<summary>35. Refunds above $500 require human approval - what is the correct mechanism?</summary>
A PreToolUse hook intercepting process_refund: check the amount, block above $500, route to human escalation. A prompt instruction works most of the time - and a single failure is a large unapproved refund.
</details><br>

<details>
<summary>36. Fixed sequential pipeline vs dynamic adaptive decomposition - when to use each?</summary>
Fixed pipeline (prompt chaining): predetermined steps, best for predictable structured tasks (code review, document extraction, compliance) - consistent, reliable, debuggable, but cannot adapt to findings. Dynamic decomposition: plan evolves from what's discovered, best for open-ended unknown-scope work (legacy exploration, security audits, debugging unfamiliar systems) - adaptable but less predictable.
</details><br>

<details>
<summary>37. Match the pattern: multi-file code review, and legacy codebase exploration.</summary>
Multi-file code review -> fixed pipeline (per-file analysis + cross-file integration is predictable). Legacy codebase exploration -> dynamic decomposition (dependencies and issues emerge during investigation). Match to task characteristics, not to what sounds more sophisticated.
</details><br>

<details>
<summary>38. What is attention dilution and how do you recognise it?</summary>
An agent processing too many items in one pass produces inconsistent depth: detailed on early items, shallow on later ones; the same pattern flagged in one item but approved in another; obvious bugs missed while minor nits are caught. The attention budget is spread thin across all items.
</details><br>

<details>
<summary>39. What does NOT fix attention dilution, and what does?</summary>
Does NOT fix it: a more powerful model, a larger context window, or better prompts (it's architectural, not a capability problem). Fix: multi-pass architecture - a per-item local pass for each item (full attention each) plus a cross-item integration pass for cross-cutting concerns.
</details><br>

<details>
<summary>40. Why is batching files into groups insufficient on its own?</summary>
Batching reduces dilution WITHIN a batch but misses cross-batch issues (data flow, pattern consistency). It still needs a dedicated cross-item integration pass across all items.
</details><br>

<details>
<summary>41. Name the three session-management options and what each is for.</summary>
--resume (restore full history - continuation when prior context is still valid); fork_session (independent branch from a shared baseline - divergent exploration of alternatives); fresh start + summary injection (new session with no prior tool results, seeded with a structured summary - for stale or degraded context).
</details><br>

<details>
<summary>42. What is the stale context problem, and why does simply resuming cause it?</summary>
Resuming restores the ENTIRE history including old tool results; if files changed since, the old file contents still sit in the conversation, so the agent reasons from outdated data and gives contradictory advice (e.g. recommending fixes already made).
</details><br>

<details>
<summary>43. After modifying files, why is "resume and ask it to re-read the changed files" not the best fix?</summary>
The stale tool results remain in history and can still influence reasoning, especially on tangential decisions. The reliable fix is a fresh session with a structured summary + targeted re-analysis of the changed files.
</details><br>

<details>
<summary>44. Only 3 of 50 files changed - how do you re-analyse efficiently?</summary>
Targeted re-analysis: fresh session, inject a summary of prior findings naming the 3 changed files, let the agent re-read only those, and combine with the preserved summary for the unchanged 47. Full re-exploration is wasteful.
</details><br>

<details>
<summary>45. Why can't fork_session fix stale context after file changes?</summary>
Fork branches from the existing session, so it inherits its stale tool results. Only a fresh start (with summary injection) actually drops the outdated data.
</details><br>

<details>
<summary>46. How do you create a named session, and how do you resume it?</summary>
Start it with --name / -n (e.g. `claude -n "auth-refactor"`), then resume by that name with `claude --resume auth-refactor`. The name is a display label shown in /resume and the terminal title (/rename changes it mid-session). It is --name, not --session-name.
</details><br>

<details>
<summary>47. What is the PRIMARY mechanism a model uses to select a tool?</summary>
The tool descriptions - not supplementary metadata. The model reads them to decide which tool to call, so minimal descriptions cause misrouting between tools with overlapping purposes.
</details><br>

<details>
<summary>48. Name the five elements of a production-grade tool description (and the five questions).</summary>
Purpose, inputs, examples, edge cases/limitations, boundaries. As questions: What does it do? What inputs does it accept? What queries suit it? What does it NOT handle? When should the other tool be used instead?
</details><br>

<details>
<summary>49. Two tools with minimal descriptions cause misrouting. What is the correct first fix, and why not the alternatives?</summary>
Expand the descriptions - low effort, high leverage, fixes the root cause. NOT few-shot examples (token overhead, treats the symptom), NOT a routing classifier (over-engineered, bypasses the LLM), NOT tool consolidation (valid long-term but more effort). The exam favours low-effort high-leverage first fixes.
</details><br>

<details>
<summary>50. After improving tool descriptions the model still misroutes - what subtle cause should you check?</summary>
The system prompt: keyword-sensitive instructions (e.g. "always check customer details first") can create unintended tool associations that override well-written descriptions. Always review the prompt for keyword conflicts after editing descriptions.
</details><br>

<details>
<summary>51. Name the four tool-error categories and whether each is retryable.</summary>
Transient (retryable, as-is), validation (retryable, after fixing the input), business (NOT retryable - escalate/alternative path), permission (NOT retryable - escalate or different credentials). isError signals failure; the category/retryable metadata tells the agent how to recover.
</details><br>

<details>
<summary>52. What does isRetryable actually promise, and how do transient vs validation differ despite both being retryable?</summary>
It answers only "is there any path to success through retrying" - not that the same request succeeds unchanged. Transient: retry as-is once the system recovers. Validation: retry only after self-correcting the input. Read isRetryable for "can a retry ever work", then errorCategory for how.
</details><br>

<details>
<summary>53. Access failure vs valid empty result - what's the difference and why does it matter?</summary>
Access failure = the tool couldn't reach the data source (timeout/auth/down) - an error, may warrant retry. Valid empty result = the query ran and found nothing - NOT an error, do not retry. Confusing them causes wasted retries and wrong escalations; make a successful-but-empty result look fundamentally different (isError:false, resultCount:0).
</details><br>

<details>
<summary>54. Is `isError` a standard MCP field? What about errorCategory / isRetryable / description?</summary>
isError is a standard tool-result field (with content and optional structuredContent). errorCategory/isRetryable/description are NOT spec top-level fields - they're an application-level convention (put them in structuredContent or the content text). Also: MCP separates JSON-RPC protocol errors (unknown tool, invalid args) from tool-execution errors (isError:true).
</details><br>

<details>
<summary>55. How should errors propagate in a multi-agent system?</summary>
Local recovery with selective propagation: subagents retry transient failures locally; propagate only what can't be resolved locally; include partial results and what was attempted. Avoid silently suppressing errors as empty success, and avoid killing the whole workflow on one failure.
</details><br>

<details>
<summary>56. How many tools should an agent have, and why?</summary>
About 4-5, scoped to its role. Selection reliability degrades as tools grow (more decision complexity, more errors), and tools outside an agent's specialisation get misused (e.g. a synthesis agent with web_search runs redundant searches). Give each agent only what its role needs.
</details><br>

<details>
<summary>57. When do you use tool_choice "any" vs forced (specific tool)?</summary>
"any" (must call some tool) when you need guaranteed structured output but the schema is unknown - e.g. multiple extraction schemas, one per tool, and the model picks. Forced (type:tool, name) to enforce a mandatory first step that can't be skipped or reordered; switch to "auto" for subsequent turns.
</details><br>

<details>
<summary>58. What is a scoped cross-role tool and when do you use it? (Q9)</summary>
A constrained version of another role's capability given directly to an agent, sized to the common case - e.g. a synthesis agent gets a scoped verify_fact for the ~85% simple lookups, while the ~15% complex verifications still route through the coordinator. It avoids coordinator round-trips (2-3 hops, up to 40% latency) for high-frequency simple operations.
</details><br>

<details>
<summary>59. Why prefer a constrained load_document over a generic fetch_url?</summary>
Least privilege: the constrained tool prevents misuse (can't fetch arbitrary URLs), makes its purpose clearer in the description, and reduces unintended side effects. Each tool should do exactly what the agent needs and nothing more.
</details><br>

<details>
<summary>60. Why does the coordinator have no domain-specific tools?</summary>
It controls the workflow (spawn subagents via Agent, review_output, request_revision) and delegates all domain work to specialists - matching the hub-and-spoke role split. Domain tools live on the specialist agents, scoped to their roles.
</details><br>

<details>
<summary>61. Does forced tool_choice (type:tool) guarantee exactly one tool call? What breaks if you assume so?</summary>
No - it guarantees the tool IS called, not that it's called once. Parallel tool use is on by default, so Claude may emit several tool_use blocks in one turn. If you answer only the first (e.g. with .find()), the API rejects the next turn because every tool_use id needs a matching tool_result in the immediately following user message. Fix: filter for ALL tool_use blocks and return ALL tool_result blocks in one user message (or set disable_parallel_tool_use: true for a single call).
</details><br>

<details>
<summary>62. Project-level .mcp.json vs user-level ~/.claude.json - what's the difference?</summary>
.mcp.json (project root) is version-controlled and shared with the team - for servers everyone needs (Jira, GitHub). ~/.claude.json is personal, not version-controlled, not shared - for experimental/personal servers. (Full picture: three scopes - local [default, ~/.claude.json, per-project private], project [.mcp.json, shared], user [~/.claude.json, all projects]; older names were project=local, global=user.)
</details><br>

<details>
<summary>63. How do you keep credentials out of version control while sharing .mcp.json?</summary>
Use ${VAR} environment-variable expansion in the env block (e.g. "${GITHUB_TOKEN}"). The committed file references variable names, not values; each developer sets their own tokens locally. Config is safe to commit, everyone uses their own credentials, and no secret enters repo history.
</details><br>

<details>
<summary>64. What are MCP resources for, and how do they differ from tools?</summary>
Resources expose content catalogs (issue lists, doc TOCs, database schemas) upfront, giving the agent visibility into available data without exploratory tool calls. Tools let the agent act on data. Resources = visibility, tools = action; together they cut wasted round-trips.
</details><br>

<details>
<summary>65. Build a custom MCP server or use a community one?</summary>
Evaluate community servers first for standard integrations (Jira, GitHub, Slack, Linear, Notion) - tested, maintained, no build burden. Build custom only for team-specific workflows, custom business logic, or proprietary systems with no community server.
</details><br>

<details>
<summary>66. Why might an agent ignore a capable MCP tool in favour of built-in Grep, and how do you fix it?</summary>
The MCP tool's description is sparse, so the model - which has richer context on built-ins - prefers the built-in. Fix by enhancing the MCP description: explain capabilities, outputs, and an explicit boundary ("use instead of Grep when searching by intent, not exact string").
</details><br>
