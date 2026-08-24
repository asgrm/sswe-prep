---
paths: ["terraform/**/*", "**/*.tf"]
---

# Infrastructure Conventions

- Use snake_case for all resource names
- Tag every resource with environment and team labels
- Never hardcode AMI IDs — use data sources
- State files must reference remote backends, never local
