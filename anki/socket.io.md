# Socket.io

<details>
<summary>1. What is the difference between `io.emit` and `socket.broadcast.emit` in Socket.IO?</summary>

`io.emit(event, data)` sends an event to every connected socket, including the one that triggered it. `socket.broadcast.emit(event, data)` sends to all connected sockets except the socket it is called on — useful for notifying others without echoing back to the sender.

```js
io.on("connection", (socket) => {
  // Sends to everyone, including this socket
  io.emit("announcement", "A new user joined");

  // Sends to everyone except this socket
  socket.broadcast.emit("announcement", "Someone else joined");
});
```

Gotcha: `io.emit` broadcasts to all sockets across all rooms. To broadcast only within a specific room, use `io.to('roomName').emit(event, data)` — otherwise you will send the event to clients who should not receive it.

</details><br>

<details>
<summary>2. How does `socket.emit()` work in Socket.IO, and what data types can be sent?</summary>

`socket.emit(eventName, ...args)` sends a named event with any number of arguments to the other side of the connection. The API is symmetric — the same method works on both client and server. The receiver listens with `socket.on(eventName, ...args)` and receives arguments in the same order they were sent.

Supported types: primitives, plain objects, arrays, and binary types (`ArrayBuffer`, `TypedArray`, `Buffer`). Socket.IO serializes everything automatically.

```js
// Client → Server
socket.emit("order", 42, "urgent", { item: "book", qty: Uint8Array.from([3]) });

io.on("connection", (socket) => {
  socket.on("order", (id, priority, details) => {
    console.log(id); // 42
    console.log(priority); // 'urgent'
    console.log(details); // { item: 'book', qty: <Buffer 03> }
  });
});

// Server → Client
io.on("connection", (socket) => {
  socket.emit("welcome", { message: "hello", data: Buffer.from([1, 2]) });
});

socket.on("welcome", (payload) => {
  console.log(payload.message); // 'hello'
  console.log(payload.data); // ArrayBuffer [ 1, 2 ]
});
```

Gotcha: do not manually call `JSON.stringify()` before emitting — Socket.IO serializes objects automatically. Passing a JSON string instead of an object means the receiver gets a string and must parse it themselves. Binary types are also handled natively: a server-side `Uint8Array` arrives as a Node.js `Buffer`; a server-side `Buffer` arrives on the client as an `ArrayBuffer`.

</details><br>

<details>
<summary>3. How do acknowledgements work in Socket.IO, and what are the two ways to implement them?</summary>

Acknowledgements give Socket.IO a request-response pattern on top of its event model. The sender passes a callback as the last argument to `emit()`, and the receiver calls that callback to confirm receipt and optionally return data. Always pair acknowledgements with `socket.timeout(ms)` — without it, the callback never fires if the other side disconnects or fails to respond.

Callback style — the callback receives an error as the first argument on timeout, or the response data on success:

```js
// Sender
socket.timeout(5000).emit("save", { name: "Alice" }, (err, response) => {
  if (err) console.error("No acknowledgement received in time");
  else console.log(response.status); // 'ok'
});

// Receiver
socket.on("save", (data, callback) => {
  db.save(data);
  callback({ status: "ok" });
});
```

Promise style — `emitWithAck()` returns a Promise that resolves with the response or rejects on timeout:

```js
// Sender
try {
  const response = await socket
    .timeout(5000)
    .emitWithAck("save", { name: "Alice" });
  console.log(response.status); // 'ok'
} catch (e) {
  console.error("No acknowledgement received in time");
}

// Receiver is identical for both styles
socket.on("save", (data, callback) => {
  db.save(data);
  callback({ status: "ok" });
});
```

The pattern is fully symmetric — the server can also emit with an acknowledgement and the client calls the callback.

Gotcha: the receiver must always call the callback (sync or async). If it forgets and no timeout is set, the sender's callback hangs forever. Always set a timeout on any emit that uses an acknowledgement.

</details><br>

<details>
<summary>4. How do catch-all listeners work in Socket.IO and when are they useful?</summary>

Catch-all listeners intercept every event on a socket without needing to register a handler per event name. `onAny` fires for every incoming event; `onAnyOutgoing` fires for every outgoing event. Both receive the event name as the first argument followed by all event arguments. They are primarily useful for debugging, logging, and monitoring without modifying existing handlers.

```js
// Log all incoming events
socket.onAny((eventName, ...args) => {
  console.log(`[IN]  ${eventName}`, args);
});

// Log all outgoing events
socket.onAnyOutgoing((eventName, ...args) => {
  console.log(`[OUT] ${eventName}`, args);
});

// Specific handlers still fire normally alongside catch-all listeners
socket.on("chat message", (msg) => {
  // runs as usual
});
```

Gotcha: catch-all listeners do not intercept internal Socket.IO system events like `connect`, `disconnect`, or `error` — only application-level events emitted with `socket.emit()`. Also, `onAnyOutgoing` is not available on the server-side `io` object; it must be attached to an individual socket instance.

</details><br>

<details>
<summary>5. What are rooms in Socket.IO and how do you use them to target subsets of connected clients?</summary>

A room is a named channel that any socket can join or leave at any time. Rooms let you broadcast events to a specific subset of connected clients rather than everyone. A socket can be in multiple rooms simultaneously, and rooms are managed entirely on the server — clients have no direct API to join or leave rooms themselves.

```js
io.on("connection", (socket) => {
  // Add this socket to a room
  socket.join("admins");

  // Emit to everyone in the room (including this socket if it's a member)
  io.to("admins").emit("announcement", "Server restarting in 5 minutes");

  // Emit to everyone NOT in the room
  io.except("admins").emit("announcement", "Nothing to see here");

  // Remove this socket from the room
  socket.leave("admins");

  // A socket can be in multiple rooms at once
  socket.join("room-A");
  socket.join("room-B");
  io.to("room-A").to("room-B").emit("update", "Affects both rooms");
  // alternative syntax
  io.to(["room-A", "room-B"]).emit("update", "Affects both rooms");
});
```

Gotcha: every socket automatically joins a room named after its own `socket.id` on connection. This means you can send a private message to a single client with `io.to(socket.id).emit(...)` without any extra setup. Rooms are cleaned up automatically on disconnect — you do not need to call `socket.leave()` manually.

</details><br>

<details>
<summary>6. What is connection state recovery in Socket.IO and how do you enable it?</summary>

Connection state recovery is a server-side feature that buffers events emitted while a client is disconnected and replays them automatically when the client reconnects. It also restores the socket's room memberships. From the client's perspective the disconnection is invisible — it receives all missed events in order as if it never dropped. `socket.recovered` is `true` after a successful recovery.

**Recovery will not always be successful. That's why you will still need to handle the case where the states of the client and the server must be synchronized.**

```js
const { Server } = require("socket.io");

const io = new Server(server, {
  connectionStateRecovery: {
    // how long to buffer events for a disconnected client (default: 2 minutes)
    maxDisconnectionDuration: 2 * 60 * 1000,
    // whether to skip middlewares on recovery (default: true)
    skipMiddlewares: true,
  },
});

io.on("connection", (socket) => {
  console.log(socket.recovered); // true if state was successfully recovered
});
```

Gotcha: recovery only works if the client reconnects within the `maxDisconnectionDuration` window. If that window expires, buffered events are discarded, the socket connects fresh, and `socket.recovered` is `false`. For longer-lived gaps you need a separate persistence strategy — for example, storing missed events in a database and replaying them on reconnect.

</details><br>

<details>
<summary>7. How does manual message recovery work in Socket.IO using a server offset, and what is the `auth` handshake option used for?</summary>

When connection state recovery is disabled or its buffer window has expired, a client can recover missed messages manually by tracking the ID of the last message it received and sending it to the server on reconnect. The server then queries its persistence layer for everything after that ID and replays it to just that socket.

The `auth` option is an arbitrary object the client sends to the server during the handshake, readable on the server via `socket.handshake.auth`. It is commonly used for tokens, user IDs, or a cursor value like `serverOffset` that tells the server where the client's state left off. `socket.auth` is a live object — mutating it between connections means the updated value is sent automatically on the next reconnect.

```js
// Client — sends serverOffset in auth on every (re)connection
const socket = io({
  auth: { serverOffset: 0 },
});

socket.on("chat message", (msg, serverOffset) => {
  renderMessage(msg);
  socket.auth.serverOffset = serverOffset; // advance cursor with each message
});
```

```js
// Server — emits the DB row ID alongside every message as the offset
io.on("connection", async (socket) => {
  socket.on("chat message", async (msg) => {
    const result = await db.run(
      "INSERT INTO messages (content) VALUES (?)",
      msg,
    );
    io.emit("chat message", msg, result.lastID);
  });

  // socket.recovered = true  → Socket.IO already replayed events, nothing to do
  // socket.recovered = false → replay missed messages manually from DB
  if (!socket.recovered) {
    await db.each(
      "SELECT id, content FROM messages WHERE id > ?",
      [socket.handshake.auth.serverOffset || 0],
      (_err, row) => {
        socket.emit("chat message", row.content, row.id);
      },
    );
  }
});
```

Gotcha: `socket.auth` mutations are only transmitted during the initial handshake of each connection attempt, not during an existing session. If the client updates `serverOffset` mid-session, the new value is not sent until the next reconnect.

</details><br>

<details>
<summary>8. How do you guarantee at-least-once delivery of Socket.IO events, and what are the two approaches?</summary>

By default, Socket.IO buffers `socket.emit()` calls during disconnection and flushes them on reconnect, but this does not cover server crashes, database failures, or messages lost mid-flight. At-least-once delivery ensures the client keeps retrying until the server explicitly acknowledges receipt.

The first approach is a manual recursive retry using acknowledgements with a timeout:

