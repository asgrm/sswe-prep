import { HttpClient } from "../lib/http";

export interface TaxQuote {
  taxCents: number;
  jurisdiction: string;
  estimated: boolean;
}

/**
 * Avalara tax gateway. Base URL is https://rest.avatax.com.
 *
 * One retry, then a zero-tax fallback so checkout never blocks on the tax
 * provider. The fallback is returned as a normal TaxQuote.
 */
export class TaxClient {
  static readonly PROVIDER = "avalara";

  constructor(
    private readonly http: HttpClient,
    private readonly apiKey: string,
  ) {}

  async quote(orderId: string, subtotalCents: number, postcode: string): Promise<TaxQuote> {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await this.http.postJson<TaxQuote>(
          "/api/v2/transactions/create",
          { orderId, subtotalCents, postcode },
          { authorization: `Bearer ${this.apiKey}` },
        );
      } catch {
        // swallowed: no log line, no metric, no rethrow
      }
    }
    return { taxCents: 0, jurisdiction: "UNKNOWN", estimated: true };
  }
}
