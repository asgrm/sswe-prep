# Quick Recap

- **Event loop**: single-threaded. Phases: timers → pending callbacks → idle/prepare → poll → check (setImmediate) → close callbacks. I/O is non-blocking via libuv thread pool
- **Streams**: Readable, Writable, Duplex, Transform. Process data in chunks — don't load entire file into memory. `.pipe()` connects streams and handles backpressure automatically
- **Backpressure**: writable stream's internal buffer fills up (slow consumer). `pipe()` pauses the readable automatically. Manual: check `writable.write()` return value, wait for `drain` event
- **Buffer**: raw binary data in Node.js. `Buffer.from()`, `Buffer.alloc()`. Use for: binary protocols, file processing, crypto, image manipulation
- **Binary file processing**: use `fs.createReadStream()` not `fs.readFile()` — avoid loading entire file into memory. Use `Transform` streams to process chunks
- **Worker threads**: true parallelism for CPU-bound tasks. Share memory via `SharedArrayBuffer`. Don't use for I/O (event loop handles that)
- **Cluster**: fork process per CPU core. Each gets its own event loop. Load balanced by OS. Use for HTTP servers to utilise all cores
- **EventEmitter**: observer pattern. `.on()`, `.emit()`, `.once()`, `.removeListener()`. Memory leak risk: too many listeners (`setMaxListeners`)
- **Modules**: CommonJS (`require`, `module.exports`) vs ESM (`import`/`export`). ESM is async, supports tree-shaking. Node.js 20 supports both
- **Garbage collection**: V8 generational GC. Young gen (Scavenge) + old gen (Mark-Sweep/Compact). Watch for memory leaks: closures holding references, global caches, EventEmitter listener leaks

---

## Node.js Core

### Streams

<details>
<summary>Streams — why, types, and how to use them</summary>

**Why streams:** loading a 2 GB file with `fs.readFile()` allocates 2 GB in RAM at once. Streams process data **chunk by chunk** — constant memory regardless of file size.

**Four stream types:**

| Type | Direction | Example |
|---|---|---|
| `Readable` | Source of data | `fs.createReadStream`, `http.IncomingMessage` |
| `Writable` | Sink for data | `fs.createWriteStream`, `http.ServerResponse` |
| `Duplex` | Both read and write | TCP socket, `net.Socket` |
| `Transform` | Duplex that transforms data | `zlib.createGzip()`, CSV parser |

**Basic file copy with streams:**
```typescript
import { createReadStream, createWriteStream } from 'fs';

const readable = createReadStream('large-file.bin');
const writable = createWriteStream('output.bin');

readable.pipe(writable);

writable.on('finish', () => console.log('Done'));
readable.on('error', err => console.error('Read error', err));
writable.on('error', err => console.error('Write error', err));
```

**`pipeline()` — preferred over `pipe()` for error handling:**
```typescript
import { pipeline } from 'stream/promises';
import { createReadStream, createWriteStream } from 'fs';
import { createGzip } from 'zlib';

// Compress a file — all errors properly propagated
await pipeline(
  createReadStream('input.bin'),
  createGzip(),
  createWriteStream('output.bin.gz'),
);
```

**Custom Transform stream (process CSV line by line):**
```typescript
import { Transform } from 'stream';

class CsvParserTransform extends Transform {
  private buffer = '';

  _transform(chunk: Buffer, _enc: string, callback: () => void) {
    this.buffer += chunk.toString();
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop()!; // keep incomplete last line

    for (const line of lines) {
      if (line.trim()) {
        this.push(JSON.stringify(line.split(',')) + '\n');
      }
    }
    callback();
  }

  _flush(callback: () => void) {
    if (this.buffer.trim()) {
      this.push(JSON.stringify(this.buffer.split(',')) + '\n');
    }
    callback();
  }
}

// Usage
await pipeline(
  createReadStream('data.csv'),
  new CsvParserTransform(),
  createWriteStream('data.jsonl'),
);
```

