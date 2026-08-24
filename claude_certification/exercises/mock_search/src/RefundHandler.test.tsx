import { RefundHandler } from "./RefundHandler";

describe("RefundHandler", () => {
  it("handles a full refund", async () => {
    const handler = new RefundHandler();
    expect(await handler.handleRefund("ORD-2001")).toBe(true);
  });

  it("handles a partial refund", async () => {
    const handler = new RefundHandler();
    expect(await handler.handlePartialRefund("ORD-2002")).toBe(true);
  });

  it("retries a refund with a raw id", async () => {
    const handler = new RefundHandler();
    expect(await handler.retryRefund("2003")).toBe(true);
  });
});
