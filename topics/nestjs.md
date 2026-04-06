# Quick Recap

- **Guards**: implement `CanActivate`, return `true`/`false`. Used for auth (JWT), RBAC, feature flags. Executed before interceptors and pipes
- **Interceptors**: wrap request/response. Use for logging, response transformation, caching, timeout. Implement `NestInterceptor`, use `tap`/`map` on Observable
- **Pipes**: transform and validate incoming data. `ValidationPipe` (class-validator), `ParseIntPipe`, custom pipes. Throw `BadRequestException` on failure
- **Request lifecycle**: Middleware → Guards → Interceptors (pre) → Pipes → Route handler → Interceptors (post) → Exception filters
- **Dependency injection**: NestJS IoC container. `@Injectable()` marks a provider. Scope: `DEFAULT` (singleton), `REQUEST` (per request), `TRANSIENT` (per injection)
- **Modules**: encapsulate providers + controllers. `imports`, `exports`, `providers`, `controllers`. `@Global()` makes providers available everywhere without importing
- **Exception filters**: catch exceptions, return formatted HTTP responses. `@Catch(HttpException)`. Global filter via `APP_FILTER`
- **Custom decorators**: `createParamDecorator` for route params, `SetMetadata` + `Reflector` for metadata-based logic (RBAC roles)
- **Lifecycle hooks**: `OnModuleInit`, `OnApplicationBootstrap`, `OnModuleDestroy`. Use for DB connections, cache warm-up, graceful shutdown

---

## NestJS

### Guards

<details>
<summary>Guards — auth and RBAC</summary>

Guards decide whether a request should be handled. They implement `CanActivate` and run **after middleware but before interceptors and pipes**.

**JWT auth guard:**
```typescript
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(private jwtService: JwtService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const token = this.extractToken(request);

    if (!token) throw new UnauthorizedException('No token provided');

    try {
      const payload = this.jwtService.verify(token);
      request['user'] = payload; // attach to request for downstream use
      return true;
    } catch {
      throw new UnauthorizedException('Invalid or expired token');
    }
  }

  private extractToken(request: Request): string | null {
    const auth = request.headers['authorization'];
    if (!auth?.startsWith('Bearer ')) return null;
    return auth.slice(7);
  }
}
```

**RBAC roles guard — using `Reflector` + metadata:**
```typescript
// 1. Define roles decorator
export const Roles = (...roles: string[]) => SetMetadata('roles', roles);

// 2. Guard reads metadata from handler/class
@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<string[]>('roles', [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required?.length) return true; // no roles required — allow

    const { user } = context.switchToHttp().getRequest();
    return required.some(role => user?.roles?.includes(role));
  }
}

// 3. Use on controller
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles('admin')
@Delete(':id')
remove(@Param('id') id: string) { ... }
```

**Global guard registration (applies everywhere):**
```typescript
// app.module.ts
{ provide: APP_GUARD, useClass: JwtAuthGuard }

// Skip for public routes with a custom decorator:
export const Public = () => SetMetadata('isPublic', true);

// In JwtAuthGuard.canActivate():
const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', [
  context.getHandler(),
  context.getClass(),
]);
if (isPublic) return true;
```

