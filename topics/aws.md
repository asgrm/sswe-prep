# Quick Recap

- **SNS vs SQS**: SNS = pub/sub fan-out (push to many subscribers). SQS = queue (pull by one consumer). Often combined: SNS → multiple SQS queues
- **Connecting AWS services**: IAM roles (not keys), event-driven via SNS/SQS/EventBridge, synchronous via Lambda → SDK calls
- **Lambda vs containers**: Lambda = short-lived, event-driven, auto-scale, pay-per-ms, cold starts. Containers (ECS/Fargate) = long-running, full control, no cold starts, fixed cost
- **Cold start**: time to init Lambda execution environment. Reduce with: provisioned concurrency, smaller bundle, avoid heavy init at module load
- **Caching static data**: CloudFront (CDN) in front of API Gateway or S3. ElastiCache (Redis) for DB query results. DynamoDB DAX for DynamoDB reads
- **IAM**: least-privilege roles. Lambda needs execution role. Cross-account = assume role. Never hardcode credentials
- **S3**: object storage. Presigned URLs for client uploads/downloads. Lifecycle policies for cost management
- **DynamoDB**: key-value + document. Single-table design. Partition key = distribution. GSI for secondary access patterns. No joins
- **API Gateway**: REST or HTTP API in front of Lambda. HTTP API is cheaper/faster. Use for auth (Lambda authorizer, Cognito), rate limiting, CORS

---

## AWS

### Connecting Services

<details>
<summary>SNS — Simple Notification Service (pub/sub)</summary>

SNS is a **push-based pub/sub** service. A publisher sends a message to a **topic**, and SNS pushes it to all subscribers simultaneously.

**Subscribers can be:** SQS queues, Lambda functions, HTTP/HTTPS endpoints, email, SMS.

**Use SNS when:** one event needs to trigger multiple independent actions (fan-out).

```
Order placed
    ↓ publish to SNS topic: order.created
    ├→ SQS queue: inventory-service    (deduct stock)
    ├→ SQS queue: notification-service (send email)
    └→ Lambda: analytics-function      (update metrics)
```

**SNS + SQS fan-out pattern (most common):**
```typescript
// Publish to SNS topic (from Lambda or NestJS service)
import { SNSClient, PublishCommand } from '@aws-sdk/client-sns';

const sns = new SNSClient({ region: 'us-east-1' });

await sns.send(new PublishCommand({
  TopicArn: process.env.ORDER_CREATED_TOPIC_ARN,
  Message: JSON.stringify({ orderId, userId, total }),
  MessageAttributes: {
    eventType: { DataType: 'String', StringValue: 'order.created' },
  },
}));
```

**SNS message filtering:** subscribers can filter messages by `MessageAttributes` — so one topic can serve many subscribers, each receiving only relevant events.

```json
// Subscription filter policy — only receive 'order.created' events
{ "eventType": ["order.created"] }
```

</details><br>

<details>
<summary>SQS — Simple Queue Service (message queue)</summary>

SQS is a **pull-based queue**. Producers put messages in; consumers poll and process them. One message is delivered to **one consumer** (unlike SNS which fans out to all).

**Standard Queue vs FIFO Queue:**

| | Standard | FIFO |
|---|---|---|
| **Order** | Best-effort | Guaranteed (exactly-once, in-order) |
| **Throughput** | Nearly unlimited | 300 msg/s (3,000 with batching) |
| **Duplicates** | Possible (at-least-once) | Exactly-once processing |
| **Use case** | High throughput, order doesn't matter | Financial transactions, order processing |

**Key concepts:**
- **Visibility timeout** — when a consumer picks up a message, it becomes invisible to others for N seconds. If not deleted in time, it reappears (enables retry).
- **Dead Letter Queue (DLQ)** — messages that fail to process N times are moved here. Essential for debugging failed messages.
- **Long polling** — consumer waits up to 20s for messages instead of returning empty. Reduces cost and CPU.