```js
function emitWithRetry(socket, event, arg) {
  socket.timeout(5000).emit(event, arg, (err) => {
    if (err) {
      // no ack received within 5 seconds — retry
      emitWithRetry(socket, event, arg);
    }
  });
}

emitWithRetry(socket, "order", { item: "book" });
```

The second approach uses the built-in `retries` option, which handles queuing and retrying automatically:

```js
const socket = io({
  ackTimeout: 10000, // ms to wait for an ack before counting as a failure
  retries: 3, // max retry attempts, The client will try to send the event (up to retries + 1 times), until it gets an acknowledgement from the server.
});

socket.emit("order", { item: "book" }); // retried automatically if unacknowledged
```

The server must call the acknowledgement callback to signal successful processing:

```js
io.on("connection", (socket) => {
  socket.on("order", async (data, callback) => {
    await db.save(data);
    callback(); // signals success — client stops retrying
  });
});
```

Gotcha: with the manual retry approach, multiple in-flight retries can arrive out of order if earlier attempts are delayed. The `retries` option avoids this by queuing messages and sending them one at a time. Either way, your server handler should be idempotent — the same message may arrive more than once, so processing it twice must not cause duplicate side effects.

</details><br>

<details>
<summary>9. How do you implement exactly-once delivery in Socket.IO to prevent duplicate message processing?</summary>

At-least-once delivery with retries solves message loss but introduces duplicates — the server may receive the same message multiple times if a retry arrives after the original was already processed. Exactly-once delivery adds idempotency by assigning each message a stable client-generated ID and using a database unique constraint to silently reject duplicates.

The client generates a stable ID per message using its socket ID combined with a counter. The same ID is resent on every retry:

```js
let counter = 0;

const socket = io({
  ackTimeout: 10000,
  retries: 3,
});

submitButton.addEventListener("click", () => {
  const clientOffset = `${socket.id}-${counter++}`;
  socket.emit("message", inputValue, clientOffset);
});
```

The server stores `clientOffset` in a column with a UNIQUE constraint. On a duplicate insert the database throws a constraint error, the server acknowledges without reprocessing, and the client stops retrying:

```js
io.on("connection", (socket) => {
  socket.on("message", async (content, clientOffset, callback) => {
    try {
      await db.run(
        "INSERT INTO messages (content, client_offset) VALUES (?, ?)",
        content,
        clientOffset,
      );
      io.emit("message", content);
      callback(); // ack — client stops retrying
    } catch (e) {
      if (e.errno === 19 /* SQLITE_CONSTRAINT — already inserted */) {
        callback(); // ack the duplicate so client stops retrying
      }
      // any other error: do not ack — client will retry
    }
  });
});
```

Gotcha: `socket.id` changes on every new connection. If the client disconnects and gets a new `socket.id` before a retry goes out, the retry carries a different offset and the message could be inserted twice. For stricter guarantees, generate the offset with `crypto.randomUUID()` before the connection is established so the ID is independent of the socket lifecycle.

</details><br>

<details>
<summary>10. How do you scale a Socket.IO server horizontally across multiple CPU cores, and what role does an adapter play?</summary>

Node.js runs on a single thread by default, leaving all other CPU cores idle. The Node.js `cluster` module solves this by forking one worker process per core, each running its own Socket.IO server instance. However, a client connected to worker A will not receive events emitted by worker B — they are separate processes with no shared memory. An adapter bridges this gap by forwarding events between all workers so that `io.emit()` reaches every connected client regardless of which worker they are on.

```js
import { availableParallelism } from "node:os";
import cluster from "node:cluster";
import { createAdapter, setupPrimary } from "@socket.io/cluster-adapter";
import { Server } from "socket.io";
import { createServer } from "node:http";

if (cluster.isPrimary) {
  const numCPUs = availableParallelism();

  for (let i = 0; i < numCPUs; i++) {
    cluster.fork({ PORT: 3000 + i });
  }

  // Primary process coordinates event forwarding between workers
  setupPrimary();
} else {
  const server = createServer();
  const io = new Server(server, {
    adapter: createAdapter(), // each worker registers with the primary
  });

  io.on("connection", (socket) => {
    socket.on("chat message", (msg) => {
      io.emit("chat message", msg); // forwarded to all workers via adapter
    });
  });

  server.listen(process.env.PORT);
}
```

Gotcha: each worker listens on a different port, so you need a load balancer (e.g. nginx) in front to distribute incoming connections. When using the long-polling transport, Socket.IO requires sticky sessions — all requests from a given client must reach the same worker, because the handshake and subsequent requests landing on different workers will fail. Using the WebSocket transport exclusively avoids this requirement since the connection is persistent.

</details><br>

<details>
<summary>11. What is HTTP long-polling in Socket.IO and what are its trade-offs compared to WebSocket?</summary>

HTTP long-polling is a transport strategy where the client communicates with the server through successive HTTP requests rather than a persistent connection. It works in two directions: long-running GET requests that stay open waiting for the server to push data, and short POST requests the client uses to send data. As soon as the server has data to send, it responds to the pending GET, and the client immediately opens a new one to keep the channel alive.

WebSocket, by contrast, establishes a single persistent full-duplex TCP connection after an initial HTTP upgrade handshake, with much lower per-message overhead and no request/response cycling.

Socket.IO starts with long-polling by default and upgrades to WebSocket once the connection is established:

```js
// client side

// Default behavior — starts on polling, upgrades to WebSocket
const socket = io();

// Force WebSocket only, skipping the polling phase entirely
const socket = io({ transports: ["websocket"] });
```

Gotcha: because Socket.IO begins with polling, the first few messages may travel over HTTP even in a WebSocket-capable environment. More importantly, the GET and POST requests for the same client can hit different nodes in a multi-server setup, so all nodes must share state via an adapter and the load balancer must be configured for sticky sessions. Forcing `transports: ['websocket']` eliminates this requirement but means clients without WebSocket support will fail to connect.

</details><br>

<details>
<summary>12. What information does the Engine.IO server send during the initial handshake, and what is each field used for?</summary>

When a client first connects, the Engine.IO server responds with a JSON handshake payload before any application data is exchanged:

```json
{
  "sid": "FSDjX-WRwSA4zTZMALqx",
  "upgrades": ["websocket"],
  "pingInterval": 25000,
  "pingTimeout": 20000,
  "maxPayload": 1000000
}
```

`sid` is the session ID. The client must include it as a `sid` query parameter on all subsequent HTTP requests so the server can associate them with the correct session.

`upgrades` lists the transports the server considers better than the current one. If it contains `"websocket"`, the client will attempt to upgrade after the initial polling connection is established.

`pingInterval` and `pingTimeout` drive the heartbeat mechanism — the server sends a PING every `pingInterval` ms, and the client must reply with a PONG within `pingTimeout` ms.

`maxPayload` is the maximum number of bytes the server will accept per packet.

Gotcha: the `sid` here is an Engine.IO session ID, distinct from the Socket.IO `socket.id` exposed to application code, though in practice they share the same value. Always include it in subsequent HTTP requests or the server will reject them as unrecognized sessions.

</details><br>

<details>
<summary>13. Why does Socket.IO start with HTTP long-polling instead of immediately attempting a WebSocket connection?</summary>

Socket.IO prioritizes reliability and perceived performance over raw efficiency. WebSocket connections can silently fail in environments with corporate proxies, personal firewalls, or overzealous antivirus software. When this happens, the client may wait up to 10 seconds before the failure is detected, visibly breaking the user experience.

By starting with HTTP long-polling — which nearly always succeeds — Socket.IO guarantees a working connection immediately, then attempts to upgrade to WebSocket in the background once the session is established.

The upgrade sequence is:

```
1. Client connects via HTTP long-polling (handshake)
2. Client sends/receives data over polling
3. Client checks outgoing buffer is empty, sets polling to read-only
4. Client attempts WebSocket connection
5. If successful, polling transport is closed and WebSocket takes over
6. If unsuccessful, polling continues uninterrupted
```

Gotcha: if you know your environment supports WebSocket reliably, you can skip the polling phase entirely by setting `transports: ['websocket']` on the client. This reduces connection overhead but means the connection will fail outright in environments where WebSocket is blocked, with no polling fallback.

</details><br>

<details>
<summary>14. How does Engine.IO detect disconnections, and what is the heartbeat mechanism?</summary>

Engine.IO treats a connection as closed under three conditions:

- a GET or POST HTTP request fails (e.g. the server shuts down)
- the WebSocket connection is closed (e.g. the user closes the browser tab)
- `socket.disconnect()` is called explicitly on either the server or client side.

Because network failures can occur silently without triggering any of these events, Engine.IO also runs a heartbeat mechanism using the `pingInterval` and `pingTimeout` values from the handshake:

```
Server                          Client
  |--- PING (every pingInterval) -->|
  |<-- PONG (within pingTimeout) ---|
```

If the server does not receive a PONG within `pingTimeout` ms of sending a PING, it considers the connection dead. Conversely, if the client does not receive a PING within `pingInterval + pingTimeout` ms, it considers the connection dead and will attempt to reconnect.

```js
// These values are set server-side and sent to the client during handshake.
// You can configure them when creating the Server:
const io = new Server(server, {
  pingInterval: 25000, // ms between each PING
  pingTimeout: 20000, // ms the client has to respond with a PONG
});
```

Gotcha: setting `pingTimeout` too low causes false disconnections on slow networks where the PONG reply arrives just after the deadline. Setting it too high means a silently dead connection goes undetected for longer, holding resources on the server unnecessarily.

</details><br>

<details>
<summary>15. What delivery guarantee does Socket.IO provide by default, and what are its implications for disconnected clients?</summary>
Socket.IO's default delivery guarantee is at-most-once: every event is sent at most one time with no retry logic. This means the same message will never be delivered twice, but it may not be delivered at all.

There are three specific behaviors that follow from this:

