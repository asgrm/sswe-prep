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
