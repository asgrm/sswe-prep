import { processLegacyOrder, processOrder, formatOrderId } from "./utils";

export class RefundHandler {
  async handleRefund(orderId: string): Promise<boolean> {
    const result = await processOrder(orderId, { validate: true });
    return result.status === "processed";
  }

  async handlePartialRefund(orderId: string): Promise<boolean> {
    const result = await processLegacyOrder(orderId);
    return result.status === "processed";
  }

  async retryRefund(rawId: string): Promise<boolean> {
    const orderId = formatOrderId(rawId);
    const result = await processLegacyOrder(orderId);
    return result.status === "processed";
  }
}
