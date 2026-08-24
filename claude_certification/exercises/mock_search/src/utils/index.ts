// Barrel file: re-exports shared helpers for the order domain.
export { processLegacyOrder, processOrder } from "../legacyOrders";
export type { OrderOptions, OrderResult } from "../legacyOrders";

export function formatOrderId(raw: string): string {
  return raw.startsWith("ORD-") ? raw : `ORD-${raw}`;
}
