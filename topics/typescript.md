# Quick Recap

- **Generics**: parameterize types. `<T>` on functions/classes/interfaces. Constraints: `T extends SomeType`. Default: `T = string`
- **Utility types**: `Partial<T>`, `Required<T>`, `Readonly<T>`, `Pick<T, K>`, `Omit<T, K>`, `Record<K, V>`, `ReturnType<F>`, `Parameters<F>`, `Awaited<T>`
- **Conditional types**: `T extends U ? X : Y`. Used for type inference and branching. `infer` keyword extracts a type from within a structure
- **Mapped types**: iterate over keys of a type. `{ [K in keyof T]: ... }`. Used to build Partial, Readonly, Record etc.
- **Template literal types**: `type EventName = \`on${Capitalize<string>}\`` — string pattern types
- **`satisfies` operator**: validates a value against a type without widening it. Keeps the inferred literal types while ensuring shape compliance
- **Decorators**: metadata annotations on class/method/property/parameter. Require `experimentalDecorators`. Used heavily by NestJS, TypeORM, class-validator
- **Declaration merging**: interfaces with the same name merge. Modules can be augmented. Used to extend third-party types
- **Discriminated unions**: union of objects each with a literal `type` field. TypeScript narrows automatically in switch/if
- **`unknown` vs `any`**: `any` disables type checking. `unknown` requires a type check before use — always prefer `unknown` for external data

---

## TypeScript

### Generics

<details>
<summary>Generics — functions, classes, constraints</summary>

**Basic generic function:**
```typescript
function identity<T>(value: T): T {
  return value;
}

identity<string>('hello');  // explicit
identity(42);               // inferred: T = number
```

**Generic with constraint:**
```typescript
function getProperty<T, K extends keyof T>(obj: T, key: K): T[K] {
  return obj[key];
}

const user = { id: 1, name: 'Alice' };
getProperty(user, 'name'); // ✅ string
getProperty(user, 'age');  // ❌ TS error — 'age' not in keyof typeof user
```

**Generic interface and class:**
```typescript
interface Repository<T, ID = string> {
  findById(id: ID): Promise<T | null>;
  save(entity: T): Promise<T>;
  delete(id: ID): Promise<void>;
}

class InMemoryRepo<T extends { id: string }> implements Repository<T> {
  private store = new Map<string, T>();

  async findById(id: string) { return this.store.get(id) ?? null; }
  async save(entity: T) { this.store.set(entity.id, entity); return entity; }
  async delete(id: string) { this.store.delete(id); }
}
```

**Generic default type parameter:**
```typescript
interface ApiResponse<T = unknown> {
  data: T;
  status: number;
  message: string;
}

// Without explicit generic — T defaults to unknown
const response: ApiResponse = { data: 'anything', status: 200, message: 'ok' };

// With explicit generic
const userResponse: ApiResponse<User> = { data: user, status: 200, message: 'ok' };
```

**Multiple generics:**
```typescript
function merge<A, B>(a: A, b: B): A & B {
  return { ...a as any, ...b as any };
}

const merged = merge({ name: 'Alice' }, { age: 30 });
// type: { name: string } & { age: number }
```

</details><br>

### Utility Types

<details>
<summary>Utility types — the essential ones</summary>

**`Partial<T>` — all properties optional:**
```typescript
interface User { id: string; name: string; email: string; }

function updateUser(id: string, patch: Partial<User>) { ... }
updateUser('1', { name: 'Bob' }); // only name, rest are optional
```

**`Required<T>` — all properties required (removes `?`):**
```typescript
type RequiredConfig = Required<Partial<Config>>;
```

**`Readonly<T>` — all properties read-only:**
```typescript
const config: Readonly<Config> = { apiUrl: '...', timeout: 5000 };
config.timeout = 1000; // ❌ TS error
```

**`Pick<T, K>` and `Omit<T, K>`:**
```typescript
type UserPreview = Pick<User, 'id' | 'name'>;
type UserWithoutPassword = Omit<User, 'password' | 'salt'>;
```

