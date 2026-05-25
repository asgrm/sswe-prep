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
