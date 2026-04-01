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
