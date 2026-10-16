# Node.js

<details>
<summary>1. How do you import a JSON file in Node.js using ES Modules?</summary>

Since Node.js 22, JSON files can be imported directly using ES module `import` syntax with an import attribute declaring the type as `'json'`. The JSON content is available as the default export.

```js
import data from "./config.json" with { type: "json" };

console.log(data.version); // access any top-level property
```

This requires the project to be running in ES module mode — either `"type": "module"` in `package.json` or a `.mjs` file extension. The `with { type: 'json' }` attribute is mandatory; omitting it throws an error.

Gotcha: this replaces older workarounds like `fs.readFile` + `JSON.parse` or `createRequire` from the CommonJS interop layer. If you are on an older Node.js version, those patterns are still necessary.

</details><br>

<details>
<summary>2. What happens to in-memory state when a Node.js process restarts?</summary>

Node.js is a single process. All in-memory data — variables, caches, queues, worker threads, open connections — lives exclusively in that process's memory. When the process exits or crashes, everything it held in memory is lost immediately and irrecoverably.

Gotcha: this applies equally to worker threads spawned by the process. If the main process dies, all its workers die with it regardless of what they were doing.

</details><br>

<details>
<summary>3. What does timeout.unref() do in Node.js and when should it be used?</summary>

Calling `unref()` on a `Timeout` object tells the Node.js event loop that it does not need to stay alive just to run that timer. If no other active work is keeping the event loop running when the timer fires, the process is free to exit before the callback is invoked.

Calling `unref()` more than once on the same timer has no additional effect.

```js
// Safe use: optional background task that should not block process exit
function scheduleMetricsFlush() {
  const timer = setTimeout(async () => {
    try {
      await metricsClient.flush();
    } catch (err) {
      console.error("Metrics flush failed", err);
    }
  }, 5000);

  timer.unref();
  // Process can exit cleanly without waiting for this timer.
  // The flush runs only if the process is still alive when the 5s elapses.
}
```

Use `unref()` for work that is genuinely optional relative to process lifetime: telemetry flushes, background cache warming, optional retries, or periodic maintenance tasks.

Do not use `unref()` for anything that must complete: payment writes, database commits, critical shutdown logic, or any side effect whose loss would leave the system in a broken state.

Gotcha: `unref()` does not cancel or delay the timer — it only removes the timer's hold on the event loop. If other work keeps the process alive long enough, the callback will still run normally.

</details><br>

<details>
<summary>4. What does `url.fileURLToPath()` do in Node.js and why should you use it instead of reading `.pathname` directly?</summary>

`fileURLToPath()` converts a `file:` URL string or `URL` object into a correct, platform-native absolute file path. Reading `.pathname` directly gives you a raw URL-encoded string — it retains percent-encoding, uses wrong separators on Windows, and mishandles UNC paths.

```js
const { fileURLToPath } = require("node:url");

new URL("file:///你好.txt").pathname; // '/%E4%BD%A0%E5%A5%BD.txt' — wrong
fileURLToPath("file:///你好.txt"); // '/你好.txt' — correct (POSIX)

new URL("file:///C:/path/").pathname; // '/C:/path/' — wrong
fileURLToPath("file:///C:/path/"); // 'C:\path\' — correct (Windows)

new URL("file://nas/foo.txt").pathname; // '/foo.txt' — wrong
fileURLToPath("file://nas/foo.txt"); // '\\nas\foo.txt' — correct (Windows UNC)
```

Common use: reconstruct `__filename` and `__dirname` in ES modules, which do not provide them natively.

```js
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const configPath = join(__dirname, "config.json");
```

Gotcha: `fileURLToPath()` decodes percent-encoded dot segments before normalizing — `%2e%2e` becomes `..`. A crafted URL like `file:///app/%2e%2e/secret` will traverse directories after decoding.

</details><br>
<details>
<summary>5. What is the purpose of the `events.errorMonitor` symbol in Node.js, and how does it differ from a regular `'error'` listener?</summary>

`events.errorMonitor` is a well-known symbol exported from `node:events` that lets you observe `'error'` events on an EventEmitter without consuming them. A regular `'error'` listener marks the error as handled, suppressing the default crash behavior. A listener registered under `errorMonitor` runs before any regular `'error'` listeners but does not affect the error's propagation — if no regular `'error'` listener exists, Node.js will still throw the error and crash, exactly as if the monitor were not there.

This separation enforces a clean boundary between observability (logging, metrics, alerting) and control flow (retry, fallback, crash). A monitor must never be used as a substitute for actual error handling.

```js
import { EventEmitter, errorMonitor } from "node:events";

const emitter = new EventEmitter();

// Observes the error — does not handle it
emitter.on(errorMonitor, (err) => {
  monitoringTool.log(err);
});

// No regular 'error' listener is registered,
// so the process still throws after the monitor runs.
emitter.emit("error", new Error("connection lost"));
// => still throws and crashes Node.js
```

Gotcha: adding a regular `'error'` listener solely for logging is a common bug. It silently swallows the error, leaving the application in a broken state with no crash signal. Use `errorMonitor` for observation, and a separate `'error'` listener only when you have a genuine recovery strategy.

</details><br>

<details>
<summary>6. Why is using an async function as an EventEmitter event handler dangerous by default, and what problem does it introduce?</summary>

When an async function is used as an event handler and throws, the resulting rejected Promise is not connected to the EventEmitter in any way. The emitter has no knowledge of the Promise, so the rejection goes unhandled — it does not trigger the emitter's `'error'` event and will produce an `UnhandledPromiseRejection` warning or crash (depending on Node.js version and flags).

```js
import { EventEmitter } from "node:events";
const ee = new EventEmitter();

ee.on("something", async (value) => {
  throw new Error("kaboom");
  // This rejected Promise is invisible to the emitter.
  // No 'error' event is fired. Node.js warns or crashes separately.
});

ee.emit("something", 42);
```

Gotcha: the emitter's `'error'` listener gives you no protection here. The throw escapes the emitter's error routing entirely because async functions always return a Promise — the emitter only sees that the handler returned without throwing synchronously.

</details><br>

<details>
<summary>7. What does the `captureRejections` option do on an EventEmitter, and how does it route a rejection from an async handler?</summary>

When `captureRejections: true` is set — either per-instance in the constructor or globally via `EventEmitter.captureRejections = true` — the emitter wraps each registered listener's return value with `.then(undefined, handler)`. If the listener is async and rejects, that rejection is caught and routed through the emitter's own error machinery instead of becoming a stray unhandled rejection.

The routing priority is:

1. If the emitter has a `Symbol.for('nodejs.rejection')` method defined, the rejection is delivered there.
2. Otherwise, it is forwarded to the emitter's `'error'` event.

```js
import { EventEmitter } from "node:events";

const ee = new EventEmitter({ captureRejections: true });

ee.on("something", async (value) => {
  throw new Error("kaboom"); // now captured, not a stray rejection
});

// Option A: handle via 'error' event
ee.on("error", (err) => console.error("caught via error event:", err));

// Option B: handle via custom rejection handler
ee[Symbol.for("nodejs.rejection")] = (err, eventName) => {
  console.error(`rejection from event "${eventName}":`, err);
};
```

To apply the opt-in globally so every new EventEmitter instance captures rejections without individual configuration:

```js
import { EventEmitter } from "node:events";
EventEmitter.captureRejections = true;
```

Gotcha 1: `captureRejections` only applies to listeners registered after the option is set. Listeners already attached before enabling the global flag are not retroactively wrapped.

Gotcha 2: `captureRejectionSymbol` exported from `node:events` and `Symbol.for('nodejs.rejection')` are the exact same symbol — `captureRejectionSymbol === Symbol.for('nodejs.rejection')` is `true`. The named export exists purely for ergonomics. Both forms are valid when defining the rejection handler method on a class:

```js
import { EventEmitter, captureRejectionSymbol } from "node:events";

class MyEmitter extends EventEmitter {
  [captureRejectionSymbol](err, event) {
    // identical to [Symbol.for('nodejs.rejection')]
    console.error("rejected on", event, err);
  }
}
```

</details><br>

<details>
<summary>8. Why must you never use an async function as an `'error'` event handler on an EventEmitter that has `captureRejections` enabled?</summary>

When `captureRejections` is active, a rejection from an async listener is routed back to the emitter's `'error'` event. If the `'error'` handler itself is async and also throws, that new rejection would be captured again and re-routed to `'error'`, producing an infinite loop of error events.

To break this cycle, Node.js deliberately does not attach a `.then(undefined, handler)` wrapper to listeners registered on the `'error'` event itself — meaning any rejection thrown from an async `'error'` handler becomes an unhandled rejection again, defeating the entire purpose of `captureRejections`.

```js
import { EventEmitter } from "node:events";
const ee = new EventEmitter({ captureRejections: true });

ee.on("something", async () => {
  throw new Error("first failure");
});

// WRONG: async 'error' handler can itself reject,
// creating an unhandled rejection or infinite loop.
ee.on("error", async (err) => {
  await someAsyncCleanup(); // if this throws, you lose the error entirely
});

// CORRECT: 'error' handlers must be synchronous.
ee.on("error", (err) => {
  console.error("handled synchronously:", err);
});
```

The rule is absolute: `'error'` event handlers on an EventEmitter must always be synchronous functions, regardless of whether `captureRejections` is enabled.

</details><br>

<details>
<summary>9. What is the `'newListener'` event on an EventEmitter, and what is the practical consequence of it firing before the listener is actually added?</summary>

An EventEmitter emits `'newListener'` on itself each time a new listener is about to be registered. The callback receives the event name and the listener function. Crucially, this fires before the incoming listener is inserted into the internal array.

Because the incoming listener does not exist in the array yet when the callback runs, any listener you register for the same event inside the callback will be inserted first — it ends up ahead of the one that triggered `'newListener'`.

```js
import { EventEmitter } from "node:events";
const ee = new EventEmitter();

ee.on("newListener", (eventName, incomingListener) => {
  if (eventName === "data") {
    // This runs before incomingListener is added,
    // so it ends up at index 0, ahead of incomingListener.
    ee.on("data", () => console.log("I always run first"));
  }
});

ee.on("data", () => console.log("I was registered by the caller"));

ee.emit("data");
// => 'I always run first'
// => 'I was registered by the caller'
```

</details><br>

<details>
<summary>10. How do you get the names of all events that currently have registered listeners on an EventEmitter?</summary>
Call emitter.eventNames(). It returns an array of strings and symbols representing every event for which the emitter has at least one active listener. Events that were once listened to but have since had all their listeners removed will not appear. The 'newListener' and 'removeListener' meta-events are included if they have listeners attached.
</details><br>

<details>
<summary>11. What happens when the number of listeners for a single event on an emitter exceeds `maxListeners`?</summary>
Node.js prints a MaxListenersExceededWarning to stderr suggesting a possible memory leak. The limit is per-event per-emitter — 11 listeners split across different events is fine, but 11 listeners on the same event triggers the warning. Nothing is enforced; listeners are still registered normally. The default threshold is 10, adjustable via emitter.setMaxListeners(n).
</details><br>

<details>
<summary>12. How do you register a listener so it runs before all existing listeners for an event?</summary>
Use emitter.prependListener(eventName, listener) instead of emitter.on(). It inserts the listener at the beginning of the listeners array rather than the end.
</details><br>

<details>
<summary>13. Does removing a listener mid-execution affect the current emit cycle?</summary>
No. Removing a listener reindexes the internal array but does not affect listeners already being called in the current emit() cycle — those run to completion in their original order. Only subsequent emit() calls reflect the removal. Any snapshot obtained via emitter.listeners() before the removal is stale and must be re-fetched.
</details><br>

<details>
<summary>14. How do you remove the default listener warning limit in Node.js EventEmitter?</summary>

By default, Node.js warns when more than 10 listeners are registered on a single event, as this often signals a memory leak. You can raise or remove the limit per instance using `setMaxListeners(n)`, where `0` means unlimited.

</details><br>

<details>
<summary>15. How do you retrieve the original unwrapped function from a `.once()` listener in Node.js?</summary>

`emitter.rawListeners(eventName)` returns listeners including their internal wrappers. For `.once()` listeners, the returned wrapper has a `.listener` property pointing to the original function. Calling `.listener()` directly invokes it without consuming the one-time registration.

```js
const { EventEmitter } = require("events");
const emitter = new EventEmitter();

emitter.once("ping", () => console.log("pong"));

const raw = emitter.rawListeners("ping");
raw[0].listener(); // calls original — 'ping' listener still active
raw[0](); // calls wrapper — triggers and removes the listener
```

Gotcha: listeners added with `.on()` have no `.listener` property — `raw[0].listener` will be `undefined` for those.

</details><br>

<details>
<summary>16. What is the difference between `Symbol()` and `Symbol.for()` in JavaScript?</summary>

`Symbol()` always creates a brand new unique symbol — no two calls ever return the same value. `Symbol.for(key)` looks up a global registry first: if a symbol with that key already exists, it returns it; otherwise it creates, registers, and returns a new one. This makes `Symbol.for()` produce a process-wide singleton identified by a string key.

```js
Symbol("foo") === Symbol("foo"); // false — always a new unique symbol
Symbol.for("foo") === Symbol.for("foo"); // true  — same registry entry returned
```

This property is why Node.js uses `Symbol.for()` for internal contracts like `Symbol.for('nodejs.rejection')` — any module anywhere in the process can reference the same symbol without importing it from a shared location:

```js
// node:events internals and your code agree on the same key
// without either importing from the other
ee[Symbol.for("nodejs.rejection")] = (err, event) => {
  /* ... */
};
```

Gotcha: the registry is global across the entire process, including third-party modules. Avoid short or generic keys like `Symbol.for('id')` to prevent accidental collisions. Prefer namespaced keys like `Symbol.for('mylib.rejectionHandler')`.

</details><br>

<details>
<summary>17. What does `events.once()` return and how does it differ from `emitter.once()`?</summary>

`events.once(emitter, eventName)` returns a Promise that resolves when the event fires — letting you await a one-time event inline instead of nesting a callback. This is useful when your setup code is async and you need to wait for a resource to be ready before proceeding.

```js
const { once, EventEmitter } = require("node:events");

async function connectAndRun() {
  const db = new DatabaseClient();

  db.connect();
  await once(db, "ready"); // wait for connection before querying

  const result = await db.query("SELECT 1");
  console.log(result);
}
```

The resolved value is always an array of all arguments the event emitted — destructure immediately:

```js
const [port, host] = await once(server, "listening");
```

Gotcha: if you forget to destructure, you get an array where you expected a plain value. `const port = await once(server, 'listening')` gives you `[3000]`, not `3000`.

</details><br>

<details>
<summary>18. How does `events.once()` handle an `'error'` event emitted while waiting for a different event?</summary>

If the emitter fires `'error'` before the awaited event fires, `events.once()` rejects the returned Promise with that error. This special behavior only applies when waiting for a non-error event — `'error'` acts as an automatic rejection signal.

```js
const { once, EventEmitter } = require("node:events");

const ee = new EventEmitter();

process.nextTick(() => ee.emit("error", new Error("kaboom")));

try {
  await once(ee, "myevent"); // never fires
} catch (err) {
  console.error(err.message); // kaboom
}
```

Gotcha: if you use `events.once()` to wait for the `'error'` event itself, this special handling does not apply — the error is treated as a normal event and the Promise resolves rather than rejects.

```js
once(ee, "error")
  .then(([err]) => console.log("resolved:", err.message)) // resolves normally
  .catch(() => console.log("this will not run"));

ee.emit("error", new Error("boom")); // prints: resolved: boom
```

</details><br>

<details>
<summary>19. How do you cancel a pending `events.once()` call using an AbortSignal?</summary>

Pass an `AbortSignal` via the options object. If the signal is aborted before the event fires, the Promise rejects with an `AbortError`. Without explicitly checking `err.name === 'AbortError'` in the catch block, a deliberate cancellation and a real emitter failure look identical — you risk silently swallowing genuine errors or misreporting a clean cancel as a crash.

```js
const { once, EventEmitter } = require("node:events");

const ee = new EventEmitter();
const ac = new AbortController();

async function waitForEvent(emitter, event, signal) {
  try {
    await once(emitter, event, { signal });
    console.log("event fired");
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("cancelled — timed out or user navigated away");
    } else {
      // real failure — rethrow or handle separately
      throw err;
    }
  }
}

waitForEvent(ee, "ready", ac.signal);
ac.abort();
```

Gotcha: `ac.abort()` is synchronous but the rejection lands asynchronously. Do not assume cleanup has finished on the line immediately after `abort()`.

</details><br>

<details>
<summary>20. Why can sequential `await once()` calls miss events, and what is the fix?</summary>

`events.once()` returns a Promise, and Promises are microtasks — they only resume after the current synchronous execution stack completes. This means if two events are emitted in the same tick, the second `await once()` is not even registered yet by the time the second event fires, so it is missed permanently.

```js
const { EventEmitter, once } = require("node:events");
const ee = new EventEmitter();

async function listen() {
  await once(ee, "foo"); // resumes after foo fires
  console.log("foo");

  // by the time this line registers, 'bar' has already been emitted
  await once(ee, "bar"); // Promise never resolves
  console.log("bar"); // never reached
}

process.nextTick(() => {
  ee.emit("foo");
  ee.emit("bar"); // fired in the same tick, before the second await registers
});
```

The fix is to create all Promises before awaiting any of them, so every listener is registered synchronously upfront:

```js
async function listen() {
  const [fooResult, barResult] = await Promise.all([
    once(ee, "foo"),
    once(ee, "bar"), // registered immediately, before any await yields control
  ]);
  console.log("foo and bar both caught");
}
```

Gotcha: `process.nextTick()` makes this worse — nextTick callbacks run before Promise microtasks, so events emitted inside `nextTick` can fire before any awaited Promise has had a chance to register its listener. The same trap applies to events emitted synchronously inside a loop or constructor.

</details><br>

<details>
<summary>21. What does `events.on()` return and when would you use it over `events.once()`?</summary>

`events.on(emitter, eventName)` returns an AsyncIterator that yields every emission of the named event indefinitely — use it when you need to process a continuous stream of events with async/await syntax instead of registering a persistent callback listener.

```js
const { on, EventEmitter } = require("node:events");

const ee = new EventEmitter();

process.nextTick(() => {
  ee.emit("message", "hello");
  ee.emit("message", "world");
});

for await (const [data] of on(ee, "message")) {
  console.log(data); // 'hello', then 'world'
}
```

Each iteration value is an array of all arguments the event emitted — destructure inline. Use `events.once()` when you only need the first emission; use `events.on()` when the event fires repeatedly and you want to process each occurrence in sequence.

Gotcha: the `for await` loop body is synchronous per iteration — it processes one event at a time. If your handler is slow and events arrive faster than you process them, they buffer up. Do not use this pattern when you need concurrent handling of multiple events.

</details><br>

<details>
<summary>22. How do you stop a `events.on()` async iteration, and what happens to listeners when it exits?</summary>

There are two ways to exit a `events.on()` loop:

1. Pass an `AbortSignal` via options to cancel it externally — the loop throws an `AbortError`.
2. Pass a `close` option naming one or more events that act as a natural finish line — when any of them fires, the iterator stops cleanly without throwing.

When the loop exits by any means, all internal listeners are automatically removed — no manual cleanup needed.

```js
const { on, EventEmitter } = require("node:events");

const ee = new EventEmitter();
const ac = new AbortController();

// Option A: external cancellation via AbortSignal
(async () => {
  try {
    for await (const [val] of on(ee, "data", { signal: ac.signal })) {
      console.log(val);
    }
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("cancelled externally");
    } else {
      throw err; // real emitter error — do not swallow
    }
  }
})();

// Option B: natural termination via close events
(async () => {
  for await (const [val] of on(ee, "data", { close: ["end", "disconnect"] })) {
    console.log(val);
  }
  console.log("loop exited cleanly"); // reached normally, no try/catch needed
})();

ee.emit("data", 1);
ee.emit("data", 2);
ee.emit("end"); // stops Option B cleanly
ac.abort(); // stops Option A via AbortError
```

Use `close` when the emitter already has a built-in "done" signal — a socket emitting `'close'`, a stream emitting `'end'` — so you do not need an AbortController just to stop the loop. Use `AbortSignal` when the stop condition is external to the emitter, such as a timeout or user cancellation.

Gotcha: if the emitter fires an `'error'` event during iteration, the loop throws regardless of which exit strategy you chose — always wrap AbortSignal-based loops in try/catch and check `err.name === 'AbortError'` to distinguish cancellation from a real failure. The `close` path does not throw, so no try/catch is needed there.

</details><br>

<details>
<summary>23. What is `events.addAbortListener()` and why should you use it over `signal.addEventListener('abort', fn)`?</summary>

`events.addAbortListener(signal, listener)` is a Node.js utility (added in v20.5.0 / v18.18.0) for safely reacting to AbortSignal cancellation. It solves two problems with the raw `signal.addEventListener('abort', fn)` approach:

First, any third party sharing the same signal can call `e.stopImmediatePropagation()` inside their listener, silently blocking yours from ever running. `addAbortListener` bypasses this — your callback is guaranteed to fire when the signal aborts regardless of what other listeners do.

Second, `addEventListener` requires manual `removeEventListener` cleanup. `addAbortListener` returns a `Disposable` that integrates with the `using` keyword for automatic cleanup when the scope exits.

```js
const { addAbortListener } = require("node:events");

async function processRequest(req, signal) {
  // guaranteed to run on abort, even if other listeners call stopImmediatePropagation()
  using _ = addAbortListener(signal, () => {
    req.destroy(); // clean up the request on cancellation
  });

  const data = await fetchSomething(signal);
  return transform(data);
  // scope exits here — abort listener is automatically removed
}
```

Without `using`, clean up manually via the returned Disposable:

```js
const disposable = addAbortListener(signal, () => cleanup());
// later, when done:
disposable[Symbol.dispose]();
```

Gotcha: use this any time you receive an AbortSignal you did not create — from a caller, a framework, or a third-party API. When you fully own the signal and all its listeners, `addEventListener` is fine. Once the signal crosses a trust boundary, `addAbortListener` is the correct tool.

</details><br>

<details>
<summary>24. What problem does `EventEmitterAsyncResource` solve, and when should you use it over a regular `EventEmitter`?</summary>

A regular `EventEmitter` does not preserve async context. When a listener fires, it runs in the async context of the `emit()` call — not the context where the emitter was created or where the listener was registered. For short-lived emitters this rarely matters, but for long-lived emitters that are constructed in one async context and emit in another, async context tracking tools — `AsyncLocalStorage`, APM agents, distributed tracers — lose the thread entirely.

`EventEmitterAsyncResource` (added in v17.4.0 / v16.14.0) solves this by extending both `EventEmitter` and `AsyncResource`. It captures the async context at construction time and ensures every listener runs within that context, regardless of where `emit()` is called from.

```js
const { EventEmitterAsyncResource } = require("node:events");
const { AsyncLocalStorage } = require("node:async_hooks");

const store = new AsyncLocalStorage();
let emitter;

store.run({ requestId: "abc-123" }, () => {
  // async context is captured here at construction time
  emitter = new EventEmitterAsyncResource({ name: "RequestQueue" });
});

emitter.on("done", () => {
  // runs inside the original context, even though emit() happens outside it
  console.log(store.getStore()); // => { requestId: 'abc-123' }
});

// emit() called outside the original store.run() scope
Promise.resolve().then(() => emitter.emit("done"));
```

Use `EventEmitterAsyncResource` whenever an emitter is long-lived, created during request or transaction handling, or used inside a system that relies on async context propagation. For simple fire-and-forget emitters scoped to a single async operation, a regular `EventEmitter` is sufficient.

Gotcha: the `name` option is not cosmetic — it is the label that appears in async stack traces and APM dashboards to identify this emitter's async scope. Always set it to something meaningful when using this class in production.

</details><br>

<details>
<summary>25. What are the constructor options for `EventEmitterAsyncResource` and what does each control?</summary>

`new EventEmitterAsyncResource(options)` accepts all options from both `EventEmitter` and `AsyncResource`:

`captureRejections` — same as on a regular `EventEmitter`, enables automatic capturing of rejected promises from async listeners. Defaults to `false`.

`name` — the async type label attached to this resource's async scope. Shows up in async stack traces and APM tooling. Defaults to the class name via `new.target.name`, so subclasses get their own name automatically.

`triggerAsyncId` — the execution context ID to use as the trigger for this resource. Defaults to `executionAsyncId()` at construction time, which is almost always what you want. Override only when you need to manually stitch async context across a boundary that Node.js cannot track automatically.

`requireManualDestroy` — controls whether `emitDestroy` is called automatically when the object is garbage collected. Defaults to `false`, meaning destruction is reported automatically if any active destroy hook exists. Set to `true` only when you are retrieving the resource's `asyncId` and calling `emitDestroy` yourself via the `async_hooks` API — otherwise automatic and manual destruction would both fire.

```js
const ee = new EventEmitterAsyncResource({
  name: "PaymentQueue",
  captureRejections: true,
  // triggerAsyncId and requireManualDestroy left as defaults
});
```

Gotcha: `triggerAsyncId` and `requireManualDestroy` are low-level escape hatches for custom async tracking instrumentation. In normal application code you will never need to set them — leaving both at their defaults is correct in virtually every case.

</details><br>

<details>
<summary>26. What is `EventEmitterAsyncResource.asyncId` and when would you use it?</summary>

`.asyncId` is a read-only `<number>` that returns the unique async ID Node.js assigned to this resource at construction time. It is the same ID that `async_hooks.executionAsyncId()` would return while running inside this resource's async scope.

You need it only when working directly with the low-level `async_hooks` API — for example, to call `async_hooks.emitDestroy(asyncId)` manually when `requireManualDestroy: true` was set.

```js
const ee = new EventEmitterAsyncResource({ name: "MyQueue" });
console.log(ee.asyncId); // e.g. 7 — stable for the object's lifetime
```

Gotcha: in normal application code you will never need to read `.asyncId`. Async context propagation happens automatically without touching it.

</details><br>

<details>
<summary>27. What is `EventEmitterAsyncResource.asyncResource` and what cross-reference does it expose</summary>

