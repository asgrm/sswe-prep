# Quick Recap

- **Tech debt definition**: shortcuts taken to ship faster that make future work harder. Like financial debt — accrues interest (maintenance cost, slow delivery, bugs)
- **Types**: intentional (conscious trade-off, documented) vs inadvertent (bad practices, outdated code nobody owns)
- **First action on encountering outdated code**: document it — add a comment, create a ticket. Don't refactor silently without a plan
- **Strangler fig pattern**: incrementally replace legacy code by building new implementation alongside old, routing traffic gradually. Never big-bang rewrites
- **ADR (Architecture Decision Record)**: document why a decision was made. Prevents future developers from re-debating settled decisions
- **Communicating debt to stakeholders**: frame as business risk ("this code costs us X extra hours per feature"). Attach estimated cost to each debt item
- **Tech debt backlog**: categorise by impact + effort. Fix high-impact, low-effort items first. Negotiate time for high-impact, high-effort items
- **Boy Scout Rule**: leave the code cleaner than you found it — small improvements on every pass, without large unrequested refactors

---

## Tech Debt

### Encountering Outdated Code

<details>
<summary>What to do when you encounter hard-to-understand legacy code</summary>

**Scenario:** you're working on a task and hit a module nobody has touched in 2 years. No tests, no documentation, unclear naming, complex logic.

**Step 1 — Document before anything else:**
Don't touch the code yet. First, write down what you understand.

```typescript
/**
 * TODO: [TECH-DEBT] This class manages order state transitions.
 * It was written in 2021 and has no tests. The state machine logic
 * is embedded in the if/else chain in processOrder().
 * Refactor plan tracked in ticket PLAT-456.
 *
 * Current understanding:
 * - process() accepts an order and routes to handler based on status
 * - Side effects: sends emails, updates audit log (hidden, not obvious from signature)
 */
```

Create a ticket for the refactor. Link it from the code comment.

**Step 2 — Add tests before changing anything:**
Write tests that describe the current behaviour (characterisation tests), even if the behaviour is wrong. These prevent accidental breakage while you work.

```typescript
// Characterisation test — describes what it currently DOES, not what it SHOULD do
it('returns "processed" when order status is pending and amount > 0', () => {
  const result = legacyProcessor.process({ status: 'pending', amount: 50 });
  expect(result).toBe('processed'); // we don't know if this is right — but it's current behaviour
});
```

**Step 3 — Assess severity before deciding action:**

| Impact | Effort | Action |
|---|---|---|
| High (frequently changed, blocks team) | Low | Fix now, in this PR or next sprint |
| High | High | Create a proposal, negotiate sprint time |
| Low | Low | Boy Scout rule — clean up while you're there |
| Low | High | Log it, don't prioritise |

**Step 4 — Communicate to the team:**
- Raise it in the next retrospective or team discussion.
- Don't silently fix architecture — get alignment before large refactors.
- Don't silently accept — write it down, make it visible.

**Step 5 — Decide: refactor or replace?**
- **Refactor** (improve incrementally): safe, low risk, keeps existing behaviour.
- **Rewrite** (replace entirely): tempting, almost always underestimated. Usually 3-5× the effort originally thought.
- **Strangler fig** (gradual replacement): best for large modules — build new alongside old, route traffic incrementally, retire old.

</details><br>

<details>
<summary>Strangler fig — incremental replacement of legacy code</summary>

**Why not big-bang rewrites:**
- Underestimated effort (legacy code has hidden edge cases).
- Long time with nothing to show → stakeholder pressure → shortcuts.
- All bugs appear at once at go-live.
- Team is blocked from shipping features during the rewrite.

**Strangler fig pattern:**
1. Build new implementation alongside the old one.
2. Route a subset of traffic/calls to the new implementation.
3. Validate new implementation with real traffic.
4. Gradually increase routing to new implementation.
5. Once new handles 100%, remove the old.

```typescript
// Feature flag controls routing — gradually switch over
async processOrder(orderId: string) {
  if (await this.featureFlags.isEnabled('new-order-processor', orderId)) {
    return this.newOrderProcessor.process(orderId);
  }
  return this.legacyOrderProcessor.process(orderId); // old path, still running
}
```

**Applied to a module level:**
```
Phase 1: New OrdersService created, handles only new orders (created after migration)
Phase 2: New service handles new orders + backfilled historical reads
Phase 3: All writes route to new service, old is read-only
Phase 4: Old service removed
```

