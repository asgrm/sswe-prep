import { HttpClient, HttpError } from "../lib/http";

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

/**
 * SendGrid notification gateway. Base URL is https://api.sendgrid.com.
 *
 * The reference retry policy in this codebase: 3 attempts, exponential
 * backoff, retry only on retryable statuses, rethrow everything else.
 */
export class NotificationClient {
  static readonly PROVIDER = "sendgrid";

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
    private readonly maxAttempts = 3,
  ) {}

  async sendRefundConfirmation(email: string, orderId: string, amountCents: number): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < this.maxAttempts; attempt++) {
      try {
        await this.http.postJson(
          "/v3/mail/send",
          { to: email, template: "refund_confirmation", data: { orderId, amountCents } },
          { authorization: `Bearer ${this.apiKey}` },
        );
        return;
      } catch (err) {
        lastError = err;
        const retryable = err instanceof HttpError && RETRYABLE_STATUSES.has(err.status);
        if (!retryable || attempt === this.maxAttempts - 1) throw err;
        await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }
}
