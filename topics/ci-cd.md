# Quick Recap

- **CI (Continuous Integration)**: automatically build, test, and validate every code change merged into the shared branch. Goal: catch problems early, keep the main branch always working
- **CD (Continuous Delivery)**: every passing build is automatically deployable to production. Deploy is one click or fully automated
- **Why CI/CD**: eliminates "works on my machine", reduces integration pain, enforces quality gates, enables fast and safe releases, reduces manual toil
- **CI pipeline contents**: lint → typecheck → unit tests → build → integration tests → security scan → publish artefact
- **Fail fast**: order steps cheapest-first. Lint fails in 5s, saving the 5-min test run for code that passes basic checks
- **Artefacts**: Docker image, ZIP bundle, npm package. Built once, deployed many times (same artefact to staging and production)
- **CD strategies**: blue/green (two environments, swap traffic), canary (gradual rollout to % of users), rolling (replace instances one by one)
- **Feature flags**: decouple deploy from release. Code ships dark (disabled), enabled per user/segment when ready
- **Rollback**: keep previous artefact/image tag. Switch traffic back in seconds. DB migrations must be backwards-compatible

---

## CI/CD

### Why CI/CD

<details>
<summary>Why we need CI/CD — the real reasons</summary>

**Problem without CI/CD:**
- Developers work on branches for days/weeks. Merging becomes painful ("integration hell").
- "Works on my machine" — inconsistent environments, hidden dependencies.
- Manual testing before every release — slow, error-prone, blocks deploys.
- Releases are rare (monthly/quarterly) and high-risk — big batches of changes.

**CI solves integration pain:**
- Every PR triggers a pipeline: lint, test, build, scan.
- Problems caught when the change is fresh in the developer's head — cheap to fix.
- Main branch is always in a working state.
- "Shift left" — move quality checks earlier in the process.

**CD solves release risk:**
- Small, frequent releases are safer than large, rare ones.
- If a bug ships, it's in a small change set — easy to identify and revert.
- Teams can release multiple times per day.

**Business value:**
- Faster time-to-market — features reach users in hours, not weeks.
- Higher confidence — changes are automatically validated.
- Less toil — no manual release scripts, no "who has the deploy credentials".
- Better developer experience — short feedback loop, no integration surprises.

</details><br>

<details>
<summary>What should be in a CI pipeline</summary>

**Order matters — fail fast on cheapest checks first:**

```
Push / PR opened
    ↓
1. Install dependencies    (pnpm install --frozen-lockfile)
    ↓
2. Lint                    (ESLint, Prettier --check)        ~5–15s
    ↓
3. Type check              (tsc --noEmit)                    ~10–30s
    ↓
4. Unit tests              (jest --ci --forceExit)           ~30s–2min
    ↓
5. Build                   (tsc / webpack / esbuild)         ~1–3min
    ↓
6. Integration tests       (jest with real DB via Docker)    ~2–5min
    ↓
7. Security scan           (npm audit, Snyk, Trivy for image)
    ↓
8. Build Docker image      (docker build)
    ↓
9. Push artefact           (ECR, npm registry, S3)
    ↓
10. (CD) Deploy to staging  → smoke test → deploy to prod
```

**Each step explained:**

**Lint:** catches style violations, unused variables, import order, forbidden patterns. Prevents code review noise.

**Type check:** `tsc --noEmit` catches type errors that tests might not catch. Fails before running tests if types are broken.

**Unit tests:** fast, no infra needed. Catch regressions in business logic. Must always pass before merging.

**Build:** verify the code compiles to a deployable artefact. Catches import errors, missing modules.

**Integration tests:** test service + DB, HTTP-level tests. Slower — run in Docker Compose or against a test environment.

**Security scan:** `npm audit` for known CVEs in dependencies. Container image scan for OS vulnerabilities. Add SAST (static analysis) for serious systems.

**Build image:** `docker build` — creates the deployable image. Tag with git commit SHA for traceability.

**GitHub Actions example (monorepo, single workspace):**
```yaml
name: CI

on:
  pull_request:
    paths:
      - 'workspaces/orders-service/**'

jobs:
  ci:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: pnpm/action-setup@v3
        with: { version: 9 }

      - uses: actions/setup-node@v4
        with: { node-version: '20', cache: 'pnpm' }

      - run: pnpm install --frozen-lockfile

      - run: pnpm --filter orders-service run lint
      - run: pnpm --filter orders-service run typecheck
      - run: pnpm --filter orders-service run test -- --ci --forceExit
      - run: pnpm --filter orders-service run build
```

**Quality gates (PR merge requirements):**
- All CI steps green.
- Code coverage above threshold (e.g. 80%).
- No new high/critical security vulnerabilities.
- At least 1 code review approval.

</details><br>

### Deployment Strategies

<details>
<summary>CD strategies — blue/green, canary, rolling</summary>

**Blue/Green deployment:**
```
Current:  Blue (v1) ← 100% traffic
          Green (v2) — deploy here, run smoke tests

Switch:   Blue (v1) ← 0% traffic
          Green (v2) ← 100% traffic

Rollback: swap back to Blue instantly
```
- Zero downtime. Instant rollback (just re-point the load balancer).
- Requires 2× infrastructure.
- Good for: critical services, when rollback speed matters.

**Canary release:**
```
v1 ← 95% traffic
v2 ←  5% traffic  (monitor errors, latency)
      ↓ metrics healthy?
v2 ← 20% → 50% → 100% traffic
v1 decommissioned
```
- Gradual rollout. Real traffic validates the new version.
- Catch issues before they affect all users.
- Good for: feature changes, performance-sensitive endpoints, large user bases.

**Rolling deployment:**
```
[v1][v1][v1][v1]  →  [v2][v1][v1][v1]  →  [v2][v2][v1][v1]  →  [v2][v2][v2][v2]
```
- Replace instances one by one. Both versions run simultaneously during rollout.
- Low resource overhead (no double infra).
- Risk: database schema must be backwards-compatible (old and new code run together).
- Good for: Kubernetes deployments (default strategy), ECS services.

**Feature flags — decouple deploy from release:**
```typescript
// Ship dark — code deployed but disabled
if (featureFlags.isEnabled('new-checkout-flow', userId)) {
  return this.newCheckoutService.process(cart);
} else {
  return this.oldCheckoutService.process(cart);
}
```
- Deploy anytime, enable for specific users/segments.
- Kill switch — disable instantly without redeployment.
- Tools: LaunchDarkly, AWS AppConfig, Unleash, simple DB/Redis flag.

**Database migrations in CD:**
- Migrations must be **backwards-compatible** during rolling/canary deploys.
- Expand/contract pattern: add column (nullable) → deploy new code that writes to it → backfill → make required → deploy removal of old column.
- Never rename or drop a column in the same deploy as the code that removes its usage.

</details><br>