**Polling SQS in NestJS (worker pattern):**
```typescript
@Injectable()
export class OrderWorker implements OnApplicationBootstrap {
  private running = true;

  constructor(private sqsClient: SQSClient) {}

  onApplicationBootstrap() {
    this.poll();
  }

  async poll() {
    while (this.running) {
      const { Messages } = await this.sqsClient.send(new ReceiveMessageCommand({
        QueueUrl: process.env.ORDER_QUEUE_URL,
        MaxNumberOfMessages: 10,
        WaitTimeSeconds: 20, // long polling
      }));

      for (const msg of Messages ?? []) {
        await this.process(JSON.parse(msg.Body!));
        await this.sqsClient.send(new DeleteMessageCommand({
          QueueUrl: process.env.ORDER_QUEUE_URL,
          ReceiptHandle: msg.ReceiptHandle!,
        }));
      }
    }
  }
}
```

</details><br>

<details>
<summary>Connecting two AWS services — patterns</summary>

**Rule 1 — use IAM roles, never hardcoded credentials.**
Every Lambda, ECS task, or EC2 instance gets an **execution role** with only the permissions it needs.

```json
// Lambda execution role policy — least privilege
{
  "Effect": "Allow",
  "Action": ["sqs:ReceiveMessage", "sqs:DeleteMessage", "sqs:GetQueueAttributes"],
  "Resource": "arn:aws:sqs:us-east-1:123456789:orders-queue"
}
```

**Common connection patterns:**

| Pattern | How | When |
|---|---|---|
| **Event-driven async** | Lambda → SNS/SQS → Lambda/ECS | Decoupled services, retry needed |
| **Direct invocation** | Lambda → SDK call → another Lambda | Simple, synchronous, same account |
| **EventBridge** | Service → event bus → multiple targets | Cross-account, scheduled, complex routing |
| **API Gateway + Lambda** | HTTP request → API GW → Lambda | Public/private HTTP endpoints |
| **Lambda → RDS** | Lambda + VPC + security groups | DB access from serverless |
| **Step Functions** | Orchestrate multi-step workflows | Long-running, branching, retry logic |

**Lambda → SQS trigger (infrastructure connection):**
```typescript
// CDK example — Lambda triggered by SQS
const queue = new sqs.Queue(this, 'OrdersQueue', {
  visibilityTimeout: Duration.seconds(30),
  deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
});

const handler = new lambda.Function(this, 'OrderHandler', {
  runtime: lambda.Runtime.NODEJS_20_X,
  handler: 'index.handler',
  code: lambda.Code.fromAsset('dist'),
});

handler.addEventSource(new SqsEventSource(queue, { batchSize: 10 }));
queue.grantConsumeMessages(handler);
```

</details><br>

### Lambda vs Containers

<details>
<summary>Lambda vs ECS/Fargate containers — when to use each</summary>

| | Lambda | ECS / Fargate (containers) |
|---|---|---|
| **Startup** | Cold start (100ms–3s) | Always warm (seconds to scale) |
| **Execution limit** | 15 min max | No limit |
| **Scaling** | Instant, automatic, per-request | Task-based, slower (30s–2min) |
| **Cost model** | Pay per 1ms of execution | Pay per running task/hour |
| **Idle cost** | Zero | Tasks keep running (cost) |
| **State** | Stateless — no local disk persistence | Can use EFS, local disk |
| **Concurrency** | Up to 1,000 concurrent by default | Limited by task count |
| **Runtime** | Limited (up to 10 GB RAM, 10 GB /tmp) | Any container, any resource |
| **Cold starts** | Yes (mitigate with provisioned concurrency) | No |

**Choose Lambda when:**
- Event-driven, sporadic workloads (S3 events, SNS/SQS triggers, cron jobs).
- Short-lived tasks (API handlers, data transformations, webhooks).
- Cost optimisation — you pay only when it runs.
- Truly stateless processing.

