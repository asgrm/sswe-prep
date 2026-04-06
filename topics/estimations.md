# Quick Recap

- **Story points**: relative complexity, not time. Fibonacci scale (1, 2, 3, 5, 8, 13, 21). Calibrated to team velocity. Forces relative comparison, not time guessing
- **T-shirt sizing**: XS/S/M/L/XL. Fast, rough. Good for roadmap/backlog grooming when details are sparse
- **Planning poker**: everyone reveals estimate simultaneously to avoid anchoring bias. Discussion on disagreements reveals hidden complexity
- **3-point estimation (PERT)**: `(Optimistic + 4×Most Likely + Pessimistic) / 6`. Produces expected value with uncertainty modelled. Good for projects, not sprint tasks
- **Preliminary estimation**: no details yet → use analogies, spike/research tasks, give range not a single number, flag assumptions explicitly
- **Velocity**: team's average story points per sprint. Used to forecast delivery dates, not to pressure the team to go faster
- **Estimation anti-patterns**: estimating in hours (false precision), pressure to estimate lower, no discussion, ignoring unknowns, not accounting for review/testing/deploy time

---

## Estimations

### Techniques

<details>
<summary>Story points — relative estimation</summary>

**What story points measure:** relative complexity + effort + uncertainty. NOT hours.

**Fibonacci scale: 1, 2, 3, 5, 8, 13, 21**
- The gaps get bigger as complexity grows — reflects the increasing uncertainty with larger tasks.
- 1 = trivially small (change a label, fix a typo in config).
- 3 = small but involves a few components (add a new optional field to an API endpoint).
- 5 = medium (new CRUD endpoint with validation, service, and tests).
- 8 = complex (new feature touching multiple services, DB changes, integration).
- 13+ = too big — split before estimating. If you're estimating 13, you don't understand the task.

**How the team calibrates:**
- Pick one "reference story" the team agrees is a 3 (or 5). All future estimates are relative to it.
- "Is this harder or easier than the 3-pointer we did last sprint?"

**Velocity:** sum of story points completed per sprint (last 3–5 sprints, averaged). Used for forecasting:
```
Remaining backlog: 150 points
Team velocity: 30 points/sprint
Estimated sprints: 150 / 30 = 5 sprints
```

**Why NOT hours:**
- Everyone estimates hours differently (senior vs junior, morning vs end-of-day).
- Hours invite micromanagement: "you said 4 hours, it's been 6 hours."
- Points abstract away individual speed — the team's velocity is the stable unit.

</details><br>

<details>
<summary>Planning poker — eliminating anchoring bias</summary>

**The anchoring problem:** if one person says "I think this is a 5," everyone else anchors to that number. You lose diverse perspectives.

**Planning poker process:**
1. Product owner reads the user story.
2. Team asks clarifying questions.
3. **Everyone picks a card simultaneously** — no one reveals until all cards are down.
4. Cards revealed at the same time.
5. If estimates agree → done.
6. If disagree → the **highest and lowest** estimators explain their reasoning.
7. Repeat until convergence.

**The value is in the discussion**, not the number. If one person says 3 and another says 13, someone knows something the other doesn't — a hidden dependency, a technical risk, a missing requirement.

**Online tools:** PlanningPoker.com, Jira (built-in), Miro, Notion plugins.

**Physical cards:** 0, ½, 1, 2, 3, 5, 8, 13, 21, ?, ∞, ☕
- `?` — "I have no idea, need more info."
- `∞` — "This is way too big, needs splitting."
- `☕` — "I need a break."

</details><br>

<details>
<summary>3-point estimation (PERT) — modelling uncertainty</summary>

**Formula:**
```
Expected = (Optimistic + 4 × Most Likely + Pessimistic) / 6
Std Dev   = (Pessimistic - Optimistic) / 6
```

**Example — integrating a new payment provider:**
- Optimistic: 3 days (API is well-documented, no issues)
- Most Likely: 8 days (some integration quirks, normal testing)
- Pessimistic: 20 days (undocumented edge cases, sandbox issues, compliance review)

