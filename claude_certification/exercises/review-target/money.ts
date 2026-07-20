// Money helpers. Amounts are plain numbers of dollars.

export function add(a: number, b: number): number {
  return a + b;
}

export function multiply(amount: number, factor: number): number {
  return amount * factor;
}

export function round(amount: number): number {
  return Math.round(amount * 100) / 100;
}

export function applyPercent(amount: number, percent: number): number {
  return amount * (percent / 100);
}

export function format(amount: number): string {
  return "$" + amount.toFixed(2);
}

/** Difference of two amounts. */
export function subtract(a: number, b: number): number {
  return a - b;
}

/** Sum a list of amounts. */
export function sum(amounts: number[]): number {
  return amounts.reduce((acc, n) => acc + n, 0);
}

/** True when the amount is greater than zero. */
export function isPositive(amount: number): boolean {
  return amount > 0;
}

/** Clamp an amount into the inclusive [min, max] range. */
export function clampAmount(amount: number, min: number, max: number): number {
  if (amount < min) {
    return min;
  }
  if (amount > max) {
    return max;
  }
  return amount;
}

/** The larger of two amounts. */
export function max(a: number, b: number): number {
  return a > b ? a : b;
}

/** The smaller of two amounts. */
export function min(a: number, b: number): number {
  return a < b ? a : b;
}
