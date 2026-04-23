# Other protocols (and related miscellaneous)

<details>
<summary>1. What is the Internet Protocol (IP) and what delivery guarantees does it provide?</summary>
IP is a packet-switched networking protocol that defines how datagrams (packets) are transmitted between hosts on a network. Each packet carries a source and destination address, and routers forward it hop-by-hop based on the destination address.

IP provides best-effort delivery only — packets may be lost in transit, arrive out of order, or be duplicated. Higher-level protocols (like TCP) are responsible for reliability on top of IP.

```
[Sender Host] --> [Router A] --> [Router B] --> [Destination Host]
                    (each router inspects dest. IP and forwards accordingly)
```

Gotcha: "Best effort" means no delivery confirmation at the IP layer. If your application needs guaranteed delivery, use TCP, not raw IP or UDP.

</details><br>

<details>
<summary>2. What is the difference between IPv4 and IPv6 address spaces and notation?</summary>
IPv4 addresses are 32 bits long, giving roughly 4.3 billion unique addresses. They are written in dotted-decimal notation — four decimal octets separated by dots.

IPv6 addresses are 128 bits long, giving an astronomically larger address space. They are written as eight groups of four hexadecimal digits separated by colons. The larger space eliminates the need for techniques like NAT (Network Address Translation).

```
IPv4: 198.51.100.42
IPv6: 2001:0db8:85a3:0042:1000:8a2e:0370:7334
```

Gotcha: IPv6 allows consecutive all-zero groups to be collapsed with `::`, e.g., `2001:db8::1`, which can trip up parsers that don't handle this shorthand.

</details><br>

<details>
<summary>3. How does packet fragmentation differ between IPv4 and IPv6?</summary>
In IPv4, routers are allowed to fragment a packet if it is too large for the next data link segment. The fragments are reassembled at the destination. The sender can set a "Don't Fragment" flag, in which case a router that cannot forward the packet will drop it and send an ICMP "Packet Too Big" message back.

In IPv6, routers never fragment packets. If a packet is too large, the router drops it and sends an ICMPv6 "Packet Too Big" message to the sender. The two endpoints then perform Path MTU Discovery to determine the maximum transfer unit (MTU) across the full path, and only the sending endpoint may fragment if absolutely necessary (e.g., when the upper-layer minimum payload exceeds the path MTU). With TCP over IPv6, this situation typically does not arise.

```
IPv4: sender --> [router may fragment] --> dest reassembles
IPv6: sender --> [router drops + ICMPv6] --> sender adjusts MTU --> retransmits
```

</details><br>

<details>
<summary>4. What is Inter-Process Communication (IPC) and why is it necessary?</summary>

IPC refers to mechanisms that allow separate processes to exchange data and coordinate actions. Processes are isolated by design — each has its own virtual address space and cannot directly read or write another process's memory. IPC provides controlled channels to bridge that isolation.

Common IPC mechanisms include:

- Shared memory (fastest, same machine only)
- Message queues
- Pipes and named pipes
- Sockets (works across machines too)
- Remote Procedure Calls (RPC)

```
Process A (addr space 0x0000...)   Process B (addr space 0x0000...)
         |                                  |
         +--------[ IPC channel ]-----------+
         (pipe / socket / shared mem / RPC)
```

Gotcha: Even on the same physical machine, two processes have distinct virtual address spaces. A pointer valid in process A is meaningless in process B — you must serialize data to cross the boundary.

</details><br>

<details>
<summary>5. What is a Remote Procedure Call (RPC) and how does it abstract network communication?</summary>

RPC is a communication paradigm that lets a program call a function in a different address space — on the same machine or across a network — as if it were a normal local function call. The network communication is hidden behind the function call abstraction.

RPC is a form of IPC: when processes are on the same host they use distinct virtual address spaces; when on different hosts they use entirely different physical machines. Both synchronous (client blocks until response) and asynchronous (client continues without waiting) modes exist.

