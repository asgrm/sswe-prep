<details>
<summary>251. What is a Man-in-the-Middle (MITM) attack?</summary>

A Man-in-the-Middle (MITM) attack occurs when an attacker secretly intercepts and potentially alters communications between two parties who believe they are communicating directly with each other. The attacker sits between the two hosts, relaying messages while having full visibility — and possible control — over the data in transit.

Example flow:

```
Alice  <-->  [Attacker]  <-->  Bob
              intercepts
              & relays
```

The key danger is that neither Alice nor Bob is aware of the intermediary. This enables passive eavesdropping, active data manipulation, credential theft, and session hijacking.

</details><br>

<details>
<summary>252. What is a Rogue Access Point attack and why is it effective?</summary>

A Rogue Access Point attack exploits the behavior of wireless devices that automatically connect to the strongest available Wi-Fi signal. An attacker sets up a fraudulent access point — often with the same SSID as a legitimate network — broadcasting at high power, causing nearby devices to join it instead of the real network.

Once connected, all the victim's traffic flows through the attacker's machine, enabling sniffing, injection, and stripping attacks.

```
Victim device  -->  [Rogue AP (attacker)]  -->  Internet
                    (appears legitimate)
```

</details><br>

<details>
<summary>253. What is ARP Spoofing and how does it enable MITM attacks?</summary>

ARP (Address Resolution Protocol) maps IP addresses to MAC addresses on a local network. ARP has no authentication — any host can broadcast a gratuitous ARP reply claiming ownership of any IP address, and receiving hosts will update their ARP cache accordingly.

An attacker exploits this by sending forged ARP replies to both a victim and a gateway, associating the attacker's MAC address with each party's IP. Both parties then send their traffic to the attacker.

```
Normal:   Victim  -->  Gateway  -->  Internet
Spoofed:  Victim  -->  Attacker  -->  Gateway  -->  Internet
```

</details><br>

<details>
<summary>254. What is mDNS Spoofing?</summary>

Multicast DNS (mDNS) allows devices on a local network to resolve hostnames without a central DNS server — devices broadcast queries to the multicast address 224.0.0.251 (IPv4) and peers respond directly. Like ARP, mDNS has no built-in authentication.

An attacker on the same LAN can listen for mDNS queries and send fraudulent responses before the legitimate device does, redirecting the querying device to the attacker's IP.

```
Victim asks:  "Who is printer.local?"
Attacker replies first:  "I am — 192.168.1.99"
Victim connects to attacker instead of real printer.
```

</details><br>

<details>
<summary>255. What is DNS Spoofing (DNS Cache Poisoning)?</summary>

DNS spoofing involves injecting fraudulent DNS records into a resolver's cache so that subsequent queries for a domain return the attacker's IP address rather than the legitimate one. Victims are then directed to attacker-controlled servers without any visible indication that something is wrong.

```
Normal:   client queries DNS --> returns 93.184.216.34 (real server)
Poisoned: client queries DNS --> returns 10.0.0.99  (attacker server)
```

**How does the attacker actually poison the cache?**
DNS was designed with no authentication. When a resolver sends a query out and waits for an answer, it identifies the correct reply using a transaction ID — just a number. If an attacker can guess or brute-force that number and send a forged reply before the real answer arrives, the resolver accepts it as legitimate and caches it.
This is a race condition. The attacker is trying to win the race against the real DNS server.

**Why the victim sees nothing suspicious.**
The browser address bar still shows `mybank.com`. The user typed the right address. Nothing looks wrong. The deception happened entirely at the infrastructure level before the browser was even involved. This is what makes it particularly dangerous compared to something like a phishing link, where at least the URL looks different.

Mitigation: use a resolver that validates DNSSEC(DNS Security Extensions), enforce DoH(DNS over TLS) or DoT(DNS over HTTPS), and pair with HTTPS + HSTS so that even a spoofed DNS response cannot silently serve an invalid certificate.

</details><br>

<details>
<summary>256. What is packet sniffing in the context of MITM attacks?</summary>

Packet sniffing is the passive capture and inspection of network traffic. An attacker places a network interface into promiscuous mode (wired) + ARP spoofing (because modern switched network ) OR monitor mode (wireless), allowing it to capture frames not addressed to it.

On switched networks, sniffing is limited to broadcast traffic and the attacker's own segment unless combined with ARP spoofing to redirect traffic. On wireless networks in monitor mode, all frames in range are visible.

Unencrypted protocols (HTTP, FTP, Telnet, plain SMTP) expose credentials and session tokens directly. Mitigation is end-to-end encryption (TLS) for all sensitive communication.

</details><br>

<details>
<summary>257. What is packet injection in the context of MITM attacks?</summary>

Packet injection is the active insertion of forged packets into an existing communication stream. It typically follows sniffing: the attacker first observes traffic to understand sequence numbers, session state, and protocol details, then crafts and injects malicious packets that appear to come from a legitimate party.

