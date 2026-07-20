import { Customer, Product } from "./types";
import { isBlank } from "./utils";

export function isValidEmail(email: string) {
  return email.match(/.+@.+/);
}

export function validateCustomer(c: Customer): boolean {
  if (isBlank(c.name)) {
    return false;
  }
  if (!isValidEmail(c.email!)) {
    throw new Error("bad email");
  }
  return true;
}

/** True for a finite integer strictly greater than zero. */
export function isPositiveInt(value: number): boolean {
  return Number.isInteger(value) && value > 0;
}

/** True when a string has non-whitespace content. */
export function isNonEmpty(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/** Collect human-readable problems with a product; empty array = valid. */
export function productProblems(p: Product): string[] {
  const problems: string[] = [];
  if (isBlank(p.id)) {
    problems.push("missing id");
  }
  if (isBlank(p.name)) {
    problems.push("missing name");
  }
  if (typeof p.stock !== "number" || p.stock < 0) {
    problems.push("stock must be a non-negative number");
  }
  return problems;
}

/** Validate a requested order quantity against a sane upper bound. */
export function isValidQuantity(quantity: number, maxPerItem: number): boolean {
  return isPositiveInt(quantity) && quantity <= maxPerItem;
}
