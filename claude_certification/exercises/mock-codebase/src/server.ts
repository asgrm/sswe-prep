import { RefundController } from "./controllers/refund";
import { PostgresPool } from "./db/postgres";
import { NotificationClient } from "./gateways/notification";
import { PaymentGateway } from "./gateways/payment";
import { TaxClient } from "./gateways/tax";
import { HttpClient } from "./lib/http";
import { QueryCache } from "./lib/query-cache";
import { CustomerRepository } from "./repos/customer";
import { OrderRepository } from "./repos/order";
import { OrderService } from "./services/order";
import { RefundProcessor } from "./services/refund";

/** Single composition root: everything is wired here and nowhere else. */
export function buildApp() {
  const pool = new PostgresPool(process.env.DATABASE_URL ?? "");
  const cache = new QueryCache(60_000);

  const orderRepository = new OrderRepository(pool, cache);
  const customerRepository = new CustomerRepository(pool);

  const taxClient = new TaxClient(new HttpClient("https://rest.avatax.com"), process.env.AVALARA_API_KEY ?? "");
  const paymentGateway = new PaymentGateway(new HttpClient("https://api.stripe.com"), process.env.STRIPE_API_KEY ?? "");
  const notificationClient = new NotificationClient(new HttpClient("https://api.sendgrid.com"), process.env.SENDGRID_API_KEY ?? "");

  const orderService = new OrderService(orderRepository, taxClient);
  const refundProcessor = new RefundProcessor(orderService, customerRepository, paymentGateway, notificationClient);

  const routes = {
    "POST /api/refunds": new RefundController(refundProcessor),
  };

  return { routes, pool, cache };
}
