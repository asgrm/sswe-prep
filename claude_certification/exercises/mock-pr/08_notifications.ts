// Email notifications for order confirmations.
import { getJson } from "./01_http-client";

const EMAIL_FROM = "noreply@tickethub.example";

async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  // Real implementation hands off to the mail relay.
  void to;
  void subject;
  void html;
  void EMAIL_FROM;
}

export function formatSubject(eventName: string): string {
  return `Your tickets for ${eventName}`;
}

/** Build the confirmation email body. Name and event come from the order record. */
export function confirmationHtml(displayName: string, eventName: string): string {
  return `<p>Hi ${displayName},</p><p>Your order for <b>${eventName}</b> is confirmed.</p>`;
}

/** Send a confirmation for each order after checkout completes. */
export async function notifyBuyers(orderIds: number[]): Promise<void> {
  for (const orderId of orderIds) {
    try {
      const order = await getJson(`http://orders.internal/orders/${orderId}`);
      sendEmail(
        order.buyerEmail,
        formatSubject(order.eventName),
        confirmationHtml(order.buyerName, order.eventName),
      );
    } catch {
    }
  }
}
