import { NotificationClient } from "../gateways/notification";
import { PaymentGateway } from "../gateways/payment";
import { CustomerRepository } from "../repos/customer";
import { OrderService } from "./order";

export class RefundNotAllowedError extends Error {}

export interface RefundReceipt {
  orderId: string;
  refundId: string;
  amountCents: number;
}

/**
 * Refund orchestration. Entry point for POST /api/refunds.
 */
export class RefundProcessor {
  constructor(
    private readonly orders: OrderService,
    private readonly customers: CustomerRepository,
    private readonly payments: PaymentGateway,
    private readonly notifications: NotificationClient,
  ) {}

  async processRefund(orderId: string, amountCents: number): Promise<RefundReceipt> {
    const order = await this.orders.getOrderWithItems(orderId);

    if (order.status === "refunded") {
      throw new RefundNotAllowedError(`Order ${orderId} is already refunded`);
    }
    if (amountCents > order.totalCents) {
      throw new RefundNotAllowedError(`Refund ${amountCents} exceeds order total ${order.totalCents}`);
    }

    // Single unguarded call into Stripe. A 503 or a request timeout aborts the
    // whole refund here, after validation has passed and before the order
    // status is updated.
    const refund = await this.payments.refundCharge(order.chargeId, amountCents, `refund-${orderId}`);

    await this.orders.markRefunded(orderId);

    const customer = await this.customers.findById(order.customerId);
    if (customer) {
      await this.notifications.sendRefundConfirmation(customer.email, orderId, amountCents);
    }

    return { orderId, refundId: refund.id, amountCents };
  }
}
