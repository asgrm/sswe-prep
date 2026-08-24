import { OrderProcessor } from "./OrderProcessor";

describe("OrderProcessor", () => {
  it("processes an incoming order", async () => {
    const processor = new OrderProcessor();
    const result = await processor.handleIncomingOrder("ORD-1001");
    expect(result.status).toBe("processed");
  });

  it("tracks the number of processed orders", async () => {
    const processor = new OrderProcessor();
    await processor.handleIncomingOrder("ORD-1002");
    await processor.handleIncomingOrder("ORD-1003");
    expect(processor.getProcessedCount()).toBe(2);
  });
});
