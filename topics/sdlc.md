# Quick Recap

- **Functional requirements**: what the system does — features, user actions, data processing. Verifiable with tests ("the system must allow users to reset their password")
- **Non-functional requirements (NFR)**: how the system performs — performance, security, scalability, reliability, maintainability. Often called quality attributes
- **NFR examples**: response time < 200ms (p95), 99.9% uptime, supports 10,000 concurrent users, GDPR compliant, zero-trust security
- **Definition of Done (DoD)**: team-agreed criteria a task must meet before it's "done" — code reviewed, tests written, deployed to staging, documented
- **Acceptance criteria**: task-specific conditions. Written from user perspective. "Given X, when Y, then Z." The product owner agrees these define success for the ticket
- **SDLC models**: Waterfall (sequential, predictable), Agile/Scrum (iterative, adaptive), Kanban (flow-based, continuous), SAFe (scaled agile for large orgs)
- **Scrum ceremonies**: sprint planning, daily standup, sprint review, sprint retrospective, backlog grooming
- **User story format**: "As a [role], I want [capability], so that [benefit]." With acceptance criteria in Given/When/Then

---

## SDLC

### Requirements

<details>
<summary>Functional vs non-functional requirements</summary>

**Functional requirements — what the system does:**
- Describe specific behaviours, features, and functions.
- Can be tested with a yes/no answer: does it do X?
- Written from the user or business perspective.

Examples:
- Users can register with email and password.
- The system sends an email confirmation after registration.
- Admins can deactivate user accounts.
- The search returns results sorted by relevance.
- The system processes refund requests within 24 hours.

**Non-functional requirements (NFR) — how the system performs:**
- Describe quality attributes, constraints, and operational characteristics.
- Often called "ilities": scalability, reliability, maintainability, usability, security.
- Harder to test — require benchmarks, audits, monitoring.

Examples:
- **Performance**: API response time < 200ms at p95 under 500 concurrent users.
- **Availability**: 99.9% uptime (≤ 8.7 hours downtime/year).
- **Scalability**: system handles 10× traffic spike without configuration changes.
- **Security**: all PII encrypted at rest and in transit. OAuth 2.0 for authentication.
- **Compliance**: GDPR — user data deletable within 30 days of request.
- **Maintainability**: new developer can set up local environment in < 1 hour.
- **Observability**: all API errors logged with correlation ID, stack trace, and request context.

**Why NFRs get neglected and why they shouldn't:**
- NFRs don't map to visible features — stakeholders don't ask for them by name.
- But they determine whether the system actually works in production.
- A system that meets all functional requirements but has no observability, poor performance, or no authentication is not production-ready.
- **Senior engineers advocate for NFRs early** — retrofitting them is expensive.

**NFRs drive architecture decisions:**
- Need 99.99% uptime? → Multi-region, active-active.
- Need 10ms response time? → In-process cache, CDN, database optimisation.
- Need GDPR compliance? → Data residency, right to erasure, audit logs.
- Need zero-trust security? → Service mesh, mTLS, least-privilege IAM.

</details><br>

<details>
<summary>Definition of Done vs Acceptance Criteria</summary>

**Definition of Done (DoD) — applies to all tasks:**
A team-level agreement of what "done" means. Applied to every ticket regardless of its content.

Typical DoD checklist:
- [ ] Code reviewed and approved by at least 1 peer
- [ ] Unit tests written and passing
- [ ] Integration tests written if applicable
- [ ] Code coverage ≥ 80% for changed files
- [ ] No new lint errors
- [ ] Deployed to staging environment
- [ ] QA tested in staging
- [ ] No critical security vulnerabilities introduced
- [ ] Documentation updated (if API or public interface changed)

**Acceptance criteria (AC) — specific to one ticket:**
Conditions that define success for this particular user story. Written before development starts. Product owner (or QA) verifies them.

