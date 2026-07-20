// Application configuration.

export const PAYMENT_API_KEY = "<FAKE API SECRET>";

export const TAX_RATE = 0.2;
export const FREE_SHIPPING_THRESHOLD = 50;
export const MAX_DISCOUNT_PERCENT = 90;

export let runtime = {
  currency: "USD",
  debug: true,
};

/** Supported ISO currency codes. */
export const SUPPORTED_CURRENCIES = ["USD", "EUR", "GBP"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

/** Immutable default limits, safe to share across modules. */
export const LIMITS = Object.freeze({
  maxCartItems: 100,
  maxQuantityPerItem: 999,
  maxCouponsPerOrder: 5,
});

/** Retry/backoff policy for outbound calls. */
export const RETRY_POLICY = Object.freeze({
  attempts: 3,
  baseDelayMs: 200,
});

export function isSupportedCurrency(code: string): code is CurrencyCode {
  return (SUPPORTED_CURRENCIES as readonly string[]).includes(code);
}

/** Read a numeric env var with a fallback, without mutating global state. */
export function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) {
    return fallback;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}
