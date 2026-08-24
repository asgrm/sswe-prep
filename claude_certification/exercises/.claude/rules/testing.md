---
paths: ["**/*.test.ts", "**/*.test.tsx", "**/*.spec.ts"]
---

# Test Conventions

- Use describe/it blocks with descriptive sentence-style names
- Each test must cover at least one happy path and one error case
- Use factory functions for test data, not inline literals
- Mock external services at the module boundary
