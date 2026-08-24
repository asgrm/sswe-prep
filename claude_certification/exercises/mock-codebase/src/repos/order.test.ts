import { QueryCache } from "../lib/query-cache";
import { OrderRepository } from "./order";

const row = {
  orderId: "ORD-1001",
  customerId: "CUS-77",
  status: "paid" as const,
  totalCents: 24_783,
  chargeId: "ch_3PabcDEF",
  placedAt: "2024-03-03T10:12:00Z",
};

function makeRepo() {
  const pool = { query: jest.fn().mockResolvedValue({ rows: [row], rowCount: 1 }) };
  const cache = new QueryCache();
  return { repo: new OrderRepository(pool as never, cache), pool, cache };
}

describe("OrderRepository", () => {
  it("reads through to Postgres on a cache miss", async () => {
    const { repo, pool } = makeRepo();
    expect((await repo.findById("ORD-1001"))?.orderId).toBe("ORD-1001");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("serves the second read from the cache", async () => {
    const { repo, pool } = makeRepo();
    await repo.findById("ORD-1001");
    await repo.findById("ORD-1001");
    expect(pool.query).toHaveBeenCalledTimes(1);
  });

  it("returns null when no row matches", async () => {
    const { repo, pool } = makeRepo();
    pool.query.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await repo.findById("ORD-none")).toBeNull();
  });

  it("lists orders for a customer", async () => {
    const { repo } = makeRepo();
    expect(await repo.findByCustomer("CUS-77")).toHaveLength(1);
  });
});
