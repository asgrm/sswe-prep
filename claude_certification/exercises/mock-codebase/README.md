# shop-orders

Order and refund service for the storefront. Node + TypeScript, PostgreSQL,
three external providers.

```
npm install
npm run test          # jest
npm run coverage      # writes coverage/coverage-summary.json
npm run start         # boots the HTTP layer on :8080
```

Environment: `DATABASE_URL`, `STRIPE_API_KEY`, `AVALARA_API_KEY`,
`SENDGRID_API_KEY`.

Ownership is split across two teams (orders and payments) and the wiring has
not been documented since the v2 refactor - read the source.