`.asyncResource` is a read-only property returning the underlying `AsyncResource` instance that `EventEmitterAsyncResource` wraps internally. The returned `AsyncResource` has an extra `.eventEmitter` property that points back to the outer `EventEmitterAsyncResource`, so you can navigate in both directions.

```js
const ee = new EventEmitterAsyncResource({ name: "MyQueue" });

const resource = ee.asyncResource;
console.log(resource.eventEmitter === ee); // true
```

The main practical use is calling `AsyncResource` methods directly — for example `.runInAsyncScope(fn)` — when you need to execute a callback explicitly inside the captured async context outside of a normal emit.

Gotcha: this is an instrumentation escape hatch. Everyday use of `EventEmitterAsyncResource` does not require touching `.asyncResource` at all.

</details><br>

<details>

<summary>28. What does `EventEmitterAsyncResource.emitDestroy()` do, when must you call it, and what happens if you call it twice</summary>

`.emitDestroy()` fires all `destroy` hooks registered via `async_hooks` for this resource, signalling that it is done and its async scope should be cleaned up.

By default (`requireManualDestroy: false`) this is triggered automatically when the object is garbage collected — you never need to call it yourself. You only need to call it manually when you constructed the emitter with `requireManualDestroy: true`, which opts out of the automatic GC-triggered call.

```js
const ee = new EventEmitterAsyncResource({
  name: "MyQueue",
  requireManualDestroy: true,
});

// ... use ee ...

ee.emitDestroy(); // must be called exactly once when done
```

Gotcha: calling `emitDestroy()` more than once throws. If you leave `requireManualDestroy` at its default `false`, the GC handles destruction automatically — calling this method manually in that case risks a double-call error if a destroy hook is active.

</details><br>

<details>
<summary>29. What is the relationship between `EventEmitter`, `EventTarget`, and `NodeEventTarget` in Node.js?</summary>

These are three generations of the same idea — a thing that can send and receive named events.

`EventEmitter` is the original Node.js event system, available since v0.1. It is entirely Node-specific. Almost all of Node's core APIs (`fs`, `net`, `http`) are built on it. You register listeners with `.on("event", fn)` and fire them with `.emit("event", value)`.

`EventTarget` is the browser's standard event system (`addEventListener`, `dispatchEvent`). When Node.js began exposing Web APIs like `fetch`, `WebSocket`, and `ReadableStream`, it needed to speak the browser's language. So starting in v14.5.0, Node.js ships its own implementation of the `EventTarget` spec. It is not the browser's code, but it follows the same interface.

`NodeEventTarget` is a bridge between the two. It extends `EventTarget` (browser-style interface) and adds a subset of `EventEmitter` methods like `.on()` and `.emit()`, so existing Node.js code can interact with newer Web-API-style objects without fully breaking. It is not a complete `EventEmitter` — it is missing `prependListener()`, does not emit `newListener`/`removeListener`, and silently ignores duplicate listener registrations.

```js
// EventEmitter — classic Node.js
const { EventEmitter } = require("node:events");
const ee = new EventEmitter();
ee.on("data", (val) => console.log(val));
ee.emit("data", 42);

// EventTarget — browser-compatible
const target = new EventTarget();
target.addEventListener("data", (event) => console.log(event.type));
target.dispatchEvent(new Event("data"));
```

In practice: use `EventEmitter` for Node.js-only code. You will encounter `EventTarget` when working with Web APIs in Node.js. You will rarely construct a `NodeEventTarget` yourself — it exists so Node's own internals can expose a familiar interface during the transition between the two worlds.

</details><br>

<details>
<summary>30. How does Node.js's `EventTarget` differ from the DOM `EventTarget`?</summary>

Two differences.

1. No event propagation for Node.js's `EventTarget`.

2. Async listeners are handled safely. If a listener is an async function or returns a Promise that rejects, Node.js captures that rejection and treats it the same as a synchronous throw.

```js
const target = new EventTarget();

target.addEventListener("foo", async () => {
  throw new Error("oops"); // treated same as a sync throw in Node.js
});

target.dispatchEvent(new Event("foo"));

process.on("unhandledRejection", (err) => {
  console.error("async listener threw:", err);
});
```

</details><br>

<details>
<summary>31. How does `NodeEventTarget` differ from `EventEmitter`?</summary>

1. Duplicate listeners are silently ignored.

2. Several `EventEmitter` APIs are absent: `prependListener()`, `prependOnceListener()`, `rawListeners()`, and `errorMonitor`. The `newListener` and `removeListener` events are never emitted either.

3. No special `"error"` event behavior. On `EventEmitter`, emitting `"error"` with no listener throws and crashes the process. On `NodeEventTarget`, it is treated like any other event type.

4. Listeners can be objects. As well as plain functions, `NodeEventTarget` accepts any object with a `handleEvent` method as a listener, following the browser `EventListener` interface.

</details><br>

<details>
<summary>32. Can you pass a plain Uint8Array to Node.js APIs that accept Buffer?</summary>

Yes.

```js
import { createHash } from "node:crypto";

const raw = new Uint8Array([104, 101, 108, 108, 111]); // "hello" in UTF-8
const hash = createHash("sha256").update(raw).digest("hex");
// Works fine — no Buffer.from() needed
```

Gotcha: the reverse is not universally true in browser environments. Code that passes a Buffer to a Web API may fail there because browsers do not know what Buffer is. Prefer Uint8Array when writing isomorphic code.

</details><br>

<details>
<summary>33. What is the difference between Buffer.alloc, Buffer.allocUnsafe, and Buffer.allocUnsafeSlow?</summary>

**Buffer.alloc(size)** allocates and zero-fills the memory before returning. Safe to use immediately; no old data leaks. Slightly slower due to the fill step.

**Buffer.allocUnsafe(size)** allocates from a shared internal memory pool without zeroing. May contain sensitive leftover bytes from prior allocations. Faster for large-throughput paths where you will overwrite every byte yourself. Buffers smaller than 4 KiB come from the pool; larger ones skip it.

**Buffer.allocUnsafeSlow(size)** is like `allocUnsafe` but always bypasses the pool, allocating raw OS memory directly. Intended for long-lived Buffers that you do not want to keep the pool alive. Slower than allocUnsafe for small sizes.

Gotcha: never expose an allocUnsafe buffer to untrusted output before writing to every byte — you risk leaking heap contents (passwords, keys, etc.) from earlier allocations.

</details><br>

<details>
<summary>34. What do "encoding" and "decoding" mean for character encodings vs binary-to-text encodings in Node.js Buffers?</summary>

For character encodings (utf8, latin1, etc.): converting a string to a Buffer is called encoding; converting a Buffer to a string is called decoding.

For binary-to-text encodings (base64, hex): the convention is reversed. Converting a Buffer to a string is called encoding; converting a string to a Buffer is called decoding. This matches the network/storage convention where raw bytes are encoded into printable text for transport.

```js
// Character encoding (utf8) — string → Buffer is "encoding"
const buf = Buffer.from("hello", "utf8"); // encode

// Character encoding — Buffer → string is "decoding"
const str = buf.toString("utf8"); // decode

// Binary-to-text (base64) — Buffer → string is "encoding"
const b64 = buf.toString("base64"); // encode

// Binary-to-text — string → Buffer is "decoding"
const back = Buffer.from(b64, "base64"); // decode
```

</details><br>

<details>
<summary>35. What silent truncation risk exists with the 'hex' Buffer encoding?</summary>

When decoding a hex string into a Buffer, Node.js processes pairs of hexadecimal characters. If the string contains an odd number of hex characters, the trailing unpaired character is silently dropped — no error is thrown. Similarly, any non-hex character terminates decoding at that point without warning.

```js
// Even-length hex — all bytes decoded correctly
Buffer.from("deadbeef", "hex"); // <Buffer de ad be ef>

// Odd number of hex digits — last character silently dropped
Buffer.from("deadbee", "hex"); // <Buffer de ad be>  (not 'f')

// Non-hex character stops decoding early
Buffer.from("dead!beef", "hex"); // <Buffer de ad>  (stops at '!')
```

Always validate that hex input is a string of even length containing only [0-9a-fA-F] before decoding.

</details><br>

<details>
<summary>36. What is a Blob in Node.js and how does it differ from a Buffer?</summary>

Blob is a web-standard API that encapsulates an immutable, opaque chunk of raw binary data with an optional MIME type string. It cannot be mutated after creation.

Key differences from Buffer:

1. Mutability: Buffer exposes direct byte-level access (buf[0] = 255 works). Blob does not — you cannot read or write individual bytes directly.

2. API shape: Blob exposes its data only through async methods: .arrayBuffer(), .text(), and .stream(). Buffer access is synchronous.

3. MIME type: Blob carries a type string (e.g. "image/png"). Buffer has no concept of content type.

4. Source copying: ArrayBuffer, TypedArray, DataView, and Buffer sources passed to the Blob constructor are copied in, so mutating the original after construction does not affect the Blob.

```js
const blob = new Blob(['{"ok":true}'], { type: "application/json" });

// Async access only
const text = await blob.text();
const ab = await blob.arrayBuffer();
const u8 = new Uint8Array(ab); // now byte-addressable
```

The main use case in Node.js is interoperability with web-standard APIs — `fetch`, `FormData`, and `File` — which expect `Blob`, not `Buffer`. Blob lets you share upload and streaming logic between Node.js and browser code without changes.

</details><br>

<details>
<summary>37. How do ArrayBuffer, TypedArray/Buffer, and Blob relate to each other in the Node.js binary type hierarchy?</summary>

The three types occupy distinct layers with different roles.

ArrayBuffer is the raw memory block itself. A fixed-size allocation of bytes with no read or write methods. You cannot touch the bytes directly; it exists only to be pointed at by a view.

TypedArray (including Uint8Array) / Buffer is a view over an ArrayBuffer. This is the layer that lets you read and write individual bytes. Buffer is Node.js's subclass of Uint8Array; they share the same underlying memory model. Multiple views can point at overlapping ranges of the same ArrayBuffer.

Blob wraps binary data (copied in from any source) with a MIME type and makes it accessible only through async methods. It is not a view; it hides the memory behind a promise-based interface.

```js
// Typical pattern: Blob → ArrayBuffer → writable view
const blob = new Blob(["hello"]);

const ab = await blob.arrayBuffer(); // raw memory block
const u8 = new Uint8Array(ab); // byte-addressable view (web-standard)
const buf = Buffer.from(ab); // Node.js-specific view of the same memory

// ArrayBuffer shared between views (demonstrates the layer separation)
const shared = new ArrayBuffer(4);
const viewA = new Uint8Array(shared);
const viewB = new DataView(shared);
viewA[0] = 255;
viewB.getUint8(0); // 255 — same underlying memory
```

</details><br>

<details>
<summary>38. What does the Blob constructor's 'endings' option do, and when should you set it?</summary>

The endings option controls how line-ending characters (\n) in string source parts are treated when the Blob is constructed. It accepts two values.

'transparent' (default) — line endings are left exactly as provided in the source string. No conversion happens.

'native' — line endings are converted to the platform-native newline sequence before the data is stored. On Windows this produces \r\n; on Unix/macOS it produces \n (using require('node:os').EOL internally).

```js
import os from "node:os";

const src = "line1\nline2\nline3";

const transparent = new Blob([src], { type: "text/plain" });
const native = new Blob([src], { type: "text/plain", endings: "native" });

// On Windows: native blob contains "line1\r\nline2\r\nline3"
// On macOS/Linux: native blob is identical to transparent
```

Avoid 'native' for data you intend to transmit over a network, hash, or compare across platforms — the resulting bytes will differ per OS, breaking reproducibility. Reserve it for files written to local disk that must conform to the host OS's text convention.

</details><br>

<details>
<summary>39. How do you stream the contents of a Blob using blob.stream(), and when would you use it over blob.arrayBuffer() or blob.text()?</summary>

blob.stream() returns a web-standard ReadableStream (not a Node.js stream) that lets you consume the Blob's bytes incrementally, without loading the entire contents into memory at once.

The key distinction from the other async accessors:

blob.arrayBuffer() and blob.text() load everything into memory in one go before resolving. Fine for small payloads, but a problem for large files.

blob.stream() gives you a ReadableStream you can pipe, cancel, or read chunk by chunk — the data is never all in memory at once.

```js
const blob = new Blob(["hello ", "world"]);

// Basic chunk-by-chunk consumption
const reader = blob.stream().getReader();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;
  console.log(value); // Uint8Array chunk
}
```

The most common use in Node.js is piping into a fetch body or a writable destination. Because fetch natively accepts a ReadableStream as its body, you can stream a large Blob to a server without buffering it:

```js
const blob = new Blob([largeBinaryData], { type: "application/octet-stream" });

await fetch("https://example.com/upload", {
  method: "POST",
  body: blob.stream(), // streamed — never fully buffered
  headers: { "Content-Type": blob.type },
});
```

If you need to pipe into a Node.js Writable (e.g. a file write stream), convert with Readable.fromWeb() from node:stream:

```js
import { Readable } from "node:stream";
import { createWriteStream } from "node:fs";

const blob = new Blob([largeBinaryData]);
const nodeReadable = Readable.fromWeb(blob.stream());

nodeReadable.pipe(createWriteStream("output.bin"));
```

Gotcha: the ReadableStream returned is a WHATWG web stream, not a Node.js stream.Readable. APIs that expect a Node.js stream will reject it — use Readable.fromWeb() to bridge the two.

</details><br>

<details>
<summary>40. What is MessageChannel and how do its two ports relate to each other?</summary>

MessageChannel is a web-standard API that creates a pair of connected ports. Whatever is posted into one port comes out the other. It is the primitive underlying structured inter-context communication — most commonly used between a main thread and a Worker, or between two Workers, when the two sides should not share a direct object reference.

```js
const { port1, port2 } = new MessageChannel();

port1.onmessage = ({ data }) => console.log("received:", data);
port2.postMessage("hello");
// → received: hello
```

Each side holds one port. Communication is bidirectional — both ports can send and receive. When you are done, call port.close() to release the channel and allow garbage collection.

</details><br>

<details>
<summary>41. How does posting a Blob over MessageChannel differ from posting a plain object or a transferable, and why is this safe?</summary>

postMessage handles different value types in one of three ways:

Structured clone (most objects) — the data is deep-copied immediately at post time. The sender and receiver each have their own independent copy in memory.

Transfer (ArrayBuffer, MessagePort, etc.) — ownership moves to the receiver. The sender's reference becomes detached and unusable. No copy is made, but only one side can use it.

Blob — neither of the above. The Blob is shared by reference across threads. The underlying bytes are not copied at post time. A copy is made only later, per-receiver, when that receiver calls .arrayBuffer(), .text(), or .stream().

```js
const blob = new Blob(["hello there"]);

const { port1: r1, port2: s1 } = new MessageChannel();
const { port1: r2, port2: s2 } = new MessageChannel();

r1.onmessage = async ({ data }) => console.log(await data.arrayBuffer());
r2.onmessage = async ({ data }) => console.log(await data.arrayBuffer());

s1.postMessage(blob); // no copy made yet
s2.postMessage(blob); // no copy made yet

blob.text().then(console.log); // original still fully usable
```

This is safe precisely because Blob is immutable. Because no receiver can mutate the shared data, there is no risk of one thread corrupting what another is about to read. A Buffer could not be shared this way safely.

</details><br>

<details>
<summary>42. What is a practical use case for posting the same Blob to multiple MessageChannel recipients?</summary>

The pattern is useful any time you need to fan a single binary payload out to multiple consumers without making upfront copies or reading the raw bytes more than once per consumer.

A concrete example: a file upload handler receives a large file and needs to store it in object storage, write metadata to a database, and forward it to an analytics pipeline. Posting the same Blob to three workers means no worker waits on another, no extra memory is consumed until each worker is actually ready to act, and the main thread remains unblocked.

```js
import { Blob } from "node:buffer";
import { Worker } from "node:worker_threads";

async function handleUpload(rawBytes) {
  const blob = new Blob([rawBytes], { type: "application/octet-stream" });

  for (const worker of [storageWorker, dbWorker, analyticsWorker]) {
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ blob, port: port1 }, [port1]);
    // each worker receives the same shared reference
    // bytes are only copied when that worker calls .arrayBuffer()
  }
}
```

The key property being exploited is lazy copying: memory for the data is duplicated only at the moment each recipient actually consumes it, not at the moment it is sent.

</details><br>

<details>
<summary>43. How do you join multiple Buffers into one?</summary>

Use `Buffer.concat(list_of_buffers [, totalLength])`. It takes an array of Buffer or Uint8Array instances and returns a single new Buffer with their contents joined in order. If the list is empty, a zero-length Buffer is returned. `totalLength` is optional. If omitted, it is calculated automatically by summing the lengths of all items. Providing it explicitly skips that summation (minor performance win).

Gotcha: Buffer.concat() may allocate from the internal pool the same way Buffer.allocUnsafe() does, so memory is not zero-filled before the source bytes are written in. Never assume bytes beyond the actual content are zero.

</details><br>

<details>
<summary>44. What is the difference between Buffer.from(typedArray) and Buffer.from(typedArray.buffer)?</summary>

Passing a TypedArray copies only the bytes the view exposes into a new independent Buffer — no memory is shared. Passing the underlying .buffer (the ArrayBuffer itself) creates a view over the entire backing memory, ignoring any offset or length the TypedArray was created with, and mutations on either side are immediately visible through the other.

```js
const arrA = Uint8Array.from([0x63, 0x64, 0x65, 0x66]);
const arrB = new Uint8Array(arrA.buffer, 1, 2); // view over bytes at index 1–2

const bufC = Buffer.from(arrB); // copies view  → 6465
const bufD = Buffer.from(arrB.buffer); // shares memory → 63646566

arrA[1] = 0xa5; // mutate original
console.log(bufC.toString("hex")); // 6465 — unaffected, it was copied
console.log(bufD.toString("hex")); // 63a56566 — changed, memory is shared
```

The bug is silent — no error is thrown, you just get unexpected bytes.

</details><br>

<details>
<summary>45. Does modifying a Buffer affect other Buffers copied from it?</summary>

No. Buffer.from(buffer) copies the data into a new independent Buffer. The two share no memory — mutations to one are not visible in the other.

```js
const buf1 = Buffer.from("buffer");
const buf2 = Buffer.from(buf1);

buf1[0] = 0x61; // change 'b' to 'a'

console.log(buf1.toString()); // 'auffer'
console.log(buf2.toString()); // 'buffer' — unaffected
```

This is the opposite of Buffer.from(arrayBuffer), which shares memory. Buffer.from(buffer) always copies.

</details><br>

<details>
<summary>46. How do you compare two Buffers?</summary>

buf.compare(target) compares bytes lexicographically and returns 0 (equal), -1 (buf sorts before target), or 1 (buf sorts after target). Works directly as a Array.sort comparator via the static Buffer.compare.

```js
const buf1 = Buffer.from("ABC");
const buf2 = Buffer.from("BCD");
const buf3 = Buffer.from("ABCD");

buf1.compare(buf1); // 0  — equal
buf1.compare(buf2); // -1 — buf1 sorts before buf2
buf2.compare(buf1); // 1  — buf2 sorts after buf1

[buf2, buf3, buf1].sort(Buffer.compare);
// → [buf1, buf3, buf2]  (ABC, ABCD, BCD)
```

</details><br>

<details>
<summary>47. How do you copy bytes from one Buffer into another?</summary>

buf.copy(target[, targetStart[, sourceStart[, sourceEnd]]]) copies a range of bytes from buf into target, which must be a Buffer or Uint8Array. All offset parameters default to 0 / buf.length. Returns the number of bytes copied.

```js
const src = Buffer.from("hello world");
const dst = Buffer.alloc(5);

src.copy(dst); // copies first 5 bytes → dst = 'hello'
src.copy(dst, 0, 6, 11); // copies 'world' into dst starting at offset 0
```

</details><br>

<details>
<summary>48. How do you read numeric values from a Buffer at a specific byte offset?</summary>

Use the typed read methods. readUInt8(offset) is the most common — reads one unsigned byte. For multi-byte numbers you pick the type and byte order (BE = big-endian, LE = little-endian).

```js
const buf = Buffer.from([0x01, 0x02, 0x03, 0x04]);

buf.readUInt8(0); // 1      — single byte, no endianness
buf.readUInt16BE(0); // 258    — 0x0102, big-endian
buf.readUInt16LE(0); // 513    — 0x0201, little-endian
buf.readInt32BE(0); // 16909060
```

The full family follows the pattern read[U]Int[8|16|32|64]BE/LE, with float and double variants as well. For arbitrary byte lengths use readUIntBE(offset, byteLength) or readUIntLE(offset, byteLength).

</details><br>

<details>
<summary>49. How do you get a slice of a Buffer without copying?</summary>

buf.subarray(start, end) returns a new Buffer that references the same memory as the original — no copy is made. Mutations in the subarray are visible in the original and vice versa.

```js
const buf = Buffer.from("hello world");
const sub = buf.subarray(0, 5);

sub[0] = 0x48; // 'H'
console.log(buf.toString()); // 'Hello world' — original affected
```

To get an independent copy instead, use Buffer.from(buf.subarray(0, 5)).

</details><br>

<details>
<summary>50. How do you write a string into an existing Buffer at a specific offset?</summary>

buf.write(string[, offset[, length]][, encoding]) writes a string into buf at the given offset, returning the number of bytes written. Defaults: offset 0, length buf.length - offset, encoding utf8.

```js
const buf = Buffer.alloc(10);

buf.write("hello", 0); // writes at start
buf.write("world", 5); // writes at offset 5
console.log(buf.toString()); // 'helloworld'
```

Gotcha: if the string is longer than length allows, it is truncated silently. Allocate carefully or check the returned byte count.

</details><br>

<details>
<summary>51. How do you write a numeric value into a Buffer at a specific byte offset?</summary>

The numeric write methods follow the same naming pattern as the read methods: write[U]Int[8|16|32|64]BE/LE, plus float and double variants. Each takes a value and an offset, and returns the offset plus the number of bytes written.

```js
const buf = Buffer.alloc(4);

buf.writeInt8(127, 0); // writes 1 byte  at offset 0
buf.writeInt16BE(256, 1); // writes 2 bytes at offset 1, big-endian
buf.writeUInt8(255, 3); // writes 1 byte  at offset 3

console.log(buf); // <Buffer 7f 01 00 ff>
```

</details><br>

<details>
<summary>52. What is File and how does it differ from Blob?</summary>

File extends Blob and adds two pieces of metadata: a file name and a last-modified timestamp. Everything else — immutability, async access, MIME type, thread-safe sharing — is inherited from Blob unchanged.

Signatute is `new buffer.File(sources, fileName[, options])`

```js
const file = new File(['{"ok":true}'], "data.json", {
  type: "application/json",
  lastModified: Date.now(),
});

file.name; // 'data.json'
file.lastModified; // timestamp
file.type; // 'application/json'
const text = await file.text(); // inherited from Blob
```

The practical difference shows up with FormData: appending a Blob requires passing the filename as a third argument; appending a File does not — the name is already embedded.

```js
form.append("upload", blob, "data.json"); // must name it manually
form.append("upload", file); // name comes from the File itself
```

</details><br>

<details>
<summary>53. Can fs.open() + createReadStream() be used on non-file resources?</summary>

Yes. On Linux everything is a file descriptor, so `fs.open()` works on character devices, serial ports, sound cards, and virtual files — not just regular files. `createReadStream()` simply wraps the descriptor in Node's stream interface; the kernel doesn't distinguish.

```js
import { open } from "node:fs/promises";

// Read raw 24-byte keyboard event structs from a character device
const fd = await open("/dev/input/event0", "r");
const stream = fd.createReadStream({ highWaterMark: 24 });

stream.on("data", (chunk) => {
  const type = chunk.readUInt16LE(16);
  const code = chunk.readUInt16LE(18);
  const value = chunk.readInt32LE(20);

  if (type === 1) {
    // EV_KEY
    console.log(`Key ${code} ${value === 1 ? "pressed" : "released"}`);
  }
});
```

Gotcha: character devices only produce data when an event occurs (keypress, audio sample, serial byte), so reads **block** instead of returning EOF. Calling `stream.close()` is not enough — a pending read inside the kernel keeps the stream alive. Force-terminate it from the inside:

```js
stream.push(null); // fake EOF signal
stream.read(0); // flush stream state machine to act on it
```

</details><br>

<details>
<summary>54. How does autoClose affect file descriptor lifetime in createReadStream?</summary>

With the default `autoClose: true` the file descriptor is closed automatically on `'end'` or `'error'`. Set it to `false` when you need to reuse the same `FileHandle` across multiple streams — one `open()`, many reads.

The classic real-world case is **HTTP range requests** (video seeking, resumable downloads):

```js
const fd = await open("movie.mp4");

// Browser requests initial chunk
fd.createReadStream({ start: 0, end: 999, autoClose: false }).pipe(res1);

// User scrubs to a timestamp — same fd, different range
fd.createReadStream({ start: 50000, end: 50999, autoClose: false }).pipe(res2);

// Last request — let autoClose clean up
fd.createReadStream({ start: 99000, end: 99999 }).pipe(res3);
```

Other cases: log file tailing (new stream each poll cycle), retry logic (resume from last good byte position), parsing binary formats (header tells you where to seek next).

Gotcha: with `autoClose: false`, errors also leave the descriptor open — always attach an `'error'` handler and close manually, or you leak file descriptors.

</details><br>

<details>
<summary>55. What does filehandle.datasync() do and when would you use it?</summary>

Writes don't go straight to disk — the OS buffers them in memory and flushes whenever it wants, for performance. `datasync()` forces that flush immediately, blocking until the data is physically on disk. Unlike `sync()`, it skips flushing metadata (last modified time, file size, permissions) — saving unnecessary I/O when you only care that the content survived.

| Method       | Flushes data | Flushes metadata |
| ------------ | ------------ | ---------------- |
| `datasync()` | ✅           | ❌               |
| `sync()`     | ✅           | ✅               |

The classic use case is any place where you confirm an action to the user — you must guarantee the record hit disk first:

```js
const fd = await open("transactions.log", "a");

await fd.write('tx:{"id":1,"amount":99.99}\n');
await fd.datasync(); // data is on disk — safe to confirm to the user

console.log("Payment confirmed");
```

Without `datasync()`, a power loss between the write and the OS flush means the transaction record is gone — even though you already told the user it succeeded.

