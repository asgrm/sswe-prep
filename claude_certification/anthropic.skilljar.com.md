# Claude Certification - Revision Notes

Condensed from anthropic.skilljar.com course notes. Corrections applied where the original notes were factually off (marked inline where relevant for the exam).

---

## 1. Claude Code Basics

### Keyboard & modes

| Action              | Effect                                                                                |
| ------------------- | ------------------------------------------------------------------------------------- |
| `Shift+Tab`         | Auto-accept mode - file edits applied without confirmation                            |
| `Shift+Tab` (twice) | Plan mode - Claude researches and produces a plan, not an implementation              |
| `Esc`               | Interrupt Claude                                                                      |
| `Esc` + `Esc`       | Rewind conversation to an earlier message (newer messages are discarded from context) |
| `#`                 | Memory shortcut - adds a note to CLAUDE.md                                            |
| `@`                 | Reference a file in the prompt (same syntax works inside .md files)                   |

### Extending thinking

- Use keywords in the prompt: `think` < `think more` < `ultrathink`, or the effort setting.
- **Higher effort = depth** (complex logic, debugging, algorithms).
- **Plan mode = breadth** (broad codebase understanding, multi-step / multi-file changes).

### Session commands

- `/init` - generates CLAUDE.md; recommended for projects with no .md docs. Can be re-run - it updates the existing CLAUDE.md.
- `/compact` - summarizes conversation history while preserving key learned context. Use when the conversation is long but its context is still valuable for related follow-up tasks.
- `/clear` - fresh conversation, empty context. Previous conversations remain accessible via `/resume`.

---

## 2. Custom Slash Commands

- Add a file `.claude/commands/<name>.md` - callable as `/<name>`. Include a one-line description of what Claude should do, plus the body. Restart Claude to pick it up.
- Arguments: place `$ARGUMENTS` in the command file; everything typed after the command name is substituted there.

```markdown
<!-- .claude/commands/write_tests.md -->

Write unit tests for: $ARGUMENTS
```

Usage: `/write_tests the use-auth.ts file in the hooks directory`

---

## 3. GitHub Integration

- Run `/install-github-app` to set up Claude for a GitHub project.
- In `claude.yml`: add env-preparation steps, optional `custom_instructions` (rules, preferred tools), optional `mcp_config`, and `allowed_tools`:

```yaml
allowed_tools: "Bash(npm:*),Bash(sqlite3:*),mcp__playwright__browser_snapshot,mcp__playwright__browser_click"
```

- **No wildcards for MCP tools** - if an MCP server exposes several tools, each one used must be listed explicitly (Bash patterns like `Bash(npm:*)` are the exception).

---

## 4. Hooks

- Hooks run commands **before** (`PreToolUse`) or **after** (`PostToolUse`) Claude uses a tool.
- **`PreToolUse` can block the tool call; `PostToolUse` cannot** - it runs follow-ups (e.g. format the file just edited) and can feed feedback back to Claude: write to **stderr** and exit with **code 2** (in Node: `console.error(...)` + `process.exit(2)`).
- Hook input arrives as JSON on **stdin**:

```js
const input = await new Promise((resolve) => {
  let data = "";
  process.stdin.on("data", (chunk) => (data += chunk));
  process.stdin.on("end", () => resolve(data));
});
const toolInput = JSON.parse(input).tool_input;
```

- Match multiple tools with one matcher; register multiple hooks per matcher:

```json
"PostToolUse": [
  {
    "matcher": "Write|Edit|MultiEdit",
    "hooks": [
      { "type": "command", "command": "jq -r '.tool_response.filePath // .tool_input.file_path // empty' | xargs -I {} npx --yes prettier --write {}" },
      { "type": "command", "command": "node $PWD/hooks/tsc.js" }
    ]
  }
]
```

