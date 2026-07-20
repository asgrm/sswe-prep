# Code Review Findings - review-target

## types.ts
- `Product.price` typed as `any`, defeating type safety across all pricing code (high) - recommend typing as `number`
- Raw credit card number stored on `Customer` (high, PCI concern) - recommend tokenizing via the payment provider instead of storing PANs
- `Order.status` is a free-form string (low) - recommend a string-literal union of valid statuses

## config.ts
- Live payment API key hardcoded and committed to source (critical) - recommend loading from env/secret manager and rotating the exposed key
- `runtime` exported as a mutable global with `debug: true` default (medium) - recommend a frozen config object with debug off by default
- `MAX_DISCOUNT_PERCENT` defined but never enforced anywhere (medium) - recommend applying it in the discount module
- `TAX_RATE` duplicated by a second constant in pricing.ts (low) - recommend a single source of truth

## logger.ts
- `audit` serializes entire entities, leaking sensitive fields such as credit cards into logs (critical) - recommend redacting/masking sensitive fields before logging
- `JSON.stringify` in `audit` throws on circular references (low) - recommend a safe serializer
- Loose equality check on the debug flag (low) - recommend a plain truthiness check
- `warn`/`error` write to stdout instead of stderr (low) - recommend `console.warn`/`console.error`

## money.ts
- All monetary math uses binary floating point on dollar amounts (high) - recommend integer cents or a decimal library
- `round` suffers classic float artifacts on half-cent values (medium) - recommend a rounding strategy on integer cents
- No guards against negative amounts (medium) - recommend validating inputs at module boundaries

## utils.ts
- `deepEqual` via JSON serialization is order-sensitive and mishandles undefined/Dates/cycles (high) - recommend a proper structural comparison
- `sortByPrice` mutates its input array while appearing pure (medium) - recommend sorting a copy
- `chunk` infinite-loops when size is zero or negative (medium) - recommend validating the size parameter
- `unique` is O(n^2) (low) - recommend using a Set
- `pluck` accepts `any[]` with an unchecked cast and has a logging side effect (low) - recommend proper generics and removing the side effect
- `isBlank` does not trim whitespace, inconsistent with `isNonEmpty` in validation.ts (low) - recommend trimming

## validation.ts
- `validateCustomer` non-null-asserts the optional email field, crashing on customers without one (high) - recommend handling absent email explicitly
- `isValidEmail` returns a match array instead of boolean and the regex accepts almost anything (medium) - recommend an anchored pattern returning a boolean
- Mixed failure modes: returns false for bad name but throws for bad email (medium) - recommend one consistent error contract

## customer.ts
- `saveCustomer` ignores the validation result, storing invalid customers (high) - recommend rejecting when validation fails
- Full customer record including credit card passed to audit logging (critical) - recommend masking or omitting sensitive fields
- `getCustomer` return type omits `undefined` for unknown ids (medium) - recommend `Customer | undefined`

## inventory.ts
- `reserve` has a read-await-write race causing lost updates and overselling (critical) - recommend an atomic check-and-decrement
- `reserve` crashes on unknown product ids (high) - recommend an existence check with a failure result
- `reserve` allows stock to go negative and always returns true (high) - recommend validating availability and returning real success/failure
- `lowStock` hardcodes threshold 5 and ignores the `reorderLevel` field (medium) - recommend using each product's reorder level

## pricing.ts
- Line totals multiply an `any`-typed price, silently producing NaN for bad data (high) - recommend fixing the type and validating inputs
- Local `TAX_RATE` constant duplicates config and is dead code (low) - recommend removing it
- `subtotal` accumulates unrounded floats across lines (medium) - recommend integer-cent math with a single final rounding
- Bulk discount boundary excludes exactly 10 units (low) - recommend confirming the intended threshold with the business rule

## tax.ts
- `calcTax` accepts a region parameter and silently ignores it, applying a flat rate everywhere (high) - recommend implementing region-based rates or removing the parameter
- Percent conversion round-trip is needlessly convoluted (low) - recommend multiplying by the rate directly

## discount.ts
- Coupon expiry check is inverted, so valid coupons never apply and expired ones would (critical) - recommend flipping the comparison
- Discounts computed from the original amount stack additively past 100 percent, producing negative totals (critical) - recommend compounding on the running total and clamping at zero
- `MAX_DISCOUNT_PERCENT` from config never enforced (high) - recommend capping the combined discount
- Coupon lookup is case-sensitive and fails for lowercase input (medium) - recommend normalizing case