```
// What the developer writes (looks local):
result = remoteService.add(3, 4)

// What actually happens under the hood:
// 1. serialize args → 2. network call → 3. server executes → 4. serialize result → 5. return
```

Gotcha: RPC hides latency and failure modes that don't exist for local calls. A local function never times out or partially fails — a remote one can. Treating RPC calls as if they were local is a classic distributed systems mistake (see: Fallacies of Distributed Computing).

</details><br>

<details>
<summary>6. What are the steps in the RPC call sequence, and what is marshalling?</summary>
An RPC call travels through a sequence of layers on both sides:

1. The client calls the client stub — a local function with the same signature as the remote procedure.
2. The stub marshals (serializes) the parameters into a portable binary or text format and makes a system call to send the message.
3. The client OS transmits the message over the network to the server.
4. The server OS receives the packets and passes them to the server stub.
5. The server stub unmarshals (deserializes) the parameters back into native types.
6. The server stub calls the actual server procedure. The response travels the same path in reverse.

```
Client                        Server
------                        ------
fn call()                     real fn()
   |                              ^
client stub (marshal)         server stub (unmarshal)
   |                              |
[ network transport layer ] ------+
```

Marshalling is the process of packaging parameters into a transferable format. Unmarshalling is the reverse. The stub layer is typically auto-generated from an interface definition (IDL).

</details><br>

<details>
<summary>7. What is JSON-RPC and how does it differ from using plain REST/HTTP?</summary>

JSON-RPC is a transport-agnostic RPC protocol that encodes calls and responses as JSON. It can run over HTTP, TCP, or WebSockets. When using HTTP, it uses a single endpoint (URL) and only the POST method — the action being called is determined by the message body, not the URL or HTTP verb.

This contrasts with REST, which maps actions to URLs and HTTP verbs (GET, POST, PUT, DELETE) and leverages HTTP-native features like caching and status codes for semantics.

```
// JSON-RPC request (POST to a single URL, e.g. /api)
{
  "jsonrpc": "2.0",
  "method": "user.getById",
  "params": { "id": 42 },
  "id": 1
}

// JSON-RPC response
{
  "jsonrpc": "2.0",
  "result": { "name": "Alice", "email": "alice@example.com" },
  "id": 1
}
```

Gotcha: Because everything goes to one URL via POST, standard HTTP caching (which keys on URL + method) does not work. Logs and proxies that expect REST-style routing will also have a harder time interpreting traffic.

</details><br>

<details>
<summary>8. What is the structure of a JSON-RPC 2.0 request and response?</summary>
A JSON-RPC 2.0 request object has these fields:

- `jsonrpc` — must be exactly the string `"2.0"`
- `method` — string name of the method to invoke
- `params` — optional object or array of arguments
- `id` — optional string or integer; if omitted, the call is a notification (no response expected)

A JSON-RPC 2.0 response object has:

- `jsonrpc` — `"2.0"`
- `result` — the return value; present only on success
- `error` — present only on failure; an object with `code` (integer), `message` (string), and optional `data`
- `id` — matches the `id` from the corresponding request

```
// Notification (no id → no response expected)
{ "jsonrpc": "2.0", "method": "log.event", "params": { "msg": "started" } }

// Error response
{
  "jsonrpc": "2.0",
  "error": { "code": -32601, "message": "Method not found" },
  "id": 1
}
```

Gotcha: `result` and `error` are mutually exclusive — a response must contain exactly one of them, never both. Pre-defined error codes below -32000 are reserved by the spec (e.g., -32700 Parse error, -32600 Invalid Request, -32601 Method not found).

</details><br>

<details>
<summary>9. What is Protocol Buffers (protobuf) and why does gRPC use it instead of JSON?</summary>

