# Project instructions

<!--
Step 4 artifact: in the real target repository this file lives at the repo
root (or .claude/CLAUDE.md). Claude Code reads CLAUDE.md in CI exactly as it
does interactively - it is the ONLY project context a `claude -p` invocation
gets beyond the prompt itself. Without it, CI-invoked test generation
produces generic boilerplate and review severity is arbitrary.
-->

## Testing Standards (CI Context)

- Use factory functions from `test/factories/` for data creation - never
  hand-build entity literals in tests.
- Integration tests use the test database via `test/setup/db.ts`.
- Do not test private implementation details; test observable behaviour.
- Test naming: `describe('<unit under test>')` / `it('should <behaviour> when <condition>')`.
- Coverage target: 80% branch coverage for new code.
- Available fixtures:
  - `test/fixtures/users.json`
  - `test/fixtures/orders.json`

## Review Criteria (CI Context)

Severity levels for review findings - use exactly these three values:

- **critical**: security issues, data loss risk, authentication bypass
- **major**: missing error handling, uncovered edge cases
- **minor**: naming conventions, style inconsistencies

Only report findings on lines changed in the pull request. One finding per
distinct issue; do not repeat the same issue for every occurrence in a file.
