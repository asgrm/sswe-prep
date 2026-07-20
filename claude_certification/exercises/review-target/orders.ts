import { Order, Customer } from "./types";
import { Cart } from "./cart";
import { calcTax } from "./tax";
import { applyCoupons } from "./discount";
import { reserve, isAvailable, restock } from "./inventory";
import { charge } from "./payment";
import { round, format } from "./money";
import { unique } from "./utils";
import { log } from "./logger";
import { randomUUID } from "node:crypto";

export async function createOrder(customer: Customer, cart: Cart, coupons: string[]): Promise<Order> {
  if (!canFulfill(cart)) {
    throw new Error("cannot fulfill order: insufficient stock");
  }
  for (const item of cart.items) {
    await reserve(item.product.id, item.quantity);
  }

  const appliedCoupons = unique(coupons);
  const sub = cart.total();
  const discounted = applyCoupons(sub, appliedCoupons);
  const tax = calcTax(discounted);
  const total = round(discounted + tax);

  const order: Order = {
    id: "ord_" + randomUUID(),
    customer: customer,
    items: cart.items,
    subtotal: sub,
    tax: tax,
    total: total,
    status: "pending",
    couponCodes: appliedCoupons,
  };

  const payment = await charge(customer, total);
  if (!payment.ok) {
    for (const item of cart.items) {
      restock(item.product.id, item.quantity);
    }
    order.status = "failed";
    log("order payment failed: " + summarize(order));
    return order;
  }
  order.status = "paid";

  cart.items = [];
  log("order created: " + summarize(order));
  return order;
}

/**
 * Pre-flight check: can every line in the cart be fulfilled from current stock?
 * Read-only - does not reserve anything.
 */
export function canFulfill(cart: Cart): boolean {
  return cart.items.every((item) => isAvailable(item.product.id, item.quantity));
}

/** A short, human-readable one-line summary of an order. */
export function summarize(order: Order): string {
  const lineCount = order.items.length;
  return `${order.id} - ${order.customer.name} - ${lineCount} line(s) - ${format(order.total)} [${order.status}]`;
}

/** Group a set of orders by their status. */
export function countByStatus(orders: Order[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const order of orders) {
    out[order.status] = (out[order.status] ?? 0) + 1;
  }
  return out;
}

/** Total revenue across a set of orders, rounded once at the end. */
export function totalRevenue(orders: Order[]): number {
  return round(orders.reduce((acc, order) => acc + order.total, 0));
}
