import { TaxClient } from "../gateways/tax";
import { Order, OrderRepository, OrderStatus, OrderWithItems } from "../repos/order";

export class OrderNotFoundError extends Error {
  constructor(readonly orderId: string) {
    super(`Order ${orderId} not found`);
  }
}

/**
 * Order domain logic. Owns every status transition and the tax recalculation
 * that follows one.
 */
export class OrderService {
  constructor(
    private readonly orders: OrderRepository,
    private readonly tax: TaxClient,
  ) {}

  async getOrder(orderId: string): Promise<Order> {
    const order = await this.orders.findById(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  async getOrderWithItems(orderId: string): Promise<OrderWithItems> {
    const order = await this.orders.findWithItems(orderId);
    if (!order) throw new OrderNotFoundError(orderId);
    return order;
  }

  async setStatus(orderId: string, status: OrderStatus): Promise<void> {
    await this.orders.updateStatus(orderId, status);
  }

  async markRefunded(orderId: string): Promise<void> {
    await this.setStatus(orderId, "refunded");
  }

  async recalculateTax(orderId: string, postcode: string): Promise<number> {
    const order = await this.getOrderWithItems(orderId);
    const subtotal = order.items.reduce((sum, item) => sum + item.quantityOrdered * item.unitPriceCents, 0);
    const quote = await this.tax.quote(orderId, subtotal, postcode);
    return quote.taxCents;
  }
}