Gotcha: `datasync()` is a real I/O wait — calling it after every single write in a hot loop will destroy throughput. Batch writes together and call it once at the end of the batch.

</details><br>

<details>
<summary>56. How do you clear a file's content without deleting it?</summary>

`filehandle.truncate(0)` sets the file size to zero, wiping all content while keeping the file and its descriptor open.

```js
const fd = await open("app.log", "r+");
await fd.truncate(0); // file exists, now empty
```

Useful for log rotation — you keep the fd open and writing, you just wipe what's already there.

There are similar varians like `fs.ftruncate(fd[, len], callback)` and `fs.truncate(path[, len], callback)`.

If value passed to truncate greater than file length it will be filled with empty bytes.

</details><br>

<details>
<summary>57. How do you check if a file is readable/writable?</summary>

`fsPromises.access()` with permission flags — fulfills if the process has access, rejects if not.

```js
import { access, constants } from "node:fs/promises";

const canAccess = async (path, mode) => {
  try {
    await access(path, mode);
    return true;
  } catch {
    return false;
  }
};

await canAccess("/etc/passwd", constants.R_OK | constants.W_OK); // true or false
```

Gotcha: never use this before `open()` — another process can change the file between the two calls. Open directly and handle the error instead.

</details><br>

<details>
<summary>58. How do you reference files relative to the current module in ESM?</summary>

In CommonJS `__dirname` gave you the current file's directory. ESM doesn't have it — use `import.meta.url` instead, which is the URL of the current file.

```js
// CommonJS
path.join(__dirname, "./package.json");

// ESM
new URL("./package.json", import.meta.url);
```

Gotcha: plain relative paths like `'./package.json'` are relative to where you _ran_ the process from, not where the file lives — so they break depending on your working directory. `import.meta.url` always anchors to the file itself.

</details><br>

<details>
<summary>59. How do you use an async generator as a transform stage in a pipeline?</summary>

An `async function*` can sit between streams in `pipeline` — it receives the previous stream as `source` and yields transformed chunks downstream.

```js
await pipeline(
  fs.createReadStream("lowercase.txt"),

  async function* (source, { signal }) {
    source.setEncoding("utf8"); // work with strings, not Buffers
    for await (const chunk of source) {
      yield await processChunk(chunk, { signal });
    }
  },

  fs.createWriteStream("uppercase.txt"),
);
```

`for await` pulls chunks from the readable, `yield` pushes them to the writable. Always accept and forward `signal` so the inner async work can be cancelled too.

\*signal is auto injected by pipeline, can be fired on pipeline error

</details><br>

<details>
<summary>60. How do you use an async generator as the source in a pipeline?</summary>

Pass it as the first argument — it produces data from scratch with no incoming stream.

```js
await pipeline(async function* ({ signal }) {
  await someLongRunningFn({ signal });
  yield "asd";
}, fs.createWriteStream("output.txt"));
```

Gotcha: if the generator is the source and you ignore `signal`, the pipeline **will never complete** when aborted — `pipeline` tries to destroy everything, but your generator keeps running. Always pass `signal` into any internal async work so it can react to cancellation.

</details><br>

<details>
<summary>61. Can you rewind a readable stream after unpiping it?</summary>

No. After `unpipe()`, re-piping resumes from wherever the underlying resource left off — the stream has no "rewind" concept.

```js
const src = fs.createReadStream("file.txt");
const dst1 = fs.createWriteStream("a.txt");
const dst2 = fs.createWriteStream("b.txt");

src.pipe(dst1);
src.unpipe(dst1); // pauses the stream — does NOT reset position

src.pipe(dst2); // continues from where it stopped, not from byte 0
src.resume(); // unpipe() kills flowing mode — must call this explicitly
// or re-piping alone won't emit data
```

The read position is owned by the underlying resource (file descriptor, socket, etc.) — Node doesn't touch it on `unpipe`. To start over, create a fresh stream:

```js
// ✅ start from byte 0
const fresh = fs.createReadStream("file.txt");
fresh.pipe(dst2);
```

Gotcha: after `unpipe()`, `readableFlowing` becomes `false` — even re-attaching a pipe won't resume data flow until `resume()` is explicitly called.

</details><br>

<details>
<summary>62. How do you reliably detect when a stream has fully finished?</summary>

`stream.finished()` resolves when a stream is no longer readable or writable — for any reason (end, error, destroy). Unlike listening to `'end'` directly, it works on both Readables and Writables, and fires on errors and early destroys too.

```js
const { finished } = require("node:stream/promises");

// Log rotation — wait for full flush before swapping the file
const logStream = fs.createWriteStream("app.log");
logStream.end();
await finished(logStream);
await fs.rename("app.log", `app-${Date.now()}.log`); // safe — fully flushed
```

Works with `AbortSignal` too — lets you cancel and know exactly when teardown is complete:

```js
const ac = new AbortController();
const rs = fs.createReadStream("huge.dat");
rs.resume();

setTimeout(() => ac.abort(), 500);

try {
  await finished(rs, { signal: ac.signal });
} catch (err) {
  if (err.name === "AbortError") {
    // we cancelled it intentionally — not a real error
    console.log("Stream was cancelled");
  } else {
    // actual stream failure — broken pipe, file not found, etc.
    throw err; // re-throw so it doesn't get silently swallowed
  }
}
```

Gotcha: `finished()` leaves `'error'`, `'end'`, `'finish'`, and `'close'` listeners dangling on the stream after the promise settles. In long-lived processes handling many streams this causes memory leaks — use `{ cleanup: true }` to remove them automatically after settlement.

```js
await finished(rs, { cleanup: true });
```

</details><br>

<details>
<summary>63. When do you use stream.destroy() vs stream.end()?</summary>

`end()` is a graceful shutdown — flushes all buffered data before closing. `destroy()` is immediate and violent — drops buffered data, releases the resource right now, no waiting.

```js
// ✅ end() — normal completion, data must land on disk
const file = fs.createWriteStream("report.csv");
for (const row of data) file.write(row);
file.end(); // flushes remaining buffer, then closes

// ✅ destroy() — user cancelled, don't bother flushing
request.on("close", () => {
  fileStream.destroy(); // release the fd immediately
});

// ✅ destroy(err) — validation failed, partial data is unacceptable
parser.on("data", (row) => {
  if (!isValid(row)) {
    fileStream.destroy(new Error("Invalid data detected"));
    return;
  }
  fileStream.write(row);
});
```

The error argument to `destroy(err)` emits an `'error'` event — so anything listening upstream knows _why_ the stream died, not just that it's gone.

Gotcha: calling `destroy()` while writes are still buffered means those writes may never reach the destination — subsequent `write()` calls throw `ERR_STREAM_DESTROYED`. If data must be complete, use `end()` or wait for the `'drain'` event first.

| Situation                        | Use            |
| -------------------------------- | -------------- |
| Normal completion                | `end()`        |
| Error, partial data unacceptable | `destroy(err)` |
| Client disconnected              | `destroy()`    |
| Hung connection / timeout        | `destroy(err)` |

</details><br>

<details>
<summary>64. What is backpressure in Node.js streams and what happens if you ignore it?</summary>

Backpressure is the signal a Writable sends when it can't keep up with incoming data. It triggers exactly when `.write()` returns `false` — meaning the internal buffer has exceeded `highWaterMark` (default 16kb) or the write queue is busy.

The correct response cycle:

```js
function write(data) {
  const ok = writable.write(data);
  if (!ok) {
    // ❌ stop writing — buffer is full
    readable.pause();
    writable.once("drain", () => {
      readable.resume(); // ✅ buffer cleared, safe to continue
    });
  }
}
```

This also applies to custom Readables — `.push()` has the same contract:

```js
// ❌ ignores backpressure signal from downstream
_read(size) {
  let chunk;
  while (null !== (chunk = getNextChunk())) {
    this.push(chunk);
  }
}

// ✅ stops pushing when downstream says so
_read(size) {
  let chunk;
  let canPushMore = true;
  while (canPushMore && null !== (chunk = getNextChunk())) {
    canPushMore = this.push(chunk);
  }
}
```

Also a common antipattern that bypasses backpressure entirely:

```js
// ❌ forces data through regardless of whether writable is ready
readable.on("data", (data) => writable.write(data));
```

Gotcha: the cost of ignoring backpressure is not theoretical. Benchmarks from the Node.js docs show the same file compression operation using ~87MB with backpressure respected vs ~1.52GB without it — an order of magnitude difference. GC also degrades: instead of frequent small sweeps it accumulates large expensive ones.

</details><br>

<details>
<summary>65. What does cork/uncork actually do and when does it help?</summary>

`cork()` buffers all `write()` calls in memory instead of forwarding them to the underlying resource immediately. `uncork()` flushes them all at once.

```js
// Without cork — 3 separate syscalls
stream.write("a");
stream.write("b");
stream.write("c");

// With cork — 1 syscall
stream.cork();
stream.write("a");
stream.write("b");
stream.write("c");
stream.uncork(); // flushed together
```

Cork doesn't solve backpressure — it reduces how often you hit it by generating less I/O pressure in the first place. Backpressure (`write()` → `false` → `drain`) is flow control; cork/uncork is batching. They operate at different levels.

Gotcha: cork only gives a real throughput win if the underlying stream implements `_writev()` — the method that accepts multiple chunks at once. Without it, chunks are still written one by one, just delayed.

```
cork() + _writev() present  → chunks merged into one write  ✅ faster
cork() + no _writev()       → same syscalls, just deferred  ❌ no gain
```

Built-in streams (`fs`, `net`, `zlib`) implement `_writev()` so you get the benefit for free. Custom Writables need to add it explicitly.

Gotcha: `cork()` is a counter, not a boolean toggle — every `cork()` must have exactly one matching `uncork()` or data will never flush.

```js
stream.cork(); // counter = 1
stream.cork(); // counter = 2
stream.uncork(); // counter = 1 — still corked
stream.uncork(); // counter = 0 — flushes now
```

</details><br>

<details>
<summary>66. What is the correct pattern for using cork/uncork?</summary>

Always defer `uncork()` with `process.nextTick()` — never call it synchronously at the end of a write loop.

```js
// ❌ flushes mid-tick — misses writes happening later in the same tick
stream.cork();
stream.write("a");
stream.write("b");
stream.uncork(); // flushes NOW, before other code in this tick runs
someOtherFn(stream); // write('c') inside here — separate syscall, not batched

// ✅ defers until all writes in this tick are collected
stream.cork();
stream.write("a");
stream.write("b");
process.nextTick(() => stream.uncork()); // flushes after full tick completes
someOtherFn(stream); // write('c') — included in the batch
```

Also avoid calling synchronous cork/uncork pairs back to back — it makes two calls on the C++ layer and defeats batching entirely:

```js
// ❌ two separate flushes — cork/uncork technique useless
ws.cork();
ws.write("hello ");
ws.uncork(); // hits C++ layer immediately

ws.cork();
ws.write("world");
ws.uncork(); // hits C++ layer again

// ✅ both batches deferred — single coordinated flush
ws.cork();
ws.write("hello ");
process.nextTick(doUncork, ws);

ws.cork();
ws.write("world");
process.nextTick(doUncork, ws);

function doUncork(stream) {
  stream.uncork();
}
```

The `nextTick` deferral is what makes cork actually work — without it you're just adding latency with no batching benefit.

</details><br>

<details>
<summary>67. When should you use `'readable'` over `'data'` event, and what is the core difference?</summary>

The fundamental difference is **who controls the reading pace**.

`'data'` is push-based — the stream drives the process and fires chunks as fast as it can. You have no control over timing or chunk size:

```js
// ❌ no control — chunks arrive whenever stream decides
stream.on("data", (chunk) => {
  process(chunk); // called on stream's schedule, not yours
});
```

`'readable'` is pull-based — the stream signals that data is _available_, but you decide when and how much to read. Adding a `'readable'` handler automatically pauses the stream:

```js
// ✅ you drive — read only when ready
stream.on("readable", () => {
  let chunk;
  while ((chunk = stream.read()) !== null) {
    process(chunk);
  }
});
```

Use `'readable'` when:

**1. You need exact byte counts** — `'data'` gives whatever chunk size the stream decides; `stream.read(n)` gives exactly `n` bytes:

```js
stream.on("readable", () => {
  const header = stream.read(4); // exactly 4 bytes
  const bodySize = header.readUInt32BE(0);
  const body = stream.read(bodySize); // exactly that many bytes
});
```

**2. You're parsing a binary protocol or wire format** where chunk boundaries matter (HTTP, msgpack, custom formats).

**3. You want natural backpressure without manual pause/resume** — just stop calling `stream.read()` and the stream stops. No `.pause()`/`.resume()` needed.

</details><br>

<details>
<summary>68. How do you distinguish the flow state of a readable stream?</summary>

Check `stream.readableFlowing`:

- `null` — no handler attached, stream hasn't started
- `false` — paused; either `.pause()` was called or a `'readable'` handler is attached
- `true` — flowing; data is being emitted via `'data'` event

</details><br>

<details>
<summary>69. How do you keep a Writable open after a Readable finishes?</summary>

By default, `pipe()` calls `writer.end()` automatically when the readable emits `'end'`. Pass `{ end: false }

Real cases where you need this:

**Sequential file merging** — piping multiple files into one output, closing after the first would cut off the rest.

**Persistent log stream** — a single log file writable that receives from different request-scoped readables over the server's lifetime:

```js
const logFile = fs.createWriteStream("app.log", { flags: "a" });

function logRequest(requestStream) {
  requestStream.pipe(logFile, { end: false }); // logFile stays open for next request
}
```

**WebSocket or TCP socket** — you may pipe different sources into the same socket across its lifetime; closing the socket after the first source ends would drop the connection:

```js
audioStream.pipe(socket, { end: false });
audioStream.on("end", () => {
  videoStream.pipe(socket); // reuse same socket connection
});
```

</details><br>

<details>
<summary>70. Can `readable.read()` return `null` before the stream is finished?</summary>

Yes — `null` means "buffer empty right now", not necessarily end of stream. With a large file or slow source, the buffer can be temporarily exhausted while more data is still incoming.

The correct pattern is to collect across multiple `'readable'` events and only act on `'end'`:

```js
const chunks = [];

readable.on("readable", () => {
  let chunk;
  while (null !== (chunk = readable.read())) {
    chunks.push(chunk);
  }
  // null here — could just be a pause, don't act yet
});

readable.on("end", () => {
  const content = chunks.join(""); // now it's safe
});
```

`'end'` is the only guarantee that `null` is final.

</details><br>

<details>
<summary>71. What is `stream.compose` and how does it differ from `stream.pipeline`?</summary>

`pipeline` is **terminal** — runs immediately, forms a closed circuit, first stream must be readable, last must be writable:

```js
stream.pipeline(readable, transform, writable, callback);
// done, can't be piped further
```

`compose` **packages a chain into a reusable Duplex** you can keep piping or composing further:

```js
const segment = stream.compose(transform1, transform2);
segment.pipe(anotherStream); // plug it into a pipeline
stream.compose(segment, transform3).pipe(x); // or compose further
```

This makes it useful for exposing reusable processing steps in libraries — callers pipe into it without knowing what's inside.

`compose` also accepts async generators and iterables alongside classic streams:

```js
const segment = stream.compose(
  removeSpacesTransform, // classic Transform
  async function* (source) {
    // generator as transform stage
    for await (const chunk of source) yield chunk.toUpperCase();
  },
);
```

**Instance shorthand** — `readable.compose(stream)` is available directly on Readable and Duplex instances as a convenience wrapper:

```js
// equivalent
stream.compose(readable, transform);
readable.compose(transform);
```

Error behavior mirrors `pipeline` — any stream errors and the entire composed Duplex is destroyed.

</details><br>

<details>
<summary>72. What is `stream.duplexPair()` and when do you use it?</summary>

`duplexPair()` returns two connected Duplex streams — whatever is written into one comes out the other:

```js
const [sideA, sideB] = stream.duplexPair();

sideA.write("hello");
sideB.on("data", (chunk) => console.log(chunk.toString())); // 'hello'

sideB.write("world");
sideA.on("data", (chunk) => console.log(chunk.toString())); // 'world'
```

The streams are symmetrical — neither side has special behavior over the other.

Primary use case is **testing network protocol implementations without a real network** — give one side to your server logic, the other to your client, and they communicate in-process as if over a real socket:

```js
const [clientSide, serverSide] = stream.duplexPair();

myServer.handleConnection(serverSide);
myClient.connect(clientSide);
```

</details>
<br>

<details>
<summary>73. What are dangling event listeners in `stream.pipeline` and how to avoid them?</summary>

On success, `pipeline` cleans up all its internal listeners. On error, it destroys the underlying resources but **leaves its listeners attached** to the stream JS objects.

Reusing a stream instance after a failed pipeline means two sets of listeners react to the same events — causing silent swallowed errors or double-fired callbacks.

The fix: **treat streams as one-shot, always create fresh instances**:

```js
// ❌ reusing instance — dangling listeners from first run interfere
const transform = new MyTransform();
pipeline(r1, transform, w1, onDone);
pipeline(r2, transform, w2, onDone);

// ✅ factory — fresh instance each time, no leftover listeners
const createTransform = () => new MyTransform();
pipeline(r1, createTransform(), w1, onDone);
pipeline(r2, createTransform(), w2, onDone);
```

</details>
<br>

<details>
<summary>74. How do you convert between Node.js streams and Web Streams API?</summary>

Node.js streams and Web Streams (`ReadableStream`, `WritableStream`) are two separate APIs. Bridge methods convert between them:

```js
// Node → Web
const webReadable = stream.Readable.toWeb(nodeReadable);
const webWritable = stream.Writable.toWeb(nodeWritable);

// Web → Node
const nodeReadable = stream.Readable.fromWeb(webReadable);
const nodeWritable = stream.Writable.fromWeb(webWritable);
```

Real world: `fetch` response body is a Web Stream, Node.js built-ins (`fs`, `zlib`) are Node streams — bridge them to pipe fetch response directly to disk:

```js
const { body } = await fetch("https://example.com/large-file");
// body is a Web ReadableStream

stream.Readable.fromWeb(body)
  .pipe(zlib.createGunzip())
  .pipe(fs.createWriteStream("file.txt"));
```

</details>
<br>

<details>
<summary>75. What is `stream.Readable.isDisturbed()` and why use it?</summary>

Returns `true` if a stream has already been consumed (read, piped, resumed) or cancelled — `false` if completely untouched.

Use it to guard against silently reading an already-drained stream, which would give you empty data with no error:

```js
if (stream.Readable.isDisturbed(req)) {
  return res.status(400).send("request body already read");
}
```

</details>
<br>

<details>
<summary>76. What is `writable._writev()` and when does it matter?</summary>

When extending `Writable`, you implement `_write` to handle one chunk at a time — it is required:

```js
class MyWritable extends Writable {
  _write(chunk, encoding, callback) {
    fs.write(this.fd, chunk, callback); // one syscall per chunk
  }
}
```

Optionally you can also implement `_writev` — called when chunks accumulate in the buffer while the stream is busy processing a previous one:

```js
class MyWritable extends Writable {
  _writev(chunks, callback) {
    // chunks = [{ chunk, encoding }, { chunk, encoding }, ...]
    const combined = Buffer.concat(chunks.map((c) => c.chunk));
    fs.write(this.fd, combined, callback); // one syscall for all buffered chunks
  }
}
```

If both are implemented, `_writev` takes priority when multiple chunks are buffered, `_write` handles the single chunk case.

Critical for `cork()`/`uncork()` — without `_writev`, corked chunks still drain one by one via `_write` and batching gives no real gain:

```
cork() + _writev     → chunks merged, one syscall  ✅
cork() + no _writev  → chunks still one by one      ❌
```

</details>
<br>

<details>
<summary>77. What happens to a `Readable` stream when the `Writable` it is piped into emits an error?</summary>

The `Readable` is automatically unpiped from the `Writable` — but **not destroyed**. The `Readable` stops sending data to that destination but remains open and can be piped elsewhere.

```js
readable.pipe(writable);

writable.on("error", (err) => {
  // writable errored — readable is now unpiped
  // but readable is still alive, you can re-pipe it
  readable.pipe(fallbackWritable);
});
```

Note: the `Writable` itself is not automatically destroyed either — you need to handle cleanup manually to avoid resource leaks:

```js
writable.on("error", (err) => {
  writable.destroy(); // clean up writable explicitly
  readable.destroy(); // clean up readable if you don't need it anymore
});
```

Use `stream.pipeline` instead of manual `pipe` if you want automatic cleanup of all streams on error.

</details>
<br>

<details>
<summary>78. Why does `Buffer.toString()` break with multi-byte characters and how does `StringDecoder` fix it?</summary>

`Buffer.toString()` is stateless — decodes each buffer in isolation with no memory of previous chunks. Multi-byte characters like `€` (3 bytes: `0xE2 0x82 0xAC`) can arrive split across chunks:

```js
chunk1.toString("utf8"); // '??' — incomplete character, garbage
chunk2.toString("utf8"); // '?'  — orphaned byte, garbage
```

`StringDecoder` fixes this by holding incomplete bytes internally until enough arrive to form a complete character:

```js
const decoder = new StringDecoder("utf8");

decoder.write(Buffer.from([0xe2, 0x82])); // '' — holds bytes, not enough yet
decoder.write(Buffer.from([0xac])); // '€' — character complete
```

Always call `decoder.end()` when the source is exhausted — flushes any bytes still held in the internal buffer:

```js
_final(callback) {
  this.data += this._decoder.end(); // flush remainder
  callback();
}
```

Not stream-specific — useful anywhere you assemble a string from buffers chunk by chunk: sockets, files, any binary source.

</details>
<br>

<details>
<summary>79. What happens if you push a zero-length buffer or empty string in `_read()` when extending `Readable`?</summary>

When extending `Readable`, never push zero-length values in `_read()` — `_read()` won't be called again and the stream silently stalls. Not ended, not progressing, no error thrown:

```js
class MyReadable extends Readable {
  _read(size) {
    this.push(Buffer.alloc(0)); // ⚠️ deadlock — stream hangs silently forever
    this.push(""); // ⚠️ same problem

    this.push(null); // ✅ clean EOF
    this.push(Buffer.alloc(8)); // ✅ zero-filled but non-empty — valid data
  }
}
```

</details>
<br>

<details>
<summary>80. What is net.Socket in Node.js, what stream type does it extend, and how is it normally obtained?</summary>

net.Socket is Node's abstraction over a single connected endpoint: either a TCP connection or a streaming IPC endpoint (named pipes on Windows, Unix domain sockets elsewhere). It extends stream.Duplex, so it is readable and writable at the same time, supports pipe()/backpressure, and inherits the EventEmitter API ('data', 'end', 'error', 'close', ...).

There are two normal ways to get one. Client side: net.createConnection() (or new net.Socket() followed by socket.connect()) returns a socket you use to talk to a server. Server side: Node constructs the socket for an accepted connection and passes it to the 'connection' listener of a net.Server.

```js
const net = require("node:net");

// Client: Node creates and connects the socket for you.
const client = net.createConnection({ port: 8000, host: "127.0.0.1" }, () => {
  client.write("ping");
});
client.on("data", (chunk) => console.log(chunk.toString()));

// Server: Node hands you an already-connected socket.
const server = net.createServer((socket) => {
  socket.pipe(socket); // echo
});
server.listen(8000);
```

Gotcha: socket.connect() exists but is rarely needed directly; it is intended for custom Socket subclasses or for reconnect logic on a socket you constructed yourself. Because a socket is a Duplex, calling socket.end() only half-closes it (sends FIN, stops writing); the readable side can still emit data until the peer closes. Use socket.destroy() to tear it down immediately.

</details><br>

<details>
<summary>81. How can a connected TCP socket be handed to another thread in Node.js, and what happens to the original socket?</summary>

A connected TCP net.Socket can be listed in the transferList of a worker_threads postMessage() call. The underlying OS handle moves to the receiving thread: the source socket is destroyed on the sending thread (any further use rejects with ERR_STREAM_DESTROYED rather than silently discarding data), and the socket continues to work normally on the receiving thread. This lets one thread accept connections and distribute them across a worker pool, i.e. a node:cluster-like model built on worker threads instead of processes.

```js
const net = require("node:net");
const { Worker } = require("node:worker_threads");

const worker = new Worker("./worker.js"); // receives { socket } messages

const server = net.createServer((socket) => {
  worker.postMessage({ socket }, [socket]); // socket must be in the transferList
});
server.listen(8000);
```

A listening net.Server can be transferred the same way, which moves the listening socket and its pending accept queue to the receiving thread.

Gotcha: this is a recent addition to net (Node.js 24 line); on older runtimes the socket is simply not transferable and postMessage() throws. Because the send destroys the source socket, do not attach handlers or write to it after transferring, and never transfer the same socket twice. Errors surface as ERR_STREAM_DESTROYED, so a "socket vanished" symptom in the accepting thread is usually a use-after-transfer bug.

</details><br>

<details>
<summary>82. How does TCP keep-alive differ from HTTP keep-alive, and why does confusing them cause bugs?</summary>

In one line: TCP keep-alive asks "is this wire still connected?", HTTP keep-alive says "let's reuse this wire for several requests". They share a name and nothing else - enabling one does not enable the other.

TCP keep-alive is a low-level heartbeat that lives in the OS network stack, enabled per socket with socket.setKeepAlive(). Once the connection has been idle for the configured delay, the kernel sends a tiny empty probe segment to the peer - no application data, just "you still there?". If several probes in a row go unanswered, the OS declares the connection dead and tears it down. Its two jobs are detecting a peer that vanished without a proper close, and generating enough traffic that routers, NAT boxes, and firewalls do not silently drop the connection from their state tables.

HTTP keep-alive (persistent connections) is an application-level decision that has nothing to do with probing. Without it, every HTTP request opens a fresh TCP connection, does one request/response, and closes it - slow and wasteful, since every request repays the TCP handshake and any TLS handshake. HTTP keep-alive instead leaves the connection open so the next request/response can go over the same one. In Node it is controlled by entirely separate knobs: http.Agent({ keepAlive: true }) pools connections on the client, and server.keepAliveTimeout decides how long the server holds an idle persistent connection open.

```js
const http = require("node:http");

// HTTP layer: reuse one connection for many requests (client side)
const agent = new http.Agent({ keepAlive: true, maxSockets: 50 });

