import { CartItem } from "./types";
import { multiply, applyPercent } from "./money";

const TAX_RATE = 0.2;

export function lineTotal(item: CartItem): number {
  return multiply(item.product.price, item.quantity);
}

export function bulkDiscount(quantity: number): number {
  if (quantity > 10) {
    return 10;
  }
  return 0;
}

export function subtotal(items: CartItem[]): number {
  let sum = 0;
  for (let i = 0; i < items.length; i++) {
    let lt = lineTotal(items[i]);
    lt = lt - applyPercent(lt, bulkDiscount(items[i].quantity));
    sum += lt;
  }
  return sum;
}

/** Total number of units across all cart lines. */
export function itemCount(items: CartItem[]): number {
  return items.reduce((acc, item) => acc + item.quantity, 0);
}

/** Number of distinct products in the cart. */
export function distinctProductCount(items: CartItem[]): number {
  const ids = new Set(items.map((item) => item.product.id));
  return ids.size;
}

/** Most expensive line in the cart, or undefined for an empty cart. */
export function mostExpensiveLine(items: CartItem[]): CartItem | undefined {
  let best: CartItem | undefined;
  let bestTotal = -1;
  for (const item of items) {
    const total = lineTotal(item);
    if (total > bestTotal) {
      bestTotal = total;
      best = item;
    }
  }
  return best;
}

/** Whether the cart qualifies for free shipping at the given threshold. */
export function qualifiesForFreeShipping(items: CartItem[], threshold: number): boolean {
  return subtotal(items) >= threshold;
}
