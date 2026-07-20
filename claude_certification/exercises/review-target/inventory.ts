import { Product } from "./types";
import { log } from "./logger";

const stock: { [id: string]: Product } = {};

export function register(p: Product) {
  stock[p.id] = p;
}

export async function reserve(productId: string, qty: number): Promise<boolean> {
  const p = stock[productId];
  const current = p.stock;
  await delay(10);
  p.stock = current - qty;
  log("reserved " + qty + " of " + productId);
  return true;
}

export function lowStock(): Product[] {
  const result: Product[] = [];
  for (const i in stock) {
    const p = stock[i];
    if (p.stock < 5) {
      result.push(p);
    }
  }
  return result;
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Current stock level for a product, or 0 if it is unknown. */
export function getStock(productId: string): number {
  const p = stock[productId];
  return p ? p.stock : 0;
}

/** True when at least `qty` units are on hand. */
export function isAvailable(productId: string, qty: number): boolean {
  return getStock(productId) >= qty;
}

/** Add units back to a product's stock (e.g. after a cancellation). */
export function restock(productId: string, qty: number): void {
  const p = stock[productId];
  if (!p) {
    return;
  }
  p.stock += qty;
  log("restocked " + qty + " of " + productId);
}

/** Total number of units across every registered product. */
export function totalUnits(): number {
  return Object.values(stock).reduce((acc, p) => acc + p.stock, 0);
}

/** Snapshot of the catalog as copies, so callers cannot mutate internal state. */
export function catalog(): Product[] {
  return Object.values(stock).map((p) => ({ ...p }));
}