- If the connection breaks while an event is in flight, there is no guarantee the other side received it and no automatic retry will occur on reconnection.
- A disconnected client buffers outgoing events locally and flushes them when it reconnects — but the first point still applies, so events in flight at the moment of disconnection may still be lost.
- The server has no such buffer. Any event emitted by the server while a client is disconnected is simply dropped. When the client reconnects, it will not receive those missed events.

</details><br>

<details>
<summary>16. How do you enable debug logging in Socket.IO, and how do you scope it to specific modules?</summary>

Socket.IO uses the `debug`for all internal logging. All output is suppressed by default. You opt in by setting the `DEBUG` environment variable on Node.js or the `localStorage.debug` property in the browser.

To see everything:

```bash
# Node.js
DEBUG=* node yourfile.js
```

```js
// Browser console
localStorage.debug = "*";
```

To scope output to specific modules, use the module prefix. Scopes can be combined with commas:

```bash
# Only Socket.IO client debug messages
DEBUG=socket.io:client* node yourfile.js

# Engine.IO and all Socket.IO messages
DEBUG=engine,socket.io* node yourfile.js
```

Also, error messages like `net::ERR_CONNECTION_REFUSED`, `WebSocket is already in CLOSING or CLOSED state`, or CORS warnings in the browser console are not emitted by Socket.IO — they come from the browser itself and cannot be suppressed or controlled by the library.

</details><br>

<details>
<summary>17. What happens when sticky sessions are not configured in a multi-server Socket.IO setup, and why are they required?</summary>

Socket.IO sessions maintain state on the server that handled the initial handshake. When a client connects, the first request establishes a session identified by a `sid`. All subsequent HTTP requests for that session — polling packets, upgrade requests — must reach the same server instance, because only that instance holds the session state.

In a multi-server setup without sticky sessions, a load balancer may route follow-up requests to a different server. That server has no record of the session and responds with HTTP 400 and the error body `{"code":1,"message":"Session ID unknown"}`.

Sticky sessions (also called session affinity) fix this by configuring the load balancer to always route requests from the same client to the same server, typically using a cookie or the client's IP address.

Gotcha: sticky sessions are only required when HTTP long-polling is in use, because polling sends multiple independent HTTP requests that must all land on the same server. If you force `transports: ['websocket']` on the client, the entire session runs over a single persistent TCP connection that naturally stays on one server, making sticky sessions unnecessary. However, this removes the polling fallback for environments where WebSocket is blocked.

</details><br>

<details>
<summary>18. How do you share an express-session middleware instance with a Socket.IO server?</summary>

Pass the session middleware directly to `io.engine.use()`. This makes the session object available on every socket's request object.

```ts
import session from "express-session";
import { Server } from "socket.io";

const sessionMiddleware = session({
  secret: "changeit",
  resave: true,
  saveUninitialized: true,
});

app.use(sessionMiddleware);
io.engine.use(sessionMiddleware); // shares session with Socket.IO

io.on("connection", (socket) => {
  const session = socket.request.session;
  console.log(session.count);
});
```

Gotcha: use `io.engine.use()`, not `io.use()`. The engine-level middleware runs before the Socket.IO handshake, ensuring the session is populated before the `connection` event fires.

</details><br>

<details>
<summary>19. How can you use the express-session ID to link HTTP and Socket.IO connections for the same user?</summary>

The session ID (`req.session.id`) is stable across HTTP requests and Socket.IO connections for the same browser session. You can use it as a Socket.IO room to target all sockets belonging to a user.

```ts
// Socket.IO: join a room named after the session ID
io.on("connection", (socket) => {
  const sessionId = socket.request.session.id;
  socket.join(sessionId);
});

// Express: emit to all sockets sharing that session
app.post("/incr", (req, res) => {
  req.session.count = (req.session.count || 0) + 1;
  res.status(200).end("" + req.session.count);
  io.to(req.session.id).emit("current count", req.session.count);
});

// Express: disconnect all sockets on logout
app.post("/logout", (req, res) => {
  const sessionId = req.session.id;
  req.session.destroy(() => {
    io.in(sessionId).disconnectSockets();
    res.status(204).end();
  });
});
```

</details><br>

<details>
<summary>20. Why must you call `req.session.reload()` and `req.session.save()` when modifying session data inside a Socket.IO event handler?</summary>

Unlike HTTP requests, a Socket.IO connection is long-lived. The session object captured at connection time can become stale if it was modified elsewhere (another tab, another request). `reload()` fetches the latest version from the store; `save()` persists changes back.

```ts
io.on("connection", (socket) => {
  const req = socket.request;

  socket.on("increment", () => {
    req.session.reload((err) => {
      if (err) return socket.disconnect();
      req.session.count = (req.session.count || 0) + 1;
      req.session.save();
    });
  });
});
```

Gotcha: do not store the session in a local variable before calling `reload()`. After reload, `req.session` points to a new object — any previously captured reference still points to the stale one.

```ts
// WRONG
const session = socket.request.session;
session.reload(() => {
  session.count++; // stale reference — changes may be lost
});

// CORRECT
req.session.reload(() => {
  req.session.count++;
  req.session.save();
});
```

</details><br>

<details>
<summary>21. How do you apply a Socket.IO per-packet middleware to keep the session fresh on every incoming event?</summary>

Use `socket.use()` to register a middleware that calls `req.session.reload()` before every event handler runs. This avoids duplicating reload logic in every individual event handler.

```ts
io.on("connection", (socket) => {
  const req = socket.request;

  socket.use((__, next) => {
    req.session.reload((err) => {
      if (err) {
        socket.disconnect();
      } else {
        next();
      }
    });
  });

  socket.on("increment", () => {
    req.session.count = (req.session.count || 0) + 1;
    req.session.save();
  });
});
```

Gotcha: `socket.use()` middleware receives `(packet, next)` — not `(req, res, next)` like Express middleware. Calling `next()` passes control to the next middleware or the event handler; omitting it silently drops the event.

</details><br>

<details>
<summary>22. How do you handle session expiration for long-lived Socket.IO connections?</summary>

Periodically call `req.session.reload()` on a timer. If the session no longer exists (expired), close the underlying connection to force the client to reconnect and re-authenticate.

```ts
const SESSION_RELOAD_INTERVAL = 30 * 1000;

io.on("connection", (socket) => {
  const timer = setInterval(() => {
    socket.request.session.reload((err) => {
      if (err) {
        // session expired — force reconnect so client can re-authenticate
        socket.conn.close();
      }
    });
  }, SESSION_RELOAD_INTERVAL);

  socket.on("disconnect", () => {
    clearInterval(timer); // prevent timer leak after disconnect
  });
});
```

Gotcha: `socket.conn.close()` closes the underlying transport and triggers an automatic client reconnect attempt. `socket.disconnect()` also disconnects but suppresses the client's automatic reconnect — only use it if you want to fully terminate the session.

</details><br>

<details>
<summary>23. What configuration is required on both server and client when the frontend and backend run on different origins and share an express-session cookie?</summary>

Cookies are not sent cross-origin by default. You must configure CORS with `credentials: true` on the server and `withCredentials: true` on the client. Both Express and Socket.IO need the CORS options applied independently.

```ts
// Server
import cors from "cors";

const corsOptions = {
  origin: ["http://localhost:4200"],
  credentials: true,
};

app.use(cors(corsOptions));

const io = new Server(httpServer, {
  cors: corsOptions,
});
```

```ts
// Client
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  withCredentials: true,
});
```

Gotcha: setting `credentials: true` without a specific `origin` (e.g., using `origin: "*"`) is rejected by browsers — a wildcard origin is incompatible with credentialed requests. Always specify explicit origins when using cookies cross-site.

</details><br>

<details>
<summary>24. How do you enable cookie-based sticky sessions in Socket.IO, and what does the handshake cookie contain?</summary>

When the `cookie` option is enabled, Socket.IO sends a `Set-Cookie` header on the first HTTP request of the session, with the Engine.IO session ID as its value. A load balancer can then use this cookie to route subsequent requests from the same client to the same server node.

```ts
const io = new Server(httpServer, {
  cookie: true,
});

// equivalent explicit form with defaults
const io = new Server(httpServer, {
  cookie: {
    name: "io",
    path: "/",
    httpOnly: true,
    sameSite: "lax",
  },
});
```

The handshake response looks like:

```
Set-Cookie: io=G4J3Ci0cNDWd_Fz-AAAC; Path=/; HttpOnly; SameSite=Lax
```

Other supported cookie options: `domain`, `encode`, `expires`, `maxAge`, `secure`.

Gotcha: a Node.js client only includes cookies in requests if `withCredentials: true` is set (supported from Socket.IO v4.7.0). Without this, cookie-based sticky sessions will not work for server-to-server connections.

</details><br>

<details>
<summary>25. How do you set and read custom application cookies in Socket.IO using engine-level header events?</summary>

Socket.IO's engine exposes two events for intercepting HTTP headers. `initial_headers` fires once during the handshake; `headers` fires on every HTTP request including the WebSocket upgrade. Both give you direct access to the outgoing `headers` object.

```ts
import { serialize, parse } from "cookie";

// set a cookie once, at handshake time
io.engine.on("initial_headers", (headers, request) => {
  headers["set-cookie"] = serialize("uid", "1234", { sameSite: "strict" });
});

// conditionally set a cookie on every request
io.engine.on("headers", (headers, request) => {
  if (!request.headers.cookie) return;
  const cookies = parse(request.headers.cookie);
  if (!cookies.randomId) {
    headers["set-cookie"] = serialize("randomId", "abc", { maxAge: 86400 });
  }
});
```

Gotcha: these event emitters are synchronous. Async operations inside the callback will not work as expected — the headers will be sent before the async call resolves.

```ts
// WRONG
io.engine.on("initial_headers", async (headers, request) => {
  const session = await fetchSession(request); // too late — headers already sent
  headers["set-cookie"] = serialize("sid", session.id, { sameSite: "strict" });
});
```

If you need async work during the handshake, use the `allowRequest` option instead.