**Guard vs Middleware:**
- Middleware runs before NestJS routing — no access to `ExecutionContext` (can't see route metadata, decorators).
- Guards run after routing — have full `ExecutionContext`, can read `@SetMetadata` values.
- **Use middleware** for: request logging, CORS, body parsing.
- **Use guards** for: authentication, authorisation, feature flags.

</details><br>

<details>
<summary>Interceptors — logging, transformation, timeout</summary>

Interceptors wrap the route handler execution. They can run logic **before and after** the handler, and transform the response.

```typescript
@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const req = context.switchToHttp().getRequest();
    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const ms = Date.now() - start;
        console.log(`${req.method} ${req.url} — ${ms}ms`);
      }),
    );
  }
}
```

**Response transformation (wrap all responses in `{ data: ... }`):**
```typescript
@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, { data: T }> {
  intercept(_: ExecutionContext, next: CallHandler): Observable<{ data: T }> {
    return next.handle().pipe(map(data => ({ data })));
  }
}
```

**Timeout interceptor:**
```typescript
@Injectable()
export class TimeoutInterceptor implements NestInterceptor {
  intercept(_: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      timeout(5000),
      catchError(err => {
        if (err instanceof TimeoutError) throw new RequestTimeoutException();
        return throwError(() => err);
      }),
    );
  }
}
```

**Apply globally:**
```typescript
app.useGlobalInterceptors(new LoggingInterceptor());
// or via DI:
{ provide: APP_INTERCEPTOR, useClass: LoggingInterceptor }
```

</details><br>

<details>
<summary>Pipes — validation and transformation</summary>

Pipes run **after guards and before the route handler**. They transform or validate input data. On failure: throw an exception — NestJS converts it to an HTTP error response.

**Global `ValidationPipe` (standard setup):**
```typescript
// main.ts
app.useGlobalPipes(new ValidationPipe({
  whitelist: true,        // strip properties not in DTO
  forbidNonWhitelisted: true, // throw if extra props sent
  transform: true,        // auto-transform payloads to DTO types (string → number)
  transformOptions: { enableImplicitConversion: true },
}));
```

**DTO with class-validator:**
```typescript
export class CreateOrderDto {
  @IsUUID()
  userId: string;

  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => OrderItemDto)
  items: OrderItemDto[];

  @IsOptional()
  @IsString()
  couponCode?: string;
}
```

**Custom pipe:**
```typescript
@Injectable()
export class ParsePositiveIntPipe implements PipeTransform<string, number> {
  transform(value: string): number {
    const n = parseInt(value, 10);
    if (isNaN(n) || n <= 0) throw new BadRequestException('Must be a positive integer');
    return n;
  }
}

// Usage:
@Get(':id')
findOne(@Param('id', ParsePositiveIntPipe) id: number) { ... }
```

</details><br>

### Request Lifecycle

<details>
<summary>Full NestJS request lifecycle</summary>

```
Incoming request
    ↓
1. Middleware           — Express/Fastify middleware (body parsing, CORS, logging)
    ↓
2. Guards              — CanActivate (auth, RBAC). Throw UnauthorizedException / ForbiddenException
    ↓
3. Interceptors (pre)  — before next.handle() — logging start time, add context
    ↓
4. Pipes               — transform + validate route params, body, query
    ↓
5. Route handler       — @Get / @Post / @Put etc. in controller
    ↓
6. Interceptors (post) — after next.handle() — transform response, log duration
    ↓
7. Exception filters   — catch any thrown exception, format HTTP response
    ↓
Response
```

**Key rule:** guards run before interceptors — if a guard rejects, interceptors don't execute.

**Exception filters** catch anything not already handled:
```typescript
@Catch(HttpException)
export class HttpExceptionFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const status = exception.getStatus();
    const message = exception.getResponse();

    response.status(status).json({
      statusCode: status,
      message,
      timestamp: new Date().toISOString(),
    });
  }
}
```

</details><br>

### Dependency Injection

<details>
<summary>DI container, scopes, and module structure</summary>

**How NestJS DI works:**
- Every `@Injectable()` class is a **provider**.
- NestJS builds a dependency graph at startup and injects dependencies automatically.
- Providers are singletons by default — one instance per module (or globally if exported).

**Provider scopes:**

| Scope | Instance per | Use case |
|---|---|---|
| `DEFAULT` (singleton) | App lifetime | Services, repositories — 99% of cases |
| `REQUEST` | HTTP request | Inject request context, tenant resolution |
| `TRANSIENT` | Each injection point | Rarely needed |

```typescript
@Injectable({ scope: Scope.REQUEST })
export class TenantService {
  constructor(@Inject(REQUEST) private req: Request) {}
  getTenantId() { return this.req.headers['x-tenant-id']; }
}
```

**Module structure:**
```typescript
@Module({
  imports: [TypeOrmModule.forFeature([Order]), SharedModule],
  controllers: [OrdersController],
  providers: [OrdersService, OrdersRepository],
  exports: [OrdersService], // expose to modules that import OrdersModule
})
export class OrdersModule {}
```

**Custom providers:**
```typescript
// Value provider — useful for config or mocking in tests
{ provide: 'CONFIG', useValue: { timeout: 5000 } }

// Factory provider — async init (DB connections, external configs)
{
  provide: 'DB_CONNECTION',
  useFactory: async (configService: ConfigService) => {
    return createConnection(configService.get('DB_URL'));
  },
  inject: [ConfigService],
}

// Class alias
{ provide: AbstractOrdersService, useClass: OrdersService }
```

**Testing — override providers:**
```typescript
const module = await Test.createTestingModule({
  providers: [
    OrdersService,
    { provide: getRepositoryToken(Order), useValue: mockRepo },
  ],
}).compile();
```

</details><br>