Format: **Given / When / Then** (Gherkin-style)
```
User story: As a user, I want to reset my password via email.

AC 1: Given I am on the login page,
      When I click "Forgot password" and enter a valid email,
      Then I receive a reset link within 60 seconds.

AC 2: Given I have received a reset link,
      When I click the link within 24 hours,
      Then I can set a new password.

AC 3: Given I have received a reset link,
      When I click the link after 24 hours,
      Then I see an "expired link" error and am offered a new link.

AC 4: Given a reset link has been used once,
      When I click it again,
      Then I see an "already used" error.
```

**DoD vs AC:**
- DoD = "is the code ready?" — engineering/process quality.
- AC = "does it do the right thing?" — business/product correctness.
- A task can pass AC but fail DoD (works but no tests written). Both must be met.

</details><br>

### SDLC Models

<details>
<summary>SDLC models — Waterfall, Agile, Kanban</summary>

**Waterfall:**
```
Requirements → Design → Development → Testing → Deployment → Maintenance
```
- Sequential — each phase complete before the next starts.
- **Strength:** predictable, good for fixed-scope projects with stable requirements (regulatory systems, hardware).
- **Weakness:** changes are expensive late in the cycle. Feedback comes only at the end.
- **When to use:** government contracts, compliance-heavy systems, embedded software with hardware dependencies.

**Agile/Scrum:**
- Iterative sprints (1–4 weeks). Deliver working software every sprint.
- Inspect and adapt. Requirements can change.
- Roles: Product Owner (prioritises backlog), Scrum Master (removes blockers), Dev Team (delivers).
- Ceremonies: **Sprint Planning** → **Daily Standup** → **Sprint Review** → **Retrospective** → repeat.

```
Backlog → Sprint Planning → Sprint (1-2 weeks) → Review → Retro → next Sprint
              ↑_______________________________________________|
```

**Scrum ceremonies (what each is for):**
- **Sprint Planning**: what do we commit to this sprint? Break stories into tasks.
- **Daily standup (15 min)**: what did I do yesterday? What will I do today? Any blockers?
- **Sprint review**: demo completed work to stakeholders. Get feedback.
- **Retrospective**: what went well? What didn't? What do we change? (team improvement)
- **Backlog grooming**: refine upcoming stories — add AC, estimate, remove outdated items.

**Kanban:**
- No sprints — continuous flow. Work items move through columns (To Do → In Progress → Review → Done).
- WIP (Work in Progress) limits prevent bottlenecks.
- **Strength:** flexible, good for support/ops teams, maintenance work, unpredictable demand.
- **Weakness:** less predictability for deadline-driven delivery.

**In practice:** most teams use Scrum for product development and Kanban for bug queues and ops work.

</details><br>

<details>
<summary>User stories and backlog management</summary>

**User story format:**
```
As a [type of user],
I want [a capability or action],
So that [a benefit or value].
```

Examples:
- "As a shopper, I want to save items to a wishlist, so that I can buy them later."
- "As an admin, I want to export user data as CSV, so that I can run reports in Excel."
- "As an API consumer, I want rate limit headers in responses, so that I know when I'm being throttled."

**INVEST criteria (good user story checklist):**
- **I**ndependent — can be built in any order.
- **N**egotiable — details can be discussed, not a rigid contract.
- **V**aluable — delivers value to user or business.
- **E**stimable — team can estimate it.
- **S**mall — fits in a sprint.
- **T**estable — has clear acceptance criteria.

**Backlog grooming (refinement):**
- Regular session (usually mid-sprint) where team reviews upcoming stories.
- Goals: add acceptance criteria, split large stories, estimate, re-prioritise.
- Stories should be "sprint-ready" (clearly defined, estimated) before sprint planning.

**Epic → Feature → User Story → Task hierarchy:**
```
Epic: User Account Management
  Feature: Password Management
    User Story: Reset password via email
      Task: Build /reset-password endpoint
      Task: Build email template
      Task: Write tests
```

**When a story is too big (splitting strategies):**
- Split by workflow step (step 1 → step 2 → step 3).
- Split by data type (handle type A first, type B in next story).
- Split by happy path vs edge cases (happy path first, error handling second).
- Split by role (regular user first, admin second).

</details><br>