</details><br>

<details>
<summary>26. How do you type a Socket.IO server in TypeScript, and what does each generic parameter represent?</summary>

The `Server` class accepts four generic type parameters. Define each as an interface and pass them in order when constructing the server.

```ts
interface ServerToClientEvents {
  noArg: () => void;
  basicEmit: (a: number, b: string, c: Buffer) => void;
  withAck: (d: string, callback: (e: number) => void) => void;
}

interface ClientToServerEvents {
  hello: () => void;
}

interface InterServerEvents {
  ping: () => void;
}

interface SocketData {
  name: string;
  age: number;
}

const io = new Server
  ClientToServerEvents,
  ServerToClientEvents,
  InterServerEvents,
  SocketData
>();
```

- `ClientToServerEvents` — events the server listens for via `socket.on()`.
- `ServerToClientEvents` — events the server emits via `socket.emit()`, `io.emit()`, or `io.to().emit()`.
- `InterServerEvents` — events used for inter-server communication via `io.serverSideEmit()`.
- `SocketData` — the shape of `socket.data`, used to attach typed metadata to a socket.

```ts
io.on("connection", (socket) => {
  socket.on("hello", () => {}); // typed by ClientToServerEvents
  socket.emit("basicEmit", 1, "2", Buffer.from([3])); // typed by ServerToClientEvents
  socket.data.name = "john"; // typed by SocketData
});
```

Gotcha: these types are compile-time only. They do not validate or sanitize runtime input — never trust user-supplied event data without explicit validation.

</details><br>

<details>
<summary>27. How do you type a Socket.IO client in TypeScript, and how do the generic parameters differ from the server?</summary>

The client-side `Socket` type takes the same two event interfaces as the server, but with the order reversed — because what the server sends is what the client receives, and vice versa.

```ts
import { io, Socket } from "socket.io-client";

// Server: Server<ClientToServerEvents, ServerToClientEvents>
// Client: Socket<ServerToClientEvents, ClientToServerEvents>
const socket: Socket<ServerToClientEvents, ClientToServerEvents> = io();

socket.emit("hello"); // typed by ClientToServerEvents

socket.on("basicEmit", (a, b, c) => {
  // a: number, b: string, c: Buffer — inferred from ServerToClientEvents
});

socket.on("withAck", (d, callback) => {
  // d: string, callback: (e: number) => void — fully inferred
});
```

Gotcha: the most common mistake is passing the interfaces in the same order as the server. On the client, the first parameter is what it receives (ServerToClientEvents) and the second is what it sends (ClientToServerEvents) — the inverse of the server.

</details><br>

<details>
<summary>28. How do you apply separate TypeScript types to a Socket.IO namespace?</summary>

Each namespace can be typed independently by passing its own event interfaces to `io.of()` and annotating the result as `Namespace<...>`. The client mirrors this by typing the `Socket` returned from `io("/namespace-name")`.

```ts
// Server
import { Server, Namespace } from "socket.io";

interface NsClientToServer {
  foo: (arg: string) => void;
}
interface NsServerToClient {
  bar: (arg: string) => void;
}

const io = new Server();

const myNamespace: Namespace<NsClientToServer, NsServerToClient> =
  io.of("/my-namespace");

myNamespace.on("connection", (socket) => {
  socket.on("foo", () => {}); // typed by NsClientToServer
  socket.emit("bar", "123"); // typed by NsServerToClient
});
```

```ts
// Client
import { io, Socket } from "socket.io-client";

const socket: Socket<NsServerToClient, NsClientToServer> = io("/my-namespace");

socket.on("bar", (arg) => {
  console.log(arg); // arg inferred as string
});
```

Gotcha: the main `Server` instance and each namespace carry their own independent type parameters. Types declared on the root `io` do not automatically apply to namespaces created with `io.of()`.

</details><br>

<details>
<summary>29. What is a Socket.IO namespace and what does each namespace independently maintain?</summary>

A namespace is a communication channel that lets you split application logic over a single shared connection (multiplexing). Each namespace independently maintains its own event handlers, rooms, and middlewares — they do not bleed into one another.

```ts
// separate event handlers
io.of("/orders").on("connection", (socket) => {
  socket.on("order:list", () => {});
});

io.of("/users").on("connection", (socket) => {
  socket.on("user:list", () => {});
});

// rooms with the same name are distinct across namespaces
io.of("/orders").on("connection", (socket) => {
  socket.join("room1");
  io.of("/orders").to("room1").emit("hello"); // only reaches /orders sockets
});

io.of("/users").on("connection", (socket) => {
  socket.join("room1"); // different room1, different namespace
  io.of("/users").to("room1").emit("holà");
});

// separate middlewares
io.of("/orders").use((socket, next) => {
  // auth check scoped to /orders only
  next();
});
```

</details><br>

<details>
<summary>30. What is the main namespace in Socket.IO and how do top-level `io` methods relate to it?</summary>

The main namespace is `/`. All methods called directly on the `io` instance are shorthand for calling the same methods on `io.of("/")`. The alias `io.sockets` also points to the same namespace.

```ts
io.on("connection", (socket) => {});
io.use((socket, next) => {
  next();
});
io.emit("hello");

// all equivalent to:
io.of("/").on("connection", (socket) => {});
io.of("/").use((socket, next) => {
  next();
});
io.of("/").emit("hello");

// io.sockets is simply an alias
io.sockets === io.of("/"); // true
```

</details><br>

<details>
<summary>31. How does Socket.IO multiplexing work on the client, and when is it disabled?</summary>

When a client connects to multiple namespaces on the same origin, Socket.IO reuses a single underlying WebSocket connection and routes packets to the correct namespace automatically.

```ts
// one WebSocket connection, three namespaces
const socket = io();
const orderSocket = io("/orders");
const userSocket = io("/users");

// cross-origin equivalent
const socket = io("https://example.com");
const orderSocket = io("https://example.com/orders");
```

Multiplexing is disabled — resulting in separate WebSocket connections — in three cases:

connecting to the same namespace more than once, connecting to different domains, or using the `forceNew` option.

```ts
const socket1 = io();
const socket2 = io(); // separate connection — same namespace opened twice

const socket3 = io("https://first.example.com");
const socket4 = io("https://second.example.com"); // separate connection — different domains

const socket5 = io();
const socket6 = io("/admin", { forceNew: true }); // separate connection — forced
```

</details><br>

<details>
<summary>32. How do you create dynamic namespaces in Socket.IO using a regex or function, and what is a parent namespace?</summary>

Dynamic namespaces are created by passing a regular expression or a function to `io.of()`. The return value is a parent namespace — middlewares and broadcasts applied to it automatically propagate to all matched child namespaces.

```ts
// regex-based dynamic namespace
io.of(/^\/dynamic-\d+$/).on("connection", (socket) => {
  const namespace = socket.nsp; // the specific matched namespace
});

// function-based — call next(null, true) to allow, next(null, false) to deny
io.of((name, auth, next) => {
  next(null, true);
});

// function-based  for multi tenant app
io.of((name, auth, next) => {
  const match = name.match(/^\/tenant-(\w+)$/);
  if (!match) return next(null, false); // wrong shape entirely

  const tenantId = match[1]; // e.g. "acme"
  const userBelongs = auth.tenantId === tenantId;
  // only allow access to namespaces that related to this tenant
  next(null, userBelongs);
});

// parent namespace: middleware applies to all children
const parent = io.of(/^\/dynamic-\d+$/);

parent.use((socket, next) => {
  next();
}); // runs for /dynamic-1, /dynamic-2, etc.
parent.emit("hello"); // broadcast to all matched namespaces
```

Gotcha: explicitly registered namespaces take priority over dynamic ones. If `/dynamic-101` is registered with `io.of("/dynamic-101")`, the dynamic regex handler will not fire for connections to that namespace.

</details><br>

<details>
<summary>33. What drives Socket.IO server memory usage and how can you reduce per-connection overhead?</summary>

Memory usage scales linearly with two factors: the number of connected clients, and the rate of messages (emits, acknowledgements, broadcasts) sent and received per second.

By default, Socket.IO keeps a reference to the first HTTP request of each session in memory. This is needed for integrations like express-session, but can be discarded when not required.

```ts
io.engine.on("connection", (rawSocket) => {
  rawSocket.request = null;
});
```

Gotcha: nulling out `rawSocket.request` will break any middleware or code that reads from `socket.request` later in the connection lifecycle — such as express-session access inside `io.on("connection", ...)`. Only discard it if you are certain nothing downstream depends on the original request object.

</details><br>

<details>
<summary>34. How do you initialize a Socket.IO server, both standalone and with Express?</summary>

Socket.IO attaches to a Node.js HTTP server. Pass the HTTP server instance to `new Server()`. With Express, you must first wrap the Express app in an HTTP server manually — Socket.IO cannot attach directly to an Express app.

Standalone HTTP server:

```ts
import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, {
  /* options */
});

io.on("connection", (socket) => {
  // ...
});

httpServer.listen(3000);
```

With Express:

```ts
import express from "express";
import { createServer } from "http";
import { Server } from "socket.io";

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
  /* options */
});

io.on("connection", (socket) => {
  // ...
});

httpServer.listen(3000);
```

Gotcha: passing the Express `app` directly to `new Server(app)` will not work correctly. Express itself is not an HTTP server — always wrap it with `createServer(app)` first, then pass the result to Socket.IO.

</details><br>

<details>
<summary>35. What is `io.engine` in Socket.IO and what can you do with it?</summary>

`io.engine` is a reference to the underlying Engine.IO server that Socket.IO is built on top of. It exposes lower-level transport functionality not available directly on the Socket.IO server instance.

Common uses:

1. Get the count of currently connected clients at the transport level:

```js
const count = io.engine.clientsCount;
// Compare with Socket.IO-level count in the main namespace:
const count2 = io.of("/").sockets.size;
```