**Choose containers (ECS/Fargate) when:**
- Long-running processes (WebSocket servers, queue workers, background jobs).
- Need full OS control (custom runtimes, specific native libs).
- Cold starts are unacceptable (latency-sensitive user-facing API).
- Persistent connections (DB connections pools, TCP sockets).
- Heavy memory/CPU requirements.

**Cold start mitigation for Lambda:**
- **Provisioned concurrency** — pre-warm N instances, always ready. Costs money.
- **Smaller bundle** — tree-shake, don't import the entire AWS SDK (use `@aws-sdk/client-sqs` not `aws-sdk`).
- **Move init outside handler** — DB connections, SDK clients created once at module load, reused across invocations.
- **SnapStart** (Java only) — snapshot restored instantly.

```typescript
// Good — client created once at module level, reused across warm invocations
const sqs = new SQSClient({ region: 'us-east-1' });

export const handler = async (event: SQSEvent) => {
  // sqs is already initialised
  for (const record of event.Records) { ... }
};
```

</details><br>

### Caching Near-Static Data

<details>
<summary>Caching near-static data (e.g. product catalogue)</summary>

**Scenario:** ecommerce product catalogue — thousands of products, changes rarely, read millions of times per day.

**Solution layers (apply from outermost to innermost):**

**1. CDN (CloudFront) — cache at the edge, closest to user:**
- Cache API responses at CloudFront edge nodes worldwide.
- `Cache-Control: public, max-age=300` on the response tells CloudFront to cache for 5 min.
- Invalidate on product update: `CloudFront.createInvalidation({ paths: ['/products/*'] })`.
- Cost: near-zero at scale. Latency: <10ms from edge vs 100ms+ from origin.

```typescript
// NestJS controller — set cache headers
@Get('products')
@Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=60')
findAll() {
  return this.productsService.findAll();
}
```

**2. Application cache (Redis/ElastiCache) — cache DB query results:**
- Cache the DB result in Redis with a TTL.
- On cache miss → query DB → store in Redis → return.
- On product update → delete cache key.

```typescript
@Injectable()
export class ProductsService {
  constructor(
    private redis: RedisService,
    private repo: ProductsRepository,
  ) {}

  async findAll(): Promise<Product[]> {
    const cached = await this.redis.get('products:all');
    if (cached) return JSON.parse(cached);

    const products = await this.repo.findAll();
    await this.redis.set('products:all', JSON.stringify(products), 'EX', 300);
    return products;
  }

  async update(id: string, dto: UpdateProductDto) {
    await this.repo.update(id, dto);
    await this.redis.del('products:all'); // invalidate on write
    await this.redis.del(`products:${id}`);
  }
}
```

**3. In-process memory cache — for ultra-hot data:**
- Small, frequently-read config or lookup tables.
- Store in a `Map` in the service, refresh on a timer.
- Risk: each pod has its own copy, can drift. Acceptable for truly static data.

**4. S3 + CloudFront for static assets:**
- Product images, JSON exports → store in S3, serve via CloudFront.
- No server involved — pure CDN delivery.

**Decision matrix:**

| Data | Cache where | TTL | Invalidation |
|---|---|---|---|
| Product list (all) | Redis + CDN | 5 min | Delete on update |
| Single product | Redis | 10 min | Delete on update |
| Product images | S3 + CloudFront | Long (immutable URL with version) | New URL on change |
| User-specific data | Redis (per user key) | Short (1 min) | Delete on write |
| Auth tokens | Redis (blocklist) | Token TTL | Add to blocklist on logout |

**Anti-patterns:**
- No invalidation strategy — cache grows stale indefinitely.
- Caching per-user data at CDN level — different users see each other's data.
- Too-short TTL — cache never helps, every request hits DB.
- Too-long TTL without invalidation — users see outdated prices/products.

</details><br>
