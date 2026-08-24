import { processOrder, OrderResult } from "./legacyOrders";

export class OrderProcessor {
  private processed: OrderResult[] = [];

  async handleIncomingOrder(orderId: string): Promise<OrderResult> {
    const result = await processOrder(orderId, { validate: true });
    this.processed.push(result);
    return result;
  }

  getProcessedCount(): number {
    return this.processed.length;
  }
}
