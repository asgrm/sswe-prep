import { HttpClient } from "../lib/http";

const REFUND_ENDPOINT_TEMPLATE = "/v1/charges/{chargeId}/refunds?expand[]=balance_transaction";
const IDEMPOTENCY_HEADER = "Idempotency-Key";

export interface StripeRefund {
  id: string;
  amount: number;
  status: "pending" | "succeeded" | "failed";
  balance_transaction: string | null;
}

/**
 * Stripe payments gateway. Base URL is https://api.stripe.com.
 *
 * Errors from HttpClient (HttpError, AbortError on timeout) propagate to the
 * caller untouched - this gateway has no retry, no backoff and no circuit
 * breaker.
 */
export class PaymentGateway {
  static readonly PROVIDER = "stripe";

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
  ) {}

  async refundCharge(chargeId: string, amountCents: number, idempotencyKey: string): Promise<StripeRefund> {
    const path = REFUND_ENDPOINT_TEMPLATE.replace("{chargeId}", chargeId);
    return this.http.postJson<StripeRefund>(
      path,
      { amount: amountCents, reason: "requested_by_customer" },
      { authorization: `Bearer ${this.apiKey}`, [IDEMPOTENCY_HEADER]: idempotencyKey },
    );
  }

  async captureCharge(chargeId: string): Promise<StripeRefund> {
    return this.http.postJson<StripeRefund>(`/v1/charges/${chargeId}/capture`, {}, { authorization: `Bearer ${this.apiKey}` });
  }
}
