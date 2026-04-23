# JS

<details>
<summary>1. What is the `using` keyword in JavaScript and what problem does it solve?</summary>

`using` is a block-scoped declaration introduced in ES2025 that automatically calls `[Symbol.dispose]()` on a resource when it goes out of scope — even if an error is thrown. It eliminates the "forgot to clean up" bug that only surfaces under error conditions or early returns.

Before `using`, disciplined cleanup required `try/finally` everywhere:

```js
const conn = db.connect();
try {
  return conn.query("SELECT 1");
} finally {
  conn.release();
}
```

With `using`, cleanup is guaranteed by the language:

```js
using conn = db.connect();
return conn.query("SELECT 1");
// conn[Symbol.dispose]() is called automatically here
```

For `using` to work, the object must implement `[Symbol.dispose]()`:

```js
class DbConnection {
  [Symbol.dispose]() {
    this.release();
  }
}
```

Gotcha: `using` is synchronous — it calls `[Symbol.dispose]()`, not an async teardown. For resources that require async cleanup, use `await using` with `[Symbol.asyncDispose]()` instead.

</details><br>

<details>
<summary>2. What is `await using` and when should you use it over `using`?</summary>

`await using` is the async counterpart to `using`. When the scope exits, instead of calling `[Symbol.dispose]()`, it calls `[Symbol.asyncDispose]()` and awaits the result. Use it whenever teardown involves I/O — flushing buffers, closing file handles, draining queues, or releasing network connections.

```js
class FileWriter {
  async [Symbol.asyncDispose]() {
    await this.flush();
    await this.close();
  }
}

async function writeReport(data) {
  await using writer = new FileWriter("report.csv");
  for (const row of data) {
    await writer.write(row);
  }
  // writer[Symbol.asyncDispose]() is awaited automatically here
}
```

A class can implement both symbols to support both sync and async usage:

```js
class Connection {
  [Symbol.dispose]() {
    this.socket.destroy(); // best-effort sync teardown
  }
  async [Symbol.asyncDispose]() {
    await this.socket.end(); // graceful async teardown
  }
}
```

Gotcha: `await using` can only appear inside an async function or at the top level of a module. Using it in a synchronous context is a syntax error.

</details><br>

<details>
<summary>3. How does `using` behave when multiple resources are declared, and what happens if a disposer throws?</summary>

Multiple `using` declarations dispose in reverse order — last declared, first disposed. This mirrors stack unwinding and ensures a resource that depends on another is torn down before its dependency.

```js
{
  using db = openDatabase(); // disposed second
  using conn = db.getConnection(); // disposed first
  conn.query("SELECT 1");
}
```

If a disposer throws, JavaScript does not silently drop either error. All errors are aggregated into a `SuppressedError`, where the disposal error is stored as `.error` and the original error as `.suppressed`:

```js
try {
  using r = new Resource();
  throw new Error("main error");
} catch (e) {
  // e               → SuppressedError
  // e.error         → error thrown by r[Symbol.dispose]()
  // e.suppressed    → "main error"
}
```

Gotcha: all disposers are guaranteed to run even if earlier ones throw — no resource is skipped due to a disposal failure in another. This is a stronger guarantee than a naive `try/finally` chain, where a throw in one `finally` block can prevent subsequent `finally` blocks from executing.

</details><br>

<details>
<summary>4. What is the `DisposableStack` and when should you use it over individual `using` declarations?</summary>

`DisposableStack` is a container that lets you register multiple cleanup callbacks and dispose them all at once in LIFO order by calling `.dispose()`. It is useful when you need to manage resources dynamically — for example, inside a loop, or when whether a resource is acquired depends on runtime conditions — where static `using` declarations are not expressive enough.

```js
function acquireResources() {
  const stack = new DisposableStack();
  const db = stack.use(openDatabase()); // registers db[Symbol.dispose]
  const conn = stack.use(db.getConnection()); // registers conn[Symbol.dispose]
  stack.defer(() => console.log("all done")); // registers arbitrary callback
  return stack;
}

{
  using resources = acquireResources();
  // work with resources...
} // stack.dispose() is called, running all registered cleanups in reverse
```

Key methods:

- `.use(resource)` — registers a resource with a `[Symbol.dispose]()` method and returns it
- `.adopt(value, fn)` — registers a resource that does not implement Disposable, with a custom teardown function
- `.defer(fn)` — registers an arbitrary cleanup callback with no associated resource
- `.move()` — transfers ownership of all registered resources to a new stack, leaving the original empty and defused

Gotcha: once `.dispose()` is called, the stack is marked as disposed and calling it again is a no-op. Use `.move()` to safely hand off resource ownership to a caller without risking double-disposal.

</details><br>

<details>
<summary>5. What is `AsyncDisposableStack` and how does it differ from `DisposableStack`?</summary>

`AsyncDisposableStack` is the async counterpart to `DisposableStack`. It collects resources and callbacks whose teardown is asynchronous, and disposes them all via `await stack.disposeAsync()` in LIFO order. It implements `[Symbol.asyncDispose]()`, so it works directly with `await using`.

```js
async function acquireConnections() {
  const stack = new AsyncDisposableStack();
  const db = stack.use(await openAsyncDatabase());
  stack.defer(async () => await flushMetrics());
  return stack;
}

async function run() {
  await using stack = await acquireConnections();
  // work...
} // stack[Symbol.asyncDispose]() is awaited automatically
```

Unlike `DisposableStack`, it can register both sync and async resources. Sync resources registered via `.use()` are disposed by calling `[Symbol.dispose]()` during the async disposal pass — you do not need to wrap them.

Gotcha: `disposeAsync()` must be awaited. If you call it without `await`, disposal starts but your code continues before teardown completes, which defeats its entire purpose.

</details><br>

<details>
<summary>6. What does it mean for a class to implement the `Disposable` or `AsyncDisposable` interface, and how do you check for it at runtime?</summary>

A class is `Disposable` if it has a `[Symbol.dispose]()` method, and `AsyncDisposable` if it has a `[Symbol.asyncDispose]()` method. These are the contracts that `using` and `await using` respectively require. There are no formal interface types at runtime — duck typing applies.

```js
class ManagedResource {
  [Symbol.dispose]() {
    this.cleanup();
  }
}

class AsyncManagedResource {
  async [Symbol.asyncDispose]() {
    await this.asyncCleanup();
  }
}
```

To check at runtime whether a value is safely usable with `using`:

```js
function isDisposable(value) {
  return value != null && typeof value[Symbol.dispose] === "function";
}

function isAsyncDisposable(value) {
  return value != null && typeof value[Symbol.asyncDispose] === "function";
}
```

Gotcha: passing a non-disposable object to `using` throws a `TypeError` at the point of declaration — not at scope exit. Validate with the above checks when working with third-party or dynamically acquired resources.

</details><br>