// HTTP layer: how long the server holds an idle persistent connection
const server = http.createServer(handler);
server.keepAliveTimeout = 5000;

// Transport layer: probe whether the peer is still alive - completely separate
server.on("connection", (socket) => socket.setKeepAlive(true, 30000));
```

Gotcha - the classic production failure. Setting keepAlive: true on an http.Agent does not turn on TCP probes, so nothing on the client is ever checking whether a pooled connection is still alive. A load balancer, proxy, or NAT box on the path drops the idle connection after its own timeout without sending a FIN or RST, so the client never learns about it. The connection sits in the pool looking perfectly healthy, and the next request that picks it up fails with ECONNRESET or simply hangs until a timeout. This is the usual explanation for random intermittent connection errors in Node services behind a load balancer, and it looks non-deterministic because it depends on which pooled socket the next request happens to grab.

The fix is to make sure you close idle connections before the middlebox does: set the HTTP-layer idle timeout (server.keepAliveTimeout, plus the matching client-side idle timeout) shorter than the shortest idle timeout of any hop on the path, and optionally enable TCP keep-alive as a backstop. One naming trap while doing this: http.Agent's keepAliveMsecs is the TCP keep-alive initial delay applied to pooled sockets, not the HTTP idle timeout - it does not control how long a connection stays in the pool.

</details><br>

<details>
<summary>83. What exactly does socket.setTimeout() do in Node.js, and does it close the connection?</summary>

It arms an idle-inactivity timer: if no activity occurs on the socket for the given number of milliseconds, the socket emits a 'timeout' event. By default net.Socket has no timeout. Crucially, the connection is not severed - Node only notifies you. The socket remains open and usable until you explicitly call socket.end() for a graceful half-close or socket.destroy() to tear it down. Passing 0 disables an existing idle timeout. The optional callback argument is registered as a one-time 'timeout' listener. The method returns the socket.

```js
socket.setTimeout(3000);
socket.on("timeout", () => {
  console.log("socket timeout");
  socket.end(); // nothing closes unless you do this
});

// Equivalent one-shot form:
socket.setTimeout(3000, () => socket.destroy());
```

Gotcha: it is an inactivity timer, not a total-duration or deadline timer. The clock resets on every read or write, so a peer that trickles one byte per second keeps the connection alive forever under any setTimeout value. It also does not fire an 'error' event, so a handler that only listens for 'error' and 'close' will never see the timeout, and the socket can sit open indefinitely leaking a file descriptor. And because 'timeout' does not close the socket, forgetting the end()/destroy() call is the single most common way this API is misused.

</details><br>

<details>
<summary>84. Is socket.setTimeout() sufficient protection against slow-request (Slowloris-style) attacks on an HTTP server?</summary>

No, and treating it as sufficient is an outdated framing. Because setTimeout() measures inactivity and resets on every byte, an attacker who sends a single header byte just under the timeout interval keeps hundreds of connections alive indefinitely and exhausts the server's connection capacity.
s
The current answer is total-duration limits, which are on by default rather than optional. http.Server.headersTimeout bounds the time allowed to receive the complete request headers, and http.Server.requestTimeout bounds the time allowed to receive the entire request including its body. requestTimeout was introduced in Node.js 14.11.0 defaulting to 0 (disabled), and was changed to default to 300000 ms in Node.js 18.0.0 (April 2022); headersTimeout defaults to 60000 ms.

```js
const http = require("node:http");
const server = http.createServer(handler);

server.headersTimeout = 10000; // full headers must arrive within 10s
server.requestTimeout = 30000; // full request must arrive within 30s
server.keepAliveTimeout = 5000; // idle persistent connection lifetime
```

Gotcha: these are deadlines, not inactivity timers, which is exactly why they defeat trickle attacks that setTimeout() cannot. Do not set requestTimeout to 0 to "fix" large uploads - raise it to a bounded value instead, or the Slowloris protection is gone. Also make sure requestTimeout is greater than headersTimeout, and remember that these apply to http.Server only; a raw net.Server needs equivalent deadline logic implemented by hand with setTimeout/clearTimeout around the parse phase.

</details><br>

<details>
<summary>85. What is the difference between String.prototype.length and Buffer.byteLength(string, encoding), and when does it matter?</summary>

String.prototype.length counts UTF-16 code units in the JavaScript string. Buffer.byteLength(string, encoding) counts how many bytes that string occupies once serialized with the given encoding (default 'utf8'). They only agree for pure ASCII text in a single-byte-per-char encoding.

```js
const s = "hello";
s.length; // 5
Buffer.byteLength(s, "utf8"); // 5

const t = "héllo";
t.length; // 5  (5 UTF-16 code units)
Buffer.byteLength(t, "utf8"); // 6  ('é' is 2 bytes in UTF-8)

"😀".length; // 2  (surrogate pair)
Buffer.byteLength("😀", "utf8"); // 4
```

This matters for anything expressed in bytes: Content-Length, framing lengths, size limits, offsets into a Buffer.

```js
const body = JSON.stringify({ name: "José" });
res.setHeader("Content-Length", Buffer.byteLength(body)); // correct
// res.setHeader('Content-Length', body.length);          // wrong: truncates or hangs the response
```

Gotcha: Buffer.byteLength also accepts a Buffer, TypedArray, DataView or ArrayBuffer and then simply returns its .byteLength, ignoring the encoding argument. So passing an already-encoded value is safe but the encoding argument silently does nothing.

</details><br>

<details>
<summary>86. In the Node.js http module, how do response.setHeader() and response.writeHead() interact, and what is the required call order?</summary>

setHeader(name, value) stores a header in an internal, mutable map; it can be called repeatedly and read back with getHeader()/getHeaders() and removed with removeHeader(). writeHead(statusCode[, statusMessage][, headers]) finalizes the status line plus headers and marks them as sent. Therefore every setHeader() call must happen before writeHead() (and before the first write()/end(), which trigger implicit headers).

```js
res.setHeader("X-Request-Id", id);
res.setHeader("Content-Type", "text/plain");
res.writeHead(200, { "Content-Type": "application/json" }); // wins over the setHeader value
res.end(body);

res.setHeader("X-Late", "1"); // throws ERR_HTTP_HEADERS_SENT
```

Merge rule: headers set with setHeader() are merged with the object passed to writeHead(), and writeHead()'s values take precedence.

Gotcha: if setHeader() was never called, the headers passed to writeHead() are written straight to the wire without being cached internally, so getHeader()/getHeaders() will not report them. Use setHeader() when you need headers to remain readable or modifiable later, for example in middleware.

Since Node.js 11.10.0 writeHead() returns the response object, so chaining works: res.writeHead(204).end(). Check res.headersSent before attempting any header mutation in error handlers.

</details><br>

<details>
<summary>87. When you call readable.pipe(writable), what happens to the writable stream once the source ends?</summary>

By default pipe() calls writable.end() automatically when the readable emits 'end'. That is why streaming a file to an HTTP response needs no explicit close: the response is ended for you when the file is fully read.

```js
fs.createReadStream(path).pipe(res); // res.end() is called automatically
```

Pass { end: false } to keep the destination open, which is required when several sources feed one destination sequentially:

```js
a.pipe(dest, { end: false });
a.on("end", () => b.pipe(dest)); // the last pipe ends dest
```

Gotchas: process.stdout and process.stderr are never ended by pipe(), regardless of the option, because they stay open for the process lifetime. And the auto-end only fires on a clean 'end'; if the source errors or is destroyed, the destination is left dangling, which is the core reason pipe() alone is not enough in production code.

</details><br>

<details>
<summary>88. Why is readable.pipe() discouraged for production code, and what should be used instead?</summary>

pipe() is not removed or formally deprecated, but Node.js documentation has recommended stream.pipeline() over it since Node 10 (2018), and the promise form since Node 15 (2020). pipe() has two concrete defects: it does not forward errors, and it does not destroy the other streams on failure.

The consequences are real. An 'error' on the source or destination has no listener attached by pipe(), so it becomes an uncaught exception that crashes the process. If the destination fails, the source is never destroyed, leaking file descriptors and sockets. A destination that errors mid-transfer leaves a half-written file with no signal.

```js
// Discouraged:
src.pipe(dest);

// Node 15+, recommended:
const { pipeline } = require('node:stream/promises');
await pipeline(src, transform, dest);

// Node 10+, callback form:
const { pipeline } = require('node:stream');
pipeline(src, transform, dest, (err) => { if (err) ... });
```

pipeline() propagates errors to one place, destroys every stream in the chain on failure or early termination, and accepts an AbortSignal via { signal } for cancellation.

Gotcha: pipeline() returning successfully means the data reached the destination stream, not that it was durably written. For a file, fsync separately if durability matters.

</details><br>

<details>
<summary>89. What is the simplest built-in way to consume an entire readable stream into a Buffer in modern Node.js?</summary>

The node:stream/consumers module, added in Node.js 16.7.0, provides helpers that consume a whole stream and resolve to a single value: buffer(), arrayBuffer(), blob(), text() and json().

```js
const { buffer, text, json } = require("node:stream/consumers");

