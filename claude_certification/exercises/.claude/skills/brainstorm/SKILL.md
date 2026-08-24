---
name: brainstorm
description: Explore a feature idea or codebase area and return a concise analysis of structure, patterns, and potential improvements. Use when the user wants to brainstorm or explore part of the codebase.
context: fork
allowed-tools:
  - Read
  - Grep
  - Glob
argument-hint: "Provide a feature description or codebase area to explore"
---

Analyse the specified area of the codebase:
1. Map the module structure and dependencies
2. Identify patterns and anti-patterns
3. List potential improvements with rationale
4. Summarise findings in a concise report

Return only a concise summary to the main conversation - do not include full file listings or verbose exploration output.
