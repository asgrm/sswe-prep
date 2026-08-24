# 3_06 - CI/CD Pipeline with Claude Code (Task Statement 3.6)

A CI pipeline that uses Claude Code non-interactively to review pull requests:
structured findings, inline PR comments, project context via CLAUDE.md,
generation/review session isolation, and incremental review across runs.

Unlike the other exercises this one is not a runnable `.ts` script - the
artifacts are GitHub Actions workflows and shell scripts. To use them for
real, copy `workflows/*.yml` into a repo's `.github/workflows/` and add
`ANTHROPIC_API_KEY` as a repository secret.

## Layout

```
3_06-ci-cd-pipeline/
  CLAUDE.md                          step 4: CI-context project instructions
  workflows/
    step1-non-interactive.yml        step 1: claude -p
    step2-structured-output.yml      step 2: --output-format json + --json-schema
    step3-inline-comments.yml        step 3: jq -> gh api inline comments
    step5-session-isolation.yml      step 5: independent generate/review sessions
    step6-incremental-review.yml     step 6: full pipeline incl. incremental review
  scripts/
    findings-schema.json             JSON Schema for review findings
    post-inline-comments.sh          posts findings as inline PR comments
```

Each workflow builds on the previous one; `step6-incremental-review.yml` is
the complete reference implementation combining all six steps. Step 4 has no
workflow of its own - its artifact is `CLAUDE.md`.

## The six steps

1. **`-p` for non-interactive execution.** Plain `claude` starts an
   interactive session; in CI that hangs forever. `-p` (`--print`) processes
   the prompt, prints to stdout and exits.
2. **Structured output.** `--output-format json` plus `--json-schema '<schema>'`
   constrain the result to machine-parseable findings with `file`, `line`,
   `severity`, `message`. Human-readable text cannot be reliably parsed.
3. **Inline PR comments.** `jq` extracts each finding; `gh api
   repos/{owner}/{repo}/pulls/{pr}/comments` anchors it to the exact
   file + line (+ `commit_id`, `side=RIGHT`). Inline comments get read;
   PR-level walls of text get ignored.
4. **CLAUDE.md for CI.** Claude Code reads CLAUDE.md in CI exactly as in
   interactive mode. Document testing standards, factories/fixtures and
   severity criteria there, or CI-generated tests are generic boilerplate
   and severity assignment is arbitrary.
5. **Session isolation.** Every `claude -p` call is a fresh session; context
   is only shared if you pass `--continue` / `--resume`. Generate in one
   invocation, review in another - the generating session is biased toward
   justifying its own decisions.
6. **Incremental review.** Persist findings per PR (cache/artifact), feed
   them into the next run's prompt, and instruct: report only new or
   still-unaddressed issues. Otherwise every push re-posts the same
   comments and developers stop reading them.

## Exam memorisation items (Domain 3)

- `-p` / `--print`: non-interactive (print) mode - the most tested fact in
  Domain 3; Question 10 in the official sample questions.
- `CLAUDE_HEADLESS=true`: does NOT exist - exam distractor.
- `--batch`: does NOT exist - exam distractor.
- Batch API: up to 24 hours turnaround, no latency SLA - NOT suitable for
  pre-merge checks. Use synchronous `claude -p` in the CI job instead.
- CLAUDE.md is read in CI the same as interactively.
- Session isolation is the default; `--continue`/`--resume` opt into sharing.
