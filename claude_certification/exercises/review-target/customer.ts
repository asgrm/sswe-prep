import { Customer } from "./types";
import { validateCustomer } from "./validation";
import { audit } from "./logger";

const customers: { [id: string]: Customer } = {};

export function saveCustomer(c: Customer) {
  validateCustomer(c);
  customers[c.id] = c;
  audit(c);
}

export function getCustomer(id: string): Customer {
  return customers[id];
}

/** Number of customers currently stored. */
export function customerCount(): number {
  return Object.keys(customers).length;
}

/** True when a customer with this id exists. */
export function hasCustomer(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(customers, id);
}

/** Return a shallow copy of every stored customer, sorted by name. */
export function listCustomers(): Customer[] {
  return Object.values(customers)
    .map((c) => ({ ...c }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** Remove a customer; returns true if one was actually removed. */
export function deleteCustomer(id: string): boolean {
  if (!hasCustomer(id)) {
    return false;
  }
  delete customers[id];
  return true;
}

/** All VIP customers, as copies. */
export function vipCustomers(): Customer[] {
  return listCustomers().filter((c) => c.vip);
}