Protocol Buffers (protobuf) is a language-neutral, platform-neutral binary serialization format developed by Google. You define your data structures and service interfaces in a `.proto` schema file, and the protobuf compiler (`protoc`) generates strongly-typed serialization/deserialization code in your target language.

Compared to JSON:

- Smaller payloads — binary encoding is more compact than text
- Faster to serialize/deserialize — no string parsing
- Strongly typed and schema-enforced — breaking changes are caught at compile time
- Not human-readable without tooling

```proto
// user.proto
syntax = "proto3";

message User {
  int32 id = 1;
  string name = 2;
  string email = 3;
}

service UserService {
  rpc GetUser (GetUserRequest) returns (User);
}

message GetUserRequest {
  int32 id = 1;
}
```

Gotcha: Each field has a numeric tag (e.g., `= 1`). These tags are what actually appear in the binary wire format, not the field names. Changing a tag number is a breaking change even if you keep the field name the same.

</details><br>

<details>
<summary>10. What is gRPC and how does it build on RPC and protobuf?</summary>

gRPC is an open-source RPC framework developed by Google that uses HTTP/2 as its transport layer and Protocol Buffers as its default serialization format. You define services and message types in `.proto` files; `protoc` with the gRPC plugin generates both client stubs and server interfaces in your target language.

Key features:

- HTTP/2 — enables multiplexed streams, header compression, and full-duplex communication over a single connection
- Strongly typed contracts via protobuf schemas
- Auto-generated client and server code in many languages (Go, Java, Python, C++, etc.)
- Supports four communication patterns: unary, server streaming, client streaming, bidirectional streaming

```proto
service OrderService {
  rpc PlaceOrder (OrderRequest) returns (OrderResponse);           // unary
  rpc TrackOrder (TrackRequest) returns (stream StatusUpdate);     // server streaming
  rpc UploadItems (stream Item) returns (UploadSummary);           // client streaming
  rpc Chat (stream Message) returns (stream Message);              // bidirectional
}
```

Gotcha: gRPC is not natively supported in browsers (as of 2026, browsers cannot control HTTP/2 framing directly). Browser clients typically need gRPC-Web with a proxy (e.g., Envoy) that translates between gRPC-Web and standard gRPC.

</details><br>

<details>
<summary>11. How do IPC, JSON-RPC, and gRPC compare — when should you use each?</summary>
All three are mechanisms for processes to communicate, but they operate at different scopes and with different tradeoffs:

|                 | IPC (local)            | JSON-RPC          | gRPC              |
| --------------- | ---------------------- | ----------------- | ----------------- |
| Scope           | Same machine           | Any (HTTP/TCP/WS) | Any (HTTP/2)      |
| Encoding        | OS-native / shared mem | JSON (text)       | Protobuf (binary) |
| Schema          | None required          | None required     | Required (.proto) |
| Streaming       | Pipes/sockets          | No                | Yes (4 modes)     |
| Browser support | N/A                    | Yes               | Needs gRPC-Web    |
| Human readable  | N/A                    | Yes               | No                |

- Use local IPC (pipes, shared memory, Unix sockets) when both processes are on the same machine and you need minimal overhead.
- Use JSON-RPC when you need a simple, schema-free, human-readable call protocol over HTTP or WebSockets — good for internal tooling or lightweight web APIs.
- Use gRPC when you need high-throughput, strongly typed, polyglot service-to-service communication — typical in microservices backends.

Gotcha: JSON-RPC's lack of a schema means nothing enforces the contract between client and server at build time. gRPC's `.proto` file acts as a machine-verified contract, making it much harder to introduce silent breaking changes.

</details><br>

<details>
<summary>12. What are the six REST architectural constraints?</summary>

The six constraints that define a RESTful system:

1. Client-server architecture — the system is split into clients and servers. Clients are not concerned with data storage; servers are not concerned with UI or client state. Both sides can be replaced or developed independently as long as the interface between them remains stable.

2. Statelessness — the server stores no information about clients between requests. Every request must contain all information needed to process it, including client identification if required.

