import { RefundNotAllowedError, RefundProcessor } from "../services/refund";
import { OrderNotFoundError } from "../services/order";

export interface HttpRequest {
  body: { orderId?: string; amountCents?: number };
}

export interface HttpResponse {
  status: number;
  body: unknown;
}

/** Routed as POST /api/refunds by src/server.ts. */
export class RefundController {
  constructor(private readonly processor: RefundProcessor) {}

  async handle(req: HttpRequest): Promise<HttpResponse> {
    const { orderId, amountCents } = req.body;
    if (!orderId || typeof amountCents !== "number") {
      return { status: 400, body: { error: "orderId and amountCents are required" } };
    }

    try {
      const receipt = await this.processor.processRefund(orderId, amountCents);
      return { status: 200, body: receipt };
    } catch (err) {
      if (err instanceof OrderNotFoundError) return { status: 404, body: { error: err.message } };
      if (err instanceof RefundNotAllowedError) return { status: 409, body: { error: err.message } };
      // Everything else - including a Stripe outage - becomes an opaque 500.
      return { status: 500, body: { error: "refund failed" } };
    }
  }
}
