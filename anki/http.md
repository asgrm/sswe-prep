# HTTP

<details>
<summary>1. What are the required components of an HTTP request and an HTTP response?</summary>

Request must contain:

- HTTP method (verb or noun: GET, POST, PUT, DELETE, OPTIONS, HEAD, …)
- Resource path (URL stripped of protocol, domain, and default port)
- HTTP version
- Optional headers; optional body (required for POST/PUT)

Response must contain:

- HTTP version
- Status code (e.g. 200, 404, 500)
- Status message (e.g. "OK", "Not Found")
- Headers
- Optional body (the fetched resource)

```
GET /index.html HTTP/1.1
Host: example.com
Accept: text/html

---

HTTP/1.1 200 OK
Content-Type: text/html
Content-Length: 1234

<html>…</html>
```

</details><br>

<details>
<summary>2. What aspects of web communication can HTTP control beyond simple data transfer?</summary>

HTTP provides mechanisms to control several cross-cutting concerns:

Caching — servers instruct proxies and clients what to cache and for how long; clients can tell intermediate proxies to bypass the cache.

CORS (origin relaxation) — HTTP headers allow a server to relax the browser's same-origin policy, letting a page load resources from other domains.

Authentication — HTTP supports protecting resources via headers like `WWW-Authenticate` and cookie-based sessions.

Proxying / tunneling — requests can be routed through proxies (HTTP, SOCKS, etc.) to cross network boundaries or hide real IP addresses.

Sessions — `Set-Cookie` / `Cookie` headers let a stateless protocol simulate stateful sessions (shopping carts, user preferences, login state).

Gotcha: HTTP is inherently stateless; sessions are layered on top via cookies, not built into the protocol itself.

</details><br>

<details>
<summary>3. How did connection handling evolve from HTTP/0.9 through HTTP/1.1?</summary>

HTTP/0.9 (1991) and HTTP/1.0 (1995): one TCP connection per request — after the response the connection is closed immediately. This means a full TCP handshake (SYN → SYN-ACK → ACK) is paid for every single resource.

HTTP/1.1 (1997): introduced persistent ("keep-alive") connections. The same TCP connection can be reused for multiple requests. It also added pipelining (send a second request before receiving the first response), but browsers still cap simultaneous connections per host to ~6.

```
HTTP/1.0:  [TCP open] → request → response → [TCP close]  (×N)
HTTP/1.1:  [TCP open] → req1 → res1 → req2 → res2 → …  → [TCP close]
```

Gotcha: HTTP/1.1 pipelining is rarely enabled in practice because of head-of-line blocking — a slow response blocks all requests queued behind it on the same connection.

</details><br>

<details>
<summary>4. What key problems did HTTP/2 solve, and how?</summary>

HTTP/2 (2015) addressed the performance limits of HTTP/1.1 with four major changes:

Binary framing — messages are encoded as binary frames instead of plain text, making parsing faster and less error-prone.

Multiplexing — multiple logical streams share a single TCP connection. Each frame carries a stream ID, so responses can be interleaved and matched to their requests. This eliminates the ~6-connection workaround of HTTP/1.1.

Header compression (HPACK) — headers are compressed, reducing overhead for the many repetitive headers sent with every request.

Server push — the server can proactively send resources (CSS, JS) before the client requests them, so by the time the browser finishes parsing HTML those assets may already be transferred.

```
One TCP connection:
  stream 1: [header] ──────────── [data]
  stream 2:   [header] ── [data]
  stream 3:       [header] ──────────── [data]
```

Gotcha: HTTP/2 still runs over TCP, so a single packet loss causes TCP's retransmit to stall _all_ multiplexed streams — a form of head-of-line blocking that HTTP/2 cannot fully escape.

</details><br>

<details>
<summary>5. What is HTTP/3 and why was QUIC chosen as its transport?</summary>

HTTP/3 is the successor to HTTP/2. Instead of running over TCP, it runs over QUIC (Quick UDP Internet Connections), which is built on top of UDP.

QUIC reimplements reliability, ordering, and TLS 1.3 in user space on top of UDP, gaining several advantages:

