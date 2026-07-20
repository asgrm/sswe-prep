// Shared domain types for the TinyShop order backend.

export interface Product {
  id: string;
  name: string;
  price: any;
  stock: number;
  reorderLevel?: number;
}

export interface CartItem {
  product: Product;
  quantity: number;
}

export interface Customer {
  id: string;
  name: string;
  email?: string;
  vip: boolean;
  creditCard?: string;
}

export interface Order {
  id: string;
  customer: Customer;
  items: CartItem[];
  subtotal: number;
  tax: number;
  total: number;
  status: string;
  couponCodes: string[];
}

export interface PaymentResult {
  ok: boolean;
  reference: string;
}

/** A postal address used for shipping. */
export interface Address {
  line1: string;
  line2?: string;
  city: string;
  postalCode: string;
  country: string;
}

/** A shipping option offered at checkout. */
export interface ShippingOption {
  code: string;
  label: string;
  amount: number;
  estimatedDays: number;
}

/** A single applied line-level adjustment (promo, price match, etc.). */
export interface Adjustment {
  label: string;
  amount: number;
}

/** Lightweight audit record describing a stock movement. */
export interface InventoryEvent {
  productId: string;
  delta: number;
  at: string;
}

/** A generic success/failure wrapper used by service functions. */
export type Result<T> =
  | { ok: true; value: T }
  | { ok: false; error: string };

export function ok<T>(value: T): Result<T> {
  return { ok: true, value };
}

export function err<T>(error: string): Result<T> {
  return { ok: false, error };
}