const buf = await buffer(readable); // Buffer
const str = await text(readable); // string, decoded as UTF-8
const obj = await json(readable); // parsed JSON
```

They accept any of a Node stream.Readable, a web ReadableStream, or an async iterable, which makes them the one API that works across both stream worlds.

Gotchas: they buffer the entire stream in memory, so never apply them to untrusted input without an independent size limit. The returned promise rejects if the stream errors, and the stream is fully consumed, so it cannot be read again afterwards. text() and json() always decode as UTF-8 and ignore any charset declared elsewhere.

</details><br>

<details>
<summary>90. How do you collect a readable stream into a Buffer without any helper module?</summary>

A Node readable stream is an async iterable, so iterate it, push each chunk into an array, and concatenate once at the end. This works on every Node version that supports for await and has no dependencies.

```js
async function streamToBuffer(stream) {
  const chunks = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

On Node.js 22 and newer the same thing is a one-liner, because Array.fromAsync drains an async iterable into an array:

```js
const buf = Buffer.concat(await Array.fromAsync(readable));
```

Gotcha: Buffer.concat requires every element to be a Buffer or Uint8Array. If stream.setEncoding() was called, the chunks arrive as strings and Buffer.concat throws a TypeError; either drop setEncoding and decode at the end, or join the strings instead. The same applies to object-mode streams, whose chunks are arbitrary values. Also note that concatenating copies the data, so peak memory is roughly twice the payload size at the moment of the concat.

</details><br>

<details>
<summary>91. What is the security risk of buffering a whole request stream into memory, and how is it mitigated?</summary>

Reading an incoming stream to completion allocates memory proportional to what the sender chooses to send. For any network-facing stream this is an unbounded allocation controlled by an attacker, and a handful of slow, very large uploads exhausts the heap and takes the process down. This is a denial-of-service class issue, not a theoretical one, and it applies equally to a manual chunk loop, stream/consumers, and any body parser.

Do not trust the Content-Length header alone; it can be absent under chunked transfer encoding, or simply lie. Count the bytes you actually receive and destroy the stream when the cap is exceeded.

```js
async function readCapped(stream, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of stream) {
    size += chunk.length;
    if (size > limit) {
      stream.destroy();
      throw Object.assign(new Error("Payload too large"), { statusCode: 413 });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
```

Respond with 413 Payload Too Large when the cap trips. Mainstream frameworks have shipped a default limit for exactly this reason (Express's express.json defaults to 100kb), so raw http handlers must supply their own rather than assuming one exists.

Gotcha: the cap must also cover the decompressed size if you inflate a gzip body, otherwise a small compressed payload can expand into gigabytes (a zip bomb).

</details><br>

<details>
<summary>92. How do you get a Buffer from a fetch() response body, and how do web streams relate to Node streams?</summary>

fetch() is WHATWG-standard, so response.body is a web ReadableStream, not a Node stream.Readable. It has no 'data' events and no pipe() method. The Response object exposes its own consumption helpers, which is the direct route to bytes:

```js
const res = await fetch(url);
const buf = Buffer.from(await res.arrayBuffer());
// or: await res.text(), await res.json(), await res.bytes() (Node 22+, returns Uint8Array)
```

To cross between the two stream worlds, use the adapters on stream.Readable, available since Node.js 17:

```js
const { Readable } = require("node:stream");
const nodeStream = Readable.fromWeb(res.body); // web -> Node
const webStream = Readable.toWeb(nodeStream); // Node -> web
```

Gotchas: Buffer.from(arrayBuffer) creates a view that shares memory with the ArrayBuffer rather than copying, so mutating the Buffer mutates the underlying buffer; use Buffer.from(new Uint8Array(ab)) if you need an independent copy. arrayBuffer() buffers the whole response in memory, so the size-limit rule applies. A response body can only be consumed once; call res.clone() first if you need it twice.

</details><br>

<details>
<summary>93. Why does a server send multiple Set-Cookie headers while a client sends only one Cookie header?</summary>

The two directions of cookie transport use deliberately different shapes, defined in RFC 6265.

Server to client: one Set-Cookie header line per cookie. Set-Cookie cannot be folded into a single comma-separated list the way ordinary HTTP headers can, because the Expires attribute contains a comma in its date format ("Expires=Wed, 09 Jun 2027 10:18:14 GMT"), which would make the list unparseable.

```
Set-Cookie: sessionId=abc123; HttpOnly; Secure; Path=/; Max-Age=3600
Set-Cookie: theme=dark; Secure; Path=/; Max-Age=86400
```

Client to server: one Cookie header carrying all applicable name=value pairs joined by "; ", with no attributes. Attributes such as Path, HttpOnly and Max-Age are instructions to the browser only and are never echoed back.

```
Cookie: sessionId=abc123; theme=dark
```

Gotcha: because attributes are not sent back, a server cannot tell from the Cookie header which domain or path a cookie came from, nor whether it was set as Secure. Two different cookies with the same name from different paths both appear, indistinguishable, in the same Cookie header. Cookie prefixes exist specifically to work around this blindness.

</details><br>

<details>
<summary>94. How do you read headers that appear multiple times in an incoming HTTP message?</summary>

In the Node http module, request.headers and response.headers are lowercased objects where duplicates have already been collapsed, and the collapsing rule depends on the header:

set-cookie is always an array, even when there is exactly one value. A small set of headers including host, authorization, content-length and user-agent discard duplicates and keep only the first. Everything else is joined into a single string with ", ".

```js
res.headers["set-cookie"]; // ['a=1; Path=/', 'b=2; Path=/']  (always an array)
res.headers["accept"]; // 'text/html, application/json'   (joined)
req.rawHeaders; // flat [name, value, name, value, ...], nothing collapsed
```

Use rawHeaders when the original casing, ordering or exact duplication matters, for example when proxying.

Gotcha: never split a set-cookie string on commas yourself. Expires dates contain commas, so naive splitting produces broken cookie fragments.

</details><br>

<details>
<summary>95. What does the Vary response header do in HTTP caching?</summary>

A cache keys a stored response by request method and URL. Vary extends that key: it lists the request headers whose values must also match before a stored response may be reused. It exists because content negotiation lets one URL return different bytes depending on what the client asked for, and without Vary the cache would hand the wrong variant to the next client.

```
GET /page
Accept-Encoding: gzip

200 OK
Content-Encoding: gzip
Cache-Control: max-age=3600
Vary: Accept-Encoding
```

Now the cached entry is only reused for a later request whose Accept-Encoding value matches; a client that cannot decompress gets a fresh request instead of a gzip body it cannot read. Multiple headers are comma separated, for example Vary: Accept-Encoding, Accept-Language.

The rule of thumb: any request header your server branches on when producing the response body must appear in Vary. This applies to the private browser cache and to shared caches such as CDNs and reverse proxies alike.

Security gotcha: when you reflect the request Origin into Access-Control-Allow-Origin, you must send Vary: Origin. Without it a shared cache stores one response containing another site's origin and replays it, which either breaks CORS or leaks a cross-origin response to a site that was never allowed to read it.

Performance gotchas: Vary: \* means the response is never reusable from cache. Vary: User-Agent is close to that in practice, because user agent strings are near unique, so it fragments the cache into single-use entries. Vary: Cookie has the same effect for logged-in traffic, and is dangerous if any part of the response is user specific but the cache is shared; prefer Cache-Control: private or no-store for per-user responses. Matching is done on the raw header value, so "gzip, deflate" and "deflate, gzip" count as different variants.

</details><br>

<details>
<summary>96. How do ETag and If-None-Match revalidate a stale cached response?</summary>

ETag is an opaque version identifier the server attaches to a response. Its content is entirely up to the server, commonly a hash of the body or a revision number. The client stores it with the cached copy and, once that copy goes stale, sends it back in If-None-Match instead of re-downloading blindly.

```
HTTP/1.1 200 OK
ETag: "33a64df5"
Cache-Control: max-age=3600

GET /index.html HTTP/1.1
If-None-Match: "33a64df5"

HTTP/1.1 304 Not Modified      // unchanged: no body, client reuses its cached copy
HTTP/1.1 200 OK                // changed: new ETag plus the full new body
```

The win is bandwidth: an unchanged resource costs one small header exchange rather than the whole payload. The response is still a round trip, so it does not remove latency the way a fresh max-age hit does.

Gotchas: the value must be sent in double quotes, and a leading W/ marks a weak validator ("same meaning" rather than byte identical), which cannot be used for range requests. A 304 carries no body but should repeat headers that update freshness, such as Cache-Control and ETag. If both ETag and Last-Modified are present, the server compares If-None-Match first, because Last-Modified has only one-second resolution and misses rapid edits.

</details><br>

<details>
<summary>97. What makes a cookie a session cookie, and how long does it actually live?</summary>

A cookie set with neither Max-Age nor Expires is a session cookie. It is deleted when the current session ends. Any cookie that does carry one of those attributes is a permanent cookie instead.

```
Set-Cookie: sessionId=abc123; HttpOnly; Secure; Path=/            // session cookie
Set-Cookie: sessionId=abc123; HttpOnly; Secure; Max-Age=3600      // permanent, 1 hour
```

Gotcha: what counts as the end of the "current session" is defined by the browser, not by the standard. Some browsers restore the previous session when restarting, which restores the session cookies with it, so a session cookie can in practice last indefinitely. Closing the browser is not a reliable way to end a session.

</details><br>

<details>
<summary>98. What does the If-Range request header do, and why is it needed to resume an interrupted download?</summary>

If-Range makes a Range request conditional on the resource not having changed. The client sends the validator it received with the bytes it already holds. If the validator still matches, the server honours the Range and answers 206 Partial Content with just the requested bytes. If it no longer matches, the server ignores the Range and answers 200 OK with the entire resource, so the client throws away its partial data and restarts from scratch.

```
GET /big.iso HTTP/1.1
Range: bytes=1048576-
If-Range: "33a64df5"

HTTP/1.1 206 Partial Content        // unchanged: append these bytes to what we have
Content-Range: bytes 1048576-4194303/4194304

HTTP/1.1 200 OK                     // changed: full body, discard the partial file
Content-Length: 5242880
```

Without it, resuming is unsafe: a plain Range request against a resource that changed since the first fragment silently splices bytes from two different versions into one corrupt file. The choice of 200 rather than an error status is what makes this a single round trip. Compare If-Match, which answers 412 Precondition Failed on a mismatch and forces the client to issue a second request for the full resource.

Gotchas: the validator must be a strong one. A weak ETag (W/"...") is compared with the strong comparison function and therefore never matches, so it always degrades to a full 200; Last-Modified may be used instead of an ETag but only when the server can treat the date as strong, since its one-second resolution can hide an edit. Use one validator or the other, never both. If-Range is ignored unless the same request also carries a Range header, and clients must not send it without one.

</details><br>

<details>
<summary>99. How do HTTP range requests and chunked Transfer-Encoding differ, and can they be used together?</summary>

They solve opposite problems and are orthogonal. A range request is client driven: the resource has a known total size and the client asks for a subset of it, which is what makes seeking in a video, resuming a download, and reading a slice of a large file possible. Chunked transfer encoding is server driven framing: the body is sent as a sequence of length-prefixed chunks terminated by a zero-length chunk, so the server can start writing before it knows the total length, without buffering the whole response to compute Content-Length. Chunked improves time to first byte; Range reduces how much is transferred.

```
HTTP/1.1 206 Partial Content        // Range: a known-size resource, a subset of it
Content-Range: bytes 0-1023/146515
Content-Length: 1024

HTTP/1.1 200 OK                     // chunked: unknown total length, no Content-Length
Transfer-Encoding: chunked

1a
<first chunk of 26 bytes>
0

```

They are compatible in either combination, including together: a 206 response may itself be chunked, in which case it carries Content-Range but no Content-Length.

Current-practice gotcha: Transfer-Encoding is HTTP/1.1 only. HTTP/2 (RFC 9113, 2022) and HTTP/3 (RFC 9114) forbid it as a connection-specific header field, because framing is native to the protocol: a response streams as DATA frames ending with END_STREAM, so unknown-length bodies need no special header. Over those versions, only the Range mechanism from this card still applies.

Other gotchas: chunked is applied by Node automatically when you write a response body without setting Content-Length, so it is usually not something you opt into explicitly. A response generated on the fly under chunked encoding is generally not resumable with Range, because there is no stable stored representation to take a byte offset into.

</details><br>

<details>
<summary>100. How do you implement Range support for a file in a raw Node.js http handler?</summary>

Node's http module does nothing with the Range header; you have to advertise support, parse the header, and build the 206 yourself. The pieces are Accept-Ranges: bytes on the normal response, a parsed start and end, Content-Range plus a Content-Length covering only the slice, and fs.createReadStream with start and end options.

```js
const fs = require("node:fs");
const { stat } = require("node:fs/promises");
const { pipeline } = require("node:stream/promises");

function parseSingleRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return null; // multi-range or unknown unit: ignore it
  const [, s, e] = m;
  let start, end;
  if (s === "") {
    // bytes=-500 means the last 500 bytes
    if (e === "") return null;
    start = Math.max(0, size - Number(e));
    end = size - 1;
  } else {
    start = Number(s);
    end = e === "" ? size - 1 : Math.min(Number(e), size - 1);
  }
  if (start > end || start >= size) return "unsatisfiable";
  return { start, end };
}

async function serveFile(req, res, path, type) {
  const { size } = await stat(path);
  res.setHeader("Accept-Ranges", "bytes");
  res.setHeader("Content-Type", type);

  const parsed = req.headers.range && parseSingleRange(req.headers.range, size);

  if (parsed === "unsatisfiable") {
    res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
    return;
  }
  if (!parsed) {
    // no or unsupported Range: send it all
    res.writeHead(200, { "Content-Length": size });
    await pipeline(fs.createReadStream(path), res);
    return;
  }

  const { start, end } = parsed;
  res.writeHead(206, {
    "Content-Length": end - start + 1,
    "Content-Range": `bytes ${start}-${end}/${size}`,
  });
  await pipeline(fs.createReadStream(path, { start, end }), res);
}
```

Gotchas: Accept-Ranges must be on the plain 200 response too, otherwise clients never attempt a range in the first place. Never derive the reply from an unvalidated header value; feeding the parsed numbers straight into a stream without clamping them against the real file size is how you get either a hang or an unsatisfiable read. Pair this with ETag or Last-Modified so clients can send If-Range, since the file may change between two requests.

</details><br>

<details>
<summary>101. What is http.Agent responsible for, and what decides whether a socket is pooled or destroyed after a response completes?</summary>

An Agent manages connection persistence and reuse for HTTP client requests. Per host and port it keeps a queue of pending requests and serves them over a single socket until the queue is empty. What happens to the socket then depends on the keepAlive option: with keepAlive it goes into a pool of free sockets and waits to be reused by a later request to the same host and port, without it the socket is destroyed and the next request opens a new connection.

```js
const http = require("node:http");

const agent = new http.Agent({
  keepAlive: true, // pool the socket after the response instead of destroying it
  keepAliveMsecs: 5_000, // how long an idle pooled socket is kept
  maxSockets: 10, // concurrent sockets per host:port; default Infinity
  maxFreeSockets: 256, // idle sockets retained per host:port
});

http.get({ host: "example.com", path: "/", agent }, (res) => res.resume());
```

The saving is per reuse: a pooled socket skips the TCP three-way handshake, the TLS handshake for HTTPS, and the slow-start ramp, which for a chatty client dominates the cost of small requests.

Two things are outside the client's control. A server may close a pooled idle connection at any time, in which case it is removed from the pool and the next request dials a new one; and a server may refuse to serve more than one request per connection, in which case nothing is poolable and every request gets a fresh connection. The Agent still works in both cases, it just loses the reuse.

Currency gotcha: the default flipped. Up to Node.js 18, http.globalAgent used keepAlive: false, so code that never configured an Agent paid a new handshake per request. Since Node.js 19.0.0 (October 2022) the global agents have keepAlive: true with idle sockets kept for about 5 seconds, so reuse is now the default behaviour and advice written before that is inverted.

Other gotcha: TCP Keep-Alive, which pooled sockets enable, is unrelated to HTTP keep-alive. TCP Keep-Alive sends probe packets to detect a dead peer; HTTP keep-alive is the decision to send another request over an already-open connection.

</details><br>

<details>
<summary>102. How do you keep one long-lived HTTP request from occupying a slot in the agent's connection pool, and why should an unused Agent be destroyed?</summary>

An Agent does bookkeeping on every socket it hands out. A socket serving a request is tracked in agent.sockets, and a socket counts against maxSockets for as long as it is tracked there; when the response finishes it moves to agent.freeSockets for reuse, or is destroyed. A socket leaves this bookkeeping entirely when it emits either 'close' (its normal end of life) or 'agentRemove'.

That matters for a request that stays open for minutes or hours, such as a server-sent-events stream, a long poll, or a huge download. It holds its slot the whole time, so with a bounded maxSockets a handful of such requests can starve every other request to that host, which then queues indefinitely with no timeout of its own. 'agentRemove' is the documented escape hatch: it is not a TCP-level event, it is an internal signal the Agent listens for, and you emit it yourself on the socket to make the Agent forget the socket.

```js
http
  .get({ host: "example.com", path: "/events", agent }, (res) => {
    res.on("data", handleEvent); // stays open indefinitely
  })
  .on("socket", (socket) => {
    socket.emit("agentRemove"); // agent stops tracking it from here on
  });
```

The request itself is unaffected: the socket keeps working and the response streams normally. Only the Agent's ownership is severed, so the socket no longer counts towards maxSockets and will never be returned to the free pool when it eventually ends. The 'socket' event is the right hook because it fires when a socket is actually assigned to the request, which may be later than the call itself if the request had to queue.

The other half is cleanup. Idle pooled sockets are unrefed, so they do not keep the process alive when nothing is outstanding, but they still hold an operating-system file descriptor and a connection slot on the server. Unref only removes the event-loop reference; it does not close anything, and an Agent that becomes unreachable does not release its sockets either, because garbage collection has no bearing on open handles. Hence the practice of calling agent.destroy() when an Agent is no longer in use.

Gotchas: this makes the connection single use, so do not reach for 'agentRemove' as a general way to opt out of pooling; agent: false is the tool for that. And an Agent created per request or per user and then dropped leaks connections until each socket happens to time out, which is the usual cause of a slowly climbing file-descriptor count in a client-heavy process.

</details><br>

<details>
<summary>103. Does fetch() in Node.js use http.Agent, and how is its connection pooling configured?</summary>

No. Node's global fetch is implemented by undici, which has its own connection management built on a Dispatcher, with Agent and Pool implementations of that interface. It never consults node:http, so http.globalAgent, a custom Agent, maxSockets, keepAlive and the agent request option have no effect whatsoever on a fetch() call.

</details><br>

<details>
<summary>104. Why do requests over a keep-alive connection pool intermittently fail with ECONNRESET, and how is that handled?</summary>

It is an unavoidable race in connection reuse. The server closes an idle pooled connection when its own idle timeout expires and sends a FIN; the client, which cannot know this yet, picks that socket out of the pool and writes a request onto it. The server has already torn the connection down, so it answers with a RST, and the client surfaces ECONNRESET for a request the server application never saw. Nothing was processed, and the error says nothing about the request itself.

The race can be narrowed but not closed, so the handling is two-sided. Keep the client's idle timeout below the server's, so the client discards sockets first instead of gambling on them, and retry a request that failed at the socket level before any response byte arrived.

```js
const agent = new http.Agent({ keepAlive: true, keepAliveMsecs: 30_000 });
// nginx keepalive_timeout defaults to 75s, an AWS ALB to 60s: stay under it

function isIdleSocketFailure(err) {
  return err.code === "ECONNRESET" || err.code === "EPIPE";
}
// retry once when this fires and no response has started
```

Retry safety follows from idempotency: GET, HEAD, PUT and DELETE can be resent freely, whereas a POST may only be resent when you know it was never processed, which for this specific failure mode is exactly the case, since a reset connection carried no response at all. Do not retry on an error that arrives mid-response, because then the server did act on the request.

Currency gotcha: this failure class became far more common in code that never asked for it, because keepAlive went from off to on by default for the global agents in Node.js 19.0.0. A client that worked for years without retry logic can start seeing occasional resets purely from a Node upgrade.

</details><br>

<details>
<summary>105. What is an HTTP trailer section, and what problem does it solve that ordinary headers cannot?</summary>

A trailer section is a block of header-like fields sent after the message body instead of before it. Ordinary headers must be fully written before the first byte of the body, so they can only carry values that are known up front. A trailer carries metadata that can only be computed once the body has finished streaming.

The canonical cases are an integrity digest over content that is generated on the fly, a final status for an operation whose success is not known until the last row is produced, and post-hoc metrics such as the number of records actually emitted.

```js
const hash = crypto.createHash("sha256");
res.writeHead(200, { "Content-Type": "application/json", Trailer: "Digest" });
for await (const row of rows) {
  const chunk = JSON.stringify(row) + "\n";
  hash.update(chunk);
  res.write(chunk); // body goes out before the digest exists
}
res.addTrailers({ Digest: "sha-256=" + hash.digest("base64") });
res.end(); // end() flushes the trailer section
```

The alternative without trailers is to buffer the whole response in memory to compute the digest first, which defeats the point of streaming.

Gotcha: trailers are advisory metadata, not a place to put anything the receiver needs in order to start processing the body, because by definition the receiver has already consumed the entire body before it sees them.

</details><br>

<details>
<summary>106. How do trailers work in HTTP/2 and HTTP/3, where there is no chunked transfer encoding?</summary>

Chunked transfer encoding does not exist in HTTP/2 or HTTP/3; framing is handled by the protocol itself. Trailers are instead a second HEADERS frame sent after the DATA frames, carrying the END_STREAM flag. There is no Content-Length restriction and no announcement requirement, so trailers are structurally cheaper and more reliable than in HTTP/1.1.

```js
// node:http2 compatibility API
server.on("request", (req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.write(payload);
  res.addTrailers({ digest: "sha-256=..." }); // h2 field names must be lowercase
  res.end();
});
```

The most widespread production use of trailers is gRPC, which runs over HTTP/2 and puts its final call status in the trailer fields grpc-status and grpc-message. That is what makes a server-streaming gRPC call able to report a mid-stream failure after it has already sent a 200 and some data.

Gotcha: HTTP/2 requires lowercase field names, and a proxy translating HTTP/2 to HTTP/1.1 must reintroduce chunked encoding to carry the trailers, which is a common place for them to be lost.

</details><br>

<details>
<summary>107. How does a server cancel in-flight work when the client disconnects mid-request?</summary>

By propagating an AbortSignal tied to the request's lifetime into every downstream call. When the client goes away, the request is destroyed before completion, the signal aborts, and the database query or outbound HTTP call that is still running is torn down instead of finishing into a socket nobody is reading.

Node exposes this directly as IncomingMessage signal, added in v26.1.0. It aborts when the message is destroyed before completion, or when the underlying socket closes before request handling or response reading finishes.

```js
http
  .createServer(async (req, res) => {
    try {
      const upstream = await fetch("https://example.com/api", {
        signal: req.signal,
      });
      res.end(JSON.stringify(await upstream.json()));
    } catch (err) {
      if (err.name === "AbortError") return; // client left, nothing to answer
      res.statusCode = 500;
      res.end("Internal Server Error");
    }
  })
  .listen(3000);
```

Without this, a client that closes the tab leaves the server holding an expensive query whose result can never be delivered, which under load turns abandoned requests into real resource exhaustion.

It replaces a hand-rolled AbortController aborted from the request's close event, which was error-prone because close also fires on success, so an unguarded handler cancelled work on the happy path.

```js
// pre-v26.1.0 equivalent
const ac = new AbortController();
req.on("close", () => {
  if (!req.complete) ac.abort(); // the guard is the part people omit
});
```

The even older aborted event and message.aborted boolean have been deprecated since v16.12.0 and v17.0.0 for covering only one teardown path; the documented replacement is close plus message.destroyed.

Gotcha: the signal is created lazily on first property access, so no AbortController is allocated for handlers that never touch it. That makes the property cheap to have but means touching req.signal on every request in generic middleware reintroduces the allocation the design was avoiding.

</details><br>

<details>
<summary>108. What does the bash builtin disown do, and what problem does it solve?</summary>

When a terminal closes, the shell receives `SIGHUP` (the "hangup" signal), and an interactive bash resends `SIGHUP` to every job in its job table before exiting, which kills background jobs you started with `&`. `disown` removes a job from the shell's job table, so the shell no longer tracks it and will not forward the hangup signal. The process keeps running after you close the terminal or log out.

```sh
long_running_script.sh &    # background job, still tied to this shell
disown                      # detach the most recent background job

jobs                        # list background jobs, e.g. [1]+ Running ./script.sh &
disown %1                   # detach job number 1
disown -a                   # detach all jobs
disown -r                   # detach only running (not stopped) jobs
disown -h %1                # keep job 1 in the table but mark it to NOT receive SIGHUP
```

With `-h` the job stays visible to `jobs` and can still be brought back with `fg`, it is only shielded from `SIGHUP`.

Gotcha: `disown` does not redirect output. If the job writes to the terminal and the terminal goes away, writes fail or the process gets `SIGPIPE`, so redirect `stdout` and `stderr` to a file first (`cmd >out.log 2>&1 &`).

</details><br>

<details>
<summary>109. How does nohup differ from disown for keeping a process alive after the terminal closes?</summary>

Both protect a process from the hangup signal but at different moments. `nohup` is a command you put in front of another command before starting it: it launches the process with `SIGHUP` set to ignored and, if `stdout` is a terminal, redirects output to `nohup.out`. `disown` is a shell builtin applied after the job is already running in the background: it removes the job from the shell's job table so the shell never sends it `SIGHUP`.

```sh
nohup ./long_task.sh > task.log 2>&1 &   # decide up front, output redirected

./long_task.sh &                         # already running, decide later
disown
```

</details><br>

<details>
<summary>110. What are the sections of the Unix man pages, and how do you open a specific one?</summary>

`man` groups documentation into numbered sections because the same name can exist in several: `open` is both a shell command and a C system call. Standard Linux sections are:

- `1` (user commands);
- `2` (system calls, the kernel interface, documented as C functions with their headers such as `#include <fcntl.h>`);
- `3` (library functions, the C library, for example `printf`);
- `4` (special files in `/dev`);
- `5` (file formats and configuration files);
- `6` (games);
- `7` (miscellaneous conventions and protocols);
- `8` (system administration commands).

Some systems add 9 for kernel internals. The section number goes before the name.

```sh
man open          # first match in search order, usually section 1 if it exists
man 2 open        # the open() system call
man 3 printf      # the C library printf()
man 1 printf      # the shell printf command
man 2 syscalls    # overview list of all Linux system calls
man -k socket     # keyword search across all sections (same as apropos)
man man           # how man itself works, including the section list
```

</details><br>

<details>
<summary>111. How do you do arithmetic in bash, and what does $(( )) mean?</summary>

Bash treats everything as strings by default: `x=1+2` stores the literal text `1+2`. `$(( expression ))` is arithmetic expansion: the shell evaluates the contents as an integer expression and substitutes the result. Inside it, variable names do not need the `$` prefix. The related `(( expression ))` without the leading `$` evaluates the expression for its side effects or truth value and returns an exit status (0 if the result is non-zero), which makes it the natural form for conditions and assignments.

```sh
x=4; y=3
echo $(($x + $y))     # 7, works
echo $((x + y))       # 7, preferred: no $ needed inside
echo $((x * y ** 2))  # 36, ** is exponent
echo $((7 / 2))       # 3, integer division truncates
echo $((16#ff))       # 255, base prefix

(( x++ ))             # assignment / side effect, no output
if (( x > y )); then echo "x is bigger"; fi
```

Gotcha: bash arithmetic is 64-bit integer only. `$((1 / 3))` is `0` and `$((1.5 + 1))` is a syntax error. For decimals use `bc -l`, `awk`, or `printf '%.2f'`. Division by zero aborts the expression with an error, and leading zeros make a number octal (`$((010))` is 8).

</details><br>

<details>
<summary>112. In what order does bash resolve a command name you type?</summary>

When bash reads a command word it searches in a fixed order and runs the first match:

- aliases (if the word is an alias, and alias expansion is on, which it is only in interactive shells by default, the text is replaced and resolution restarts on the replacement);
- functions (a shell function with that exact name);
- builtins (commands implemented inside bash itself, such as `echo`, `cd`, `export`, `type`);
- executables (found by searching the directories listed in `$PATH` from left to right; bash caches the location in a hash table so later calls skip the search).

Gotcha: because functions win over `PATH` executables, a function named `node` silently shadows the real `node`. Conversely, builtins win over `PATH`, so `/usr/bin/echo` is only used if you call it by full path or via `spawn` from another program that does not use a shell.

</details><br>

<details>
<summary>113. How do bash aliases work, and how do you make one permanent?</summary>

An alias is a text substitution applied to the first word of a command before anything else is resolved. The related commands are:

- `alias name="replacement"` (defines it for the current shell process only);
- `unalias name` (removes it);
- `alias` with no arguments (lists all of them);
- `type name` (shows what a name resolves to).

Because aliases live in the shell's memory, they vanish when the shell exits and are not visible to child processes or other terminals. To make one permanent, add the definition to the startup file that interactive shells read, `~/.bashrc` for bash, then reload it with `source ~/.bashrc` or open a new terminal.

```sh
alias runplay="node /path/to/playground.js"
runplay                      # runs node /path/to/playground.js, tab completion works
type runplay                 # runplay is aliased to `node /path/to/playground.js'
unalias runplay

echo 'alias runplay="node /path/to/playground.js"' >> ~/.bashrc
source ~/.bashrc             # reload without restarting the terminal
```

</details><br>

<details>
<summary>114. How do you define, call, and remove a shell function in bash?</summary>

A shell function is a named block of commands that runs in the current shell. Arguments are available as positional parameters:

- `$1` (the first argument);
- `$2` (the second, and so on);
- `$@` (all of them);
- `$#` (their count).

Functions can be typed directly at the prompt or placed in `~/.bashrc` to persist. `declare -f name` prints a function's definition and `unset -f name` removes it (plain `unset name` also works in bash when no variable with that name exists, but `-f` is explicit and required in some shells).

```sh
greet() {
  local who="$1"            # local keeps the variable out of the global scope
  echo "Hello, $who (${#} args)"
}

greet "Alice" "extra"       # Hello, Alice (2 args)
declare -f greet            # show the definition
unset -f greet              # remove it
```

Gotcha: functions run in the caller's shell, so without `local` every assignment leaks into the global scope, and `exit` inside a function exits the whole shell rather than just the function (use `return`). The alternative keyword form `function greet { ... }` is bash-specific; the `name() { ... }` form is POSIX and works everywhere.

</details><br>

<details>
<summary>115. What is the PATH variable, how do you inspect and extend it, and why do child processes see it?</summary>

`PATH` is an environment variable holding a colon-separated list of directories. When you type a command that is not an alias, function, or builtin, the shell searches those directories left to right for an executable file with that name, so `ls` runs as `/bin/ls` or `/usr/bin/ls` because those directories are in `PATH`. The name `bin` stands for binaries. Since `PATH` is exported, every child process inherits it, which is why `process.env.PATH` in a Node program shows the same value as `$PATH` in the shell that launched it.

```sh
echo "$PATH" | tr ':' '\n'       # one directory per line
which node                       # first match in PATH
command -v node                  # same, portable

PATH="$PATH:/opt/mytools/bin"    # append for this shell session only
PATH="/opt/mytools/bin:$PATH"    # prepend so it overrides same-named commands

echo 'export PATH="$PATH:/opt/mytools/bin"' >> ~/.bashrc   # persist
```

Gotcha: order matters, because the first match wins. Version managers such as `nvm` switch Node versions by prepending the chosen version's `bin` directory to `PATH`.

</details><br>

<details>
<summary>116. What is the difference between a shell variable and an environment variable, and how are they passed to child processes?</summary>

A plain assignment `foo=123` creates a shell variable that exists only inside the current shell process. `export foo=123` marks it as an environment variable, which means it is copied into the environment of every child process the shell starts from then on. Prefixing a single command with an assignment, `foo=123 node index.js`, exports the variable for that one command only. The related commands are:

- `unset foo` (removes the variable);
- `env` or `printenv` (lists the current environment);
- `export -n foo` (turns an environment variable back into a shell-only one).

```sh
a=1
node -e 'console.log(process.env.a)'        # undefined, a was not exported

export a=1
node -e 'console.log(process.env.a)'        # 1

b=2 node -e 'console.log(process.env.b)'    # 2, only for this command
echo "$b"                                   # empty, b never existed in the shell
```

In Node, the `env` option of `spawn`, `exec`, and `fork` controls what the child receives; it defaults to `process.env`.

```js
import { spawn } from "node:child_process";
spawn("node", ["worker.js"], { env: { ...process.env, MODE: "test" } });
```

Gotcha: the `env` option replaces the whole environment instead of merging, so `env: { MODE: "test" }` alone drops `PATH` and the child may fail with `ENOENT`. Environment is copied at process start, so a parent changing its variables later has no effect on children already running, and children can never modify the parent's environment.

</details><br>

<details>
<summary>117. How does process.env behave in Node.js on Windows and inside worker threads, and what happens when you assign to it?</summary>

`process.env` is a live view of the process environment, but it has platform and threading quirks. On Windows environment variable names are case-insensitive, so `process.env.path`, `process.env.Path`, and `process.env.PATH` all read the same value; on Unix they are three different variables. Assigning any value converts it to a string, so `process.env.PORT = 3000` stores `"3000"` and `process.env.DEBUG = undefined` stores the string `"undefined"`; use `delete process.env.DEBUG` to remove a variable. Each worker thread gets its own copy of `process.env`, taken from the parent thread at creation or from the `env` option of the `Worker` constructor; changes made in one thread are invisible to the others, and only changes made in the main thread reach the operating system or native addons. On Windows the worker's copy is case-sensitive, unlike the main thread's.

```js
import { Worker, SHARE_ENV } from "node:worker_threads";

process.env.PORT = 3000;
console.log(typeof process.env.PORT); // "string"

new Worker("./w.js"); // gets a snapshot copy of process.env
new Worker("./w.js", { env: { MODE: "x" } }); // gets only this
new Worker("./w.js", { env: SHARE_ENV }); // shares the parent's object, writes visible both ways
```

Gotcha: because workers copy the environment at start, calling `process.loadEnvFile()` or setting variables after a worker exists does not affect it. On Windows `Object.keys(process.env)` returns the names in whatever case the system stored them, so code that iterates keys must compare case-insensitively to stay portable.

</details><br>

<details>
<summary>118. How are Unix file permissions displayed by ls -l, and how do you change them with chmod?</summary>

Every file has three permission sets, each with read (`r`), write (`w`), and execute (`x`) bits: one for the owning user, one for the owning group, and one for everyone else. `ls -l` prints them as a 10-character string. The first character is the file type:

- `-` (regular file);
- `d` (directory);
- `l` (symlink);
- `s` (socket);
- `p` (named pipe);
- `c` or `b` (device).

The next three triplets are user, group, and others, with `-` in place of a missing permission. `chmod` changes them either symbolically (who `u`/`g`/`o`/`a`, operator `+`/`-`/`=`, bits `rwx`) or with octal digits where `r` is 4, `w` is 2, `x` is 1.

```sh
ls -l script.sh
# -rwxr-xr--  1 alice dev  512 Oct  4 10:00 script.sh
#  ^ type   ^user ^group ^others

chmod u-rw script.sh      # remove read and write from the owner
chmod u+x script.sh       # add execute for the owner
chmod go-w script.sh      # remove write from group and others
chmod a+r script.sh       # add read for everyone
chmod 755 script.sh       # rwxr-xr-x in octal
chmod 644 notes.txt       # rw-r--r--
```

Gotcha: the symbolic form takes one operator per clause, so `chmod u-r-w` is a syntax error; write `u-rw` or `u-r,u-w`. On directories `x` means permission to enter and traverse, not to run, and `r` without `x` lets you list names but not open the files. `chown user:group file` changes ownership and usually needs `sudo`.

</details><br>

<details>
<summary>119. Does a shell script need the .sh extension, and what is required to run one directly as ./script.sh?</summary>

The `.sh` extension is only a convention for humans and editors; the kernel and the shell ignore it. A script is a text file, not a compiled executable, so something must interpret it. There are two ways to run it. Passing it to an interpreter explicitly, `bash script.sh`, works with any name and needs only read permission. Running it directly as `./script.sh` requires the execute bit (`chmod +x`) and a shebang line, `#!` followed by the interpreter path as the first line, which tells the kernel what program to launch to read the file.

```sh
#!/usr/bin/env bash
# file: deploy (no extension, still fine)
echo "deploying $1"
```

```sh
bash deploy prod          # interpreter named explicitly
chmod +x deploy
./deploy prod             # kernel reads the shebang and runs /usr/bin/env bash deploy prod
```

Gotcha: without a shebang the kernel refuses with `ENOEXEC`; an interactive bash then falls back to running the file with itself, but programs such as Node's `spawn("./script.sh")` get an error instead. A file saved on Windows with CRLF line endings fails with `bad interpreter: /bin/bash^M` because the carriage return becomes part of the interpreter path; fix with `dos2unix` or by saving with LF endings. `#!/usr/bin/env bash` finds bash via `PATH`, which is more portable than hard-coding `/bin/bash`.

</details><br>

<details>
<summary>120. What is a shebang line, how does the kernel use it, and why is #!/usr/bin/env preferred over a fixed interpreter path?</summary>

A shebang (also called hashbang) is the first line of a script, starting with the two characters `#!` followed by the path of an interpreter. When you execute a file directly (`./script.js`), the kernel reads its first bytes; if they are `#!`, it treats the rest of the line as the interpreter command and runs it with the script path appended: `<interpreter> [one optional argument] <path-to-script>`. So `./hello.js` becomes `/usr/bin/env node ./hello.js`. The `#` makes the line a comment for the interpreter itself, so it is ignored once the program starts. Using `/usr/bin/env node` instead of a hard-coded path such as `/usr/local/bin/node` makes `env` look the interpreter up in `PATH`, so the script works wherever Node is installed (including version managers such as `nvm`).

```sh
#!/bin/bash              # bash script
#!/bin/sh                # POSIX shell
#!/usr/bin/python3       # Python at a fixed path
#!/usr/bin/env python3   # Python found via PATH
#!/usr/bin/env node      # Node.js found via PATH
```

```js
#!/usr/bin/env node
// hello.js
const name = process.argv[2] || "World";
console.log(`Hello, ${name}!`);
```

```sh
chmod +x hello.js        # execute permission is also required
./hello.js Alice         # Hello, Alice!
node hello.js Alice      # still works, the shebang is just a comment here
```

Gotcha: the shebang must be the very first bytes of the file, so a UTF-8 byte order mark or a blank line before it breaks it, as does a CRLF line ending (`bad interpreter: node^M`). Without a shebang the kernel returns `ENOEXEC`; an interactive bash then falls back to running the file as a shell script, while `spawn` from Node fails. On Linux everything after the interpreter path is passed as a single argument, so `#!/usr/bin/env node --harmony` does not work; use `#!/usr/bin/env -S node --harmony` (GNU coreutils 8.30+, 2018) or set options inside the script.

</details><br>

<details>
<summary>121. What does the source command (or .) do, and how is it different from running a script normally?</summary>

Running `bash file.sh` or `./file.sh` starts a new shell process that executes the file and exits; any variables, functions, aliases, or directory changes it makes disappear with that process. `source file.sh`, or its POSIX spelling `. file.sh`, reads the file and executes every line inside the current shell, as if you had typed them at the prompt. Everything the file defines therefore stays available afterward. This is how `~/.bashrc` is loaded, and why reloading it after an edit is done with `source ~/.bashrc`.

```sh
# helpers.sh
export API_URL="http://localhost:3000"
hello() { echo "hi from helpers"; }
cd /tmp
```

```sh
bash helpers.sh; hello; pwd      # "hello: command not found", pwd unchanged
source helpers.sh; hello; pwd    # "hi from helpers", now in /tmp
. helpers.sh                     # identical to source
```

Gotcha: because the file runs in your shell, an `exit` statement inside it closes your terminal, and `set -e` or `set -u` inside it changes the options of your interactive session. `source` searches `PATH` for a bare filename, so use `./helpers.sh` or an absolute path for a local file. `source` is a bash and zsh name; strict POSIX `sh` only knows `.`.

</details><br>

<details>
<summary>122. What are login, non-login, interactive, and non-interactive shells, and which startup files does each read?</summary>

A shell is a login shell when it is the first process of a session, for example an `ssh` session, a console login, the shell a WSL terminal opens, or `bash -l`. A login bash reads `/etc/profile` and then the first existing of `~/.bash_profile`, `~/.bash_login`, `~/.profile`. A shell is interactive when it is attached to a terminal and shows a prompt; an interactive non-login bash (a new tab in a terminal emulator) reads `~/.bashrc`. A non-interactive shell runs a script or a single `-c` command without a prompt and reads none of those files, only the file named in `$BASH_ENV` if set.

Node's `child_process.exec` runs `/bin/sh -c "command"`: non-login and non-interactive. So `exec("ll")` fails with `ll: not found` because the alias in `~/.bashrc` was never loaded, and on Debian and Ubuntu `/bin/sh` is `dash`, which never reads `~/.bashrc` at all.

Gotcha: `exec("source ~/.bashrc && ll")` is a fragile fix. Many `~/.bashrc` files return early when the shell is non-interactive.

</details><br>

<details>
<summary>123. How does child_process.exec differ from child_process.spawn in Node.js, and which shell does exec use?</summary>

`exec(command, options, callback)` passes the whole command string to a shell, `/bin/sh -c command` on Unix and the program named by `process.env.ComSpec` (normally `cmd.exe`) on Windows, and buffers all output until the process exits, then calls the callback with `stdout` and `stderr` strings. Because a shell is involved, pipes, redirections, globs, and environment expansion work, but arguments must be quoted carefully. `spawn(file, args, options)` executes the file directly: Node looks the name up in `PATH`, passes `args` as an array with no quoting or interpretation, uses no shell unless `shell: true`, and returns a `ChildProcess` whose `stdout` and `stderr` are streams.

```js
import { exec, spawn } from "node:child_process";

exec("ls -l | wc -l", { shell: "/bin/bash" }, (err, stdout, stderr) => {
  console.log(stdout.trim()); // pipes work because a shell runs it
});

const child = spawn("echo", ["hello", "world"]); // no shell, PATH lookup of echo
child.stdout.on("data", (chunk) => process.stdout.write(chunk));
```

`echo` works with `spawn` even though it is a shell builtin, because a real executable also exists (`whereis echo` shows `/usr/bin/echo`). Pure builtins such as `cd`, `alias`, or `export` have no file and fail with `ENOENT`.

Gotcha: `exec` has a `maxBuffer` limit (1 MiB by default) and kills the child with an error if output exceeds it, so use `spawn` for large or streaming output. Never build an `exec` string from user input, since it is a shell injection vector; `spawn` with an argument array avoids that by design.

</details><br>

<details>
<summary>124. When should you use execFile instead of exec in Node.js, and how does execFile compare to spawn?</summary>

`exec` and `execFile` both buffer the whole output and hand it to a callback, so they feel alike, but `exec` starts a shell and `execFile` does not. The shell is what interprets pipes, globs, `&&`, and variable expansion, and it is also what turns untrusted input into a command injection: `exec("convert " + userFile)` runs anything a user hides in the file name. `execFile("convert", [userFile])` passes the name as one literal argument, so no shell feature can fire. It is also slightly faster because no `sh` process is started. Make `execFile` the default for running a known program with arguments, and fall back to `exec` only when you truly need shell syntax.

```
                          exec                      execFile
Spawns a shell            yes                       no
Command format            one string "ls -la"       file + args array
Shell features | * &&     yes                       no
Injection risk            high with user input      low
Performance               slightly slower           slightly faster
```

`execFile` and `spawn` differ in how output arrives, not in whether a shell is used (neither uses one by default).

```
                          execFile                        spawn
Output delivery           buffered, all at once           streamed in chunks
Result via                callback or promise             events on stdout / stderr
Memory usage              holds all output                constant, chunks processed as they arrive
Output size limit         maxBuffer, default 1 MiB,       none
                          exceeded = child killed
timeout option            built in                        built in (since v15.13 / v14.18)
Best for                  short commands, small output    long-running or large / continuous output
```

```js
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const run = promisify(execFile);

const { stdout } = await run("ffprobe", [
  "-v",
  "error",
  "-show_format",
  inputPath,
]);
```

Rule of thumb:

- `execFile` (run a known program and read its result);
- `exec` (when you need pipes or globbing);
- `spawn` (streaming or very large output);
- `fork` (another Node script with IPC).

Gotcha: on Windows, `.bat` and `.cmd` files are not executables and cannot be started by `execFile` or `spawn` directly; you must pass `{ shell: true }` (which brings the injection risk back) or run `cmd.exe` with `/c` and the script as arguments. `execFile` still has the `maxBuffer` limit, so switch to `spawn` as soon as output may exceed 1 MiB.

</details><br>

<details>
<summary>125. What are PID and PPID, and how does an operating system start a new process?</summary>

Every process has a unique process ID (`PID`) and records the ID of the process that created it (`PPID`). A new process is created in two steps on Unix: the parent calls `fork()`, which makes a copy of itself, and the copy calls `execve(path, argv, envp)`, which asks the kernel to load the executable file from storage into memory and start it with the given arguments. The child inherits the parent's environment variables, open file descriptors including `stdin`, `stdout`, and `stderr`, the current working directory, user and group IDs, and the nice value. This forms a tree: on Linux `PID 1` is `init` or `systemd`, the ancestor of all user processes; `PID 0` is the kernel's idle task, which has no parent and appears as the parent of `PID 1`.

```sh
echo $$                       # PID of the current shell
echo $PPID                    # its parent
ps -o pid,ppid,cmd -p $$      # inspect any process
pstree -p                     # the whole tree
```

```js
console.log(process.pid, process.ppid);
```

Gotcha: when a parent dies first, its children are not killed; they are orphaned and re-parented to `PID 1` (or to a designated subreaper), which is how daemons are traditionally created. The kernel itself is not a process in this tree, it is the code that implements `fork` and `exec`.

</details><br>

<details>
<summary>126. What is the difference between a process's virtual size and its resident set size on Unix, and which one does a memory limit care about?</summary>

Every process gets its own virtual address space, divided into pages (usually 4 KB). Reserving address space costs nothing; the operating system only backs a page with physical RAM the first time the process touches it. That gives two different sizes. The virtual size (VSZ) is everything the process has reserved: heap arenas, memory-mapped files, thread stacks, shared libraries. It can be gigabytes and says little about real usage. The resident set size (RSS) is the set of pages currently sitting in physical RAM. RSS excludes pages that were reserved but never touched and pages that were swapped out, and it includes shared pages such as the executable and `libc`, counted in full for every process that maps them.

```sh
ps -o pid,vsz,rss,cmd -p $$        # sizes in KB
cat /proc/$$/status | grep -E 'VmSize|VmRSS'
cat /proc/$$/smaps_rollup | grep -E '^(Rss|Pss)'   # Pss divides shared pages fairly
```

```js
console.log(process.memoryUsage.rss()); // the same RSS number from inside Node, in bytes
```

Gotcha: container and cgroup memory limits, and therefore the Linux OOM killer, look at resident memory of the whole group of processes, so RSS is the number that gets you killed, not the virtual size and not the JavaScript heap. Summing RSS over several processes overcounts shared pages; the proportional set size (PSS) in `smaps_rollup` splits shared pages between the processes that use them and gives a fair total. RSS also does not shrink promptly after memory is freed, because allocators keep pages for reuse.

</details><br>

<details>
<summary>127. When should you use path.win32 or path.posix instead of the default path module in Node.js?</summary>

The `path` module adapts to the operating system Node is running on: on Windows it uses `\` as separator and understands drive letters, on Unix it uses `/`. When you need to manipulate paths for a different system than the one you run on, or need identical results everywhere, use the explicit flavors. `path.win32` always applies Windows rules and `path.posix` always applies POSIX rules, regardless of the host OS. Typical cases are building paths for a remote machine, generating URLs or archive entries (always `/`), or writing tests that must pass on both platforms.

```js
import path from "node:path";

path.join("a", "b"); // "a/b" on Linux, "a\\b" on Windows
path.posix.join("a", "b"); // "a/b" everywhere
path.win32.join("a", "b"); // "a\\b" everywhere

path.win32.basename("C:\\temp\\file.txt"); // "file.txt" even on Linux
path.posix.basename("C:\\temp\\file.txt"); // "C:\\temp\\file.txt", backslash is not a separator
```

Gotcha: `path.win32` accepts both `\` and `/` as separators, but `path.posix` treats `\` as an ordinary filename character. Paths inside URLs, `import` specifiers, and `.zip` or `.tar` archives are always POSIX style, so use `path.posix` for them even on Windows.

</details><br>

<details>
<summary>128. What is the difference between path.join() and path.resolve() in Node.js, and when does each one touch the current working directory?</summary>

Both build a path from segments and normalize the result (collapsing `..`, `.`, and repeated separators), but they answer different questions. `path.join(...segments)` simply concatenates the segments with the platform separator and normalizes; the result is relative if the first segment is relative and it never consults the current working directory.
`path.resolve(...segments)` produces an absolute path. It processes the segments from right to left, prepending each one until an absolute path has been formed, and if none of the segments is absolute it finally prepends `process.cwd()`.
That is why a later absolute segment discards everything before it, and why `path.resolve()` with no arguments returns the current working directory. `resolve` also removes a trailing separator unless the result is the root.

```js
import path from "node:path";

path.join("/foo", "bar", "baz/asdf", "quux", ".."); // "/foo/bar/baz/asdf"
path.join("foo", "/bar"); // "foo/bar"  (join never makes it absolute)
path.join("", ""); // "."

path.resolve("/foo/bar", "./baz"); // "/foo/bar/baz"
path.resolve("/foo/bar", "/tmp/file/"); // "/tmp/file"  ("/tmp/file/" is absolute, "/foo/bar" is dropped)
path.resolve("wwwroot", "static_files/png/", "../gif/image.gif");
// "/home/me/node/wwwroot/static_files/gif/image.gif" when cwd is /home/me/node
path.resolve(); // same as process.cwd()
```

Gotcha: because `resolve` depends on `process.cwd()` whenever no segment is absolute, the same call can return different paths depending on where the program was started; anchor file paths to `__dirname` or `import.meta.dirname` to avoid that.

</details><br>

<details>
<summary>129. What does path.parse() do in Node.js, and what does it return?</summary>

`path.parse(pathString)` splits a path string into its parts and returns an object with five string properties:

- `root` (the leading `/` or `C:\\` of an absolute path, empty otherwise);
- `dir` (everything before the last separator);
- `base` (the last segment, name plus extension);
- `ext` (the extension including the dot);
- `name` (`base` without `ext`).

A trailing separator is ignored. It only works on the string and never touches the file system.

```js
import path from "node:path";

path.parse("/home/user/dir/file.txt");
// { root: "/", dir: "/home/user/dir", base: "file.txt", ext: ".txt", name: "file" }
```

Gotcha: `ext` is taken from the last dot only, so `archive.tar.gz` gives `".gz"`, and a dotfile such as `.bashrc` gives an empty `ext` with `name` equal to `".bashrc"`.

</details><br>

<details>
<summary>130. What is the current working directory, and how do you read, change, and pass it to a child process in Node.js?</summary>

Every process has a current working directory (CWD): the directory against which relative paths are resolved. The shell shows it with `pwd` and changes it with `cd`. A child process inherits the CWD of its parent at start. In Node, `process.cwd()` returns it and `process.chdir(dir)` changes it for the running process. The `cwd` option of `spawn`, `exec`, `execFile`, and `fork` sets the directory the child starts in; it defaults to `process.cwd()`.

```sh
pwd                     # /home/alice/project
cd src && pwd           # /home/alice/project/src
```

```js
import { spawn } from "node:child_process";

console.log(process.cwd());
process.chdir("/tmp");
console.log(process.cwd()); // /tmp

spawn("ls", ["-l"], { cwd: "/var/log", stdio: "inherit" });
```

Gotcha: a child cannot change its parent's directory, which is why `cd` must be a shell builtin and why `exec("cd /tmp")` has no effect on the Node process. `process.chdir` is not available inside `worker_threads`. If `cwd` points to a directory that does not exist, `spawn` fails with a misleading `ENOENT` error that looks like the executable is missing.

</details><br>

<details>
<summary>131. Why does require or import find a relative file but fs does not, and how do you fix it in Node.js?</summary>

Module loading and the file system resolve relative paths against different bases. `require("./data.json")` and `import "./data.json"` resolve relative to the directory of the file that contains the statement. `fs.readFile("./data.json")` and every other `fs` call resolve relative to the process's current working directory, which is wherever the user ran `node` from. If you start the program from another directory the module is still found but the `fs` call fails with `ENOENT`. The fix is to build an absolute path from the current file's directory: `__dirname` in CommonJS, or `import.meta.dirname` in ES modules (added in Node 20.11 and 21.2, early 2024).

```js
// CommonJS
const path = require("node:path");
const fs = require("node:fs");
const file = path.resolve(__dirname, "./data.json");
fs.readFileSync(file, "utf8");
```

```js
// ES modules
import path from "node:path";
import fs from "node:fs";
const file = path.resolve(import.meta.dirname, "./data.json");
fs.readFileSync(file, "utf8");

// Node before 20.11:
import { fileURLToPath } from "node:url";
const legacy = fileURLToPath(new URL("./data.json", import.meta.url));
```

Gotcha: `path.resolve` with a relative first argument still uses the CWD, so always pass `__dirname` or `import.meta.dirname` as the base; `path.join(__dirname, "./data.json")` gives the same result here because `__dirname` is already absolute.

</details><br>

<details>
<summary>132. How can you make a Node.js console write to files instead of the terminal?</summary>

The global `console` is an instance of the `Console` class created with `process.stdout` and `process.stderr` as its two output streams. You can construct your own `Console` with any writable streams, for example file streams from `fs.createWriteStream`. Methods such as `log` and `info` write to the first stream, while `error` and `warn` write to the second, so you get the same API and formatting as the normal console but with a different destination. `stderr` is optional: if you pass only `stdout`, warnings and errors go to that same stream, which is handy for a single combined log file. The constructor also accepts the streams positionally as `new Console(stdout, stderr)`.

```js
import fs from "node:fs";
import { Console } from "node:console";

const output = fs.createWriteStream("./stdout.log", { flags: "a" });
const errorOutput = fs.createWriteStream("./stderr.log", { flags: "a" });
const logger = new Console({ stdout: output, stderr: errorOutput });

logger.log("This goes to stdout.log");
logger.error("This goes to stderr.log");
```

Gotcha: file streams are asynchronous, so calling `process.exit()` right after logging can truncate the last lines; set `process.exitCode` and let the event loop drain, or end the streams and wait for `finish`. For simple cases the shell can do the same without code changes: `node app.js > stdout.log 2> stderr.log`.

</details><br>

<details>
<summary>133. What does console.trace() do in Node.js, and when is it worth using in a production application?</summary>

`console.trace(message, ...args)` prints the message prefixed with `Trace:` followed by the current call stack to `stderr`, without throwing or stopping anything. It answers "who called this?" at a point where you cannot attach a debugger. Its legitimate production uses are:

- finding an unexpected caller, by logging the stack once from a deprecated or supposedly dead code path so the log aggregator reveals who still uses it;
- recording where a resource was acquired, so a leaked connection, handle, or timer can be traced to its creation site rather than to where the leak was noticed;
- guarded diagnostics, left in the code behind an environment flag so an engineer can switch them on for one instance without a deploy.

```js
let warned = false;
export function legacySave(doc) {
  if (!warned) {
    warned = true;
    console.trace("legacySave() still in use, migrate the caller");
  }
  return save(doc);
}
```

Gotcha: capturing a stack is slow, so never call it unguarded on a hot path. It writes raw multi-line text to `stderr`, bypassing structured logging, log levels, and correlation IDs, so in a real service prefer `logger.warn({ stack: new Error().stack }, msg)`. The stack shows only the synchronous frames of the current tick plus what async stack traces can reconstruct, so for "how did this request get here" use `AsyncLocalStorage` with a request ID instead.

</details><br>

<details>
<summary>134. What are the standard file descriptors 0, 1, and 2, and how do shell redirection operators use them?</summary>

Every process starts with three open file descriptors:

- `0` (`stdin`);
- `1` (`stdout`);
- `2` (`stderr`).

Redirection operators rewire these before the command runs:

- `n>file` (sends descriptor `n` to a file, truncating it);
- `n>>file` (appends instead of truncating);
- `n<file` (reads descriptor `n` from a file);
- `2>&1` (makes descriptor 2 point wherever descriptor 1 currently points);
- `/dev/null` (a special file that discards everything written to it).

The descriptor number is optional: `>file` means `1>file` and `<file` means `0<file`.

```sh
node app.js > out.txt              # stdout to file (overwrite), same as 1>out.txt
node app.js >> out.txt             # append
node app.js < input.txt            # file as stdin, same as 0<input.txt
node app.js < in.txt > out.txt     # both at once
node app.js > out.txt 2> err.txt   # stdout and stderr to separate files
node app.js > out.txt 2>&1         # both into one file, order matters
node app.js &> out.txt             # bash shortcut for the line above
node app.js 2> /dev/null           # discard stderr
```

Gotcha: redirections are applied left to right, so `node app.js 2>&1 > out.txt` sends `stderr` to the terminal (where `stdout` pointed at that moment) and only `stdout` to the file. Writing `2>&1 out.txt` without the `>` passes `out.txt` as an argument to the program instead of redirecting. `>` truncates the file before the command starts, so `sort data.txt > data.txt` empties the input.

</details><br>

<details>
<summary>135. What does the pipe operator | do in bash, and what happens to stderr and exit status in a pipeline?</summary>

`command1 | command2` connects the `stdout` (descriptor 1) of the first process to the `stdin` (descriptor 0) of the second. Both processes start at the same time and data flows through a kernel buffer as it is produced; when the writer exits, the reader sees end of file. Pipes can be chained, and any program that reads `stdin` and writes `stdout` can take part, which is how small Unix tools compose.

```sh
echo "123" | node app.js                        # app.js reads "123\n" on stdin, then EOF
echo "123" | node app.js | tr 'a-z' 'A-Z'       # app output upper-cased
echo "123" | node app.js > out.txt 2> err.txt   # redirections apply to the last stage
ps aux | grep node | wc -l
```

```js
// app.js: read everything from stdin
let input = "";
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => console.log("got", input.trim()));
```

Gotcha: only `stdout` goes through the pipe; `stderr` still reaches the terminal. Use `2>&1 |` or bash's `|&` to pipe both. The exit status of a pipeline is that of the last command, so a failing first stage is hidden unless you enable `set -o pipefail`.

</details><br>

<details>
<summary>136. How do &&, ||, and ; chain commands in bash, and what decides whether the next command runs?</summary>

Every command ends with an exit status: `0` means success, anything else means failure, and the shell stores the last one in `$?`. The chaining operators look at that status:

- `a && b` (runs `b` only if `a` succeeded);
- `a || b` (runs `b` only if `a` failed);
- `a ; b` (runs `b` regardless).

These let you express "compile and then run only if compilation worked" on a single line without an `if` statement.

```sh
gcc app.c -o app && ./app              # run only if the compile succeeded
mkdir build || echo "already exists"   # fallback on failure
cd /tmp ; ls                           # run both no matter what
npm test && git push || echo "tests failed, not pushed"
echo $?                                # status of the last command
```

Gotcha: `a && b || c` is not a true if/else: `c` also runs when `a` succeeds but `b` fails. Use `if a; then b; else c; fi` when that matters. `&&` and `||` have equal precedence and are evaluated left to right, and a newline acts like `;`.

</details><br>

<details>
<summary>137. How do head and tail select part of a file or stream, and how do you skip lines from the start or end?</summary>

`head` prints the beginning of its input and `tail` the end, 10 lines each by default. `-n N` sets the line count (the shorthand `-N` also works) and `-c N` counts bytes instead of lines. Both read from files or from `stdin`, so they fit in pipelines. A plus sign changes the meaning of the count: `tail -n +K` means "output from line K to the end", with line K included. Because output starts at line K, exactly K minus 1 lines are skipped, so `tail -n +3` prints line 3 onward and drops lines 1 and 2; to skip 3 lines you write `tail -n +4`. A minus sign on `head` is the mirror image: GNU `head -n -K` means "everything except the last K lines". `cat` alone cannot skip lines; combine it with these or use `sed`.

```sh
head file.txt              # first 10 lines
head -n 20 file.txt        # first 20
head -5 file.txt           # first 5, shorthand
head -c 100 file.txt       # first 100 bytes

tail file.txt              # last 10 lines
tail -n 20 file.txt        # last 20
tail -c 100 file.txt       # last 100 bytes
tail -f app.log            # keep printing as the file grows

tail -n +3 file.txt                # start AT line 3, so lines 1-2 are skipped
tail -n +4 file.txt                # start at line 4, so 3 lines are skipped
tail -n +3 file.txt | head -n -5   # from line 3 onward, then drop the last 5
sed -n '3,$p' file.txt             # same as tail -n +3: print lines 3 to end
sed '1,2d' file.txt                # same result phrased as "delete lines 1-2"
```

Gotcha: `head -n -K` (negative count) is a GNU coreutils extension; on macOS and BSD `head` it is an error, so use `sed '$d'` in a loop or install `coreutils` (`ghead`). `tail -f` keeps following a deleted or rotated file's old inode; `tail -F` re-opens by name, which is what you want for log rotation.

</details><br>

<details>
<summary>138. What is a Unix domain socket, how does it appear in the file system, and how do you use one from Node.js?</summary>

A Unix domain socket (also called an IPC socket, address family `AF_UNIX`) is a two-way communication channel between processes on the same machine. Instead of an IP address and port it is identified by a path in the file system. The path is a rendezvous point, not a data file: `ls -l` shows type `s` and size `0`, and nothing is ever written to disk, following the Unix idea that everything is addressed like a file. Data moves through kernel memory without the TCP/IP stack, so it is faster than loopback TCP, and access is controlled with ordinary file permissions. In Node the `net` module uses the same `Socket` API as TCP; only the address changes.

```js
// server.js
import net from "node:net";
import fs from "node:fs";
const PATH = "/tmp/node_c_socket";
fs.rmSync(PATH, { force: true }); // remove a stale socket file
net
  .createServer((conn) => {
    conn.on("data", (d) => conn.write(`echo: ${d}`));
  })
  .listen(PATH);

// client.js
const client = net.createConnection({ path: "/tmp/node_c_socket" });
client.write("hello");
client.on("data", (d) => console.log(String(d)));
```

```sh
ls -l /tmp/node_c_socket
# srwxr-xr-x 1 alice alice 0 Oct  4 10:00 /tmp/node_c_socket
```

Databases such as PostgreSQL (`/var/run/postgresql/.s.PGSQL.5432`) and MySQL (`/var/run/mysqld/mysqld.sock`) accept both Unix sockets and TCP.

Gotcha: the socket file is not removed when the server crashes, and `listen` on an existing path fails with `EADDRINUSE`, so unlink it first. Windows has no Unix sockets in the same form; Node maps the same API to named pipes with paths like `\\?\pipe\myapp`. Linux also supports abstract sockets whose name starts with a null byte and that need no cleanup.

</details><br>

<details>
<summary>139. What does Windows use instead of Unix domain sockets, and how does Node.js map the same net API onto it?</summary>

The Windows equivalent of a Unix domain socket is the named pipe. Named pipes live in a separate kernel namespace managed by the Named Pipe File System and are addressed as `\\.\pipe\<name>`; nothing is created on disk, so there is no socket file to delete and no stale-path problem after a crash. A named pipe is bidirectional, works in byte or message mode, is protected by a Windows security descriptor (ACL), and, unlike a Unix socket, can be opened from another machine over SMB as `\\server\pipe\<name>`. Node's `net` module is built on libuv, which implements its pipe handle with Unix domain sockets on Unix and with named pipes on Windows, so the same JavaScript works on both platforms and only the address changes. Node requires the `\\?\pipe\` or `\\.\pipe\` prefix, and in a JavaScript string every backslash must be doubled. The IPC channel that `child_process.fork` opens between parent and child is also a named pipe on Windows.

```js
import net from "node:net";

const ADDRESS =
  process.platform === "win32"
    ? "\\\\.\\pipe\\myapp" // the string \\.\pipe\myapp
    : "/tmp/myapp.sock";

net.createServer((conn) => conn.end("hello")).listen(ADDRESS);
net
  .createConnection({ path: ADDRESS })
  .on("data", (d) => console.log(String(d)));
```

```powershell
Get-ChildItem \\.\pipe\          # list the live named pipes
```

</details><br>

<details>
<summary>140. What is inter-process communication, and how does it differ from networking?</summary>

Inter-process communication (IPC) is the set of mechanisms an operating system offers for processes on the same machine to exchange data, all mediated by the kernel using the machine's RAM. Networking moves data between different machines through protocols such as TCP and UDP, with serialization, checksums, and routing at every hop. Because IPC never leaves memory, it has far lower latency and higher throughput. Common IPC mechanisms are:

- anonymous pipes (the `|` in a shell and the `stdio` pipes of a child process);
- named pipes (FIFOs, pipes with a path in the file system);
- Unix domain sockets (bidirectional channels addressed by a path);
- signals (a notification without payload, such as `SIGTERM`);
- message queues (kernel-managed queues of discrete messages);
- shared memory (one region of memory mapped into both processes, which exchange only addresses or offsets rather than copying the data).

```js
// Node examples of each class
import { fork } from "node:child_process";
import { Worker } from "node:worker_threads";

const child = fork("./child.js"); // pipe-based IPC channel
child.send({ hello: "world" }); // serialized message

const shared = new SharedArrayBuffer(1024); // shared memory within one process
new Worker("./worker.js", { workerData: shared });
```

Gotcha: TCP to `127.0.0.1` is still networking as far as the kernel is concerned: it goes through the full TCP/IP stack and costs more than a Unix socket. Shared memory is the fastest option because nothing is copied, but it provides no synchronization, so readers and writers need locks or atomics (`Atomics.wait` and `Atomics.notify` in JavaScript) to avoid races.

</details><br>

<details>
<summary>141. How does the Node.js cluster module work, and how are incoming connections shared between workers?</summary>

The `cluster` module runs several copies of the same Node program as separate OS processes so a server can use more than one CPU core. The first process is the primary; `cluster.fork()` starts a worker, which is a child process (built on `child_process.fork`) running the same script with `cluster.isWorker` true. The operating system decides which core each process runs on. When a worker calls `server.listen(port)`, it does not bind the port itself: the primary binds it, accepts connections, and hands them to workers round-robin (the default on every platform except Windows, controlled by `cluster.schedulingPolicy`). Because `cluster.fork()` is only allowed in the primary, every cluster script branches on `cluster.isPrimary`.

```js
import cluster from "node:cluster";
import http from "node:http";
import os from "node:os";

if (cluster.isPrimary) {
  for (let i = 0; i < os.availableParallelism(); i++) cluster.fork();
  cluster.on("exit", (worker, code) => {
    console.log(`worker ${worker.process.pid} died (${code}), restarting`);
    cluster.fork();
  });
} else {
  http
    .createServer((req, res) => res.end(`handled by ${process.pid}`))
    .listen(3000);
}
```

Workers and the primary talk over the IPC channel with `worker.send()` and `process.on("message")`. If the primary dies, the IPC channel closes and each worker exits, so the primary is usually kept small and limited to supervision and restarting workers.

Gotcha: workers share nothing in memory, so sessions or caches held in a worker are invisible to the others; use an external store such as Redis or sticky sessions. `cluster.isMaster` and `setupMaster` were deprecated in Node 16 (2021) in favor of `isPrimary` and `setupPrimary`. `os.availableParallelism()` (Node 18.14+) is preferred over `os.cpus().length` because it respects container CPU limits.

</details><br>

<details>
<summary>142. What does cluster.schedulingPolicy control in Node.js, what are its two values, and why is round-robin the default?</summary>

`cluster.schedulingPolicy` decides which process accepts incoming connections when several workers share one port. It is a two-way switch, not a pluggable load balancer. With `cluster.SCHED_RR` (round-robin) the primary owns the listening socket and is the only process that calls `accept()`; each accepted connection is passed to the next worker in turn over the IPC channel using handle passing. With `cluster.SCHED_NONE` the primary instead sends the listening handle itself to every worker, all workers wait in `accept()` on the same socket, and the kernel decides who gets each connection.

```js
import cluster from "node:cluster";

cluster.schedulingPolicy = cluster.SCHED_NONE; // must come before the first fork()
if (cluster.isPrimary) {
  cluster.fork();
}
```

```sh
NODE_CLUSTER_SCHED_POLICY=none node server.js    # same switch without changing code, 'rr' or 'none'
```

</details><br>

<details>
<summary>143. What does cluster.setupPrimary() change in Node.js, and which worker setting can it not control?</summary>

By default `cluster.fork()` starts a worker running the same script as the primary (`process.argv[1]`) with the same arguments and with `stdio` inherited from the primary. `cluster.setupPrimary(settings)` changes those defaults for every later `fork()` call. The useful settings are:

- `exec` (a different file to run as the worker, so primary and worker code can live in separate files without `if (cluster.isPrimary)` branching);
- `args` and `execArgv` (arguments for the worker script and for Node itself, such as `--inspect` or `--max-old-space-size`);
- `silent` (pipes worker `stdout` and `stderr` through the primary instead of the terminal, so logs can be prefixed or collected);
- `stdio`, `cwd`, `uid`, `gid`, `serialization`, `windowsHide` (the usual `child_process.fork` options).

Settings are cumulative, are visible afterwards in `cluster.settings`, and only affect workers forked after the call; running workers are untouched. The one thing it cannot set is `env`, because environment is per worker and is passed directly as `cluster.fork(env)`.

```js
import cluster from "node:cluster";

cluster.setupPrimary({
  exec: "worker.js",
  args: ["--use", "https"],
  silent: true,
});
cluster.fork(); // https worker, output piped to the primary

cluster.setupPrimary({ args: ["--use", "http"] });
cluster.fork({ PORT: "8080" }); // http worker, env passed per fork

cluster
  .fork({ PORT: "8081" })
  .process.stdout.on("data", (d) => process.stdout.write(`[w] ${d}`));
```

Gotcha: it can only be called in the primary, and calling it also freezes `cluster.schedulingPolicy`.

</details><br>

<details>
<summary>144. What does the silent option of cluster.setupPrimary() change about worker output, and why must the primary then read the worker's streams?</summary>

With the default `silent: false`, workers inherit the primary's standard streams: a worker's `console.log` goes straight to the same terminal or `stdout` as the primary, because both processes write to the same underlying file descriptors. With `silent: true`, the worker's `stdout` and `stderr` are instead connected to the primary through pipes. Their output arrives in the primary as readable streams, `worker.process.stdout` and `worker.process.stderr`, and nothing reaches the terminal unless the primary forwards it. Reasons to do this are:

- prefixing each line with the worker id or PID so interleaved logs stay readable;
- writing worker logs to a file or a logging service instead of the console;
- filtering, parsing, or aggregating output in one place;
- keeping the terminal quiet.

```js
import cluster from "node:cluster";

cluster.setupPrimary({ silent: true });

const worker = cluster.fork();
worker.process.stdout.on("data", (d) =>
  process.stdout.write(`[worker ${worker.id}] ${d}`),
);
worker.process.stderr.on("data", (d) =>
  process.stderr.write(`[worker ${worker.id}] ${d}`),
);
```

Gotcha: if the primary attaches no listener, the output is simply lost, and if nobody drains the pipe its kernel buffer fills up; on Windows, where pipe writes are synchronous, the worker then blocks on its next `console.log`, and on POSIX the pending writes pile up in the worker's memory instead. Always consume or redirect both streams. A `data` chunk is not guaranteed to be a whole line, so a per-chunk prefix can land in the middle of a line; use `readline.createInterface` on the stream for line-accurate prefixes. For finer control than `silent`, `setupPrimary` also accepts a full `stdio` array, the same as `child_process.fork`.

</details><br>

<details>
<summary>145. How do you implement sticky sessions in Node.js so the same client always reaches the same worker, and why does the worker's HTTP server never call listen()?</summary>

Sticky sessions mean every connection from one client is handled by the same worker, which matters when a worker keeps per-client state in memory, for example WebSocket connections or an in-process session store. The cluster module's own balancing cannot do this, so you bypass it: the primary is the only process that listens, it chooses a worker from a hash of the client IP, and it hands the raw accepted socket to that worker with `worker.send(message, socket)`. The worker runs an ordinary `http.Server` that never calls `listen()`; instead it injects each received socket with `server.emit("connection", socket)`, which is how any `net.Server` or `http.Server` can serve a connection it did not accept itself. Because the workers never listen on the port, cluster's round-robin never activates and your hash is the only balancing in play.

```js
import cluster from "node:cluster";
import net from "node:net";
import http from "node:http";
import os from "node:os";

if (cluster.isPrimary) {
  const workers = [];
  for (let i = 0; i < os.availableParallelism(); i++)
    workers.push(cluster.fork());

  const pick = (ip) => {
    // same IP -> same index -> same worker
    let hash = 0;
    for (const ch of ip) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
    return workers[hash % workers.length];
  };

  net
    .createServer({ pauseOnConnect: true }, (socket) => {
      pick(socket.remoteAddress).send("sticky", socket);
    })
    .listen(3000);
} else {
  const server = http.createServer((req, res) =>
    res.end(`worker ${process.pid}\n`),
  );
  process.on("message", (msg, socket) => {
    if (msg !== "sticky") return;
    server.emit("connection", socket); // feed the socket into the HTTP server
    socket.resume(); // it was paused in the primary
  });
}
```

`pauseOnConnect: true` stops the primary from reading any bytes before the hand-off, so the worker sees the request from its first byte.

Gotcha: all clients behind one NAT or corporate proxy share an IP and land on one worker, and if a worker dies the `workers` array must be rebuilt or every hash shifts to a different worker. Production code usually uses the same idea through `@socket.io/sticky` or moves stickiness out of Node entirely, to a load balancer with cookie affinity or a shared Redis session store so that any worker can serve any client.

</details><br>

<details>
<summary>146. How do child_process, cluster, and worker_threads compare in Node.js, and how does each communicate?</summary>

All three let a Node program use more than one CPU, but at different isolation levels:

- `child_process` (starts a new OS process running any program, with its own PID and memory);
- `cluster` (a layer over `child_process.fork` specialized for running copies of the same server and sharing a port);
- `worker_threads` (a thread inside the same process with its own V8 isolate and event loop, so a separate JavaScript heap, but able to share raw memory through `SharedArrayBuffer`).

```
                 New OS process  New V8 instance              Own PID    Memory
child_process    yes             yes (if the child is Node)   yes        isolated
cluster          yes             yes                          yes        isolated
worker_threads   no              yes (isolate in same proc)   no         isolated heap,
                                                                         shareable via SharedArrayBuffer
```

Communication: processes (`child_process`, `cluster`) use the IPC channel with `child.send()` / `process.send()` and the `message` event, serializing each message (JSON by default, structured clone with `serialization: "advanced"`). Threads use `postMessage()` with structured clone, or write directly into a `SharedArrayBuffer` coordinated with `Atomics`.

```js
// process style
import { fork } from "node:child_process";
const child = fork("./task.js");
child.on("message", (m) => console.log("from child:", m));
child.send({ start: true });
// in task.js: process.on("message", (m) => process.send({ done: true }));

// thread style
import { Worker } from "node:worker_threads";
const w = new Worker("./task-worker.js");
w.on("message", (m) => console.log("from worker:", m));
w.postMessage({ start: true });
```

Gotcha: use `worker_threads` for CPU-heavy JavaScript (parsing, hashing, image math), `cluster` for scaling a network server across cores, and `child_process` for running other programs such as `ffmpeg`. Threads start faster and cost less memory than processes, but a crash in native code inside a worker can take down the whole process, whereas a crashed child process is isolated.

</details><br>

<details>
<summary>147. What is the JavaScript Atomics object, what problem does it solve for worker_threads, and when should production code use it?</summary>

`Atomics` is a built-in object with static methods that read and write memory in a `SharedArrayBuffer` as single indivisible operations. It exists because a `SharedArrayBuffer` is the one kind of memory several threads can see at once, and ordinary JavaScript has no way to make concurrent access safe: `counter[0]++` is really read, add, write, and two threads interleaving those steps lose an update. `Atomics.add`, `Atomics.load`, `Atomics.store`, and `Atomics.compareExchange` perform each step atomically, so no thread can slip in between. `Atomics.wait(array, index, expected, timeout)` puts a thread to sleep while a slot still holds `expected`, and `Atomics.notify(array, index, count)` wakes waiters, so a thread can wait for new data without spinning in a loop. This is the same idea as a futex on Linux or a condition variable in other languages. The methods only work on integer typed arrays such as `Int32Array` or `BigInt64Array` over a `SharedArrayBuffer`.

```js
// main.js
import { Worker } from "node:worker_threads";
const sab = new SharedArrayBuffer(8);
const shared = new Int32Array(sab); // shared[0] = flag, shared[1] = payload
new Worker("./worker.js", { workerData: sab });

Atomics.store(shared, 1, 42); // publish the payload
Atomics.store(shared, 0, 1); // set the flag
Atomics.notify(shared, 0, 1); // wake one waiter

// worker.js
import { workerData } from "node:worker_threads";
const shared = new Int32Array(workerData);
Atomics.wait(shared, 0, 0); // sleep while flag is still 0
console.log(Atomics.load(shared, 1)); // 42, no copy, no serialization
```

In everyday production code you rarely call `Atomics` yourself. Workers normally talk with `postMessage`, `workerData`, or a pool library such as `piscina`, and large buffers are moved with `postMessage(buffer, [buffer])`, which transfers ownership without copying. `Atomics` is reserved for cases where message passing itself is the bottleneck:

- high-frequency job queues or ring buffers between threads;
- shared counters and flags read by many workers;
- a worker that must block synchronously until the main thread answers (the trick behind `synckit`);
- WebAssembly threads, whose mutexes are implemented with `Atomics.wait` and `Atomics.notify`.

Libraries such as `piscina`, `synckit`, Emscripten, and `comlink` hide it internally.

Gotcha: `Atomics.wait` blocks the whole thread, so browsers forbid it on the main thread; use `Atomics.waitAsync`, which returns a promise, when blocking is unacceptable. `cluster` and `child_process` cannot use it at all, because separate processes do not share a `SharedArrayBuffer`. Treat shared-memory code like writing a lock in C: keep it inside a small, well-tested helper rather than scattered through business logic.

</details><br>

<details>
<summary>148. What does child_process.fork() do in Node.js, and how do parent and child exchange messages?</summary>

`fork(modulePath, args, options)` is a special case of `spawn` that always starts a new Node.js process (using `process.execPath`) running the given module, and opens an extra IPC channel alongside `stdin`, `stdout`, and `stderr`. It returns a `ChildProcess` like `spawn`, with two additions: `child.send(message)` and the `message` event. Inside the child, `process.send(message)` and `process.on("message")` are the other end of the channel. Messages are serialized (JSON by default), so functions and class instances do not survive the trip. The channel is bidirectional.

```js
// parent.js
import { fork } from "node:child_process";
const child = fork("./child.js", ["--mode", "fast"]);
child.on("message", (msg) => {
  console.log("child says:", msg);
  child.disconnect(); // close the channel so both can exit
});
child.send({ job: 42 });

// child.js
process.on("message", (msg) => {
  process.send({ result: msg.job * 2 });
});
```

Gotcha: `process.send` is `undefined` when the process was not started with an IPC channel, so guard with `if (process.send)` in modules that can run standalone. An open channel keeps both event loops alive; call `disconnect()` or `child.unref()` when finished. You can get the same channel with `spawn` by adding `"ipc"` to the `stdio` array, which is how `fork` is implemented.

</details><br>

<details>
<summary>149. How can a Node.js parent pass a TCP server or socket to a child process with send(), and where is this used in production?</summary>

`subprocess.send(message, sendHandle)` accepts a second argument that is a live network handle: a `net.Server` (including `http.Server`, which extends it), a `net.Socket`, or a `dgram.Socket`. Node does not serialize the object; it duplicates the underlying operating system file descriptor and sends it over the IPC channel, so the child ends up with a working server or socket bound to the same port or connection. The child receives it as the second argument of its `message` listener. This is how one process can bind a port and let other processes serve it, which is otherwise impossible because two processes cannot normally listen on the same port.

```js
// parent.js
import { fork } from "node:child_process";
import { createServer } from "node:net";

const child = fork("./child.js");
const server = createServer((socket) => socket.end("handled by parent\n"));
server.listen(1337, () => child.send("server", server));

// child.js
process.on("message", (m, server) => {
  if (m === "server") {
    server.on("connection", (socket) => socket.end("handled by child\n"));
  }
});
```

After this both processes accept connections on port 1337 and the operating system picks which one gets each client. Individual connections can be routed the same way: `child.send("socket", socket)` hands one accepted connection to one specific child.

In production this mechanism is mostly used indirectly. The `cluster` module is built on it: in round-robin mode the primary accepts each connection and sends the socket handle to a chosen worker, and in the shared mode it sends the listening server handle to every worker. Direct uses are:

- privilege separation (a parent running as root binds port 80 or 443, hands the server to children, then the children drop privileges);
- sticky sessions (a connection must reach a particular worker, for example WebSocket servers hashing on client IP, as the `sticky-session` package does);
- zero-downtime restarts (a supervisor keeps the listening socket and passes it to a freshly started version of the application).

Gotcha: once a server handle is sent, the parent still owns its copy and still accepts connections unless you close it or remove its listeners, which is why the example above answers from both processes. Sending a `net.Socket` closes the parent's copy by default (pass `{ keepOpen: true }` to keep it). The send is asynchronous and the handle must not be used in the parent while it is in flight. Only these network handles can be passed, not arbitrary file descriptors or pipes, and the receiving side must be a Node process connected through an IPC channel.

</details><br>

<details>
<summary>150. Why does an open IPC channel keep a Node.js parent and child from exiting, and how do you let them finish?</summary>

Node exits a process when its event loop has no referenced handles left: no timers, no pending I/O, no open server. The IPC channel created by `fork()` is an open handle in both the parent and the child, and it stays open until one side closes it. So after the child has sent its result, both event loops still wait for a possible next message and neither process exits; the script prints its answer and hangs. There are three fixes. `child.disconnect()` in the parent, or `process.disconnect()` in the child, closes the channel, both sides get a `disconnect` event, and each process exits once its own work is done. Alternatively keep the channel open but stop counting it: `child.unref()` only unrefs the process handle, so the channel also needs `child.channel.unref()` (mirror in the child: `process.channel.unref()`, with `ref()` to start waiting again).

```js
// parent.js
import { fork } from "node:child_process";
const child = fork("./child.js");
child.on("message", (result) => {
  console.log(result); // 42
  child.disconnect(); // without this line both processes hang
});
child.send(21);

// child.js
process.on("message", (n) => process.send(n * 2));

// long-lived helper the parent may never talk to again:
const helper = fork("./helper.js");
helper.unref();
helper.channel.unref(); // parent can exit, helper keeps running
```

Gotcha: `fork` is just `spawn(process.execPath, [module, ...args], { stdio: ["pipe", "pipe", "pipe", "ipc"] })`; the `"ipc"` slot creates the channel and passes its descriptor to the child via `NODE_CHANNEL_FD`, which is what makes `process.send` appear. Use `spawn` with an `"ipc"` slot yourself to run a different Node binary or to combine messaging with `"inherit"` stdio. The `stdout` and `stderr` pipes from `stdio: "pipe"` are also handles that keep the parent alive, so a fully independent background child needs `detached: true`, `stdio: "ignore"`, and `unref()`.

</details><br>

<details>
<summary>151. How do you start a child process from Node.js that keeps running after the parent exits, and what do detached, unref, and stdio do in that setup?</summary>

Three separate things tie a child to its parent, and each needs its own option:

- `detached: true` (the operating system groups the child with the parent's session and process group, so a signal sent to the group, for example Ctrl+C in the terminal or `SIGHUP` when it closes, reaches the child too; this option makes the child the leader of a new process group and session on Unix, the `setsid` call, and on Windows gives it its own console instead);
- `subprocess.unref()` (the parent's event loop counts the child as a referenced handle and keeps the parent alive until the child exits; this call removes it from that count so the parent can exit on its own);
- `stdio: "ignore"` or file descriptors from `fs.openSync` (the default `stdio` pipes connect the child's output to the parent, which both keeps the parent alive and breaks the child's writes once the parent is gone; these give the child somewhere else to write).

```js
import { openSync } from "node:fs";
import { spawn } from "node:child_process";

const out = openSync("./out.log", "a");
const err = openSync("./out.log", "a");

const subprocess = spawn("node", ["./daemon.js"], {
  detached: true, // own session: terminal signals no longer reach it
  stdio: ["ignore", out, err], // no stdin, stdout and stderr appended to a file
});
subprocess.unref(); // parent may exit now; child keeps running
console.log("started", subprocess.pid);
```

Gotcha: a child can outlive its parent even without `detached`, since Unix never kills children automatically when the parent dies; `detached` only decides whether it shares the terminal's signals. `unref()` does not take effect while an IPC channel is open; call `subprocess.disconnect()` or `subprocess.channel.unref()` as well. Keep the `pid` (write it to a file) if you ever need to stop the daemon, because after the parent exits nothing else refers to it. For anything long-lived in production prefer a real supervisor such as `systemd`, `pm2`, or a container orchestrator, which also restarts the process when it crashes.

</details><br>

<details>
<summary>152. How do you make sure a child process started in Node.js is always stopped when the code that owns it finishes, and what is the modern way to express that?</summary>

The modern way is explicit resource management: the `using` declaration, supported natively since Node 24 (2025). A variable declared with `using` is tied to the block it lives in; when the block ends for any reason, a normal return, a thrown error, or an early `break`, JavaScript automatically calls the value's `[Symbol.dispose]()` method. `ChildProcess` implements that method by killing the process, so a child declared with `using` can never be left running by accident. The ownership is visible in the code: the child lives exactly as long as the scope that created it.

```js
import { spawn } from "node:child_process";
import { once } from "node:events";

async function render(job) {
  using worker = spawn("node", ["./render.js", job.id], { stdio: "inherit" });
  const [code] = await once(worker, "exit"); // normal path: wait for it
  if (code !== 0) throw new Error(`render failed with ${code}`);
} // if we got here by throwing or timing out,
// worker is killed automatically

await using db = await openDatabase(); // async variant for resources with [Symbol.asyncDispose]()
```

Before this, the usual pattern was to create an `AbortController` for every child and pass `signal: ac.signal`, then call `ac.abort()` in a `finally` block or shutdown hook. The Node documentation marked that use of `AbortSignal`, as a general tool for tearing down long-lived resources, as deprecated in 2025 and points to `using` instead. `AbortSignal` is still correct for its original purpose, cancellation that arrives from outside: a user pressing cancel, an HTTP client disconnecting, or `AbortSignal.timeout(ms)` giving up after a deadline.

Gotcha: `using` only works on objects that have a dispose method; add `[Symbol.dispose]()` or `[Symbol.asyncDispose]()` to your own classes to opt in. Node 24 gives `ChildProcess` the synchronous `Symbol.dispose` only, so `using` works but `await using` on a child does not yet; check your version. Disposal sends `SIGTERM` and does not wait for the process to exit, so if you need the exit code you still have to await the `exit` event yourself, as the example does.

</details><br>

<details>
<summary>153. How do you run a command in the background in bash, and how do you find and stop it later?</summary>

Appending `&` to a command starts it as a background job: the shell prints the job number and PID, for example `[1] 12345`, and returns to the prompt immediately while the process keeps running. The job-control commands are:

- `jobs` (lists the shell's background jobs);
- `fg %1` (brings job 1 back to the foreground);
- `bg %1` (resumes a stopped job in the background);
- `$!` (holds the PID of the most recent background process).

Any process can be found with `ps` and terminated with `kill`.

```sh
node server.js &            # [1] 12345
jobs                        # [1]+ Running  node server.js &
echo $!                     # 12345

ps aux | grep "node server" # find it later, from any terminal
kill 12345                  # send SIGTERM, polite request to exit
kill -9 12345               # SIGKILL, cannot be caught, last resort
kill %1                     # by job number in the same shell
```

Pressing Ctrl+Z stops a foreground process and `bg` then continues it in the background.

Gotcha: background jobs are still children of the shell and receive `SIGHUP` when the terminal closes, so use `disown` or `nohup` for anything that must outlive the session. A background job that reads from the terminal is stopped by the kernel with `SIGTTIN` until you `fg` it.

</details><br>

<details>
<summary>154. What is the difference between the exit and close events of a Node.js ChildProcess, and what do their arguments mean?</summary>

`exit` fires when the process itself has finished running.

`close` fires when the process has finished and all its output streams (stdout/stderr) have been fully read and closed.

</details><br>

<details>
<summary>155. What is the Unix niceness value, how does it affect CPU scheduling, and how do you start a process with a given niceness?</summary>

Every process has a nice value that tells the scheduler how willing it is to yield CPU time to others. On Linux the range is `-20` to `19` (BSD and macOS use `-20` to `20`). The default is `0`. A higher number is "nicer", which means lower priority; `19` yields to everything, `-20` gets the largest share. `nice -n adjustment command` starts a command with its niceness changed by the given amount relative to the current value. Children inherit the parent's niceness, so applying `nice` to a script covers everything it spawns.

```sh
nice -n 19 ffmpeg -i original.mov out.mp4   # low priority, stays polite to other processes
nice -n 10 ./backup.sh                      # medium
sudo nice -n -20 ./latency-critical         # high priority, negative needs root
ps -o pid,ni,cmd -p <PID>                   # NI column shows the value
```

Any user can raise a nice value (lower the priority); only root or a process with `CAP_SYS_NICE` can lower it or go negative. Kernel and system daemons often run at negative values.

Gotcha: niceness is relative and only matters when CPUs are contended. On an idle machine a nice-19 process still gets a full core. It controls CPU share only, not disk or network, so for I/O-heavy jobs use `ionice` (for example `ionice -c3` for the idle class). From Node you can wrap the command, `spawn("nice", ["-n", "19", "ffmpeg", ...])`, to keep a transcoding job from starving your API server.

</details><br>

<details>
<summary>156. How do you change the niceness of a process that is already running, and how do you inspect it?</summary>

`nice` only sets the niceness at launch. `renice` changes it afterward for an existing process by PID, for all processes of a user, or for a process group. The modern syntax on Linux and macOS is `renice -n value -p PID`; the older form `renice value PID` is still widely used and accepted. To see the current value, use the `NI` column in `ps -l`, `ps -o ni`, `top`, or `htop`.

```sh
renice -n 19 -p 1234           # make PID 1234 as polite as possible
renice -n 5 -u alice           # all processes owned by alice
sudo renice -n -5 -p 1234      # raise priority, root only

ps -o pid,ni,cmd -p 1234       # NI column
top                            # NI column; PR is kernel priority, roughly 20 + NI
```

Gotcha: the same permission rules apply as for `nice`: an unprivileged user can only increase a process's niceness, and on Linux cannot lower it back afterward even to its previous value, unless `RLIMIT_NICE` (`ulimit -e`) allows it. `renice` on a process affects only that process, not children it already started, since each child has its own copy of the value.

</details><br>

<details>
<summary>157. How can a Node.js program set the scheduling priority of itself or another process?</summary>

The `os` module exposes the niceness mechanism portably. `os.setPriority(pid, priority)` sets the priority of the given process, and `os.setPriority(priority)` applies it to the current process; `os.getPriority(pid)` reads it. Values range from `-20` (highest priority) to `19` (lowest), matching Unix niceness, and `os.constants.priority` provides named levels:

- `PRIORITY_LOW` (19);
- `PRIORITY_BELOW_NORMAL` (10);
- `PRIORITY_NORMAL` (0);
- `PRIORITY_ABOVE_NORMAL` (-7);
- `PRIORITY_HIGH` (-14);
- `PRIORITY_HIGHEST` (-20).

On Windows Node maps these ranges onto the six Windows priority classes, so the same code works there too. A typical use is lowering the priority of a CPU-hungry child such as `ffmpeg` so the main server stays responsive.

```js
import { spawn } from "node:child_process";
import os from "node:os";

const ffmpeg = spawn("ffmpeg", [
  "-y",
  "-i",
  "input.mov",
  "-threads",
  "2",
  "output.mp4",
]);
os.setPriority(ffmpeg.pid, os.constants.priority.PRIORITY_LOW); // same as 19
console.log(os.getPriority(ffmpeg.pid)); // 19

// alternative: let the OS do it at launch
spawn("nice", ["-n", "19", "ffmpeg", "-y", "-i", "input.mov", "output.mp4"]);
```

Gotcha: the operating system's permission rules still apply, so lowering the value below the current one (raising priority) throws `EACCES` on Linux unless the process runs as root, and `PRIORITY_HIGHEST` on Windows requires elevated privileges. Priority limits CPU share only; to limit how many cores a tool like `ffmpeg` uses, pass its own `-threads` option.

</details><br>

<details>
<summary>158. What does the spawn event of a Node.js ChildProcess tell you, how does it relate to the error event, and why can it fire even when the command fails?</summary>

`spawn` is emitted once the operating system has successfully started the child process. It comes before every other event and before any `stdout` or `stderr` data, so it is the first moment the `pid` is known to be valid and the point at which setup that depends on a running process can begin, for example writing a pid file or starting a watchdog timer. If the process cannot be started at all, `spawn` is never emitted and `error` is emitted instead, typically with `ENOENT` when the executable is not in `PATH` or `EACCES` when it is not executable. `error` also fires when a `kill()` fails or an IPC message cannot be delivered. In the start-up failure case `exit` may never follow, so a child without an `error` handler crashes the parent with an unhandled error.

```js
import { spawn } from "node:child_process";

const child = spawn("ffmpeg", ["-i", "in.mov", "out.mp4"]);

child.once("spawn", () => console.log("running as pid", child.pid));
child.once("error", (err) => {
  if (err.code === "ENOENT")
    console.error("ffmpeg is not installed or not in PATH");
  else console.error("could not start or signal the process:", err);
});
child.on("exit", (code, signal) => console.log("exit", code, signal));
```

Gotcha: `spawn` only confirms that the first program started. `spawn("bash", ["-c", "some-command"])`, or any call with `shell: true`, emits `spawn` as soon as the shell itself is running, even if the shell then fails to find `some-command`. That failure shows up later as a non-zero `code` on `exit` (127 for "command not found" in POSIX shells), not as an `error` event, so when a shell is involved you must check the exit code as well.

</details><br>

<details>
<summary>159. What do process exit codes mean, and why does a process killed by a signal report a code above 128?</summary>

When a process ends it hands an exit code, an integer from 0 to 255, back to whoever launched it: a shell, a CI runner, Docker, or a Node parent. `0` means success. Small non-zero values are chosen by the program itself to describe failures; Node's own codes include:

- `1` (uncaught fatal exception);
- `9` (invalid command-line argument);
- `13` (unsettled top-level `await`).

A process that is killed by a signal has no exit code of its own, so the shell reports `128 + N`, where `N` is the signal number. The high bit (128) therefore means "terminated by a signal" and the low bits carry which one, which keeps `130` from being confused with a program that deliberately exited with code `2`.

```
Signal           Number   Reported code
SIGHUP           1        129
SIGINT (Ctrl+C)  2        130
SIGABRT          6        134
SIGKILL          9        137
SIGTERM          15       143
```

```sh
node -e "process.kill(process.pid, 'SIGABRT')"; echo $?    # 134
node -e "process.exitCode = 3"; echo $?                    # 3
```

Gotcha: `137` in a Docker or Kubernetes log means `SIGKILL`, almost always the OOM killer because the container exceeded its memory limit; `143` means the orchestrator asked the process to stop with `SIGTERM` and it did. Only the shell applies the `128 + N` convention: a Node parent watching a child gets `code` `null` and `signal` `"SIGKILL"` on the `exit` event instead. Codes above 255 wrap around, so `process.exit(256)` is reported as `0`.

</details><br>

<details>
<summary>160. Why is calling process.exit() usually a mistake in Node.js, and what should you do instead to set the exit code?</summary>

A Node process exits by itself as soon as the event loop has no more work: no timers, no open sockets or servers, no pending I/O. `process.exit(code)` is a hard stop that ends the process immediately, abandoning everything still queued, including writes to `stdout` that may be asynchronous when `stdout` is a pipe or, on Windows, a terminal. A usage message printed just before `process.exit(1)` can therefore come out truncated or not at all. The recommended pattern is to set `process.exitCode` and let the process end naturally; the property becomes the exit status when the process exits on its own or when `process.exit()` is later called without an argument. When the program must stop because of an error, throwing an uncaught error is safer than `process.exit()`, because Node flushes synchronous output and runs the normal shutdown path with code `1`.

```js
// what not to do
if (!argsValid) {
  printUsage(); // may still be in flight
  process.exit(1); // kills the process before stdout drains
}

// recommended
if (!argsValid) {
  printUsage();
  process.exitCode = 1; // exit happens when the event loop is empty
}
```

Gotcha: `process.exit()` is still right when something keeps the loop alive on purpose and you really want to stop now.

</details><br>

<details>
<summary>161. What can a listener for the Node.js process exit event do, and why does asynchronous work scheduled inside it never run?</summary>

The `exit` event is emitted on `process` when the process is about to end, either because the event loop ran dry or because `process.exit()` was called, and the listener receives the exit code. After all `exit` listeners have returned, the process terminates immediately; the event loop never turns again. Anything the listener schedules asynchronously, a timer, a promise continuation, an `fs` callback, a `write` to a pipe, is silently abandoned. Listeners must therefore perform only synchronous operations: writing a final log line with `fs.writeSync`, deleting a pid file with `fs.unlinkSync`, or flushing an in-memory buffer synchronously.

```js
process.on("exit", (code) => {
  setTimeout(() => console.log("this will never run"), 0);
  fs.writeSync(1, `exiting with ${code}\n`); // synchronous: this works
  fs.rmSync("./app.pid", { force: true }); // synchronous: this works
});
```

Gotcha: `exit` is not emitted when the process is killed by a signal it does not handle (`SIGKILL`, or `SIGTERM` without a listener), so it is not a reliable place for cleanup that matters; handle `SIGTERM` and `SIGINT` explicitly and do the asynchronous shutdown there. The event `beforeExit` is the asynchronous counterpart: it fires when the loop is empty but the process has not committed to exiting yet, so scheduling more work there keeps the process alive, which is useful for a final flush to a remote log service.

</details><br>

<details>
<summary>162. How should the uncaughtException event be used in Node.js, and why is resuming normal operation after it unsafe?</summary>

`uncaughtException` fires on `process` when an error propagates all the way up without being caught, for example a throw inside a callback or an `EventEmitter` `error` event with no listener. Without a listener Node prints the stack trace and exits with code `1`. Adding a listener replaces that default, so the process keeps running, and that is the trap. The exception interrupted some operation half way: a database transaction may be open, a lock held, a response half written, in-memory state partially updated. The Node documentation compares resuming to pulling the power cord during an upgrade: nine times out of ten nothing happens, the tenth time the system is corrupted. The correct use is to perform synchronous cleanup of resources such as file descriptors and handles, log the error, and then shut down, letting a supervisor (systemd, pm2, Kubernetes) start a fresh process.

```js
process.on("uncaughtException", (err, origin) => {
  fs.writeSync(2, `${origin}: ${err.stack}\n`); // synchronous logging
  releaseLocksSync();
  process.exit(1); // never continue serving
});
```

Gotcha: `process.setUncaughtExceptionCaptureCallback(fn)` installs a single capture function instead; while it is set, the `uncaughtException` event is not emitted at all, and it cannot be combined with the deprecated `domain` module. To observe crashes without changing behavior, for example to report to Sentry, use the `uncaughtExceptionMonitor` event, which runs before the normal handling and does not prevent the exit. The same reasoning applies to `unhandledRejection`, which since Node 15 (2020) also terminates the process by default.

</details><br>

<details>
<summary>163. How does a Node.js process receive operating system signals, which ones cannot be handled, and how does Windows differ?</summary>

The `process` object emits an event named after each signal in upper case, such as `SIGINT` or `SIGTERM`, when the operating system delivers it. Installing a listener replaces the default action, which for both of those is to terminate, so a process with a `SIGINT` listener no longer dies on Ctrl+C and must exit itself. This is the hook for graceful shutdown: stop accepting connections, finish in-flight requests, close database pools, then exit. `SIGKILL` and `SIGSTOP` cannot be listened for; the kernel enforces them without consulting the process. Signal events are only available on the main thread, not inside worker threads.

```js
process.stdin.resume(); // keep the process alive for the demo

function shutdown(signal) {
  console.log(`received ${signal}, closing`);
  server.close(() => process.exit(0)); // stop listening, finish in-flight requests
  setTimeout(() => process.exit(1), 10_000).unref(); // hard deadline
}
process.on("SIGINT", shutdown); // Ctrl+C in the terminal
process.on("SIGTERM", shutdown); // kill <pid>, docker stop, kubernetes

process.kill(otherPid, "SIGTERM"); // send one; signal 0 only checks the pid exists
```

Gotcha: Windows has no POSIX signals. Node emulates a few: Ctrl+C in a console still emits `SIGINT`, and `process.kill()` or `subprocess.kill()` with `SIGINT`, `SIGTERM`, or `SIGKILL` terminates the target unconditionally without running its handlers, after which the parent reports a signal-terminated child. Graceful shutdown on Windows therefore needs another channel, such as an IPC message. On Unix, `docker stop` sends `SIGTERM` and waits 10 seconds before `SIGKILL`, so a shutdown that takes longer gets code `137`.

</details><br>

<details>
<summary>164. What kind of streams are process.stdin, process.stdout, and process.stderr in Node.js, when are writes to them synchronous, and how do you detect a terminal?</summary>

The three standard streams are created lazily, and their class depends on what file descriptors 0, 1, and 2 are connected to when the process starts. There are three cases:

- `tty.ReadStream` and `tty.WriteStream` (connected to a terminal; they extend `net.Socket` and add terminal features such as `isTTY`, `columns`, `rows`, and `getColorDepth()`);
- `net.Socket` (connected to a pipe or socket, for example `node app.js | grep x` or a child started with `stdio: "pipe"`);
- `SyncWriteStream` (connected to a regular file, as in `node app.js > out.txt`; an internal plain `Writable` that calls `fs.writeSync` and is not a socket at all).

So the statement "stdout is a `net.Socket`" is true for terminals and pipes but false for files. Node reuses the socket class because libuv exposes pipes, Unix sockets, and TTYs through the same stream handle.

```sh
node -e "console.error(process.stdout.constructor.name)"            # in a real terminal: WriteStream (tty)
node -e "console.error(process.stdout.constructor.name)" | cat      # pipe:     Socket
node -e "console.error(process.stdout.constructor.name)" > o.txt    # file:     SyncWriteStream
```

The class decides whether a write is synchronous, and the rules differ by platform:

```
Target             POSIX           Windows
Files              synchronous     synchronous
Terminals (TTY)    synchronous     asynchronous
Pipes and sockets  asynchronous    synchronous
```

Synchronous writes keep output in order and guarantee it is on its way before `process.exit()` returns, which is why a message printed to a terminal survives an immediate exit on Linux but one printed to a pipe may be lost. `console.log` writes to `process.stdout` and `console.error` to `process.stderr`, so the same rules apply to them.

The portable way to find out which case you are in is `isTTY`, not the constructor:

```sh
node -p "Boolean(process.stdout.isTTY)"           # true
node -p "Boolean(process.stdout.isTTY)" | cat     # false
echo foo | node -p "Boolean(process.stdin.isTTY)" # false
```

```js
if (process.stdout.isTTY) {
  console.log("\x1b[32mcolored output\x1b[0m"); // a human is watching: colors, progress bars
} else {
  console.log("plain output for pipes and logs");
}
```

Gotcha: when it is a socket, `process.stdout` is `Duplex` by inheritance, but its readable side is never used and calling `end()` on it throws, because closing standard output from inside a program is almost never intended. A synchronous write blocks the event loop until it completes; a file write is nearly instant, but a pipe whose reader is slow or stalled, or a sluggish terminal, can block the loop repeatedly, so heavy production logging to `stdout` on Windows, or to files anywhere, can hurt throughput. Dedicated loggers batch writes or move them to a worker.

</details><br>

<details>
<summary>165. What does process.loadEnvFile() do in Node.js, and how does it compare to the --env-file flag and the dotenv package?</summary>

`process.loadEnvFile(path)` reads a `.env` file (default `./.env`) and copies its `KEY=value` lines into `process.env`, giving Node a built-in replacement for the `dotenv` package. Variables that already exist in the environment are not overwritten, so real deployment settings win over the file. The same parser is available as `util.parseEnv(text)`, which returns an object without touching `process.env`, and the `--env-file=path` command-line flag loads the file before any code runs. `--env-file-if-exists` (Node 22.9) does the same without failing when the file is missing.

```
# .env
PORT=3000
DB_URL="postgres://localhost/app"   # quotes and comments are supported
```

```js
import { loadEnvFile } from "node:process";
loadEnvFile(); // or loadEnvFile("./config/.env.local")
console.log(process.env.PORT); // "3000"
```

```sh
node --env-file=.env server.js
```

</details><br>

<details>
<summary>166. What is process.dlopen() in Node.js, when would you call it instead of require(), and why must you pass a module object?</summary>

`process.dlopen(module, filename, flags)` is the low-level function that loads a compiled native addon, a shared library with the `.node` extension written in C or C++ against Node-API. `require()` calls it internally whenever the resolved file ends in `.node`, so application code almost never uses it directly. The `module` argument must be an object shaped like `{ exports: {} }`, because the addon's initialization code attaches its exported functions to `module.exports`; nothing is returned. The optional `flags` come from `os.constants.dlopen`: the default `RTLD_LAZY` resolves symbols when first used, `RTLD_NOW` resolves all of them before the call returns so a missing symbol fails immediately.

```js
import { dlopen } from "node:process";
import { constants } from "node:os";
import { fileURLToPath } from "node:url";

const module = { exports: {} };
dlopen(
  module,
  fileURLToPath(new URL("./local.node", import.meta.url)),
  constants.dlopen.RTLD_NOW,
);
module.exports.foo(); // call into C++

// the usual alternative in ES modules
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const addon = require("./local.node");
```

</details><br>

<details>
<summary>167. What is the Node.js permission model, and what does process.permission.has() check?</summary>

The permission model is an opt-in sandbox for the current process. Starting Node with `--permission` denies file system access, child process spawning, worker threads, native addons, and WASI by default, and you grant each capability back with flags such as `--allow-fs-read=/app/*`, `--allow-fs-write=/tmp/*`, `--allow-child-process`, `--allow-worker`, and `--allow-addons`. `process.permission.has(scope, reference)` lets code check at runtime whether an operation would be allowed, so it can degrade gracefully. Scopes include `fs`, `fs.read`, `fs.write`, `child`, `worker`, and in newer releases `openssl.store` and `ffi`; the optional reference narrows the check to a specific path for file system scopes.

```sh
node --permission --allow-fs-read=/app/* --allow-fs-write=/app/logs/* server.js
```

```js
process.permission.has("fs.read"); // false: not all of the file system
process.permission.has("fs.read", "/app/config.json"); // true
process.permission.has("fs.write", "/etc/passwd"); // false
process.permission.has("child"); // false unless --allow-child-process
```

Gotcha: `process.permission` is only defined when the process runs with `--permission`; guard with optional chaining in libraries. The model restricts what JavaScript in this process may ask Node to do; it is not a security boundary against native addons (which is why they are blocked by default) and it does not isolate memory or network access, so it complements containers and operating system users rather than replacing them.

</details><br>

<details>
<summary>168. What do the fields returned by process.memoryUsage() mean, and which one should you watch for a given kind of problem?</summary>

`process.memoryUsage()` returns five byte counts:

- `rss` (resident set size, the physical RAM the whole process occupies: V8 heap, compiled code, thread stacks, native allocations, Buffers, and loaded libraries; the footprint a container limit cares about);
- `heapTotal` (how much memory V8 has obtained for the JavaScript heap);
- `heapUsed` (the part of that heap currently occupied by objects, including garbage not yet collected, so it rises and falls with garbage collection and is always at most `heapTotal`);
- `external` (memory of C++ objects tied to JavaScript objects but allocated outside the V8 heap, such as `Buffer` backing stores and external strings);
- `arrayBuffers` (memory of all `ArrayBuffer` and `SharedArrayBuffer` instances, including every Node `Buffer`; a subset of `external`).

Roughly, `rss` is the big box and the heap and `external` sit inside it next to things Node does not break out.

```js
const a = process.memoryUsage();
const buf = Buffer.alloc(100 * 1024 * 1024);
buf.fill(1); // touch the pages so they become resident
const b = process.memoryUsage();
console.log((b.arrayBuffers - a.arrayBuffers) / 1e6); // ~100
console.log((b.heapUsed - a.heapUsed) / 1e6); // ~0: Buffers are not on the heap
console.log((b.rss - a.rss) / 1e6); // ~100

console.log(process.memoryUsage.rss()); // much faster when you only need rss
```

Practical rule:

- `heapUsed` (watch for leaks of JavaScript objects);
- `external` and `arrayBuffers` (watch in Buffer-heavy code);
- `rss` (watch for how close you are to a real limit).

Gotcha: `rss` does not shrink promptly after garbage collection because V8 and the C allocator keep freed pages for reuse, so a high `rss` with a low `heapUsed` is usually not a leak. The full `memoryUsage()` call walks memory pages and can be slow, so do not call it on every request.

</details><br>

<details>
<summary>169. How does process.memoryUsage() behave with worker threads and with cluster workers, and why does summing rss across them overcount?</summary>

Worker threads live in the same operating system process but each has its own V8 isolate and heap. So when a worker calls `process.memoryUsage()`, `rss` is process-wide and identical to the main thread's value, while `heapTotal`, `heapUsed`, `external`, and `arrayBuffers` describe only the calling thread. The main thread's heap numbers do not include any worker's heap. To see worker memory, measure inside each worker and report it with `postMessage`, or use `worker.getHeapStatistics()` on recent Node versions, and cap a worker's heap with the `resourceLimits` option such as `maxOldGenerationSizeMb`. Cluster workers are separate processes, each with its own heap and its own `memoryUsage()`; the primary learns nothing about them unless each worker sends its numbers over IPC.

```js
// worker.js: report to the parent
import { parentPort } from "node:worker_threads";
setInterval(() => parentPort.postMessage(process.memoryUsage()), 10_000);

// cluster worker: same idea over IPC
setInterval(() => process.send({ mem: process.memoryUsage() }), 10_000);

// main thread: cap a worker's heap
new Worker("./worker.js", { resourceLimits: { maxOldGenerationSizeMb: 256 } });
```

Gotcha: adding `rss` across threads double counts because it is one number for the process; adding `rss` across cluster processes overcounts shared pages, mainly the Node binary and shared libraries, which every process counts in full. A `SharedArrayBuffer` is one block of memory but appears in `arrayBuffers` of every thread that holds it. In containers the OOM killer looks at the cgroup's total resident memory of all processes plus some kernel memory, never at `heapUsed`, so a healthy-looking heap in every worker can still get the container killed.

</details><br>

<details>
<summary>170. How do queueMicrotask() and process.nextTick() differ in Node.js, why does their order change between CommonJS and ES modules, and which should new code use?</summary>

Both defer a function until the current synchronous code finishes, before the event loop moves on to timers or I/O, but they use different queues. `queueMicrotask()` adds to the microtask queue managed by V8, the same queue used for promise `then`, `catch`, and `finally` handlers. `process.nextTick()` adds to a separate queue managed by Node. Whenever Node drains the next-tick queue, it drains the microtask queue immediately afterwards. In a CommonJS module the top-level code runs outside both queues, so after it finishes Node drains next-tick callbacks first and then microtasks. An ES module is itself evaluated as part of the microtask queue, so Node is already draining microtasks when the module body runs: new microtasks run as part of that drain, and the next-tick queue is only processed afterwards. The same three lines therefore print in opposite orders.

```js
// CommonJS (require)              // ES module (import)
Promise.resolve().then(() => console.log("resolve"));
queueMicrotask(() => console.log("microtask"));
process.nextTick(() => console.log("nextTick"));
// nextTick, resolve, microtask    // resolve, microtask, nextTick
```

The Node documentation marks `process.nextTick()` as legacy (stability 3, from Node 22.7, 2024) and recommends `queueMicrotask()` for userland code, because it is a web standard that behaves the same in browsers, Deno, and Node, and because its ordering relative to promises is predictable. `nextTick` remains for the one thing it does differently: it runs before any promise job in CommonJS, and it accepts extra arguments that are passed to the callback, which with `queueMicrotask()` requires a closure or `fn.bind(undefined, a, b)`.

Gotcha: both queues are drained to exhaustion before the loop continues, so a callback that keeps scheduling itself with either API starves timers and I/O forever; use `setImmediate()` to yield to the loop. Errors thrown inside a `queueMicrotask()` callback surface as `uncaughtException`, not as a rejected promise.

</details><br>

<details>
<summary>171. What does "releasing Zalgo" mean in asynchronous JavaScript, and how does queueMicrotask() keep an API consistently asynchronous?</summary>

An API releases Zalgo when it is sometimes synchronous and sometimes asynchronous depending on internal state. The classic case is a cache: on a miss the result arrives after an `await`, so the event or callback fires later; on a hit the data is available immediately, and if the code emits right away the event fires during the call itself, before the caller has had a chance to attach a listener. The same caller code then works on a miss and silently breaks on a hit, which depends on timing and is hard to reproduce. The fix is to defer the synchronous path so it behaves like the asynchronous one. `queueMicrotask()` is the right tool: the callback runs as soon as the current call stack unwinds, which is early enough to feel immediate but late enough that the caller's next statements, including `on("load", ...)`, have executed.

```js
class DataHandler extends EventEmitter {
  async load(key) {
    const hit = this._cache.get(key);
    if (hit !== undefined) {
      queueMicrotask(() => this.emit("load", hit)); // always asynchronous
      return;
    }
    const data = await fetchData(key);
    this._cache.set(key, data);
    this.emit("load", data);
  }
}

const handler = new DataHandler();
handler.load("user:1");
handler.on("load", (data) => console.log(data)); // now works on hit and miss alike
```

Gotcha: `process.nextTick()` would also work here but runs before any promise handler in CommonJS, so the `load` event could fire before `then` callbacks the caller expects to run first; `queueMicrotask()` keeps event emission in the same queue as promises. Promise-returning functions avoid the problem automatically, since `then` handlers are always asynchronous even when the promise is already resolved.

</details><br>

<details>
<summary>172. What is the BREACH attack, and why does HTTP response compression over HTTPS make it possible?</summary>

BREACH (Browser Reconnaissance and Exfiltration via Adaptive Compression of Hypertext), presented at Black Hat USA in August 2013, is a side-channel attack that recovers secrets such as CSRF tokens or session identifiers from HTTPS responses. TLS encrypts the body but does not hide its length. When the server compresses the body with gzip, deflate or brotli and that body contains both a secret and something the attacker controls (for example a reflected query parameter), the attacker guesses the secret one character at a time: a guess that matches a prefix of the secret gives the LZ77 stage a longer repeat, the compressed body shrinks by a byte or so, and the attacker reads that size difference off the encrypted traffic. A few thousand requests are enough to recover a token. The attack needs three conditions at once:

- `Content-Encoding` compression applied at the HTTP level (gzip, deflate, br, zstd);
- attacker-controlled input reflected into the response body;
- a static secret present in the same response body.

A common server-side remediation is to exclude responses that carry secrets from compression:

```js
import compression from "compression";

app.use(
  compression({
    filter: (req, res) => {
      if (res.getHeader("X-No-Compression")) return false; // responses with tokens opt out
      return compression.filter(req, res);
    },
  }),
);
```

Gotcha: HTTPS by itself is not a mitigation, because TLS 1.2 and TLS 1.3 both expose ciphertext length. HTTP/2 and HTTP/3 are equally affected, since body compression is independent of the transport protocol. BREACH is still a live concern as of 2026; it is TLS-level compression (the CRIME attack) that has been removed from the protocols.

</details><br>

<details>
<summary>173. How do you decompress truncated or incomplete data with Node.js zlib without getting an error?</summary>

By default a zlib decompressor finishes with `Z_FINISH`, which requires the full stream including its end marker and trailer; truncated input fails with `Z_BUF_ERROR` ("unexpected end of file"). When the data is known to be incomplete, or you only want to inspect the beginning of a large compressed file, change the flush mode used on the last chunk with the `finishFlush` option so the decompressor returns whatever it has decoded so far. The equivalents per format are:

- `zlib.constants.Z_SYNC_FLUSH` (deflate, gzip, zlib formats);
- `zlib.constants.BROTLI_OPERATION_FLUSH` (Brotli);
- `zlib.constants.ZSTD_e_flush` (Zstandard, available since Node.js 22.15 and 23.8, released in 2025).

```js
import zlib from "node:zlib";

const full = zlib.gzipSync("line one\nline two\nline three\n");
const truncated = full.subarray(0, full.length - 10); // trailer and some data missing

zlib.gunzip(truncated, (err) => console.log(err.code)); // Z_BUF_ERROR

zlib.gunzip(
  truncated,
  { finishFlush: zlib.constants.Z_SYNC_FLUSH },
  (err, out) => {
    if (err) throw err;
    console.log(out.toString()); // "line one\nline two\nline three"
  },
);
```

The same option works on stream constructors such as `zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH })`.

Gotcha: because the end of the stream is never reached, the trailing checksum (Adler-32 for zlib, CRC-32 for gzip) is never verified, so silently corrupted data can pass through. Use this only when you accept partial, unverified output.

</details><br>

<details>
<summary>174. Which zlib options control compression speed and per-stream memory in Node.js, and when should you tune them?</summary>

The `level` option (0 to 9, or `-1` for `Z_DEFAULT_COMPRESSION`, which is level 6) has by far the biggest effect on speed. Higher levels search harder for repeats and produce smaller output but take longer; lower levels produce bigger output much faster. Level 0 stores the data without compressing, level 1 is the fastest real compression and level 9 the slowest. Memory settings are a secondary speed factor: with more memory zlib processes more data per write call, so Node.js makes fewer calls into zlib and runs a little faster. The per-stream memory options are:

- `windowBits` (log2 of the LZ77 look-back window, default 15; a compressor spends `1 << (windowBits + 2)` bytes on it, 128 KiB, a decompressor only `1 << windowBits`, 32 KiB);
- `memLevel` (compression-only internal state such as hash tables, default 8, costing `1 << (memLevel + 9)` bytes, 128 KiB);
- `chunkSize` (the single output buffer each stream holds, default 16 KiB).

So a compressor at the defaults holds about 256 KiB plus the chunk, a decompressor about 32 KiB plus the chunk. Each decrement of `windowBits` or `memLevel` halves its term at the price of a worse compression ratio, which matters only when many streams run at once: a thousand concurrent compressing responses hold roughly 256 MiB of zlib state.

```js
import zlib from "node:zlib";

zlib.createGzip({ level: 1 }); // fastest, largest output, good for dynamic responses
zlib.createGzip({ level: 9 }); // smallest output, slowest, for assets compressed once
zlib.createGzip({ windowBits: 14, memLevel: 7 }); // ~128 KiB of state instead of ~256 KiB
```

Rule of thumb: keep the defaults for most applications, use `level` to choose between speed and size, and lower `windowBits` and `memLevel` only with many concurrent zlib streams or tight memory limits.

Gotcha: a decompressor's window must be at least as large as the one the compressor used, otherwise zlib fails with `Z_DATA_ERROR` ("invalid window size"), so you cannot shrink `windowBits` freely when reading data produced elsewhere; `windowBits: 0` on decompression adopts the size from the zlib header.

</details><br>

<details>
<summary>175. What does zlib.crc32() in Node.js compute, how are checksums chained, and when must it not be used?</summary>

`zlib.crc32(data, value)` computes a 32-bit Cyclic Redundancy Check of `data` and returns it as an unsigned 32-bit integer. It was added in Node.js 22.2 and 20.15 (2024). Its parameters are:

- `data` (`string`, `Buffer`, `TypedArray` or `DataView`; a string is encoded as UTF-8 before the computation);
- `value` (optional starting value, a 32-bit unsigned integer, default 0).

Passing the previous result as `value` continues the checksum, so chaining over consecutive chunks yields exactly the CRC of the concatenated data, which is how you checksum a stream without buffering it.

```js
import zlib from "node:zlib";

let crc = zlib.crc32("hello"); // 907060870
crc = zlib.crc32("world", crc); // 4192936109
zlib.crc32("helloworld"); // 4192936109, same as the chained result
```

CRC-32 is designed to detect accidental corruption in transmission and storage (it is the checksum used in gzip trailers, ZIP entries and PNG chunks). It is not suitable for cryptographic authentication: it is linear, so an attacker can modify data and fix up the checksum trivially. For integrity against an adversary use `crypto.createHash('sha256')` or an HMAC.

Gotcha: the return value is unsigned, so compare it with other unsigned results; a library that returns a signed 32-bit integer for the same data gives a negative number that must be converted with `>>> 0` before comparison.

</details><br>