```
Expected = (3 + 4×8 + 20) / 6 = (3 + 32 + 20) / 6 = 55 / 6 ≈ 9.2 days
Std Dev  = (20 - 3) / 6 ≈ 2.8 days
```

Present as: **9–10 days (±3 days depending on API quality)**.

**When to use:** projects, not sprint tasks. When you need to commit to a delivery date with explicit uncertainty. When stakeholders need a range, not a point estimate.

**Key insight:** the pessimistic scenario drives the expected value more than most people intuitively expect. Don't ignore the tail risk.

</details><br>

### Estimating Under Uncertainty

<details>
<summary>Preliminary estimation — when you don't have enough details</summary>

**Situation:** stakeholder asks "how long will this feature take?" before requirements are defined, design is done, or technical details are known.

**Wrong approach:** give a number to avoid conflict. That number becomes a commitment.

**Right approach — do all of these:**

**1. State your assumptions explicitly:**
```
"Based on what I know now:
- Assuming the existing auth system handles this (no changes needed)
- Assuming no new DB tables required, only new columns
- Assuming no third-party integrations
→ My estimate is 2–3 sprints."
```

**2. Give a range, not a point:**
- Never say "2 weeks". Say "2–4 weeks, depending on API documentation quality."
- Ranges are honest. Point estimates imply false certainty.

**3. Suggest a spike/research task:**
- "I can't estimate the payment integration without looking at their API docs first."
- "Let's timebox a 2-day spike to investigate, then we'll estimate properly."
- A spike is a fixed-time research task that produces an estimate, not deliverable code.

**4. Use T-shirt sizing for early roadmap:**
- "New checkout flow — L. Refund feature — M. Email templates — S."
- Enough for roadmap prioritisation without committing to sprint-level precision.

**5. Reference analogies:**
- "We built something similar (order notifications) in 3 sprints. This feels comparable, maybe slightly bigger — I'd say 3–4 sprints."
- Past work is the best calibration data you have.

**The Three Amigos** (best practice for reducing uncertainty):
- Developer + QA + Product Owner review the story together before estimation.
- QA finds testing edge cases. Dev finds technical constraints. PO clarifies requirements.
- 30-minute conversation saves days of rework.

**Communicating uncertainty to stakeholders:**
```
"I can give you three scenarios:
- Best case (all assumptions hold): 6 weeks
- Most likely (some unknowns surface): 10 weeks
- Worst case (major technical risk materialises): 16 weeks

I recommend planning for 10 weeks, with a checkpoint at week 4."
```

</details><br>

<details>
<summary>Estimation anti-patterns — what to avoid</summary>

**Estimating in hours:**
- Creates false precision ("I said 4 hours, why did it take 6?").
- Enables micromanagement.
- Doesn't account for context-switching, code review, testing, deployment.
- **Fix:** use story points or days with explicit buffers.

**Pressure to estimate lower:**
- "Can't you do it in 1 sprint instead of 2?" — this inflates velocity, not productivity.
- Estimates made under pressure become commitments, then become missed deadlines.
- **Fix:** separate "when could it be done?" from "when do we want it done?". The first is a technical estimate. The second is a negotiation.

**Not accounting for the full scope:**
- Dev time only. Forgot: code review, testing, QA, bug fixes from review, deployment, documentation.
- Rule of thumb: multiply pure coding time by 1.5–2× to get total task time.

**No discussion = no shared understanding:**
- Estimating silently and averaging numbers misses the point.
- The disagreement IS the information.
- **Fix:** always discuss outliers in planning poker.

**Ignoring unknowns:**
- "I'll figure it out as I go" — unknowns get under-estimated.
- **Fix:** make unknowns explicit. "I don't know how X works yet" → spike task.

**Treating estimates as contracts:**
- Estimates are predictions under uncertainty, not promises.
- As you learn more, re-estimate. It's not failure — it's normal.

</details><br>
