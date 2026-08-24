import { OrderNotFoundError, OrderService } from "./order";

const fakeOrder = {
  orderId: "ORD-1001",
  customerId: "CUS-77",
  status: "paid" as const,
  totalCents: 24_783,
  chargeId: "ch_3PabcDEF",
  placedAt: "2024-03-03T10:12:00Z",
  items: [{ sku: "SKU-9", description: "Desk lamp", quantityOrdered: 1, unitPriceCents: 24_783 }],
};

function makeService(overrides: Record<string, unknown> = {}) {
  const orders = {
    findById: jest.fn().mockResolvedValue(fakeOrder),
    findWithItems: jest.fn().mockResolvedValue(fakeOrder),
    updateStatus: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  const tax = { quote: jest.fn().mockResolvedValue({ taxCents: 4_957, jurisdiction: "GB", estimated: false }) };
  return { service: new OrderService(orders as never, tax as never), orders, tax };
}

describe("OrderService", () => {
  it("returns an order by id", async () => {
    const { service } = makeService();
    expect((await service.getOrder("ORD-1001")).orderId).toBe("ORD-1001");
  });

  it("throws OrderNotFoundError when the repository returns null", async () => {
    const { service } = makeService({ findById: jest.fn().mockResolvedValue(null) });
    await expect(service.getOrder("ORD-none")).rejects.toThrow(OrderNotFoundError);
  });

  it("returns an order with its items", async () => {
    const { service } = makeService();
    expect((await service.getOrderWithItems("ORD-1001")).items).toHaveLength(1);
  });

  it("throws OrderNotFoundError from getOrderWithItems", async () => {
    const { service } = makeService({ findWithItems: jest.fn().mockResolvedValue(null) });
    await expect(service.getOrderWithItems("ORD-none")).rejects.toThrow(OrderNotFoundError);
  });

  it("sets an arbitrary status", async () => {
    const { service, orders } = makeService();
    await service.setStatus("ORD-1001", "shipped");
    expect(orders.updateStatus).toHaveBeenCalledWith("ORD-1001", "shipped");
  });

  it("marks an order refunded", async () => {
    const { service, orders } = makeService();
    await service.markRefunded("ORD-1001");
    expect(orders.updateStatus).toHaveBeenCalledWith("ORD-1001", "refunded");
  });

  it("recalculates tax from the item subtotal", async () => {
    const { service, tax } = makeService();
    expect(await service.recalculateTax("ORD-1001", "SW1A 1AA")).toBe(4_957);
    expect(tax.quote).toHaveBeenCalledWith("ORD-1001", 24_783, "SW1A 1AA");
  });

  it("passes the estimated zero-tax fallback through unchanged", async () => {
    const { service, tax } = makeService();
    tax.quote.mockResolvedValue({ taxCents: 0, jurisdiction: "UNKNOWN", estimated: true });
    expect(await service.recalculateTax("ORD-1001", "SW1A 1AA")).toBe(0);
  });
});