- Each tool has its own input shape: `Read` -> `{"file_path"}`; `Grep` -> `{"pattern", "path"}` (path is a search _directory_); `Bash` -> `{"command"}`.
- Debug trick - log any hook's input to discover its shape: matcher `"*"` with command `jq . > post-log.json`.
- Group tools by capability when designing hooks: `Read`/`Grep` both access file contents; `Edit|MultiEdit|Write` are all formatting-trigger candidates.

---

## 5. Claude Agent SDK

- By default the SDK is effectively **read-only**. Grant more tools via `.claude` local settings or per-query options:

```js
query({ prompt, options: { allowedTools: ["Read", "Glob", "Edit"] } });
```

---

## 6. Skills

- `SKILL.md` frontmatter: `name`, `description`, plus optional `allowed-tools` (tool restriction; omitted = all available tools) and `model` (run on a non-default model).
- A good description answers **two questions**: (1) what Claude should do, (2) when to use the skill.
- A skill folder can contain `scripts/` (executables), `assets/` (images, templates, data files), `references/` (extra docs) - referenced from SKILL.md.
- Keep SKILL.md **under 500 lines**.

### Loading model (what enters context, when)

| Item                     | Loaded                                                                       |
| ------------------------ | ---------------------------------------------------------------------------- |
| CLAUDE.md                | Every conversation, always                                                   |
| Skill name + description | Always                                                                       |
| Skill body               | On demand - when invoked with `/` or when the description matches the prompt |
| Command                  | When `/command-name` appears in the prompt                                   |

### The extension-mechanism map

- **CLAUDE.md** - always-on project standards
- **Skills** - task-specific expertise, loads on demand
- **Hooks** - automated operations triggered by events
- **Subagents** - isolated execution contexts for delegated work
- **MCP servers** - external tools and integrations

Skills load into whichever context invoked them; subagents get their own isolated context.

### Troubleshooting

- Skill not listed -> run `claude --debug`, look for loading errors mentioning the skill name; run the skills validator first (catches structural problems).
- Skill doesn't trigger -> almost always the **description**.
- Skill fails during execution -> missing dependencies; missing execute permission (`chmod +x` scripts); path separators (use **forward slashes everywhere, even on Windows**).

---

## 7. Subagents

- Built-in subagents: **General purpose** (exploration + action), **Explore** (fast codebase search/navigation), **Plan** (research during plan mode).
- Create custom ones with `/agents`, stored as markdown files in `.claude/agents/`.

### Config frontmatter

```yaml
---
name: frontend-security-accessibility-reviewer
description: "Use this agent when you need to review frontend code for accessibility..."
tools: Bash, Glob, Grep, Read, WebFetch, WebSearch, Skill
model: sonnet # sonnet | opus | haiku | inherit
color: blue
skills: accessibility-audit, performance-check
---
```

- `name` is how you reference the subagent - either by asking Claude directly or by typing `@agent-<name>` in the prompt.
- `description` must be a single line (`\n` for breaks); can include example conversations. Including the word **"proactively"** makes Claude delegate without being asked.
- **Subagents don't share context with the main thread** and **don't see your skills automatically**: built-in agents can't access skills at all; custom subagents use only skills listed explicitly, loaded at subagent start (not on demand).

### Output format & tool limits

- Define a structured output format (Summary / Critical Issues / ...) - it gives natural stopping points and prevents overruns. Add an **"Obstacles Encountered"** section so the main agent doesn't have to rediscover setup issues, workarounds, and quirks.
- Least-privilege tool access: research agent -> `Glob, Grep, Read` only; code reviewer -> add `Bash` (for `git diff`) but no `Edit`/`Write`; only code-modification agents get `Edit`/`Write`.

### When to use / avoid

- **Core rule:** delegate only if you need just the final result, not the intermediate work. Keep it in the main thread if each step depends on the previous one.
- Good: research/exploration, fresh-eyes code review, tasks needing a custom system prompt (copywriting, styling).
- Anti-patterns: "expert" personas (adds nothing), sequential pipelines (context lost in handoffs), test runners (hides output needed for debugging - measured worst).

---

## 8. Plugins