**Advantages:**
- Each phase is a small, testable, reversible change.
- Old code is fallback — instant rollback by flipping flag.
- Team keeps shipping features while migration happens in parallel.

</details><br>

### Managing and Communicating Debt

<details>
<summary>Communicating tech debt to stakeholders</summary>

**The problem:** "we need to refactor X" is not compelling to a product manager. It sounds like developer housekeeping, not a business priority.

**Frame debt in business terms:**

| Bad framing | Good framing |
|---|---|
| "The code is messy and hard to read" | "Every new feature in the payments module takes 2× longer because of the tangled code — we're paying ~1 week/quarter in extra effort" |
| "We need to upgrade Node.js" | "Node.js 16 is end-of-life — we'll stop receiving security patches in 3 months. One unpatched CVE could mean a compliance incident." |
| "We have no tests" | "Without tests, every deploy is a risk. Last quarter, 3 of our 5 production incidents were regressions we would have caught with integration tests." |

**Create a tech debt backlog:**
- Each item: description, business impact (delay, risk, cost), effort estimate.
- Review quarterly — remove resolved items, add new discoveries.
- Prioritise by **impact × probability of causing a problem**.

**Negotiate time for debt:**
- "20% time" — one day per sprint for debt reduction and tooling.
- Bundle debt with feature work: "We can add this feature in 3 sprints; if we refactor the order service first (1 sprint), future features in that area will cost 30% less."
- Use incidents as moments — after a production issue caused by tech debt, the business is most receptive to investment.

</details><br>

<details>
<summary>Architecture Decision Records (ADRs)</summary>

**Problem:** six months from now, someone asks "why is this implemented this way?" Nobody knows. The original author has left. The team debates re-doing it the "right" way, not knowing a decision was already made and why.

**ADR — a short document capturing:**
1. What decision was made.
2. Why (the context and constraints at the time).
3. What alternatives were considered and why they were rejected.
4. What the consequences are.

**ADR template:**
```markdown
# ADR-012: Use outbox pattern for event publishing

**Status:** Accepted
**Date:** 2024-03-15
**Deciders:** Backend team

## Context
We need to guarantee that domain events are published to SNS when orders are created.
At-least-once delivery is required. The order creation and event publishing must be atomic.

## Decision
We use the transactional outbox pattern: write events to an `outbox` table in the same
DB transaction as the order. A poller reads and publishes unprocessed events.

## Alternatives considered
- **Dual write (write to DB + publish to SNS directly):** rejected — no atomicity guarantee.
  DB write succeeds, SNS fails → event lost.
- **SNS publish first, then DB write:** rejected — event can publish for an order that
  never commits.
- **Kafka with transactions:** rejected — we don't use Kafka; introduces new infrastructure.

## Consequences
- Events have at-least-once delivery → consumers must be idempotent.
- Adds an outbox table and a polling worker to maintain.
- Event latency is slightly higher (~5s) than direct publish.
```

**Store ADRs in the repo** (`docs/adr/ADR-012-outbox-pattern.md`). They live with the code they describe.

**When to write an ADR:**
- Any architectural decision that is hard to reverse.
- Any decision where the team discussed trade-offs before choosing.
- Any decision that will surprise a new developer ("why do we do it this way?").

</details><br>

<details>
<summary>Boy Scout Rule and sustainable code health</summary>

**Boy Scout Rule:** always leave the code a little cleaner than you found it.

Not a full refactor — small, safe improvements on every pass:
- Rename a confusing variable while you're reading the function.
- Extract a 3-line condition into a well-named boolean variable.
- Add a missing type annotation to a parameter you're editing.
- Delete a TODO comment for something that was already fixed.
- Add a missing test for a branch you noticed while writing related tests.

**Why it works:**
- Prevents code from drifting into "legacy" status — constant gentle maintenance.
- No approval needed for small clean-ups (vs large refactor proposals).
- Builds a culture of ownership — "this is our code, we care about it."

**Limits:**
- Boy Scout Rule ≠ unrequested refactors of files you're not changing.
- Don't rename half the codebase while fixing a bug — one PR, one concern.
- If the clean-up is large, create a separate ticket and PR.

**Sustainable quality practices:**
- **Linting enforced in CI** — no exceptions committed.
- **Tests required for new code** — covered by DoD.
- **Code review focused on maintainability**, not just correctness.
- **Regular retrospectives surface debt** — make it visible before it's painful.
- **Quarterly debt review** — review the debt backlog, reprioritise, commit to fixing top items.

</details><br>