**`Record<K, V>` — object with keys K and values V:**
```typescript
type RolePermissions = Record<'admin' | 'editor' | 'viewer', string[]>;
const perms: RolePermissions = {
  admin:  ['read', 'write', 'delete'],
  editor: ['read', 'write'],
  viewer: ['read'],
};
```

**`ReturnType<F>` and `Parameters<F>`:**
```typescript
function createOrder(userId: string, items: Item[]): Order { ... }

type OrderResult = ReturnType<typeof createOrder>;   // Order
type OrderArgs   = Parameters<typeof createOrder>;   // [string, Item[]]
```

**`Awaited<T>` — unwrap Promise:**
```typescript
type Result = Awaited<Promise<User>>; // User
type Nested = Awaited<Promise<Promise<string>>>; // string
```

**`NonNullable<T>` — remove null and undefined:**
```typescript
type MaybeUser = User | null | undefined;
type DefiniteUser = NonNullable<MaybeUser>; // User
```

**`Extract<T, U>` and `Exclude<T, U>`:**
```typescript
type Status = 'pending' | 'active' | 'deleted';
type LiveStatus = Exclude<Status, 'deleted'>;       // 'pending' | 'active'
type DeletedOnly = Extract<Status, 'deleted'>;       // 'deleted'
```

</details><br>

### Advanced Types

<details>
<summary>Conditional types and `infer`</summary>

**Conditional type:**
```typescript
type IsArray<T> = T extends any[] ? true : false;

type A = IsArray<string[]>; // true
type B = IsArray<string>;   // false
```

**`infer` — extract a type from within a structure:**
```typescript
// Extract the element type of an array
type ElementType<T> = T extends (infer U)[] ? U : never;

type E = ElementType<string[]>;  // string
type F = ElementType<number[]>;  // number
type G = ElementType<string>;    // never

// Extract Promise resolved type (same as Awaited)
type UnwrapPromise<T> = T extends Promise<infer R> ? R : T;

// Extract function return type (same as ReturnType)
type MyReturnType<T extends (...args: any) => any> =
  T extends (...args: any) => infer R ? R : never;
```

**Distributive conditional types:**
```typescript
// Applied to each member of a union
type ToArray<T> = T extends any ? T[] : never;
type Result = ToArray<string | number>; // string[] | number[]
// NOT (string | number)[] — it distributes
```

**Real-world use — make specific keys required:**
```typescript
type WithRequired<T, K extends keyof T> = T & Required<Pick<T, K>>;

type UserWithName = WithRequired<Partial<User>, 'id' | 'name'>;
// id and name are required, everything else optional
```

</details><br>

<details>
<summary>Mapped types and template literal types</summary>

**Mapped type — iterate over keys:**
```typescript
// Rebuild Partial manually
type MyPartial<T> = { [K in keyof T]?: T[K] };

// Make all values nullable
type Nullable<T> = { [K in keyof T]: T[K] | null };

// Prefix all keys
type Prefixed<T, P extends string> = {
  [K in keyof T as `${P}${Capitalize<string & K>}`]: T[K]
};

type PrefixedUser = Prefixed<{ name: string; age: number }, 'get'>;
// { getName: string; getAge: number }
```

**Template literal types:**
```typescript
type EventName<T extends string> = `${T}Changed`;
type UserEvents = EventName<'name' | 'email'>; // 'nameChanged' | 'emailChanged'

// HTTP methods
type HttpMethod = 'get' | 'post' | 'put' | 'delete';
type MethodHandler = `on${Capitalize<HttpMethod>}`; // 'onGet' | 'onPost' | ...
```

