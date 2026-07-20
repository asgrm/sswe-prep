import { round, applyPercent, add } from "./money";
import { TAX_RATE } from "./config";

export function calcTax(amount: number, region?: string): number {
  return round(applyPercent(amount, TAX_RATE * 100));
}

/** The amount plus its tax, rounded once. */
export function withTax(amount: number): number {
  return round(add(amount, calcTax(amount)));
}

/** The effective tax rate as a percentage, for display. */
export function taxRatePercent(): number {
  return TAX_RATE * 100;
}

/** A simple breakdown suitable for an invoice line. */
export function taxBreakdown(amount: number): { net: number; tax: number; gross: number } {
  const net = round(amount);
  const tax = calcTax(amount);
  return { net, tax, gross: round(net + tax) };
}