These two counts may differ — `clientsCount` reflects Engine.IO connections, while `sockets.size` reflects Socket.IO socket instances. They can diverge if, for example, a client connected but hasn't completed the Socket.IO handshake yet.

2. Override the session ID generator (must be unique across all servers):

```js
const uuid = require("uuid");
io.engine.generateId = (req) => {
  return uuid.v4();
};
```

</details><br>

<details>
<summary>36. What are the three special events emitted by the Engine.IO server in Socket.IO 4.1.0+?</summary>

As of `socket.io@4.1.0`, `io.engine` emits three events you can hook into:

`initial_headers` — fires just before writing response headers for the first HTTP request of a session (the handshake). Use it to set cookies or custom headers on session start:

```js
io.engine.on("initial_headers", (headers, req) => {
  headers["test"] = "123";
  headers["set-cookie"] = "mycookie=456";
});
```

`headers` — fires before writing response headers on every HTTP request in the session, including the WebSocket upgrade:

```js
io.engine.on("headers", (headers, req) => {
  headers["test"] = "789";
});
```

`connection_error` — fires when a connection is abnormally closed:

```js
io.engine.on("connection_error", (err) => {
  console.log(err.req); // the request object
  console.log(err.code); // numeric error code, e.g. 1
  console.log(err.message); // e.g. "Session ID unknown"
  console.log(err.context); // additional context object
});
```

Gotcha: `initial_headers` fires only once per session, while `headers` fires on every request — use the right one depending on whether you need session-scoped or per-request header control.

</details><br>

<details>
<summary>37. What are the four Socket.IO v4 utility methods for managing socket instances server-side, and what do they share in common?</summary>

Introduced in Socket.IO v4.0.0, these four methods let you manage socket instances in bulk from the server:

- `socketsJoin` — force matching sockets into one or more rooms
- `socketsLeave` — force matching sockets out of one or more rooms
- `disconnectSockets` — force matching sockets to disconnect
- `fetchSockets` — retrieve matching socket instances as an array

All four share the same filtering semantics as broadcasting. You can chain namespace, room, exclusion, and locality filters before calling them:

```js
io.of("/admin").in("room1").except("room2").local.disconnectSockets();
```

This disconnects all sockets in the "admin" namespace, inside "room1", excluding those also in "room2", and only on the current server.

They are also compatible with the Redis adapter (socket.io-redis@6.1.0+), so filters apply across a multi-server cluster.

</details><br>

<details>
<summary>38. How do `socketsJoin` and `socketsLeave` work in Socket.IO, and what filters can be applied?</summary>

`socketsJoin` and `socketsLeave` remotely add or remove matching socket instances from rooms without needing a reference to each socket.

```js
// All sockets join "room1"
io.socketsJoin("room1");

// All sockets in "room1" join "room2" and "room3"
io.in("room1").socketsJoin(["room2", "room3"]);

// Sockets in "room1" of the "admin" namespace join "room2"
io.of("/admin").in("room1").socketsJoin("room2");

// Target a single socket by ID
io.in(theSocketId).socketsJoin("room1");
```

`socketsLeave` follows the exact same API:

```js
io.socketsLeave("room1");
io.in("room1").socketsLeave(["room2", "room3"]);
io.of("/admin").in("room1").socketsLeave("room2");
io.in(theSocketId).socketsLeave("room1");
```

Both accept a single string or an array of room names, and both respect namespace, room, and adapter-level filters.

</details><br>

<details>
<summary>39. How does `disconnectSockets` work in Socket.IO, and what does passing `true` to it do?</summary>

`disconnectSockets` forces all matching socket instances to disconnect. It accepts an optional boolean argument: when `true`, it also closes the underlying low-level transport connection immediately rather than waiting for it to drain.

```js
// Disconnect all sockets
io.disconnectSockets();

// Disconnect all sockets in "room1" AND close the raw connection
io.in("room1").disconnectSockets(true);

// Disconnect sockets in "room1" of the "admin" namespace
io.of("/admin").in("room1").disconnectSockets();

// Target a single socket by ID
io.of("/admin").in(theSocketId).disconnectSockets();
```

Gotcha: omitting `true` (or passing `false`) performs a graceful disconnect — the low-level connection may linger briefly. Pass `true` when you need an immediate hard close.

</details><br>

<details>
<summary>40. How does `fetchSockets` work in Socket.IO, and what does each returned socket object expose?</summary>

`fetchSockets` is an async method that returns an array of socket-like objects matching the applied filters. Unlike the other utility methods, it requires `await`.

```js
const sockets = await io.fetchSockets();
const sockets = await io.in("room1").fetchSockets();
const sockets = await io.of("/admin").in("room1").fetchSockets();
const sockets = await io.in(theSocketId).fetchSockets();
```

Each object in the returned array exposes a subset of the full Socket API:

```js
for (const socket of sockets) {
  console.log(socket.id);
  console.log(socket.handshake);
  console.log(socket.rooms);
  console.log(socket.data);
  socket.emit(/* ... */);
  socket.join(/* ... */);
  socket.leave(/* ... */);
  socket.disconnect(/* ... */);
}
```

The `data` property is a plain object you can use to share arbitrary state across servers:

```js
// Server A
socket.data.username = "alice";

// Server B (via fetchSockets)
const sockets = await io.fetchSockets();
console.log(sockets[0].data.username); // "alice"
```

Gotcha: these are proxy objects, not full Socket instances — they only expose the subset shown above.

</details><br>

<details>
<summary>41. What is `serverSideEmit` in Socket.IO and how does it differ from regular `emit`?</summary>

`serverSideEmit` (added in v4.1.0) emits events to other Socket.IO server instances in a cluster — not to clients. It is the server-to-server equivalent of `emit`.

```js
// Server A — emit to all other servers
io.serverSideEmit("hello", "world");

// All other servers — listen for it
io.on("hello", (arg1) => {
  console.log(arg1); // "world"
});
```

Acknowledgements are supported:

```js
// Server A
io.serverSideEmit("ping", (err, responses) => {
  if (err) {
    // At least one server did not respond in time
    // 'responses' still contains any replies already received
  } else {
    // 'responses' has one entry per other server in the cluster
    console.log(responses[0]); // "pong"
  }
});

// Server B
io.on("ping", (cb) => {
  cb("pong");
});
```

Constraints:

- The event names `connection`, `connect`, and `new_namespace` are reserved and cannot be used.
- Arguments are JSON.stringify-ed internally — binary structures are not supported.
- The acknowledgement callback fires with an error if other servers do not respond within a set timeout.
</details><br>

<details>
<summary>42. What is the Socket.IO socket ID, and why should it not be used as a persistent user identifier?</summary>

Every new Socket.IO connection is assigned a random 20-character ID that is synchronized between server and client.

```js
// server-side
io.on("connection", (socket) => {
  console.log(socket.id); // e.g. "ojIckSD2jqNzOqIrAGzL"
});

// client-side
socket.on("connect", () => {
  console.log(socket.id); // same value
});
```

The ID is ephemeral and should not be used as a stable user identifier because:

- It is regenerated on every reconnection (page refresh, dropped WebSocket, etc.)
- Two browser tabs produce two different IDs
- No server-side message queue is maintained per ID — messages sent to a disconnected ID are lost

Use a real session ID instead, either via a cookie or sent in the auth payload at connection time. The ID cannot be overwritten, as Socket.IO uses it internally.

</details><br>

<details>
<summary>43. What information does `socket.handshake` contain in Socket.IO?</summary>

`socket.handshake` is an object populated once, at the moment the Socket.IO session is established. It exposes details about the initial HTTP request that initiated the connection.

```js
io.on("connection", (socket) => {
  console.log(socket.handshake.auth); // e.g. { token: "123" }
  console.log(socket.handshake.address); // client IP
  console.log(socket.handshake.headers); // request headers
  console.log(socket.handshake.query); // query string params
  console.log(socket.handshake.secure); // true if HTTPS/WSS
  console.log(socket.handshake.issued); // unix timestamp of creation
  console.log(socket.handshake.time); // human-readable date string
  console.log(socket.handshake.url); // full request URL
  console.log(socket.handshake.xdomain); // true if cross-domain
});
```

This is the right place to read authentication tokens or client metadata passed at connection time, since the data reflects the state of the very first request and does not change for the lifetime of the socket.

</details><br>

<details>
<summary>44. What does `socket.rooms` contain in Socket.IO, and what is its default state on connection?</summary>

`socket.rooms` is a `Set` containing the names of all rooms the socket is currently in. Every socket is automatically placed in a room named after its own ID upon connection, so the Set is never empty.

```js
io.on("connection", (socket) => {
  console.log(socket.rooms); // Set { <socket.id> }
  socket.join("room1");
  console.log(socket.rooms); // Set { <socket.id>, "room1" }
});
```

Gotcha: the socket's own ID room is added automatically and cannot be removed. It is used by Socket.IO internally to enable direct socket-to-socket messaging.

</details><br>

<details>
<summary>45. What is `socket.data` in Socket.IO and what is it used for?</summary>

`socket.data` is a plain, arbitrary object attached to each socket instance. Its primary purpose is to share state about a socket across multiple Socket.IO servers in a cluster, accessed via `fetchSockets()`.

```js
// Server A — store data on the socket
io.on("connection", (socket) => {
  socket.data.username = "alice";
});

// Server B — read it remotely
const sockets = await io.fetchSockets();
console.log(sockets[0].data.username); // "alice"
```

Using `socket.data` is preferable to attaching properties directly to the socket object when you need cross-server visibility, since `fetchSockets()` serializes and exposes `data` across the cluster.

</details><br>

<details>
<summary>46. What is `socket.conn` in Socket.IO and what low-level events does it expose?</summary>

`socket.conn` is a reference to the underlying Engine.IO socket — the transport-level connection beneath the Socket.IO abstraction. It lets you observe and react to low-level transport events.