**`satisfies` operator — validate without widening:**
```typescript
type Config = Record<string, string | number>;

// ❌ Without satisfies — TS widens type, loses literal info
const config: Config = { timeout: 5000, url: 'https://...' };
config.timeout.toFixed(); // ❌ error — TS thinks it's string | number

// ✅ With satisfies — validates shape but keeps inferred types
const config2 = {
  timeout: 5000,
  url: 'https://...',
} satisfies Config;

config2.timeout.toFixed(); // ✅ TS knows it's number
config2.url.toUpperCase(); // ✅ TS knows it's string
```

</details><br>

<details>
<summary>Discriminated unions and type narrowing</summary>

**Discriminated union — the correct way to model variants:**
```typescript
type Shape =
  | { kind: 'circle';    radius: number }
  | { kind: 'rectangle'; width: number; height: number }
  | { kind: 'triangle';  base: number;  height: number };

function area(shape: Shape): number {
  switch (shape.kind) {
    case 'circle':    return Math.PI * shape.radius ** 2;
    case 'rectangle': return shape.width * shape.height;
    case 'triangle':  return (shape.base * shape.height) / 2;
  }
}
```

**Type guards:**
```typescript
// typeof
function process(value: string | number) {
  if (typeof value === 'string') value.toUpperCase(); // narrowed to string
}

// instanceof
function handle(err: unknown) {
  if (err instanceof Error) console.error(err.message);
}

// Custom type guard
function isUser(obj: unknown): obj is User {
  return typeof obj === 'object' && obj !== null && 'id' in obj && 'name' in obj;
}

// Assertion function (throws if not valid)
function assertUser(obj: unknown): asserts obj is User {
  if (!isUser(obj)) throw new Error('Not a valid user');
}
```

**`unknown` vs `any`:**
```typescript
function processInput(data: unknown) {
  // Must narrow before use
  if (typeof data === 'string') return data.toUpperCase(); // ✅
  if (Array.isArray(data)) return data.length;             // ✅
  return null;
}

function badProcess(data: any) {
  return data.toUpperCase(); // ✅ compiles, but runtime error if data is not string
}
```

**Rule:** use `unknown` for external data (API responses, parsed JSON, `catch` blocks). Use `any` only when migrating JS code or when you truly have no type information and need to move fast.

</details><br>

### Decorators

<details>
<summary>Decorators — how they work (NestJS/TypeORM context)</summary>

Decorators are functions applied to classes, methods, properties, or parameters at class definition time. They require `"experimentalDecorators": true` in `tsconfig.json`.

**Class decorator:**
```typescript
function Singleton<T extends { new(...args: any[]): {} }>(constructor: T) {
  let instance: T;
  return class extends constructor {
    constructor(...args: any[]) {
      if (instance) return instance;
      super(...args);
      instance = this as any;
    }
  };
}
```

**Method decorator:**
```typescript
function Log(target: any, key: string, descriptor: PropertyDescriptor) {
  const original = descriptor.value;
  descriptor.value = async function (...args: any[]) {
    console.log(`Calling ${key} with`, args);
    const result = await original.apply(this, args);
    console.log(`${key} returned`, result);
    return result;
  };
  return descriptor;
}

class OrdersService {
  @Log
  async createOrder(dto: CreateOrderDto) { ... }
}
```

**Parameter decorator + `Reflector` (NestJS pattern):**
```typescript
// Define metadata on a method parameter
export const CurrentUser = createParamDecorator(
  (data: string | undefined, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest();
    const user = request.user;
    return data ? user?.[data] : user;
  },
);

// Usage in controller
@Get('profile')
getProfile(@CurrentUser() user: User) { ... }

@Get('id')
getId(@CurrentUser('id') userId: string) { ... }
```

**Decorator execution order:**
1. Parameter decorators (inner to outer)
2. Method / property decorators (bottom to top)
3. Class decorators (bottom to top)

**In TypeORM:** `@Entity`, `@Column`, `@PrimaryGeneratedColumn`, `@OneToMany`, `@Index` are all property/class decorators that attach metadata to the class. TypeORM reads this metadata at runtime via `reflect-metadata` to build SQL queries.

</details><br>
