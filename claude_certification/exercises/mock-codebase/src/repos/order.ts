import { PostgresPool } from "../db/postgres";
import { QueryCache } from "../lib/query-cache";
import { Repository } from "./repository";

export type OrderStatus = "pending" | "paid" | "shipped" | "refunded" | "cancelled";

export interface OrderItem {
  sku: string;
  description: string;
  quantityOrdered: number;
  unitPriceCents: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  status: OrderStatus;
  totalCents: number;
  chargeId: string;
  placedAt: string;
}

export interface OrderWithItems extends Order {
  items: OrderItem[];
}

export class OrderRepository implements Repository<Order> {
  constructor(
    private readonly pool: PostgresPool,
    private readonly cache: QueryCache,
  ) {}

  /** Cached read path. Cache key is `order:<orderId>`. */
  async findById(orderId: string): Promise<Order | null> {
    const cacheKey = `order:${orderId}`;
    const cached = this.cache.get<Order>(cacheKey);
    if (cached) return cached;

    const result = await this.pool.query<Order>("SELECT * FROM orders WHERE order_id = $1", [orderId]);
    const order = result.rows[0] ?? null;
    if (order) this.cache.set(cacheKey, order);
    return order;
  }

  /** Second cached read path, keyed `order:<orderId>:items`. */
  async findWithItems(orderId: string): Promise<OrderWithItems | null> {
    const cacheKey = `order:${orderId}:items`;
    const cached = this.cache.get<OrderWithItems>(cacheKey);
    if (cached) return cached;

    const order = await this.findById(orderId);
    if (!order) return null;
    const items = await this.pool.query<OrderItem>(
      "SELECT sku, description, quantity_ordered, unit_price_cents FROM order_items WHERE order_id = $1",
      [orderId],
    );
    const withItems: OrderWithItems = { ...order, items: items.rows };
    this.cache.set(cacheKey, withItems);
    return withItems;
  }

  /** Write path. Every status transition in the system goes through here. */
  async updateStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.pool.query("UPDATE orders SET status = $2 WHERE order_id = $1", [orderId, status]);
  }

  async findByCustomer(customerId: string): Promise<Order[]> {
    const result = await this.pool.query<Order>("SELECT * FROM orders WHERE customer_id = $1", [customerId]);
    return result.rows;
  }
}
