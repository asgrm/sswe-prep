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
