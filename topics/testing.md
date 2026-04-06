# Quick Recap

- **Testing pyramid**: many unit tests → fewer integration tests → even fewer e2e tests. Cost and speed dictate the ratio
- **Unit tests**: test one function/class in isolation. Fast, cheap, no I/O. Mock all dependencies. The foundation of the pyramid
- **Integration tests**: test multiple components working together (service + DB, controller + service). Slower, catch real wiring issues
- **E2e tests**: test the full system from HTTP request to DB response. Slowest, most expensive, fewest. Catch real user flows
- **Why unit tests**: fast feedback (ms), run in CI on every commit, document behaviour, force good design (untestable code = bad design signal)
- **Mocking**: replace real dependency with a controlled substitute. `jest.fn()` for functions, `jest.mock()` for modules, `{ provide: X, useValue: mock }` in NestJS
- **Test doubles**: dummy (placeholder), stub (returns fixed value), spy (records calls), mock (pre-programmed expectations), fake (working but simplified impl)
- **Code coverage**: measures lines/branches executed by tests. 80%+ is common target. High coverage ≠ good tests — test behaviour, not implementation
- **Test isolation**: each test should set up its own state, not depend on other tests. `beforeEach` resets, `afterEach` cleans up
- **TDD**: Red → Green → Refactor. Write failing test first, then minimal code to pass, then clean up

---

## Testing

### Testing Pyramid

<details>
<summary>Testing pyramid — why the shape matters</summary>

```
         /\
        /  \          E2E tests
       / e2e \        (few, slow, expensive)
      /--------\
     /          \     Integration tests
    / integration\    (moderate, slower)
   /--------------\
  /                \  Unit tests
 /   unit tests     \ (many, fast, cheap)
/____________________\
```

**Why this shape:**

| | Unit | Integration | E2e |
|---|---|---|---|
| **Speed** | Milliseconds | Seconds | Minutes |
| **Cost** | Cheap | Moderate | Expensive |
| **Isolation** | Full | Partial | None |
| **Confidence** | Low (isolated) | Medium | High (full system) |
| **Maintenance** | Low | Medium | High |
| **Failure diagnosis** | Easy | Medium | Hard |

**The pyramid is about ROI** — unit tests give the most feedback per second of execution and cent of infrastructure cost. E2e tests give the most confidence but are flaky and slow.

**Inverted pyramid (anti-pattern):** too many e2e, too few unit tests. Symptoms: slow CI, flaky tests, hard to pinpoint failures, tests break whenever anything changes.

**Practical ratio (rough guide):**
- Unit: 70%
- Integration: 20%
- E2e: 10%

</details><br>

<details>
<summary>Why unit tests — the real reasons</summary>

**1. Fast feedback loop:**
- Unit tests run in milliseconds. You get feedback while still in the editor.
- E2e tests take minutes. By the time they finish, you've context-switched.
- In CI: unit tests run in seconds on every commit. Flaky e2e tests block deployment for 20 minutes.

**2. Force good design:**
- If a function is hard to unit test, it's a design smell — too many dependencies, side effects, or responsibilities.
- Writing unit tests forces you to write small, focused, single-responsibility functions that are easier to test.
- This is why TDD practitioners say "tests are a design tool, not just a safety net."

**3. Document behaviour:**
- A well-named test is living documentation: `should return 404 when user not found`.
- Code changes? Tests break → forced to update docs. With comments, they silently lie.
- New developer reads test file → understands expected behaviour faster than reading code.

**4. Regression safety:**
- Tests catch regressions — someone changes a function and breaks an unrelated caller.
- Without unit tests, regressions only appear in e2e or production.

**5. Cheap to run in CI:**
- Run on every commit, every PR. No infrastructure needed (no DB, no network).
- Integration/e2e tests need real DBs, queues, containers → harder to run everywhere.

**Common misconception:** "100% coverage means no bugs." Coverage measures execution, not correctness. You can have 100% coverage with useless assertions (`expect(true).toBe(true)`). Test the **behaviour**, not the line count.

</details><br>

### Unit Testing in NestJS (Jest)

<details>
<summary>Unit testing NestJS services — patterns and examples</summary>