```js
io.on("connection", (socket) => {
  console.log(socket.conn.transport.name); // "polling"

  socket.conn.once("upgrade", () => {
    // Fired when transport upgrades from HTTP long-polling to WebSocket
    console.log(socket.conn.transport.name); // "websocket"
  });

  socket.conn.on("packet", ({ type, data }) => {
    // Fired for every packet received
  });

  socket.conn.on("packetCreate", ({ type, data }) => {
    // Fired for every packet sent
  });

  socket.conn.on("drain", () => {
    // Fired when the write buffer has been flushed
  });

  socket.conn.on("close", (reason) => {
    // Fired when the underlying transport connection closes
  });
});
```

Gotcha: `upgrade` fires only once per connection lifecycle. If you need to know the current transport at any time, read `socket.conn.transport.name` directly rather than caching it before the upgrade occurs.

</details><br>

<details>
<summary>47. How can you attach custom properties to a Socket.IO socket instance, and what is the recommended pattern?</summary>

You can attach arbitrary properties directly to a socket instance as long as you do not overwrite any of Socket.IO's built-in attributes (`id`, `rooms`, `data`, `handshake`, `conn`, etc.). The common pattern is to set them in a middleware and consume them in event handlers.

```js
// Attach in a middleware
io.use(async (socket, next) => {
  try {
    const user = await fetchUser(socket);
    socket.user = user; // custom property
    next();
  } catch (e) {
    next(new Error("unknown user"));
  }
});

// Read in a connection handler
io.on("connection", (socket) => {
  console.log(socket.user);

  socket.on("set username", (username) => {
    socket.username = username; // also fine inside event handlers
  });
});
```

Gotcha: custom properties are local to the current server process. If you need a property accessible across a multi-server cluster, use `socket.data` together with `fetchSockets()` instead.

</details><br>

<details>
<summary>48. What are Socket.IO per-socket middlewares and how do they differ from connection-level (namespace.use()) middlewares?</summary>

Per-socket middlewares are registered with `socket.use()` and are called for every incoming packet on that socket, not just once at connection time. They receive the packet as a destructured `[event, ...args]` array and a `next` function.

```js
io.on("connection", (socket) => {
  socket.use(([event, ...args], next) => {
    // runs for every incoming event on this socket
    console.log("incoming packet:", event);
    next(); // must be called to continue processing
  });
});
```

Calling `next` with an error stops the packet from reaching its event handler and emits an `error` event on the socket instead:

```js
io.on("connection", (socket) => {
  socket.use(([event, ...args], next) => {
    if (isUnauthorized(event)) {
      return next(new Error("unauthorized event"));
    }
    next();
  });

  socket.on("error", (err) => {
    if (err.message === "unauthorized event") {
      socket.disconnect();
    }
  });
});
```

Gotcha: this feature is server-side only. There is no equivalent `socket.use()` on the client — use catch-all listeners (`socket.onAny()`) for client-side packet interception.

</details><br>

<details>
<summary>49. What is a Socket.IO connection middleware, when does it run, and what is it used for?</summary>

A Socket.IO middleware is a function registered with `io.use()` that runs once per incoming connection, before the socket is considered connected. It receives the Socket instance and a `next` function, and is typically used for logging, authentication, or rate limiting.

```js
io.use((socket, next) => {
  if (isValid(socket.request)) {
    next();
  } else {
    next(new Error("invalid"));
  }
});
```

Multiple middlewares can be registered and are executed sequentially. If any middleware calls `next(err)`, the remaining middlewares are skipped and the connection is refused.

```js
io.use((socket, next) => {
  next(); // passes through
});

io.use((socket, next) => {
  next(new Error("thou shall not pass")); // stops the chain
});

io.use((socket, next) => {
  next(); // never reached
});
```

Gotcha: always call `next()` — with or without an error. If you forget, the connection hangs until it times out. Also, the socket is not yet connected when middlewares run, so `disconnect` events will not fire inside a middleware even if the client drops the connection mid-handshake.

</details><br>

<details>
<summary>50. How does a Socket.IO client send credentials to the server, and how does the server access them?</summary>

The client passes credentials via the `auth` option when creating the socket. It accepts either a plain object or a callback function that receives the credentials object.

```js
// plain object
const socket = io({ auth: { token: "abc" } });

// or via callback (useful when the token may change)
const socket = io({
  auth: (cb) => {
    cb({ token: localStorage.getItem("token") });
  },
});
```

On the server, the credentials are available on `socket.handshake.auth` inside any middleware:

```js
io.use((socket, next) => {
  const token = socket.handshake.auth.token;
  if (isValidToken(token)) {
    next();
  } else {
    next(new Error("not authorized"));
  }
});
```

Gotcha: the callback form is re-evaluated on every reconnection attempt, making it useful when tokens can expire and be refreshed between attempts.

</details><br>

<details>
<summary>51. How are middleware errors surfaced to the client in Socket.IO, and how can you attach extra detail to them?</summary>

When a middleware calls `next(err)` with an `Error` object, the connection is refused and the client receives a `connect_error` event. The error's `message` property is forwarded automatically.

You can attach additional structured data to the error via a `data` property on the Error object:

```js
// server-side
io.use((socket, next) => {
  const err = new Error("not authorized");
  err.data = { content: "Please retry later" };
  next(err);
});
```

```js
// client-side
socket.on("connect_error", (err) => {
  console.log(err.message); // "not authorized"
  console.log(err.data); // { content: "Please retry later" }
});
```

Gotcha: only `message` and `data` are reliably forwarded to the client. Do not rely on other Error properties (like a custom `code`) being transmitted — attach everything extra inside `err.data`.

</details><br>

<details>
<summary>52. How do you use Express-style middlewares with Socket.IO, and how do you limit them to the handshake request only?</summary>

Socket.IO middlewares (`io.use()`) are not compatible with Express middlewares because they operate outside the HTTP request/response cycle. Starting with Socket.IO v4.6.0, Express middlewares can be applied at the Engine.IO level via `io.engine.use()`, which runs them for every incoming HTTP request including WebSocket upgrade requests.

```js
import session from "express-session";
import helmet from "helmet";

io.engine.use(helmet());

io.engine.use(
  session({
    secret: "keyboard cat",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: true },
  }),
);
```

To restrict a middleware to only the initial handshake request (and skip all subsequent HTTP requests for an established session), check whether the `sid` query parameter is absent — its presence indicates an already-established session:

```js
io.engine.use((req, res, next) => {
  const isHandshake = req._query.sid === undefined;
  if (isHandshake) {
    passport.authenticate("jwt", { session: false })(req, res, next);
  } else {
    next();
  }
});
```

Gotcha: `io.engine.use()` middlewares run on raw HTTP requests — they do not have access to the Socket instance. Use `io.use()` when you need the Socket.

</details><br>

<details>
<summary>53. What two requirements must be met when deploying Socket.IO across multiple nodes or processes?</summary>

When running more than one Socket.IO server, you must address two concerns:

1. Sticky sessions — all HTTP requests belonging to the same Socket.IO session must be routed to the same server process. This is required because the default HTTP long-polling transport sends multiple HTTP requests per session. Without it, requests land on different servers that do not share session state, causing HTTP 400 "Session ID unknown" errors.

2. A compatible adapter — the adapter handles cross-server event broadcasting and room synchronization (e.g., `@socket.io/cluster-adapter`, `socket.io-redis`).

Gotcha: if you disable HTTP long-polling entirely and use WebSocket-only transport, sticky sessions are no longer required because a WebSocket is a single persistent TCP connection. However, there is then no fallback transport:

```js
const socket = io("https://io.yourhost.com", {
  transports: ["websocket"], // no long-polling fallback
});
```

</details><br>

<details>
<summary>54. How do you configure CORS in Socket.IO v3+, and what are its limitations?</summary>

Since Socket.IO v3, CORS must be explicitly enabled by passing a `cors` option to the Server constructor. The value is passed directly to the `cors` npm package, so all its options apply.

```js
import { createServer } from "http";
import { Server } from "socket.io";

const httpServer = createServer();
const io = new Server(httpServer, {
  cors: {
    origin: ["https://example.com"],
  },
});
```

Two important limitations:

CORS only applies to browsers. A script running on a server or VM can reach your Socket.IO endpoint regardless of CORS settings. Native apps are not covered either.

CORS only applies to HTTP long-polling. WebSocket connections are not subject to browser CORS restrictions at all, so the `cors` option has no effect on them.

</details><br>

<details>
<summary>55. What is the difference between `socket.connected` and `socket.active` on the Socket.IO client?</summary>

`socket.connected` is a boolean that reflects whether the socket currently has an active connection to the server. It is `true` after the `connect` event and `false` after `disconnect`.

```js
socket.on("connect", () => {
  console.log(socket.connected); // true
});

socket.on("disconnect", () => {
  console.log(socket.connected); // false
});
```

`socket.active` indicates whether the socket will automatically attempt to reconnect after a disconnection. It is `true` for temporary disconnections (e.g. a dropped network) where the client will retry on its own, and `false` when the connection was deliberately closed by the server or the client itself — in which case `socket.connect()` must be called manually to reconnect.

```js
socket.on("disconnect", (reason) => {
  if (socket.active) {
    // temporary loss, reconnect will happen automatically
  } else {
    // deliberate close — must reconnect manually
    socket.connect();
  }
});
```

Gotcha: a socket can be `connected: false` but `active: true` simultaneously — this is the normal state during the brief gap between a drop and an automatic reconnect attempt.

</details><br>

<details>
<summary>56. How does Socket.IO handle events emitted while the client is disconnected, and how can you prevent buffering?</summary>

By default, any event emitted on a Socket.IO client while it is disconnected is buffered in memory and sent automatically once the connection is restored. This is convenient for short disconnections but can cause a large burst of stale events flooding the server when reconnection happens.

Two ways to prevent this:

Check `socket.connected` before emitting and decide what to do if the socket is offline:

