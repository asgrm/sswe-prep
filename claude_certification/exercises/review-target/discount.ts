import { applyPercent } from "./money";
import { MAX_DISCOUNT_PERCENT } from "./config";

interface Coupon {
  code: string;
  percent: number;
  expires: number;
}

const COUPONS: Coupon[] = [
  { code: "SAVE10", percent: 10, expires: 4102444800000 },
  { code: "HALF", percent: 50, expires: 4102444800000 },
  { code: "MEGA", percent: 60, expires: 4102444800000 },
];

function find(code: string): Coupon | undefined {
  const normalized = code.toUpperCase();
  return COUPONS.find((c) => c.code === normalized);
}

export function isValid(c: Coupon): boolean {
  return Date.now() <= c.expires;
}

export function applyCoupons(amount: number, codes: string[]): number {
  let total = amount;
  for (const code of codes) {
    const c = find(code);
    if (c && isValid(c)) {
      total = total - applyPercent(total, c.percent);
    }
  }
  const minTotal = amount - applyPercent(amount, MAX_DISCOUNT_PERCENT);
  return Math.max(total, minTotal, 0);
}

/** Public, read-only view of the coupon catalog (copies). */
export function listCoupons(): Coupon[] {
  return COUPONS.map((c) => ({ ...c }));
}

/** Whether a coupon code is present in the catalog at all. */
export function couponExists(code: string): boolean {
  return COUPONS.some((c) => c.code === code);
}

/** The advertised percentage for a code, or 0 when unknown. */
export function advertisedPercent(code: string): number {
  const c = find(code);
  return c ? c.percent : 0;
}

/** Human-readable description for a coupon code. */
export function describe(code: string): string {
  const c = find(code);
  if (!c) {
    return `Unknown coupon: ${code}`;
  }
  return `${c.code}: ${c.percent}% off`;
}
