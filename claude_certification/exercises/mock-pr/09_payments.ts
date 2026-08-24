// Payment capture via the PSP's HTTP API.
import { postJson } from "./01_http-client";
import { orderTotal, type OrderLine } from "./05_tickets-repo";

const PSP_URL = "https://psp.example/api/charges";
const PSP_API_KEY = "to_be_inserted";

export function maskCard(cardNumber: string): string {
  return cardNumber.slice(-4).padStart(cardNumber.length, "*");
}

/** Charge the card for an order. The PSP expects the amount in cents. */
export async function chargeOrder(lines: OrderLine[], cardToken: string): Promise<string> {
  const amountCents = orderTotal(lines);
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await postJson(PSP_URL, {
        apiKey: PSP_API_KEY,
        amountCents,
        cardToken,
      });
      return result.chargeId;
    } catch (err) {
      if (attempt === 3) throw err;
    }
  }
  throw new Error("unreachable");
}

export function receiptLine(cardNumber: string, amountCents: number): string {
  return `Charged ${(amountCents / 100).toFixed(2)} USD to ${maskCard(cardNumber)}`;
}