```js
if (socket.connected) {
  socket.emit("message", data);
} else {
  // drop it, queue it yourself, show a UI warning, etc.
}
```

Use a volatile emit, which discards the event automatically if the socket is not connected at the moment of the call:

```js
socket.volatile.emit("message", data);
```

Gotcha: volatile events are also dropped if the socket is connected but the transport is not currently ready to send (e.g. mid-upgrade from polling to WebSocket). Use them only for data where occasional loss is acceptable, such as live position updates or heartbeat pings.

</details><br>

<details>
<summary>57. What are the serialization limitations of Socket.IO's emit, and how do you work around them for Date, Map, Set, and custom classes?</summary>

Socket.IO serializes payloads with JSON, so some JavaScript types do not survive the round trip intact.

`Date` objects are converted to their ISO string representation and arrive as a plain string:

```js
socket.emit("event", new Date());
// receiver gets "1970-01-01T00:00:00.000Z", not a Date instance
```

`Map` and `Set` are not JSON-serializable and must be manually converted before emitting:

```js
socket.emit("event", [...myMap.entries()], [...mySet.keys()]);

// receiver reconstructs manually:
socket.on("event", (rawMap, rawSet) => {
  const map = new Map(rawMap);
  const set = new Set(rawSet);
});
```

For custom classes, implement a `toJSON()` method to control how the object is serialized. It is called automatically by `JSON.stringify`:

```js
class Hero {
  #hp;
  constructor() {
    this.#hp = 42;
  }
  toJSON() {
    return { hp: this.#hp };
  }
}

socket.emit("hero", new Hero());
// receiver gets { hp: 42 }
```

Gotcha: `toJSON()` only controls serialization — there is no automatic deserialization on the receiving end. The receiver always gets a plain object and must reconstruct the class instance manually if needed.

</details><br>

<details>
<summary>58. How do you add a persistent event listener to a Socket.io socket?</summary>

Use `socket.on(eventName, listener)` to register a listener that fires every time the named event is received. The listener is appended to the end of the listeners array and remains active until explicitly removed.

```javascript
socket.on("message", (...args) => {
  console.log("Received:", args);
});
```

Gotcha: this listener will fire on every emission of the event. If you only need to handle it once, use `socket.once()` instead.

</details><br>

<details>
<summary>59. How do you register a one-time event listener on a Socket.io socket?</summary>

Use `socket.once(eventName, listener)` to register a listener that automatically removes itself after firing the first time.

```javascript
socket.once("welcome", (...args) => {
  console.log("Connected and greeted:", args);
});
```

Gotcha: if the event fires multiple times, only the first emission is handled. All subsequent emissions are silently ignored for that listener.

</details><br>

<details>
<summary>60. How do you remove a specific event listener from a Socket.io socket?</summary>

Use `socket.off(eventName, listener)` to remove a previously registered listener. You must pass a reference to the same function instance that was originally registered.

```javascript
const handleData = (...args) => {
  console.log(args);
};

socket.on("data", handleData);

// later, when cleanup is needed
socket.off("data", handleData);
```

Gotcha: if you register an anonymous arrow function with `socket.on`, you cannot remove it with `socket.off` because you have no reference to it. Always store the listener in a variable if you intend to remove it later.

</details><br>

<details>
<summary>61. How do you remove all listeners from a Socket.io socket?</summary>

Use `socket.removeAllListeners(eventName)` to remove all listeners for a specific event, or call it with no arguments to remove every listener on the socket.

```javascript
// remove all listeners for one event
socket.removeAllListeners("message");

// remove all listeners for all events
socket.removeAllListeners();
```

Gotcha: calling `socket.removeAllListeners()` with no argument is a heavy-handed operation. It will also strip internal Socket.io listeners if misused in the wrong context, so prefer scoping removal to a specific event name unless a full teardown is intentional.

</details><br>

<details>
<summary>62. What are catch-all listeners in Socket.IO and how do you register one?</summary>

Catch-all listeners, introduced in Socket.IO v3, allow you to intercept every incoming event on a socket without knowing the event name in advance. The listener receives the event name as its first argument, followed by the event's arguments.

```javascript
socket.onAny((eventName, ...args) => {
  console.log(`Event received: ${eventName}`, args);
});
```

Gotcha: catch-all listeners do not fire for acknowledgements. If a client emits an event with a callback, the acknowledgement response will not be caught by `onAny`.

</details><br>

<details>
<summary>63. What is the difference between socket.onAny() and socket.prependAny() in Socket.IO?</summary>

Both register a catch-all listener for incoming events, but they differ in execution order. `onAny` appends the listener to the end of the listeners array, while `prependAny` inserts it at the beginning, ensuring it fires before any other catch-all listeners.

```javascript
socket.onAny((eventName, ...args) => {
  console.log("fires second");
});

socket.prependAny((eventName, ...args) => {
  console.log("fires first");
});
```

</details><br>

<details>
<summary>64. How do you remove catch-all incoming listeners in Socket.IO?</summary>

Use `socket.offAny(listener)` to remove a specific catch-all listener, or call `socket.offAny()` with no arguments to remove all of them. You must hold a reference to the original function to remove it selectively.

```javascript
const listener = (eventName, ...args) => {
  console.log(eventName, args);
};

socket.onAny(listener);

// remove just this listener
socket.offAny(listener);

// or remove all catch-all listeners
socket.offAny();
```

</details><br>

<details>
<summary>65. How do you intercept all outgoing events on a Socket.IO socket?</summary>

Use `socket.onAnyOutgoing(listener)` to register a catch-all listener that fires whenever the socket emits any event. Use `socket.prependAnyOutgoing(listener)` to insert it at the front of the outgoing listeners array instead.

```javascript
socket.onAnyOutgoing((eventName, ...args) => {
  console.log(`Outgoing event: ${eventName}`, args);
});
```

Gotcha: acknowledgement callbacks sent back to the other side are not caught by `onAnyOutgoing`. Only explicit `socket.emit()` calls trigger it.

</details><br>

<details>
<summary>66. How do you remove catch-all outgoing listeners in Socket.IO?</summary>

Use `socket.offAnyOutgoing(listener)` to remove a specific outgoing catch-all listener, or call it with no arguments to remove all of them.

```javascript
const listener = (eventName, ...args) => {
  console.log(eventName, args);
};

socket.onAnyOutgoing(listener);

// remove a specific listener
socket.offAnyOutgoing(listener);

// remove all outgoing catch-all listeners
socket.offAnyOutgoing();
```

</details><br>

<details>
<summary>67. How do you emit an event only to clients connected to the current Socket.IO server instance, when running multiple servers?</summary>

In a multi-server Socket.IO setup, a normal `io.emit()` will broadcast to all clients across all servers (assuming a shared adapter like Redis). To restrict emission to only the clients connected to the current server instance, use the `local` flag.

```javascript
io.local.emit("announcement", "This server only");
```

Gotcha: this is only meaningful when running multiple Socket.IO server instances with a shared adapter. In a single-server setup, `io.local.emit` and `io.emit` behave identically.

</details><br>

<details>
<summary>68. What is the union behavior when emitting to multiple Socket.IO rooms at once?</summary>

When you chain multiple `to()` calls before emitting, Socket.IO performs a union of all targeted rooms. Every socket that belongs to at least one of the specified rooms receives the event exactly once, even if it is a member of several of the listed rooms.

```javascript
io.to("room-A").to("room-B").emit("update", "hello");
// A socket in both room-A and room-B receives the event only once
```

Gotcha: there is no deduplication step you need to handle manually — Socket.IO guarantees each socket receives the emission once regardless of how many of the targeted rooms it belongs to.

</details><br>

<details>
<summary>69. How do you broadcast to a room from a specific socket in Socket.IO, and who receives the event?</summary>

Calling `socket.to(roomName).emit()` from within a connection handler broadcasts to all sockets in the specified room except the sender. This is the standard pattern for relaying a client's message to the rest of a room without echoing it back to the originating socket.

```javascript
io.on("connection", (socket) => {
  socket.on("chat message", (msg) => {
    socket.to("general").emit("chat message", msg);
    // everyone in "general" receives it, except the socket that sent it
  });
});
```

Gotcha: if you use `io.to(roomName).emit()` instead of `socket.to(roomName).emit()`, the sender will also receive the event.

</details><br>

<details>
<summary>70. How does a socket leave a room in Socket.IO?</summary>

A socket leaves a room by calling `socket.leave(roomName)`, which works symmetrically to `socket.join(roomName)`. After leaving, the socket will no longer receive events broadcast to that room.

```javascript
io.on("connection", (socket) => {
  socket.join("game-lobby");

  socket.on("leave lobby", () => {
    socket.leave("game-lobby");
  });
});
```

Gotcha: Socket.IO automatically calls `leave` on all rooms when a socket disconnects, so manual cleanup on disconnect is not required.

</details><br>

<details>
<summary>71. How do you use Socket.IO rooms to broadcast to all devices or tabs of a specific user?</summary>

When a socket connects, you can derive the user's identity from the handshake headers and have that socket join a room named after the user ID. Since every tab or device belonging to that user joins the same room, emitting to that room ID reaches all of them simultaneously.

On the client, pass the auth token via the `auth` option (preferred) or `extraHeaders`. On the server, read it from `socket.handshake.auth` or `socket.handshake.headers` respectively.

```javascript
// CLIENT
const socket = io("https://example.com", {
  auth: {
    token: "user-jwt-token-here",
  },
});

// or via extraHeaders (non-browser environments, e.g. Node.js client)
const socket = io("https://example.com", {
  extraHeaders: {
    authorization: "Bearer user-jwt-token-here",
  },
});
```