3. Cacheability — every response must explicitly declare whether it is cacheable or not. This prevents clients from reusing stale or incorrect data in response to future requests.

4. Uniform interface — a single consistent interface between clients and servers. Simplifies and decouples the architecture so each part can evolve independently. Built on four sub-principles: resource identification via URI, manipulation through representations, self-descriptive messages, and HATEOAS. (See card 12 for detail.)

5. Layered system — the system may be split into a hierarchy of layers, but each component may only see and interact with the immediately adjacent layer. A client calling PayPal has no knowledge that PayPal internally calls Visa.

6. Code on demand (optional) — servers may extend client functionality by transferring executable code such as JavaScript. This is the only optional constraint.

Gotcha: omitting any non-optional constraint means the API is not formally RESTful, even if it uses HTTP and JSON.

</details><br>

<details>
<summary>13. What are the four uniform interface sub-constraints in REST, and why do they matter?</summary>

The uniform interface is the central REST constraint. It decouples client and server so both can evolve independently. It has four sub-constraints:

1. Identification of resources — in REST, a resource is anything that can be named: a user, an image, the current weather. Each resource must be identified by a stable URI that does not change when the resource's state changes. The URI names the resource; the representation of it is separate.

2. Manipulation of resources through representations — a representation is the current or desired state of a resource (e.g. a JSON or XML description of a user). Clients manipulate resources by sending representations in requests, not by calling procedures. A PUT body is the client's intended new state of the resource.

3. Self-descriptive messages — every request and response must carry all information needed to process it. No additional out-of-band context or cached session state should be required to understand a single message. HTTP headers (Content-Type, Cache-Control, status codes) fulfill this role. This property is critical for system scalability.

4. HATEOAS — resource state is communicated through body content, query parameters, request headers, and the requested URI. Responses include hypermedia links in the body or headers so clients can discover available next actions at runtime without hard-coding URLs.

```http
# Self-descriptive: Content-Type tells the receiver exactly how to parse the body
PUT /users/42 HTTP/1.1
Content-Type: application/json
{ "name": "Ana", "email": "ana@example.com" }

# HATEOAS: response body describes what the client can do next
HTTP/1.1 200 OK
{
  "id": 42, "name": "Ana",
  "_links": {
    "self":   { "href": "/users/42" },
    "delete": { "href": "/users/42", "method": "DELETE" }
  }
}
```

</details><br>

<details>
<summary>14. What is the Richardson Maturity Model and what are its four levels?</summary>

The Richardson Maturity Model (RMM) is a framework for measuring how closely an HTTP API conforms to REST principles. It has four levels:

Level 0 — The Swamp of POX: A single endpoint, a single method. The entire API is one URL receiving everything via POST. Think RPC-over-HTTP (SOAP, XML-RPC).

Level 1 — Resources: Multiple URLs represent distinct resources, but still only one HTTP method (usually POST). Each resource has its own address.

Level 2 — HTTP Verbs: Multiple URLs AND multiple HTTP methods (GET, POST, PUT, DELETE). HTTP semantics are used correctly, including status codes.

Level 3 — HATEOAS: All of Level 2, plus responses contain hypermedia links that describe available next actions. The API becomes self-discoverable.

```json
// Level 3 response — server tells the client what to do next
{
  "orderId": 42,
  "status": "pending",
  "_links": {
    "cancel": { "href": "/orders/42", "method": "DELETE" },
    "payment": { "href": "/orders/42/payment", "method": "POST" }
  }
}
```

Gotcha: most production APIs sit at Level 2 and call themselves RESTful. True Level 3 is rare in practice.

</details><br>

<details>
<summary>15. What is HATEOAS and why does it matter?</summary>

HATEOAS stands for Hypermedia As The Engine Of Application State. It is the Level 3 REST constraint requiring that a server's responses include hypermedia links pointing to all valid next actions from the current state.