**Test a service with mocked repository:**
```typescript
// orders.service.spec.ts
describe('OrdersService', () => {
  let service: OrdersService;
  let mockRepo: jest.Mocked<Repository<Order>>;

  beforeEach(async () => {
    mockRepo = {
      findOne: jest.fn(),
      save: jest.fn(),
      create: jest.fn(),
    } as any;

    const module = await Test.createTestingModule({
      providers: [
        OrdersService,
        { provide: getRepositoryToken(Order), useValue: mockRepo },
      ],
    }).compile();

    service = module.get(OrdersService);
  });

  describe('findOne', () => {
    it('returns order when found', async () => {
      const order = { id: '1', status: 'pending', total: 100 } as Order;
      mockRepo.findOne.mockResolvedValue(order);

      const result = await service.findOne('1');

      expect(result).toEqual(order);
      expect(mockRepo.findOne).toHaveBeenCalledWith({ where: { id: '1' } });
    });

    it('throws NotFoundException when not found', async () => {
      mockRepo.findOne.mockResolvedValue(null);

      await expect(service.findOne('nonexistent'))
        .rejects.toThrow(NotFoundException);
    });
  });
});
```

**Test async error handling:**
```typescript
it('throws on DB error', async () => {
  mockRepo.save.mockRejectedValue(new Error('DB connection lost'));

  await expect(service.create(dto)).rejects.toThrow('DB connection lost');
});
```

**Spy vs Mock:**
```typescript
// Spy — wraps real implementation, but records calls
const spy = jest.spyOn(service, 'findOne').mockResolvedValue(mockOrder);
expect(spy).toHaveBeenCalledTimes(1);

// Mock — replaces entirely
jest.mock('../notifications/notifications.service');
```

**Test a guard:**
```typescript
describe('JwtAuthGuard', () => {
  let guard: JwtAuthGuard;
  let jwtService: jest.Mocked<JwtService>;

  beforeEach(() => {
    jwtService = { verify: jest.fn() } as any;
    guard = new JwtAuthGuard(jwtService);
  });

  function mockContext(token?: string): ExecutionContext {
    return {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: token ? `Bearer ${token}` : undefined },
        }),
      }),
    } as any;
  }

  it('allows request with valid token', () => {
    jwtService.verify.mockReturnValue({ userId: '1', roles: ['user'] });
    expect(guard.canActivate(mockContext('valid-token'))).toBe(true);
  });

  it('throws UnauthorizedException with no token', () => {
    expect(() => guard.canActivate(mockContext())).toThrow(UnauthorizedException);
  });
});
```

</details><br>

### Integration Testing

<details>
<summary>Integration tests — testing with real DB and NestJS app</summary>

**When to write integration tests:**
- Service + repository layer — does the SQL actually work?
- Controller + service — are DTOs validated, does the right service method get called?
- Middleware/guards wired correctly — does auth actually reject bad tokens?

**NestJS integration test with real DB (TestContainers or in-memory):**
```typescript
// orders.integration.spec.ts
describe('OrdersService (integration)', () => {
  let app: INestApplication;
  let service: OrdersService;
  let dataSource: DataSource;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [
        TypeOrmModule.forRoot({
          type: 'postgres',
          host: 'localhost',
          port: 5433, // test DB port
          database: 'test_db',
          entities: [Order, User],
          synchronize: true, // OK in test — DB is ephemeral
        }),
        OrdersModule,
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();

    service = module.get(OrdersService);
    dataSource = module.get(DataSource);
  });

  afterEach(async () => {
    await dataSource.query('TRUNCATE orders CASCADE');
  });

  afterAll(async () => {
    await app.close();
  });

  it('creates and retrieves an order', async () => {
    const created = await service.create({ userId: 'u1', total: 99.99 });
    expect(created.id).toBeDefined();

    const found = await service.findOne(created.id);
    expect(found?.total).toBe(99.99);
  });
});
```

**E2e (HTTP-level) test with Supertest:**
```typescript
describe('POST /orders (e2e)', () => {
  it('returns 201 with valid body', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .set('Authorization', `Bearer ${validToken}`)
      .send({ userId: 'u1', items: [{ productId: 'p1', qty: 2 }] })
      .expect(201)
      .expect(res => {
        expect(res.body.data.id).toBeDefined();
      });
  });

  it('returns 401 without token', () => {
    return request(app.getHttpServer())
      .post('/orders')
      .send({ userId: 'u1' })
      .expect(401);
  });
});
```

</details><br>