```javascript
// SERVER
io.on("connection", async (socket) => {
  // reading from auth object (matches the auth option on client)
  const token = socket.handshake.auth.token;

  // or from headers (matches extraHeaders on client)
  // const token = socket.handshake.headers.authorization;

  const userId = await getUserIdFromToken(token);
  socket.join(userId);
});

// later, target all connections for that user
io.to(userId).emit("notification", "You have a new message");
```

Gotcha: in browser environments, `extraHeaders` is not supported by the native WebSocket transport and will only work over HTTP polling. The `auth` option works across all transports and is the recommended approach for passing credentials.

</details><br>

<details>
<summary>72. How do you use Socket.IO rooms to send targeted notifications about a specific entity?</summary>

At connection time, fetch the entities a user is associated with and have the socket join a namespaced room for each one (e.g. "project:42"). Any server-side event related to that entity can then be emitted to the corresponding room, reaching only the sockets subscribed to it.

```javascript
io.on("connection", async (socket) => {
  const projects = await fetchProjectsForUser(socket);
  projects.forEach((project) => {
    socket.join("project:" + project.id);
  });
});

// later, notify all subscribers of a specific project
io.to("project:4321").emit("project updated");
```

Gotcha: prefixing room names with a type identifier (e.g. "project:") is a convention to avoid accidental collisions between rooms for different entity types that may share numeric IDs.

</details><br>

<details>
<summary>73. Does a Socket.IO socket need to manually leave its rooms when it disconnects?</summary>

No. When a socket disconnects, Socket.IO automatically removes it from every room it had joined. No explicit `socket.leave()` calls or cleanup logic are needed on disconnect.

Gotcha: while room membership is cleaned up automatically, any application-level state you associated with that socket or those rooms (e.g. a database record, an in-memory player list) is not. That kind of cleanup still needs to be handled manually in the `disconnect` handler.

</details><br>

<details>
<summary>74. How does the Socket.IO Redis adapter synchronize events across multiple server instances?</summary>

The Redis adapter uses Redis Pub/Sub to forward packets between Socket.IO servers in a cluster. When a server needs to emit to multiple clients (e.g. a room broadcast), it delivers the event directly to its own locally connected clients and simultaneously publishes the packet to a Redis channel. All other servers in the cluster are subscribed to that channel and relay the packet to their own matching clients.

```javascript
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

const pubClient = new Redis();
const subClient = pubClient.duplicate(); // separate connection required for pub/sub

const io = new Server({
  adapter: createAdapter(pubClient, subClient),
});

io.listen(3000);
```

Gotcha: Redis Pub/Sub is stateless — no keys are stored in Redis. The adapter only uses it as a message bus, not as persistent storage.

</details><br>

<details>
<summary>75. Do you still need sticky sessions when using the Socket.IO Redis adapter?</summary>

Yes. The Redis adapter handles cross-server event broadcasting, but it does not eliminate the need for sticky sessions. During the HTTP polling phase of the Socket.IO handshake, all requests from a given client must reach the same server. Without sticky sessions, a client may hit a server that has no record of its session, resulting in HTTP 400 errors.

</details><br>

<details>
<summary>76. What happens to Socket.IO event delivery if the Redis server goes down?</summary>

If the connection to Redis is lost, the Pub/Sub channel used to forward packets to other servers becomes unavailable. Emissions will still be delivered to clients connected to the current server, but clients connected to other servers in the cluster will not receive those events. The cluster effectively degrades to isolated single-server behavior until Redis reconnects.

</details><br>

<details>
<summary>77. How do you emit Socket.IO events to connected clients from a separate Node.js process using Redis?</summary>

The `@socket.io/redis-emitter` package provides an Emitter class that publishes events to the Redis channel, allowing any Node.js process — one that is not itself a Socket.IO server — to send events to connected clients across the cluster.

```javascript
import { Emitter } from "@socket.io/redis-emitter";
import { createClient } from "redis";

const redisClient = createClient({ url: "redis://localhost:6379" });

redisClient.connect().then(() => {
  const emitter = new Emitter(redisClient);

  emitter.to("room1").emit("update", { data: 123 });
});
```

Gotcha: with `redis@3`, calling `connect()` is not necessary since the client connects automatically. With `redis@4` and later, `connect()` must be called explicitly before passing the client to the Emitter.

</details><br>

<details>
<summary>78. How do you set up the Socket.IO Redis adapter with a Redis cluster instead of a single Redis instance?</summary>

Replace the single `Redis` instance with a `Cluster` instance from ioredis, passing an array of node addresses. The rest of the setup is identical — duplicate the client for the subscriber and pass both to `createAdapter`.

```javascript
import { Cluster } from "ioredis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-adapter";

const pubClient = new Cluster([
  { host: "localhost", port: 7000 },
  { host: "localhost", port: 7001 },
  { host: "localhost", port: 7002 },
]);
const subClient = pubClient.duplicate();

const io = new Server({
  adapter: createAdapter(pubClient, subClient),
});

io.listen(3000);
```

Gotcha: you need at least two separate Redis client connections — one for publishing and one for subscribing — because a Redis client in subscribe mode cannot issue other commands.

</details><br>

<details>
<summary>79. What is the Redis Streams adapter for Socket.IO and how does it differ from the Redis Pub/Sub adapter?</summary>

The Redis Streams adapter uses a Redis stream (an append-only log structure) to forward packets between Socket.IO servers in a cluster, whereas the standard Redis adapter uses Redis Pub/Sub. The key practical difference is resilience: because a stream persists messages, a server that temporarily loses its connection to Redis can reconnect and resume reading from where it left off, with no packets lost. Pub/Sub messages that arrive during a disconnection are permanently missed.

```javascript
import { createClient } from "redis";
import { Server } from "socket.io";
import { createAdapter } from "@socket.io/redis-streams-adapter";

const redisClient = createClient({ url: "redis://localhost:6379" });

redisClient.connect().then(() => {
  const io = new Server({
    adapter: createAdapter(redisClient),
  });

  io.listen(3000);
});
```

Gotcha: by default, a single stream is shared across all namespaces. Use the `streamCount` option to partition across multiple streams if throughput becomes a bottleneck. Also use `maxLen` to cap stream size and prevent unbounded memory growth in Redis.

</details><br>

<details>
<summary>80. How does the Redis Streams adapter handle connection state recovery in Socket.IO?</summary>

When connection state recovery is enabled in Socket.IO, the Redis Streams adapter stores client sessions in Redis as standard key/value pairs. This allows a client that reconnects after a brief disconnection to recover its session and receive any missed events, rather than being treated as a brand new connection.

```javascript
const io = new Server({
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
  },
  adapter: createAdapter(redisClient),
});
```

Gotcha: session keys stored for recovery are separate from the stream itself. They are regular Redis key/value entries and are subject to expiry based on the configured `maxDisconnectionDuration`.

</details><br>

<details>
<summary>81. Why would you use a custom parser in Socket.IO instead of the default JSON parser?</summary>

The default Socket.IO parser serializes all data as JSON. This works for simple cases but has three meaningful limitations: binary data must be base64-encoded (inflating payload size by ~33%), complex types like Date, Map, and Set are silently mangled during serialization, and JSON is generally more verbose than binary formats at high message volume.

A custom parser addresses whichever of these problems applies to your use case. For example, the msgpack parser uses MessagePack, a binary format that handles binary data natively, preserves more types, and produces smaller payloads.

```javascript
// server
import { Server } from "socket.io";
import customParser from "socket.io-msgpack-parser";

const io = new Server({ parser: customParser });

// client
import { io } from "socket.io-client";
import customParser from "socket.io-msgpack-parser";

const socket = io("https://example.com", { parser: customParser });
```

Gotcha: both client and server must use the same parser. Mixing a msgpack server with a default JSON client will result in neither side being able to decode the other's packets.

</details><br>

<details>
<summary>82. What is the `new_namespace` event in Socket.IO and when does it fire?</summary>

The `new_namespace` event fires on the root server instance whenever a new namespace is created — whether dynamically or statically. It lets you apply shared setup logic (middleware, connection handlers) to every namespace in one place instead of repeating it per namespace.

```js
const io = require("socket.io")(server);

io.of(/.*/).on("connection", (socket) => {
  console.log("connected to:", socket.nsp.name);
});

io.on("new_namespace", (namespace) => {
  namespace.use((socket, next) => {
    // middleware applied to every namespace automatically
    next();
  });
});

// triggers new_namespace for "/chat"
io.of("/chat");
```

Gotcha: `new_namespace` does not fire for the default namespace (`/`) because it already exists when the server is created.

</details><br>

<details>
<summary>83. What does the `autoUnref` option do in the Socket.IO client?</summary>

By default, an active Socket.IO connection keeps the Node.js process alive, just like any open TCP socket. Setting `autoUnref: true` tells the client to "unref" its internal socket from the event loop, meaning the process is allowed to exit naturally if nothing else is keeping it alive — even if the Socket.IO connection is still open.

```js
import { io } from "socket.io-client";

const socket = io("http://localhost:3000", {
  autoUnref: true,
});

// Process will exit on its own once all other timers/sockets are done,
// without needing to explicitly call socket.disconnect()
```

Gotcha: this option only has meaningful effect in Node.js. In browsers, the concept of process lifecycle and event loop refs does not apply.

</details><br>

<details>
<summary>84. When and why would you set `autoConnect: false` in the Socket.IO client?</summary>

By default, the Socket.IO client immediately attempts to connect as soon as `io()` is called. Setting `autoConnect: false` prevents this, giving you full control over when the connection is established. This is useful when the connection depends on runtime information that is not available yet at initialization — such as an auth token, a chosen username, or user consent.

```js
import { io } from "socket.io-client";

// Socket is created but no connection is made yet
const socket = io("http://localhost:3000", {
  autoConnect: false,
});

function onUsernameSelected(username) {
  socket.auth = { username };
  socket.connect(); // connect only once we have the data we need
}
```

Gotcha: if you forget to call `socket.connect()` later, the socket will never connect and no error will be thrown — it will just silently stay disconnected.

</details><br>