- Dramatically reduced connection establishment time (0-RTT or 1-RTT vs TCP's 3-way handshake + TLS handshake).
- Multiplexing without transport-layer head-of-line blocking — each QUIC stream is independently flow-controlled, so a lost packet only stalls the one stream it belongs to.
- Built-in encryption (TLS 1.3 is mandatory).
- Connection migration — a connection can survive IP address changes (e.g. switching from Wi-Fi to cellular) using connection IDs instead of 4-tuples.

```
HTTP/1.x & 2:  HTTP → TCP → IP
HTTPS:         HTTP → TLS → TCP → IP
HTTP/3:        HTTP → QUIC (UDP + TLS 1.3) → IP
```

Gotcha: QUIC is often described as "TCP+TLS+HTTP/2 over UDP," but it is implemented entirely in user space, making it easier to deploy improvements without waiting for OS-level TCP stack updates.

</details><br>

<details>
<summary>6. What is TLS and what three guarantees does it provide?</summary>

TLS (Transport Layer Security) is the IETF-standardized successor to Netscape's SSL protocol. It operates at the application layer, directly on top of TCP, and provides three essential services to all applications running above it:

- Encryption: obfuscates data in transit so a third-party observer cannot read it.
- Authentication: verifies the identity of one or both peers using certificates and a chain of trust.
- Integrity: detects message tampering via a MAC (message authentication code) appended to each TLS record.

When used correctly, a passive observer can only infer connection endpoints, the cipher in use, and approximate data volume — not the actual content.

</details><br>

<details>
<summary>7. What happens during a full TLS handshake, and how many round-trips does it require?</summary>

A full TLS handshake requires 2 round-trips before application data can flow, on top of the 1 round-trip required for the TCP handshake (3 total from a cold start).

Step-by-step (using 28ms one-way delay as example):

- 0ms: TCP three-way handshake completes (1 RTT).
- 56ms: Client sends ClientHello — TLS version, supported cipher suites, extensions.
- 84ms: Server responds with chosen cipher, its certificate, optional client cert request.
- 112ms: Client initiates RSA or Diffie-Hellman key exchange.
- 140ms: Server processes key exchange, verifies MAC, sends encrypted Finished.
- 168ms: Client decrypts, verifies MAC — tunnel is established.

Total added TLS cost: 2 RTTs. Optimizations like TLS False Start and Session Resumption reduce this to 1 RTT.

</details><br>

<details>
<summary>8. What is TLS False Start and how does it reduce handshake latency?</summary>

TLS False Start is an optional TLS extension that allows the client to begin sending encrypted application data after sending its ClientKeyExchange message, without waiting for the server's Finished message. This cuts the full handshake from 2 RTTs down to 1 RTT for new connections.

False Start does not modify the handshake protocol itself — it only changes when application data transmission begins. The handshake completion and integrity verification happen in parallel with the first application data flight.

Gotcha: False Start only helps new sessions. For returning visitors, Session Resumption handles latency reduction.

_Modern browsers require ALPN and Perfect Forward Secrecy for a TLS False Start_

</details><br>

<details>
<summary>9. What is TLS Session Resumption and what are the two mechanisms for it?</summary>

TLS Session Resumption allows a client and server to skip the full handshake on subsequent connections by reusing previously negotiated session parameters. This saves 1 RTT and avoids expensive public-key cryptography operations.
Two mechanisms exist:

1. Session IDs (older)

- After the first handshake, the server assigns a Session ID and stores the session state in memory
- On reconnect, the client sends that ID in the ClientHello
- If the server recognizes it, they skip straight to encrypted communication
  Problem: the server must store state for every client — doesn't scale well across multiple servers/load balancers

2. Session Tickets (newer)

- Instead of the server storing state, it encrypts the session state into a "ticket" and sends it to the client
- The client stores the ticket and presents it on reconnect
- The server decrypts it, recovers the session, and resumes
  Advantage: server is stateless — any server with the right ticket encryption key can resume the session, scales much better

</details><br>

<details>
<summary>10. What is PSK in TLS 1.3 and how does session resumption work?</summary>

PSK (Pre-Shared Key) in TLS 1.3 is the mechanism that replaces Session IDs and Session Tickets from TLS 1.2. It lets a returning client skip the full handshake while still generating fresh keys every time — fixing the main weakness of older resumption mechanisms which reused the same session keys.

Note: PSK as a concept also exists outside TLS 1.3, where it means a secret configured out-of-band before any session (common in IoT). In TLS 1.3 the same mechanism is reused, but the secret is derived from a previous session rather than configured manually.

FIRST CONNECTION — where the PSK is born:

```
Client ──── ClientHello ─────────────────────────► Server
Client ◄─── ServerHello + Certificate + ... ─────── Server
Client ──── [key exchange, Finished] ────────────► Server
Client ◄─── Finished + NewSessionTicket ──────────── Server
                        ↑
            contains PSK identity + resumption secret
            derived via HKDF from session master secret
            + transcript hash
```

Client stores the PSK identity and the resumption secret. Session ends.

SECOND CONNECTION — PSK resumption:

```
Client ──── ClientHello + PSK identity + fresh DH key share ───► Server
Client ◄─── ServerHello + fresh DH key share ────────────────── Server
# no Certificate, no full key exchange
```

Server decrypts the ticket, recovers the PSK, and both sides mix the PSK together with a brand new ephemeral DH secret to derive the new traffic keys:

```
PSK ──────────────────────────────► Early Secret
PSK + new DH secret ──────────────► Handshake Secret
                                         │
                                         ▼
                                    Master Secret → traffic keys
```

The fresh DH exchange is what preserves Forward Secrecy — even though a PSK from a previous session is involved, the actual traffic keys depend on a throwaway DH secret that is discarded after the handshake. Compromising the PSK alone is not enough to decrypt the session.

0-RTT — the optional fast path:

Because the client already knows what the PSK is before the server responds, it can send encrypted application data immediately alongside the ClientHello, before any DH exchange has happened. 0-RTT early data must only be used for idempotent operations that are safe to execute twice, like a GET request. Never for payments, mutations, or anything with side effects.

</details><br>

<details>
<summary>11. What is the difference between RSA and Diffie-Hellman key exchange in TLS, and why does it matter for forward secrecy?</summary>

In RSA key exchange, the client generates a symmetric session key, encrypts it with the server's public key, and sends it. The server decrypts it with its private key. The critical weakness: if an attacker records encrypted sessions and later obtains the server's private key, they can decrypt all previously recorded sessions retroactively.

In Diffie-Hellman (DH) key exchange, the shared secret is mathematically derived by both sides without it ever being transmitted. The server's private key is only used to sign the handshake for authentication — not to wrap the session key. With ephemeral DH (DHE or ECDHE), a fresh key pair is generated for every session and discarded afterward.

This property is called Perfect Forward Secrecy (PFS): compromise of the server's long-term private key does not expose past session keys.

Modern browsers prefer cipher suites that enable PFS (ECDHE-based), and some optimizations like TLS False Start are only available when forward secrecy is active.

</details><br>

<details>
<summary>12. What is ALPN (Application Layer Protocol Negotiation) and why is it used?</summary>

ALPN (Application Layer Protocol Negotiation) is a TLS extension that allows the client and server to negotiate which application protocol (e.g., HTTP/2, HTTP/1.1) will be used within the TLS tunnel — without adding extra network round-trips.

The negotiation is embedded in the TLS handshake:

- Client includes a ProtocolNameList in its ClientHello.
- Server selects one protocol and returns it in ServerHello as ProtocolName.

Why it matters:

1. Saves a round-trip — protocol negotiation is folded into the handshake at no extra cost, similar in spirit to TLS False Start.
2. Enables HTTP/2 and HTTP/3 — browsers use ALPN to upgrade to HTTP/2 over HTTPS. Without it, you'd need a separate negotiation step after the handshake.
3. Ties directly to SNI (Server Name Indication) — the server may host multiple domains with different supported protocols. ALPN + SNI together let the server pick both the right certificate and the right protocol in one shot.
4. No plaintext exposure risk — unlike doing protocol negotiation at the application layer (e.g. HTTP Upgrade header), ALPN happens inside TLS, so it's encrypted in TLS 1.3.

ALPN is also a prerequisite for TLS False Start in Chrome and Firefox.

</details><br>

<details>
<summary>13. What is SNI (Server Name Indication) and when is it required?</summary>

SNI is a TLS extension that allows the client to include the target hostname in the ClientHello message before the TLS handshake completes. This allows a single server IP address to host multiple domains, each with its own TLS certificate — the server reads the SNI hostname and selects the appropriate certificate to present.

Without SNI, a server can only present one certificate per IP address, because the certificate must be selected before any HTTP-level Host header is available.

</details><br>

<details>
<summary>14. What is the TLS Record Protocol and what are its performance implications?</summary>

The TLS Record Protocol is the framing layer for all TLS data. Every piece of application data is broken into records before being handed to the transport layer.

Each record contains:

```
5-byte header (content type, version, length)
encrypted payload (max 16 KB)
authentication tag (AEAD, e.g. AES-GCM) — replaces the old separate MAC in TLS 1.3
optional padding
```

The 16 KB maximum record size is unchanged in TLS 1.3, but the overhead structure is cleaner — TLS 1.3 mandates AEAD ciphers, which fold encryption and integrity into one operation instead of the separate MAC field used in TLS 1.2 and below.

The core trade-off remains the same:

Small records (fitting inside a single TCP segment, ~1400 bytes) mean a lost TCP packet stalls only one small record. Higher per-byte CPU and framing overhead, but better latency for interactive traffic.

Large records (up to 16 KB) reduce framing overhead and improve throughput for bulk transfers. But a lost packet forces the entire record to be buffered and retransmitted before it can be decrypted — the TLS layer cannot partially decrypt a record.

The practical strategy, now default in most modern servers and TLS libraries:

```
new or idle connection  → small records (~1 per TCP segment)
after sustained transfer → grow records up to 16 KB
after idle period        → reset back to small records
```

For HTTP/3 (over QUIC) it is largely irrelevant — QUIC handles loss recovery per stream at the transport level, bypassing TCP's blocking problem entirely.

In practice you rarely need to tune this manually today — nginx, BoringSSL, and OpenSSL implement dynamic record sizing by default.

</details><br>

<details>
<summary>15. What is the Chain of Trust in TLS and how does certificate verification work?</summary>

TLS authentication relies on a chain of trust rooted in Certificate Authorities (CAs). The browser ships with a pre-loaded list of trusted root CAs. A site's certificate is valid if it can be traced back to one of those roots through a chain of intermediate certificates, each signed by the one above it.

Verification process:

1. Server sends its certificate chain during the TLS handshake.
2. Browser verifies each certificate's signature using the public key of its parent.
3. Browser walks the chain until it reaches a trusted root CA.
4. If any certificate in the chain is missing, the browser must fetch it separately (adds DNS + TCP + HTTP latency).
5. If any certificate is revoked or untrusted, the handshake fails.

Performance implication: the full certificate chain is sent during the TLS handshake, which happens over a new TCP connection in slow-start. If the chain is too large and overflows the initial TCP congestion window, extra round-trips are added. Include all intermediate certificates, but exclude the trusted root (it's redundant and wastes bytes).

</details><br>

<details>
<summary>16. What is HSTS and what performance and security benefits does it provide?</summary>

HTTP Strict Transport Security (HSTS) is a policy mechanism delivered via an HTTP response header that instructs compliant browsers to always use HTTPS for a given origin, for a specified duration.

Example header:

```
Strict-Transport-Security: max-age=31536000; includeSubDomains
```

Security benefits:

- Prevents HTTP downgrade attacks — the browser refuses to connect over plain HTTP even if the user types it.
- Prevents a user from bypassing TLS warnings to access the HTTP version.

Performance benefit:

- Eliminates HTTP-to-HTTPS redirect round-trips. The browser rewrites http:// requests to https:// before sending them.

Gotcha: Once HSTS is cached, any failure to establish a TLS connection results in a hard-fail — the user sees a browser error and cannot proceed.

</details><br>
