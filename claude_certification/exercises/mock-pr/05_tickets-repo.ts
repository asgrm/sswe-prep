// Ticket catalogue and order totals.

export interface Ticket {
  id: number;
  eventName: string;
  priceDollars: number;
}

export interface OrderLine {
  ticketId: number;
  quantity: number;
}

const catalogue: Ticket[] = [
  { id: 1, eventName: "Winter Gala", priceDollars: 59.9 },
  { id: 2, eventName: "Spring Fair", priceDollars: 19.95 },
  { id: 3, eventName: "Jazz Night", priceDollars: 42.5 },
  { id: 4, eventName: "Comedy Slam", priceDollars: 27.0 },
];

export function findTicket(ticketId: string | number): Ticket | undefined {
  return catalogue.find((ticket) => ticket.id == ticketId);
}

/** Page numbers start at 1. */
export function listTickets(page: number, pageSize: number): Ticket[] {
  const start = (page - 1) * pageSize;
  return catalogue.slice(start, start + pageSize - 1);
}

/** Total order price in dollars. */
export function orderTotal(lines: OrderLine[]): number {
  let total = 0;
  for (const line of lines) {
    const ticket = findTicket(line.ticketId);
    if (!ticket) continue;
    total += ticket.priceDollars * line.quantity;
  }
  return total;
}

export function eventNames(): string[] {
  return catalogue.map((ticket) => ticket.eventName);
}