- Plugins package Claude Code extensions for sharing across teams/projects. Create a `skills/` directory mirroring the `.claude` structure (one folder per skill with SKILL.md). Distribute via a marketplace; others install into their Claude Code.

---

## 9. MCP (Model Context Protocol)

- Add a server to Claude Code: `claude mcp add <name> <command>` (stdio) or `claude mcp add --transport http <name> <url>` (remote).
- **Inspector** is just a Node tool - run it against any server command:

```bash
mcp dev mcp_server.py                                        # FastMCP shortcut
npx @modelcontextprotocol/inspector node build/index.js       # Node
npx @modelcontextprotocol/inspector python mcp_server.py      # Python
npx @modelcontextprotocol/inspector ./my-mcp-server --flag v  # any binary + args
```

- **Client Session** = the actual connection to the server (MCP Python SDK concept).
- Full message list (request/result/notification types) lives in the spec repo: https://github.com/modelcontextprotocol/modelcontextprotocol (bottom of the TS schema file).
- Fun fact: typing into a running process's terminal writes to its **stdin**; what it prints back is **stdout** - which is exactly how stdio-transport MCP servers communicate.

### Stateless HTTP

When enabled: no session IDs (server can't track clients), no server-to-client requests (GET SSE pathway unavailable), **no sampling**, no progress reports, no subscriptions. Benefit: no initialization handshake required.

Use it when: horizontal scaling behind load balancers, no server-to-client communication needed, tools don't need sampling, minimal connection overhead.

`json_response=True` disables streaming for POST responses - no intermediate progress/log messages, just the final tool result as plain JSON.

---

## 10. Claude API Fundamentals

- **Minimum request requirements: API key, model name, messages, max_tokens.**
- Message roles: `user` and `assistant` (system prompt is a separate top-level field).
- `stop_reason` sits at the **root** of the assistant message (response object), not inside content.

### Temperature

- Modifies next-token probability: low temperature concentrates probability on the top token (predictable); high temperature flattens the distribution (random/creative).
- Range **0 to 1, default 1.0** (the original note said 0.5 - that's wrong).
- Suggested ranges: **0.0-0.3** factual/coding/extraction/moderation; **0.4-0.7** summarization, education, problem-solving, constrained creative; **0.8-1.0** brainstorming, creative writing, marketing, jokes.
- Note for current models: Opus 4.7+ / Sonnet 5 / Fable 5 removed `temperature` entirely (sending it returns 400) - steer with prompting instead.

### Extended thinking

- `budget_tokens` **minimum is 1024** (not a "default"), and it must be **less than `max_tokens`** - text output gets roughly `max_tokens - budget_tokens`.
- Incompatible with **message prefilling** and **temperature** changes.
- Note for current models: 4.6+ models use adaptive thinking (`thinking: {type: "adaptive"}`); `budget_tokens` is deprecated/removed there.

### Structured data via prefill + stop_sequences

Make Claude "think" it already started the answer, then cut generation at the closing fence:

````python
add_user_message(messages, "Generate a very short EventBridge rule as JSON")
add_assistant_message(messages, "```json")          # prefill
text = chat(messages, stop_sequences=["```"])       # stop at closing fence
# -> raw JSON, no markdown wrapper. Works for CSV, code, bulleted lists too.
````

Advanced variant - the prefill can steer not just the format but the _manner_ of the response (count, framing, "no comments"), because Claude continues from it as if it were its own words:

````python
add_user_message(messages, "Generate three different AWS CLI commands. Each should be very short")
add_assistant_message(messages, "Here are three commands with a single block with no additional comments: \n```bash")
text = chat(messages, stop_sequences=["```"])
# -> '\naws s3 ls\naws ec2 describe-instances\naws iam list-users\n'
````

Common recipe for Python/JSON/regex output: (1) end the prompt with "Respond only with X, no comments/explanation"; (2) prefill `"```code"` + stop sequence `"```"`.

- Note for current models: last-turn assistant prefill returns 400 on Opus 4.6+ / Sonnet 4.6+ / Fable 5 - structured outputs (`output_config.format`) replace it.

### Prompting specificity

Two approaches, often combined:

1. **Output guidelines** (use in almost every prompt): length, structure/format, required attributes, tone/style.
2. **Process steps** (for complex problems): troubleshooting, decision-making, critical thinking, multi-angle analysis.

Few-shot: use one-shot (1 example) or multi-shot (2+) input/output pairs in XML tags. Don't just give the pair - **explain why the output is good**. Cover edge cases with additional examples.

### Tool use

- Send `tool_result` back as an object inside the `content` array of a **user** message (multiple results allowed in one message):

```python
messages.append({
    "role": "user",
    "content": [{
        "type": "tool_result",
        "tool_use_id": tool_use_block.id,   # id of the tool_use block in the response
        "content": tool_result_var,
        "is_error": False
    }]
})
```

- Once tools were used, **all follow-up requests must keep the same `tools` schema**, even if no further tool call is expected.

### Fine-grained tool streaming

- Generally available - set `eager_input_streaming: true` on the tool definition (no beta header).
- Trade-off: Claude may stream invalid JSON (e.g. `"word_count": undefined`), so parse defensively:

```python
try:
    parsed_args = json.loads(chunk.snapshot)
except json.JSONDecodeError:
    pass  # handle invalid partial JSON
```

Without it, API-side validation catches such errors and may wrap problematic values in strings.

### Sending documents and images

```python
with open("./earth.pdf", "rb") as f:
    file_bytes = base64.standard_b64encode(f.read()).decode("utf-8")

content = [{
    "type": "document",              # "image" for images
    "source": {
        "type": "base64",
        "media_type": "application/pdf",
        "data": file_bytes,
    },
}]
```

### Prompt caching

- Up to **4 cache breakpoints** per request.
- Minimum cacheable prefix is ~**1024 tokens** (model-dependent; some models require more) - shorter prefixes silently don't cache.
- **Automatic caching**: pass top-level `cache_control={"type": "ephemeral"}` on the **`messages.create()` request** (not on client initialization, as the original note said) - it caches the last cacheable block.
- Caching is a **prefix match**: everything up to the last breakpoint is cached, and _any_ change earlier in the prefix (tools, system prompt, or messages - rendered in that order) invalidates the cache from that point on.
- Default TTL is 5 minutes; reads cost ~0.1x, writes ~1.25x base input price.

### Code execution tool

- Server-side, runs in an isolated sandboxed container with **no network access**.

---

## 11. Embeddings & Search

- Embedding values range roughly **-1 to 1**; each dimension represents a score in some latent "area".
- Normalize vectors to magnitude 1.0 before storing; same pipeline for queries: request -> embedding -> normalization -> vector search. **Most embedding APIs already return normalized vectors.**
- **BM25** (lexical) excels at exact matches: weights rare/specific terms higher, ignores common words, works on term frequency not meaning - great for technical terms, IDs, exact phrases.
- **Hybrid search**: semantic search handles concepts/meaning; BM25 guarantees exact-term hits. Combining both handles conceptual queries and specific lookups.

---

## 12. Agent Design Patterns

### Parallelization

Use when the task considers multiple criteria, compares options, or spans different domains of expertise. Key test: each parallel sub-task must operate **independently** and contribute a distinct piece of analysis.

### Chaining

Use when: complex tasks with many requirements; Claude keeps ignoring constraints in long prompts; you need to process/validate outputs between steps; you want each interaction focused. Often beats cramming everything into one prompt.

### Feedback loops

Always ask: **"How will Claude know if this action worked?"** Provide observability: read files before modifying, screenshot after UI interactions, check API responses, validate generated content against requirements.

### Workflows vs agents

**Prefer workflows wherever possible; use agents only when truly required.** Workflows give the reliability and predictability production needs; agents add flexibility only when exact requirements can't be predetermined.
