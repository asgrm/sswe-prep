# review-target - a code-review practice project (ANSWER KEY)

> ⚠️ **SPOILERS. Do NOT give this file to the reviewing agent.** It is the seeded-defect
> list, used to score how well a code-review agent/skill did. Point the agent at the
> `.ts` files only (e.g. "review the code in `review-target/`") and keep this file out
> of its context.

## What this is

`review-target/` is a deliberately flawed **TinyShop order backend** - 15 TypeScript
modules that import one another into a realistic dependency graph. Each file has planted
defects across four buckets:

- **Correctness bugs** - wrong behaviour / wrong results
- **Inefficiencies** - works, but wastefully
- **Code smells** - hard to maintain, confusing, or fragile
- **Bad practices / security** - patterns you should not ship

Severities are deliberately mixed: some defects are obvious (hardcoded secret, empty
catch), some are subtle (float money drift, inverted expiry check that silently disables
all coupons, tax computed on the pre-discount base). A good review finds the obvious ones
*and* at least several subtle ones, and traces cross-file interactions (e.g. the
never-awaited `charge` in `orders.ts` marking an order `paid` before payment resolves).

The code is intentionally *not* strict-typed: `review-target/tsconfig.json` sets
`strict: false` so that `any`, non-null assertions, and unchecked `undefined` compile -
which is itself a seeded bad practice. This project is excluded from the exercises' root
`npm run typecheck` (root `include` is top-level `*.ts` only), so it will not break the
real exercises.

## Note on dilution (why the files are large)

Each module contains a substantial amount of **genuinely correct, idiomatic helper code**
mixed in with the seeded defects, so the flaws are not the only thing in the file - a
reviewer has to separate signal from noise, which is the point. Implications for scoring:

- **The clean helpers are not defects.** Flagging one (e.g. `money.clampAmount`,
  `utils.groupBy`, `customer.listCustomers`, `inventory.catalog`, `cart.setQuantity`,
  `payment.maskCard`, `orders.canFulfill`) is a **false positive** and counts against the
  reviewer. Some are deliberately adjacent to a defect (e.g. `payment.maskCard` exists but
  `charge` still logs the full number; `cart.setQuantity`/`findLine` exist but `addItem`
  still duplicates lines) - noticing "the safe helper exists but the buggy path ignores it"
  is a *good* finding; calling the helper itself buggy is not.
- **The seeded-defect list below is unchanged and complete.** Diluting the files did not add
  or remove any defect. Anything not listed here is either clean filler or, if genuinely
  wrong, an unintended bug - report it to the author.

## How to use it

1. Ask your review agent/skill to review `review-target/` (all `.ts` files), reporting
   findings with file, line, severity, and category.
2. Score against the table below: count true positives, misses, and false positives.
3. The subtle/cross-file items are the interesting signal - anyone flags a hardcoded key.

## Dependency graph

```
types            (leaf; imported widely)
config           (leaf)
logger      -> config
money            (leaf)
utils       -> logger
validation  -> types, utils
customer    -> types, validation, logger
inventory   -> types, logger
pricing     -> types, money
tax         -> money, config
discount    -> money
cart        -> types, pricing
payment     -> types, config, logger
orders      -> cart, tax, discount, inventory, payment, money, utils, logger, types
index       -> inventory, customer, cart, orders, types
```

## Seeded defects by file

Approx. 50 planted issues. Line numbers drift if you edit; categories: **C**=correctness,
**E**=efficiency, **S**=smell, **B**=bad practice/security. "obv/subtle" = how hard to spot.

### types.ts
- **B, obv** - `Product.price: any` defeats type safety on the most numeric field in the app; propagates untyped into `money`/`pricing`.
- **S, subtle** - `Order.status: string` is stringly-typed; should be a union (`"pending" | "paid" | ...`).
- **S, subtle** - `Customer.email?` optional, but `validation`/`payment` treat it as required (`email!`).

### config.ts
- **B/security, obv** - `PAYMENT_API_KEY` is a hardcoded live secret in source.
- **B, subtle** - `export let runtime = {...}` is exported mutable global state; any module can flip `debug`/`currency`.
- **S, subtle** - `TAX_RATE` lives here but is *re-declared* in `pricing.ts` and imported by `tax.ts` inconsistently (DRY / drift risk).

### logger.ts
- **B, obv** - library module writes straight to `console.log`; not injectable/testable.
- **B, subtle** - `runtime.debug == true` (loose equality + redundant `== true`).
- **B/security, subtle** - `audit()` JSON-stringifies and logs entire entities, including customer email and credit-card number (PII/secret leakage).

### money.ts
- **C/S, subtle** - money modeled as floating-point `number`; `add`/`multiply` accumulate binary-float drift (classic "don't use float for currency").
- **C, subtle** - `round` uses `Math.round(x*100)/100`, which misrounds half-cent edges (e.g. `1.005`).
- **S, subtle** - `applyPercent`/`multiply` return unrounded floats; rounding is left to callers, who often forget (see `pricing.subtotal`).
- **S, subtle** - `format` uses `toFixed`, hiding upstream drift at display time.