**Stream events:**
- `data` — chunk available (flowing mode)
- `end` — no more data from readable
- `finish` — writable has flushed all data
- `error` — error occurred
- `drain` — writable buffer emptied (ready for more writes)
- `close` — underlying resource closed

</details><br>

<details>
<summary>Backpressure — what it is and how to handle it</summary>

**The problem:** a fast readable produces data faster than the writable can consume it. Without backpressure handling, data accumulates in memory — leading to memory overflow or dropped data.

```
Readable: 1 GB/s  →→→→→→→→  Writable: 10 MB/s
                             [buffer fills up → OOM]
```

**How backpressure works:**
- Every Writable has an internal buffer with a `highWaterMark` (default 16 KB for byte streams).
- `writable.write(chunk)` returns `false` when the buffer is full — this is the backpressure signal.
- When the buffer drains, the writable emits `'drain'`.
- The readable should **pause** when it gets `false` from write, and **resume** on `'drain'`.

**`pipe()` and `pipeline()` handle this automatically** — that's the main reason to use them.

**Manual backpressure (when you can't use pipe):**
```typescript
import { createReadStream, createWriteStream } from 'fs';

const readable = createReadStream('large-input.bin');
const writable = createWriteStream('output.bin');

readable.on('data', (chunk: Buffer) => {
  const canContinue = writable.write(chunk);

  if (!canContinue) {
    readable.pause(); // stop producing data — buffer is full

    writable.once('drain', () => {
      readable.resume(); // buffer cleared — resume reading
    });
  }
});

readable.on('end', () => writable.end());
```

**Why `pipe()` is better than manual:**
- Automatically pauses/resumes the readable.
- Forwards errors in both directions.
- Cleans up listeners on completion.
- `pipeline()` additionally handles stream cleanup on error (prevents resource leaks).

**Real-world symptoms of missing backpressure handling:**
- Node.js process RAM grows unboundedly when processing large files.
- `Error: write after end` when writable is closed but readable keeps pushing.
- `MaxListenersExceededWarning` from repeated `drain` listener attachment.

**Backpressure in HTTP (NestJS/Express):**
```typescript
// Stream file directly to HTTP response — no memory spike
@Get('download/:filename')
async download(@Param('filename') filename: string, @Res() res: Response) {
  const filePath = path.join('/data', filename);
  const stat = await fs.stat(filePath);

  res.setHeader('Content-Length', stat.size);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = createReadStream(filePath);
  stream.pipe(res); // pipe handles backpressure with HTTP response
}
```

</details><br>

<details>
<summary>Binary file processing in Node.js</summary>

**Buffer — Node.js raw binary data:**
```typescript
// Create
const buf = Buffer.from('hello', 'utf8');
const empty = Buffer.alloc(1024); // 1 KB zeroed
const raw = Buffer.allocUnsafe(1024); // 1 KB uninitialized (faster, but may contain old data)

// Read/write
buf.readUInt32BE(0);    // big-endian unsigned 32-bit int at offset 0
buf.writeUInt32LE(42, 0); // little-endian at offset 0
buf.slice(0, 10);       // view first 10 bytes (no copy)
buf.subarray(0, 10);    // preferred over slice in modern Node.js

// Encoding
buf.toString('hex');
buf.toString('base64');
Buffer.from('aGVsbG8=', 'base64').toString('utf8'); // → 'hello'
```

**Processing a binary file format (e.g. custom binary header + body):**
```typescript
import { pipeline } from 'stream/promises';
import { createReadStream } from 'fs';
import { Transform } from 'stream';

class BinaryFrameParser extends Transform {
  private buf = Buffer.alloc(0);

  _transform(chunk: Buffer, _: string, done: () => void) {
    this.buf = Buffer.concat([this.buf, chunk]);

    // Protocol: 4-byte length prefix + payload
    while (this.buf.length >= 4) {
      const payloadLen = this.buf.readUInt32BE(0);
      const frameLen = 4 + payloadLen;

      if (this.buf.length < frameLen) break; // incomplete frame, wait for more

      const payload = this.buf.subarray(4, frameLen);
      this.buf = this.buf.subarray(frameLen); // advance buffer

      this.push(payload); // emit complete frame
    }
    done();
  }
}

await pipeline(
  createReadStream('data.bin'),
  new BinaryFrameParser(),
  async function* (source) {
    for await (const frame of source) {
      console.log('Frame:', frame.toString('hex'));
      // process frame...
    }
  },
);
```

**Key rules for binary processing:**
1. **Always use streams** — never `fs.readFile()` for large binary files.
2. **Buffer concatenation in loops is O(n²)** — accumulate chunks in an array, `Buffer.concat(chunks)` at the end.
3. **`subarray` vs `slice`** — both create views (no copy). Prefer `subarray`.
4. **Encoding matters** — specify encoding explicitly. Default is `utf8` for strings, but binary data should stay as `Buffer`.
5. **Check `highWaterMark`** on `createReadStream` — default 64 KB. Increase for binary processing with large frames.

```typescript
// Large binary files — increase chunk size for efficiency
const stream = createReadStream('video.bin', {
  highWaterMark: 1024 * 1024, // 1 MB chunks
});
```

</details><br>

### Event Loop

<details>
<summary>Event loop — how Node.js handles concurrency</summary>

Node.js is **single-threaded** but handles thousands of concurrent I/O operations via the event loop + libuv.

**Event loop phases (in order):**
```
1. timers          — executes setTimeout / setInterval callbacks whose threshold has passed
2. pending cbs     — I/O callbacks deferred from previous iteration
3. idle / prepare  — internal use
4. poll            — retrieve new I/O events; execute I/O callbacks (most work happens here)
5. check           — setImmediate() callbacks
6. close cbs       — socket.on('close', ...) etc.
```

**Microtasks** (run between every phase, highest priority):
- `Promise.then()` / `async/await` continuations
- `queueMicrotask()`
- `process.nextTick()` — runs even before other microtasks

```typescript
setTimeout(() => console.log('1 - setTimeout'));
setImmediate(() => console.log('2 - setImmediate'));
Promise.resolve().then(() => console.log('3 - Promise'));
process.nextTick(() => console.log('4 - nextTick'));
console.log('5 - sync');

// Output: 5 → 4 → 3 → 1 → 2
// sync first, then nextTick, then Promise, then timer phase, then check phase
```

**What blocks the event loop:**
- Synchronous CPU-heavy code (JSON.parse on 50 MB, crypto, regex on large strings).
- `fs.readFileSync`, `child_process.execSync`.
- Infinite loops, heavy computation in route handlers.

**What does NOT block:**
- `fs.readFile` (async) — libuv thread pool.
- `http.get` — OS async I/O.
- `setTimeout`, `setInterval` — timer phase.
- DB queries, network calls — all async.

**libuv thread pool** (default size: 4 threads):
- Handles: `fs` operations, DNS lookups (`dns.lookup`), crypto (`crypto.pbkdf2`), `zlib`.
- Network I/O (TCP/UDP) does NOT use the thread pool — handled by OS async I/O directly.
- Increase pool size: `UV_THREADPOOL_SIZE=16 node server.js`.

**Worker threads** — true CPU parallelism:
```typescript
// main.ts
import { Worker } from 'worker_threads';

const worker = new Worker('./heavy-computation.js', {
  workerData: { dataset: largeArray },
});

worker.on('message', result => console.log('Result:', result));
worker.on('error', err => console.error(err));
```

```typescript
// heavy-computation.js
import { workerData, parentPort } from 'worker_threads';
const result = heavyCompute(workerData.dataset);
parentPort!.postMessage(result);
```

**Rule:** use Worker threads for CPU-bound work (image processing, parsing, crypto). Never for I/O — the event loop handles that more efficiently.

</details><br>
