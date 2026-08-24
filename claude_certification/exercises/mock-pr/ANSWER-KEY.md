# mock-pr - seeded 10-file mock PR (ANSWER KEY)

> SPOILERS. Do NOT give this file to the reviewing agent. It is the seeded-defect
> list used by exercise `4_06-multipass-confidence-routing.ts` to score review
> passes. Point reviewers at the `.ts` files only.

## What this is

A mock pull request for a small "TicketHub" order backend: 10 TypeScript files,
named `01_...` to `10_...` so their sorted order equals their position in the
review prompt (positional effects are the point of the exercise). Each file has
3 planted bugs, evenly distributed, mixed with genuinely correct helper code.
The blatant SQL injection sits in file 06 (middle of the review) to test
middle-of-review attention.

The exercise script (`4_06`) embeds this same list as `PLANTED_BUGS` for
machine scoring - keep the two in sync if you edit the fixture.

## Planted bugs (3 per file, 30 total)

### 01_http-client.ts
- `B01-no-status-check` - `getJson` parses the body without checking `response.ok`.
- `B01-swallowed-error` - `getJson`'s catch swallows all failures and returns `null`.
- `B01-retry-off-by-one` - `postJson` loops `attempt < maxAttempts`, so "up to 3 attempts" is actually 2.

### 02_validators.ts
- `B02-email-regex` - `/.+@.+/` has no anchors and accepts almost anything (spaces, multiple `@`).
- `B02-password-or` - password policy joins criteria with `||`, so any single criterion passes.
- `B02-age-always-true` - `age >= 18 || age <= 120` is true for every number.

### 03_users-repo.ts
- `B03-sql-injection` - `findByEmail`/`checkCredentials` interpolate `email` into SQL (same pattern as file 06).
- `B03-plaintext-password` - raw password compared to `password_hash` with `===`; no hashing.
- `B03-missing-empty-check` - `findByEmail` maps `rows[0]` without checking for an empty result.

### 04_sessions.ts
- `B04-weak-token` - session token from `Math.random()` (predictable, not crypto-safe).
- `B04-expiry-inverted` - `isValid` returns `expiresAt < Date.now()`: valid sessions rejected, expired accepted (same inverted-time pattern as file 07).
- `B04-session-leak` - expired sessions are never evicted from the map.

### 05_tickets-repo.ts
- `B05-loose-equality` - `findTicket` compares `ticket.id == ticketId` with coercion.
- `B05-pagination-off-by-one` - `slice(start, start + pageSize - 1)` drops the last item of every page.
- `B05-float-money` - order totals accumulated in binary floating-point dollars.

### 06_reports.ts (the planted middle-of-review injection)
- `B06-sql-injection` - `salesByRegion` concatenates a raw query-string value into SQL.
- `B06-sql-injection-dates` - `salesBetween` interpolates `from`/`to` into SQL.
- `B06-csv-unescaped` - `toCsv` joins values without quoting/escaping (commas, quotes, formula injection).

### 07_cache.ts
- `B07-ttl-inverted` - `get` returns entries whose `expiresAt` is in the PAST and drops fresh ones (same inverted-time pattern as file 04).
- `B07-unbounded` - the cache never evicts; unbounded memory growth.
- `B07-shared-reference` - values are stored and returned by reference; callers can mutate cached state.

### 08_notifications.ts
- `B08-null-deref` - `getJson` returns `null` on failure (see file 01), but `order.buyerEmail` is dereferenced without a check.
- `B08-unawaited-send` - `sendEmail` is not awaited: rejections escape the try/catch and nothing guarantees completion.
- `B08-html-injection` - `displayName`/`eventName` interpolated into HTML unescaped (XSS).

### 09_payments.ts
- `B09-hardcoded-secret` - live PSP API key committed in source.
- `B09-unit-mismatch` - `orderTotal` returns float DOLLARS but the value is sent as `amountCents` (cross-file with file 05).
- `B09-double-charge` - blind retry after a failed `postJson` can re-charge; no idempotency key.

### 10_audit.ts
- `B10-month-off-by-one` - `getMonth()` is 0-based; `dayOf` never adds 1.
- `B10-mutating-sort` - `sortedByTime` mutates the input array despite the doc comment claiming otherwise.
- `B10-unguarded-parse` - `parseEventLine` calls `JSON.parse` on external input with no error handling.

## Seeded cross-file issues (for the integration pass)

- **X1 data-flow**: file 05's `orderTotal` returns float dollars; file 09 assigns it to `amountCents` and the PSP is told it is cents.
- **X2 api-contract**: file 01's `getJson` returns `null` on any failure; file 08 dereferences the result without a null check.
- **X3 duplicate patterns (contradiction bait)**: the same pattern is planted twice so a single-pass review can flag it in one file and stay silent in the other:
  - SQL string interpolation: files 03 and 06.
  - Inverted time comparison: files 04 (session expiry) and 07 (cache TTL).

## Not defects (false positives if flagged)

`buildUrl`, `HttpError`, `isNonEmpty`, `sanitizeName`, `normalizeCountryCode`,
`mapRow`, `listUserEmails` (uses no user input), `touch`, `endSession`,
`eventNames`, `formatReportRow`, `makeKey`, `formatSubject`, `maskCard`,
`receiptLine` (correct GIVEN cents), `pad2`, `formatDuration`. The in-file `db`
stubs returning `[]` are stand-ins for a real driver, not bugs.