## cart.ts
- `removeProduct` splices inside a forward loop, skipping adjacent duplicate lines (high) - recommend filtering or iterating backwards
- `addItem` does not merge lines for the same product (medium) - recommend merging quantities on add
- `setQuantity` accepts zero and negative quantities (medium) - recommend validating quantity
- `items` is publicly mutable and `snapshot` is only a shallow copy (low) - recommend encapsulating the array and deep-copying snapshots

## payment.ts
- Full card number and API key written to logs (critical) - recommend using the existing `maskCard` helper and never logging secrets
- Gateway failures return success from the catch block (critical) - recommend returning a failure result and propagating the error
- Payment reference generated with `Math.random` is predictable and collision-prone (medium) - recommend UUIDs
- Negative amounts pass the gateway; `isChargeableAmount` exists but is never called (high) - recommend validating amount before charging

## orders.ts
- `charge` is not awaited and the order is marked paid unconditionally (critical) - recommend awaiting the charge and setting status from its result
- Tax computed on the pre-discount subtotal, overcharging customers (high) - recommend taxing the discounted amount
- Stock reserved without availability check or rollback on failure (high) - recommend calling the existing fulfillment check and compensating on error
- Entire order including customer credit card logged (critical) - recommend logging a redacted summary
- Order records raw coupon list while discounts used the deduplicated one (low) - recommend storing what was actually applied
- Sequential in-memory order ids are predictable and reset on restart (medium) - recommend UUIDs or a persistent sequence

## index.ts
- Top-level `createOrder` promise not awaited; completion message prints before the order finishes and rejections are unhandled (high) - recommend awaiting inside an async entry point
- Coupon passed in lowercase never matches the case-sensitive catalog (medium) - recommend normalizing case at the boundary
- Order placed without any fulfillment pre-check against stock (medium) - recommend calling the fulfillment check before ordering

---

# Session Strategy Comparison: `--resume` vs Fresh + Summary

After the initial analysis above, `discount.ts`, `payment.ts` and `orders.ts` were modified to fix
their reported issues (14 issues across the three files). Both session strategies were then asked
about the current state of those three files.

| Metric | `--resume` (stale session) | Fresh session + injected summary |
|---|---|---|
| References old code | **Yes** - cited `payment.ts:10-12` as returning `{ ok: true }` from catch and `orders.ts:34-35` as an unawaited charge; neither exists on disk any more | **No** - every cited line number matches the current files |
| Recommends already-applied fixes | **Yes** - its "fix three things today" list (await the charge, return failure from catch, fix the discount pair) was entirely already done | **No** - correctly marked all 14 previously-reported issues as fixed |
| Advice consistent with disk state | **No** - all 6 claims about the modified files were false | **Yes** - verified fixes against actual code, with accurate caveats |
| Files analysed | Answered from cached context; would need to re-read all 15 files to self-correct | Only the 3 changed files (~80% less re-analysis) |
| Cross-file knowledge retained | Yes, but stale along with everything else | Yes, via the injected summary - flagged the unchanged `inventory.ts` race and the `cart.ts` line-merging issue without re-reading them |
| Finds new issues in changed files | No - reasoned over a snapshot that predates the changes | Yes - 1 medium (`canFulfill` does not aggregate duplicate cart lines) and several low (case-inconsistent `couponExists`, unused Luhn validator, pre-validation logging, dead zero-check, shared cart/order items array) |

## Conclusion

The resumed session was not merely unhelpful - it was **confidently wrong**, because its context
still contained the file contents from the original reads and nothing signalled that the disk had
changed underneath it. Stale context does not announce itself.

The fresh session with structured summary injection combined the best of both worlds: it inherited
the *conclusions* of the original analysis (including cross-file knowledge about unchanged files)
while reading the *current* code for everything it verified. Targeting only the 3 changed files
made re-analysis cheap without sacrificing accuracy.

**When to use which:**
- **`--resume`** - continuing work when the workspace has NOT materially changed since the session
  last saw it (picking up a conversation, asking follow-up questions about the same state).
- **Fresh + summary injection** - whenever files have changed since the session's tool results were
  captured. Summarise conclusions (never raw file contents), state the delta, and target the
  re-analysis at the changed files only.
- **`fork_session`** - divergent exploration from a known-good shared context: branch several
  what-if directions off the same analysis without polluting the original session.
