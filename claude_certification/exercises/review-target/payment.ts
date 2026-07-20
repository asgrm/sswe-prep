import { randomUUID } from "node:crypto";
import { PaymentResult, Customer } from "./types";
import { log } from "./logger";

export async function charge(customer: Customer, amount: number): Promise<PaymentResult> {
  log("charging card " + maskCard(customer.creditCard), { amount });
  if (!isChargeableAmount(amount)) {
    return { ok: false, reference: "ref_invalid_amount" };
  }
  try {
    await gateway(amount);
    return { ok: true, reference: "ref_" + randomUUID() };
  } catch (e) {
    log("charge failed: " + (e instanceof Error ? e.message : String(e)), { amount });
    return { ok: false, reference: "ref_error" };
  }
}

async function gateway(amount: number): Promise<void> {
  if (amount == 0) {
    throw new Error("zero amount");
  }
  await new Promise((r) => setTimeout(r, 5));
}

/** Mask all but the last four digits of a card number for safe display. */
export function maskCard(cardNumber?: string): string {
  if (!cardNumber || cardNumber.length < 4) {
    return "****";
  }
  return "**** **** **** " + cardNumber.slice(-4);
}

/** True when an amount is a finite, positive number of dollars. */
export function isChargeableAmount(amount: number): boolean {
  return Number.isFinite(amount) && amount > 0;
}

/** Basic Luhn check for a card number (digits only). */
export function isValidCardNumber(cardNumber: string): boolean {
  const digits = cardNumber.replace(/\D/g, "");
  if (digits.length < 12) {
    return false;
  }
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (double) {
      d *= 2;
      if (d > 9) {
        d -= 9;
      }
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}