### utils.ts
- **E, obv** - `unique()` is O(n^2) (`indexOf` in a loop); a `Set` is O(n).
- **C, subtle** - `deepEqual` via `JSON.stringify` is key-order sensitive and silently wrong for `undefined`/functions/`NaN`; also uses `==`.
- **C/S, subtle** - `sortByPrice` sorts the caller's array in place (`Array.sort` mutates) - a surprising side effect for a function that returns a value.
- **B, subtle** - `isBlank` uses `== undefined`/`== ""` (loose equality).
- **B, subtle** - `pluck` takes `any[]` + string key and logs on every call (untyped + noisy).

### validation.ts
- **C, subtle** - `isValidEmail` returns the `.match` result (an array or `null`), not a boolean, and the regex `/.+@.+/` accepts obviously-invalid addresses.
- **B/S, subtle** - inconsistent error contract: returns `false` for a blank name but *throws* for a bad email.
- **C, subtle** - `c.email!` non-null assertion on an optional field; crashes/NaN if email is absent.

### customer.ts
- **B, subtle** - module-level mutable `customers` map (shared global state, not injectable).
- **C/S, subtle** - `getCustomer` returns the internal object by reference (callers can mutate the store) and is typed `Customer` though it can return `undefined`.
- **C, subtle** - `saveCustomer` ignores `validateCustomer`'s return value, so an invalid (blank-name) customer is still saved.

### inventory.ts
- **C, obv/subtle** - `reserve` does read (`current`) -> `await` -> write (`current - qty`): a check-then-act race that oversells, and it can drive stock **negative** with no guard; it also **always returns `true`** even when it shouldn't.
- **C, subtle** - `stock[productId]` is dereferenced with no existence check (throws on unknown id).
- **S, subtle** - `lowStock` hardcodes `< 5` instead of using each product's `reorderLevel`.

### pricing.ts
- **S, obv** - local `const TAX_RATE = 0.2` duplicates `config.TAX_RATE`, is never used, and invites drift (dead + DRY).
- **S, subtle** - `bulkDiscount` boundary `quantity > 10` is ambiguous (is 10 "bulk"? off-by-one risk vs `>= 10`).
- **C/S, subtle** - `subtotal` accumulates unrounded floats and applies the discount without rounding.

### tax.ts
- **S/B, subtle** - `region` parameter is accepted but ignored: a misleading API implying regional tax that does not exist.
- **C, subtle** - float-based percentage math (inherits money.ts issues).

### discount.ts
- **C, subtle** - `isValid` comparison is inverted (`Date.now() > c.expires` treats *unexpired* coupons as invalid); with 2100 expiries, **every coupon is silently rejected** - discounts never apply.
- **C, subtle** - `find` matches `code` case-sensitively (`=== "SAVE10"`) while callers pass unnormalized input (see index's `"save10"`).
- **C, subtle** - `applyCoupons` subtracts `applyPercent(amount, ...)` off the *original* amount for each code and never clamps: stacking >100% would produce a **negative total** (masked today only because `isValid` is inverted).

### cart.ts
- **C, subtle** - `addItem` pushes a new line item every call instead of merging quantity for an existing product (index adds `laptop` twice -> two lines).
- **C, obv/subtle** - `removeProduct` splices during a forward index loop, so consecutive matches are skipped (mutation-during-iteration).

### payment.ts
- **B/security, obv** - logs the full credit-card number and the API key.
- **C, obv** - `catch` swallows the gateway error and returns `{ ok: true }` anyway - failed charges look successful.
- **C/S, subtle** - `reference: "ref_" + Math.random()` is a weak, collision-prone idempotency/reference id.
- **B, subtle** - `amount == 0` loose equality.

### orders.ts
- **C, obv/subtle** - `charge(customer, total)` is **not awaited**, then `order.status = "paid"` is set immediately: the order is marked paid before (or regardless of whether) payment settles. The floating promise is also unhandled.
- **C, subtle** - `calcTax(sub)` taxes the **pre-discount** subtotal, not the discounted amount (business-logic bug).
- **C, subtle** - `reserve(...)` return value ignored, so an oversell is not detected.
- **E, subtle** - reservations run sequentially in an `await` loop; independent reservations could run with `Promise.all`.
- **C/S, subtle** - `order.items = cart.items` aliases the cart's array, then `cart.items = []` mutates the caller's cart (surprising side effect + shared reference).
- **S, obv** - `createOrder` is a long function with mixed responsibilities (reserve + price + tax + discount + pay + mutate + log).
- **B, subtle** - `log("order created", order)` logs the whole order including customer PII.

### index.ts
- **C, subtle** - `createOrder(...)` is a floating promise: not awaited, no `.catch`; `console.log("done")` prints before it settles.
- **C, subtle** - coupon passed as `"save10"` (lowercase) never matches `"SAVE10"` (compounds discount.ts's case bug).
- **S, subtle** - hardcoded demo data and a real-looking card number in source.

## Cross-file interactions worth crediting a reviewer for

- **Payment never really succeeds/fails meaningfully:** `orders` doesn't await `charge`, and `charge` swallows errors and returns `ok:true` regardless - two independent defects that both hide payment failure.
- **Discounts are dead code in practice:** `discount.isValid` is inverted *and* `index` passes a lowercase code *and* `find` is case-sensitive - any one of the three would drop the discount; all three together make coupons provably no-ops.
- **Money drift end-to-end:** `money` (float) -> `pricing.subtotal` (unrounded) -> `orders.total` (rounded once at the end) means intermediate values are wrong before the single final round.
- **PII/secret leakage on two paths:** `customer.saveCustomer` -> `audit`, and `payment.charge` -> `log`, both emit sensitive data.
