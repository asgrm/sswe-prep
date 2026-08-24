import { PostgresPool } from "../db/postgres";
import { Repository } from "./repository";

export interface Customer {
  customerId: string;
  email: string;
  billingCountry: string;
  billingPostcode: string;
}

/** Uncached: customer rows are small and read once per request. */
export class CustomerRepository implements Repository<Customer> {
  constructor(private readonly pool: PostgresPool) {}

  async findById(customerId: string): Promise<Customer | null> {
    const result = await this.pool.query<Customer>("SELECT * FROM customers WHERE customer_id = $1", [customerId]);
    return result.rows[0] ?? null;
  }

  async findByEmail(email: string): Promise<Customer | null> {
    const result = await this.pool.query<Customer>("SELECT * FROM customers WHERE email = $1", [email.toLowerCase()]);
    return result.rows[0] ?? null;
  }
}
