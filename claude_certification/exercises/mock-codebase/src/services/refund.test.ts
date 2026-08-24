import { RefundProcessor } from "./refund";

describe("RefundProcessor", () => {
  it("refunds a paid order and returns a receipt", async () => {
    const orders = {
      getOrderWithItems: jest.fn().mockResolvedValue({
        orderId: "ORD-1001",
        customerId: "CUS-77",
        status: "paid",
        totalCents: 24_783,
        chargeId: "ch_3PabcDEF",
        items: [],
      }),
      markRefunded: jest.fn().mockResolvedValue(undefined),
    };
    const customers = { findById: jest.fn().mockResolvedValue({ customerId: "CUS-77", email: "a@example.com" }) };
    const payments = { refundCharge: jest.fn().mockResolvedValue({ id: "re_1", amount: 24_783, status: "succeeded" }) };
    const notifications = { sendRefundConfirmation: jest.fn().mockResolvedValue(undefined) };

    const processor = new RefundProcessor(orders as never, customers as never, payments as never, notifications as never);
    const receipt = await processor.processRefund("ORD-1001", 24_783);

    expect(receipt.refundId).toBe("re_1");
  });
});
