# Quick Recap

- **Event path management**: correlation ID generated at entry point, propagated through all services via headers/message metadata, logged at every step. Enables distributed tracing
- **Correlation ID**: `X-Correlation-Id` header. Generate with `uuid` at API gateway / first service, pass to all downstream calls and message payloads
- **Distributed tracing**: OpenTelemetry — spans + traces. Each service creates a child span. Visualised in Jaeger, Zipkin, Datadog, AWS X-Ray
- **Message-driven systems**: event bus (Kafka/SQS/SNS) decouples producers from consumers. Producer doesn't know about consumers
- **Outbox pattern**: write event to DB in same transaction as business data. Worker reads outbox and publishes to message broker. Guarantees at-least-once delivery
- **Rate limiting**: protect services from overload. Token bucket (burst-friendly), leaky bucket (smooth), sliding window. Implement at API Gateway or service level
- **Idempotency**: processing the same message twice produces the same result. Track processed message IDs in DB/cache. Critical for retry-heavy systems

---

## System Design

### Event Path Through a System

<details>
<summary>Correlation IDs — tracking events end-to-end</summary>

**Problem:** a user action triggers a chain of service calls and async messages. When something fails, you need to find all related logs across all services.

**Solution:** a single `correlationId` (UUID) is generated at the entry point and passed to every downstream service, queue message, and log entry.

**Implementation in NestJS:**

```typescript
// 1. Middleware — generate or forward correlation ID on every request
@Injectable()
export class CorrelationIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction) {
    const correlationId =
      (req.headers["x-correlation-id"] as string) ?? randomUUID();
    req["correlationId"] = correlationId;
    res.setHeader("x-correlation-id", correlationId);
    next();
  }
}

// 2. AsyncLocalStorage — make correlationId available anywhere without passing it manually
import { AsyncLocalStorage } from "async_hooks";
export const correlationStorage = new AsyncLocalStorage<{
  correlationId: string;
}>();

// In middleware, wrap the rest of the request in the storage context:
correlationStorage.run({ correlationId }, next);

// 3. In any service — read without needing it injected
const { correlationId } = correlationStorage.getStore()!;
logger.info("Processing order", { correlationId, orderId });
```

**Propagate to outgoing HTTP calls:**

```typescript
// HTTP interceptor for Axios / NestJS HttpService
this.httpService.axiosRef.interceptors.request.use((config) => {
  const store = correlationStorage.getStore();
  if (store) config.headers["x-correlation-id"] = store.correlationId;
  return config;
});
```

**Include in every queue message:**

```typescript
await sns.send(
  new PublishCommand({
    TopicArn: process.env.TOPIC_ARN,
    Message: JSON.stringify({ orderId, items }),
    MessageAttributes: {
      correlationId: { DataType: "String", StringValue: correlationId },
    },
  }),
);
```

**Every log entry includes correlationId:**

```
[2024-01-15 10:23:45] INFO  api-gateway       correlationId=abc-123 → POST /orders
[2024-01-15 10:23:45] INFO  orders-service    correlationId=abc-123 order created orderId=xyz-789
[2024-01-15 10:23:46] INFO  inventory-service correlationId=abc-123 stock deducted productId=p1
[2024-01-15 10:23:46] INFO  notification-svc  correlationId=abc-123 email queued userId=u1
```

Now you can search for `correlationId=abc-123` in any log aggregator (CloudWatch, Datadog, ELK) and see the full journey.

</details><br>

<details>
<summary>Distributed tracing with OpenTelemetry</summary>

Correlation IDs give you log correlation. **Distributed tracing** gives you a visual timeline of every operation across services, with timing.

**Concepts:**

- **Trace** — the full journey of one request across all services.
- **Span** — one unit of work within a trace (a DB query, an HTTP call, a function). Has start time, duration, attributes, status.
- **Parent/child spans** — spans form a tree. The root span is the incoming request; child spans are downstream operations.

```
Trace: abc-123
├── Span: POST /orders (api-service)           0ms → 250ms
│   ├── Span: DB insert order                  10ms → 30ms
│   ├── Span: HTTP call to inventory-service   35ms → 120ms
│   │   ├── Span: DB update stock              40ms → 80ms
│   └── Span: SNS publish order.created        130ms → 145ms
```

**NestJS + OpenTelemetry setup:**

```typescript
// tracing.ts — init before app bootstrap
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { HttpInstrumentation } from "@opentelemetry/instrumentation-http";
import { PgInstrumentation } from "@opentelemetry/instrumentation-pg";

const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter({ url: process.env.OTEL_EXPORTER_URL }),
  instrumentations: [
    new HttpInstrumentation(), // auto-instruments all HTTP
    new PgInstrumentation(), // auto-instruments DB queries
  ],
});

sdk.start(); // call before any other imports
```

**Manual span for custom operations:**

```typescript
import { trace, SpanStatusCode } from '@opentelemetry/api';

const tracer = trace.getTracer('orders-service');

async processOrder(orderId: string) {
  return tracer.startActiveSpan('processOrder', async span => {
    span.setAttribute('order.id', orderId);
    try {
      const result = await this.doWork(orderId);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
      span.recordException(err);
      throw err;
    } finally {
      span.end();
    }
  });
}
```

**Key insight:** OpenTelemetry automatically propagates trace context via `traceparent` header in HTTP calls — no manual work needed once instrumented.

</details><br>

### Messaging Patterns

**AWS Step Functions** is a managed orchestrator — ideal for complex sagas with retries, timeouts, and parallel steps.

</details><br>

<details>
<summary>Outbox pattern — guaranteed message delivery</summary>

**Problem:** you save data to DB and publish an event to Kafka/SQS. If the publish fails after the DB commit, the event is lost. If you publish before commit and the commit fails, you published a ghost event.

**Solution — Outbox pattern:**

1. In the **same DB transaction**: write business data + write event to `outbox` table.
2. A separate worker reads unprocessed outbox events and publishes them to the message broker.
3. On successful publish, mark the event as processed.

```sql
CREATE TABLE outbox (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  aggregate_type TEXT NOT NULL,   -- 'order'
  aggregate_id   TEXT NOT NULL,   -- orderId
  event_type     TEXT NOT NULL,   -- 'order.created'
  payload        JSONB NOT NULL,
  created_at     TIMESTAMPTZ DEFAULT now(),
  processed_at   TIMESTAMPTZ     -- NULL = not yet published
);
```

```typescript
// In OrdersService — one transaction
await this.dataSource.transaction(async manager => {
  const order = await manager.save(Order, orderData);
  await manager.save(OutboxEvent, {
    aggregateType: 'order',
    aggregateId: order.id,
    eventType: 'order.created',
    payload: { orderId: order.id, userId: order.userId },
  });
});

// Worker polls outbox and publishes
@Cron('*/5 * * * * *')
async publishOutboxEvents() {
  const events = await this.outboxRepo.find({
    where: { processedAt: IsNull() },
    take: 100,
    order: { createdAt: 'ASC' },
  });

  for (const event of events) {
    await this.sns.publish(event);
    await this.outboxRepo.update(event.id, { processedAt: new Date() });
  }
}
```

**Guarantees:** at-least-once delivery (idempotent consumers required). The DB transaction ensures atomicity — either both the business data and the outbox event are saved, or neither is.

</details><br>
