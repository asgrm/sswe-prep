export interface OrderOptions {
  validate: boolean;
  notifyCustomer?: boolean;
}

export interface OrderResult {
  orderId: string;
  status: "processed" | "failed";
  processedAt: Date;
}

/**
 * @deprecated Use processOrder(orderId, { validate: true }) instead.
 * Will be removed in v3.0.
 */
export async function processLegacyOrder(orderId: string): Promise<OrderResult> {
  return {
    orderId,
    status: "processed",
    processedAt: new Date(),
  };
}

export async function processOrder(
  orderId: string,
  options: OrderOptions
): Promise<OrderResult> {
  if (options.validate && !orderId.startsWith("ORD-")) {
    return { orderId, status: "failed", processedAt: new Date() };
  }
  return { orderId, status: "processed", processedAt: new Date() };
}