```
Normal stream:  Client --> [seq=1001] --> Server
Injected:       Attacker --> [seq=1001, forged src=Client] --> Server
                (server accepts the forged packet as legitimate)
```

</details><br>

<details>
<summary>258. What is session hijacking and how does it relate to MITM?</summary>

Web applications issue a session token after login to avoid re-authenticating on every request. Session hijacking is the theft and reuse of that token to impersonate the victim without knowing their password.

In a MITM context, an attacker sniffs unencrypted or improperly secured traffic to extract the session cookie, then replays it:

```
GET /account HTTP/1.1
Host: example.com
Cookie: session=abc123   <-- attacker reuses this
```

Defenses:

- Transmit session cookies only over TLS (Secure flag).
- Set HttpOnly to prevent JavaScript access.
- Set SameSite=Strict or Lax to limit cross-origin submission.
- Bind sessions to client IP or TLS channel where feasible.
- Use short-lived tokens and rotate after privilege escalation.
</details><br>

<details>
<summary>259. What is SSL Stripping and what defense makes it ineffective?</summary>

SSL stripping (introduced publicly by Moxie Marlinspike, 2009) is an attack where a MITM attacker intercepts an initial unencrypted HTTP request and upgrades their own connection to the server over HTTPS, while serving the victim a plain HTTP version of the site. The victim never sees a TLS connection, so there is no certificate warning.

```
Victim --HTTP--> Attacker --HTTPS--> Server
         (plain)            (encrypted)
```

The primary defense is HTTP Strict Transport Security (HSTS, RFC 6797, 2012). When a server sends the header:

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

</details><br>

<details>
<summary>260. How does a VPN mitigate MITM attacks, and what are its limitations?</summary>

A Virtual Private Network (VPN) creates an encrypted tunnel between the client and a VPN endpoint, so even if an attacker intercepts traffic on the local network, they see only ciphertext and cannot read or inject meaningful content.

```
Victim --> [encrypted tunnel] --> VPN server --> Internet
           attacker sees only
           opaque ciphertext
```

Limitations:

- A VPN protects the path between the client and the VPN server, not beyond it. Traffic from the VPN server to the destination is subject to its own attack surface.
- The VPN provider itself becomes a trusted party — a malicious or compromised VPN is itself a MITM.
- VPNs do not prevent DNS leaks unless DNS queries are also routed through the tunnel and the VPN enforces DoH(DNS over TLS)/DoT(DNS over HTTPS) .
- A VPN cannot substitute for end-to-end encryption (TLS) for sensitive applications.

</details><br>

<details>
<summary>261. What are the OWASP Top 10 vulnerabilities? (overview card)</summary>

A01 — Broken Access Control: Users can act outside their intended permissions — accessing other users' data, reaching admin functions, or bypassing authorization checks entirely.

A02 — Security Misconfiguration: Insecure defaults left unchanged, unnecessary features enabled, missing HTTP headers, verbose error messages, or misconfigured cloud storage.

A03 — Software Supply Chain Failures: Applications inherit vulnerabilities from third-party libraries, build tools, container base images, and external services.

A04 — Cryptographic Failures: Sensitive data exposed due to absent, weak, or incorrectly applied encryption — in transit or at rest. This category (previously called Sensitive Data Exposure in 2021) names the root cause directly: the failure is almost always cryptographic, not accidental.

A05 — Injection: Untrusted data sent to an interpreter — SQL, OS shell, LDAP, NoSQL — as part of a command or query, causing the interpreter to execute attacker-controlled instructions. SQL injection remains the canonical example but the category covers all interpreter types including XSS, which is a subset.

A06 — Insecure Design: Security flaws introduced at the design and architecture stage — missing threat modeling, absent security requirements, or fundamental architectural decisions that make secure implementation impossible regardless of code quality.

A07 — Authentication Failures: Incorrectly implemented authentication allows attackers to compromise passwords, session tokens, or other credentials to assume users' identities. Common failures include weak password policies, missing MFA, improper session token handling, and insufficient brute-force protection.

A08 — Software or Data Integrity Failures: Applications make integrity assumptions about code or data that are never verified — insecure deserialization, CI/CD pipelines that pull unverified plugins, auto-update mechanisms with no signature validation.

A09 — Security Logging and Alerting Failures: Security-relevant events are not logged, logs lack sufficient context to reconstruct what happened, or monitoring does not generate real-time alerts. This category does not cause breaches directly — it ensures that when breaches occur, they go undetected for weeks or months.

A10 — Mishandling of Exceptional Conditions: Applications fail to handle errors, exceptions, and edge cases safely — crashing in ways that reveal stack traces, bypassing security logic on unexpected input, or entering undefined states that attackers can exploit.

</details><br>