The result is a self-documenting, discoverable API. A client only needs to know the entry-point URL; it discovers all other capabilities at runtime by following links in responses — similar to how a human browses the web by following links rather than memorising all URLs.

```json
// GET /accounts/123
{
  "accountId": 123,
  "balance": 500,
  "_links": {
    "self": { "href": "/accounts/123" },
    "deposit": { "href": "/accounts/123/transactions", "method": "POST" },
    "withdraw": { "href": "/accounts/123/transactions", "method": "POST" },
    "close": { "href": "/accounts/123", "method": "DELETE" }
  }
}
```

Practical benefit: client code does not hard-code URLs or need to know business rules about which actions are allowed in which states — the server communicates that at runtime.

</details><br>

<details>
<summary>16. What is the "Contract First" API design approach and what are its trade-offs?</summary>

Contract First means writing the API specification (e.g. an OpenAPI/Swagger document) before writing any implementation code. The contract defines endpoints, request/response schemas, and error formats upfront.

Advantages:

- Frontend and backend teams can work in parallel from day one, using generated mocks and stubs
- Code generation tools can produce server stubs, client SDKs, and mock servers from the contract
- The design is evaluated at a higher abstraction level, decoupled from implementation details
- Promotes cleaner, more reusable interfaces

Disadvantages:

- Higher up-front effort to author and agree on a specification
- The contract must be actively maintained as requirements change; drift between spec and implementation becomes a maintenance cost

</details><br>

<details>
<summary>17. What is the "Code First" API design approach and what are its trade-offs?</summary>

Code First means writing implementation code first and generating the API specification (e.g. OpenAPI/Swagger) automatically from the code using annotations or reflection.

Advantages:

- Zero extra effort to produce a contract — it is auto-generated from the running code
- The spec and implementation are always in sync (no drift) as long as generation is part of the build

Disadvantages:

- No parallel team development — the contract only exists after implementation begins
- The generated contract tends to reflect implementation details (class names, framework conventions, platform-specific types) rather than a clean domain model
- Higher coupling: changing a class name or framework changes the public API contract

</details><br>

<details>
<summary>18. What is resource naming convention in REST, and what are the key rules?</summary>

REST URIs identify resources (nouns), not actions (verbs). The HTTP method expresses the action; the URI expresses what is being acted upon.

Key rules:

- Use plural nouns for collections: `/users`, `/orders`, `/products`
- Nest sub-resources under their parent: `/users/42/orders`
- Use kebab-case for multi-word segments: `/product-categories`
- Never include verbs in URIs: `/getUser` or `/deleteOrder` violates REST

```http
# Good — noun-based URIs, verb in HTTP method
GET    /orders          # list all orders
POST   /orders          # create a new order
GET    /orders/7        # get order 7
PUT    /orders/7        # replace order 7
DELETE /orders/7        # delete order 7
GET    /orders/7/items  # list items in order 7

# Bad — RPC-style, verbs in URI
POST   /getOrders
POST   /createOrder
POST   /deleteOrder?id=7
```

Gotcha: query strings are for filtering, sorting, and pagination — not for identifying resources. `/users?id=42` is weaker than `/users/42`.

</details><br>

<details>
<summary>19. Which HTTP methods are idempotent, and which is not?</summary>

An idempotent method is one where making the same request N times leaves the server in the same state as making it once.

GET, HEAD, PUT, and DELETE are idempotent. POST is not — each call may produce a new side effect (e.g. creating a duplicate resource).

```http
DELETE /users/42   # first call: deletes the user
DELETE /users/42   # second call: user already gone — server state unchanged

POST /users        # first call: creates user, id=42
POST /users        # second call: creates another user, id=43 ← not idempotent
```

Gotcha: idempotent does not mean "no side effects." DELETE has a side effect but is still idempotent because repeating it does not change the outcome beyond the first call.

</details><br>
