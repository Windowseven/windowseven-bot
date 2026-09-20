# 09 — Authentication Engine & User Identity

**Windowseven MD Multi-Tenant Architecture & Security Specification**  
**Phase:** 4B — Authentication Engine & User Identity (Security Hardened & Closed)  
**Author:** Senior Staff Backend Engineer, Application Security Engineer & Node.js Architect  
**Date:** September 2026  
**Status:** IMPLEMENTED, HARDENED & VERIFIED  
**Installed Baileys Version:** `@whiskeysockets/baileys@7.0.0-rc14` (Preserved & Unchanged)  
**Test Suite Coverage:** 34/34 Authentication Tests Passing | 143/143 Full Regression Tests Passing (100% Pass Rate)

---

## 1. Executive Summary

Phase 4B establishes the enterprise authentication engine and user identity foundation for Windowseven MD, executing the specifications established in `docs/08_API_AND_AUTH_ARCHITECTURE.md` and hardened during the Phase 4B security review.

### Core Guarantees:
- **Strict Identity Triad**: User Identity (`email` + Argon2id hash) is strictly isolated from Tenant Identity (Workspaces) and WhatsApp Identity (Phone Numbers / JIDs). Phone numbers are **never** authentication credentials.
- **Argon2id Password Security**: Passwords hashed with RFC 9106 recommended parameters (`m=65536, t=3, p=4`). Verification is constant-time.
- **Asymmetric JWT Signing & In-Process Architecture**: Access tokens use native Node.js RFC 8037 EdDSA (Ed25519). In the current single-process architecture, signing and verification execute within `TokenService` (`IMPLEMENTED`), while isolated key-custody services remain an architectural target (`DESIGNED`).
- **Cookie-Only Refresh Tokens**: Refresh tokens are accepted **strictly via HTTP-only cookies**. Body-based refresh token acceptance has been removed. Raw refresh tokens are never returned in JSON response bodies, never logged, and never stored in plain text (only SHA-256 hash in PostgreSQL).
- **Dual-Token Rotation & Reuse Detection**: 15-minute access tokens paired with 7-day opaque refresh tokens. Token rotation is serialized with database row-level locks (`SELECT ... FOR UPDATE`). Presentation of a revoked refresh token triggers immediate **family-wide revocation** to mitigate token theft.
- **Explicit Family Revocation on Logout**: User logout (`POST /api/v1/auth/logout`) explicitly revokes the entire refresh token family, terminating all active and subsequent sessions derived from that login cycle.
- **Defense-in-Depth CSRF & Origin Allowlisting**: Configurable allowed origins (`allowedOrigins` / `ALLOWED_ORIGINS`). State-changing cookie requests are validated against the allowlist. Disallowed origins return `403 Forbidden` (`CSRF_VALIDATION_FAILED`). Requests without origin/referer require `X-Requested-With`.
- **Safe Error Semantics**: Authentication failures return generic error envelopes (`INVALID_CREDENTIALS`), completely eliminating account enumeration attacks.
- **Zero WhatsApp Disruption**: Authentication is strictly isolated from Baileys sockets. Zero modifications to `ConnectionManager`, `EventAdapter`, `ApplicationPipeline`, or existing command logic.

---

## 2. Classification Standard

To maintain engineering precision, all statements are categorized:
- **`IMPLEMENTED`**: Code and database entities written and integrated into the repository.
- **`VERIFIED`**: Behaviors, constraints, and security properties validated by automated test suites.
- **`DESIGNED`**: Architectural components specified for future implementation.
- **`KNOWN LIMITATION`**: Current operational boundaries documented for subsequent hardening.

---

## 3. Identity Model & Entity Boundaries

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        THREE SEPARATE IDENTITIES                       │
├───────────────────┬──────────────────────────┬─────────────────────────┤
│    USER IDENTITY  │     TENANT IDENTITY      │   WHATSAPP IDENTITY     │
├───────────────────┼──────────────────────────┼─────────────────────────┤
│ Email + Password  │ Organization / Workspace │ Phone Number / JID      │
│ (UUID in `users`) │ (UUID in `tenants`)      │ (String in DB)          │
│ Represents human  │ Represents SaaS account  │ Represents bot instance │
│ Authenticates via │ Scopes all data &        │ Connects via Baileys    │
│ Argon2id / JWT    │ memberships              │ Signal auth keys        │
└───────────────────┴──────────────────────────┴─────────────────────────┘
```

- **User Model (`users`)**:
  - `id`: UUIDv4 primary key.
  - `email`: Case-insensitive unique index (`LOWER(email)`).
  - `password_hash`: Encoded Argon2id hash string. Never returned in API responses or user models.
  - `created_at`, `updated_at`: ISO 8601 timestamps.
- **Authoritative Identity Extraction**: The authenticated identity is strictly `req.user.id` derived from the validated JWT subject claim (`sub`). Any `userId` supplied in request bodies is rejected or ignored.

---

## 4. Password Security (Argon2id)

- **Algorithm**: `Argon2id` (`type: argon2.argon2id`) [`IMPLEMENTED` / `VERIFIED`].
- **Accurate Security Classification**: Argon2id is a memory-hard password hashing algorithm designed to significantly increase the computational and memory cost of password cracking, including GPU/ASIC-assisted attacks. It is not claimed to be unconditionally "immune" to attacks, but rather drastically raises attacker hardware and memory costs relative to traditional algorithms like SHA-256 or bcrypt.
- **Parameters**:
  - Memory cost ($m$): $65,536\text{ KiB}$ ($64\text{ MiB}$) in production; adjusted dynamically in test runner.
  - Time cost ($t$): $3$ passes.
  - Parallelism ($p$): $4$ threads.
  - Derived Key Length: $32\text{ bytes}$.
  - Salt: Cryptographically random $16\text{ bytes}$ generated by library.
- **Password Policy (`PasswordService.validatePolicy`)**:
  - Minimum length: $12\text{ characters}$.
  - Maximum length: $256\text{ characters}$ (supports long passphrases).
  - Passphrases $\ge 18\text{ characters}$ are accepted as inherently high-entropy.
  - Passwords $12–17\text{ characters}$ must contain uppercase, lowercase, numeric, and special characters.
- **Timing Attack Mitigation**: Login requests targeting unknown email addresses execute a dummy Argon2 verification before throwing `INVALID_CREDENTIALS` to normalize server response latency.

---

## 5. JWT Strategy (Asymmetric EdDSA / Ed25519)

- **Algorithm**: `EdDSA` using curve `Ed25519` via native `node:crypto` [`IMPLEMENTED` / `VERIFIED`].
- **Implementation Reality & Key Architecture**:
  - In the current single-process architecture, both Ed25519 signing (private key) and verification (public key) execute in-process within `TokenService` [`IMPLEMENTED` / `VERIFIED`].
  - Physical separation of the private key into a dedicated, isolated authentication authority / key management service (KMS) is classified as [`DESIGNED`] for future horizontal multi-node cluster operation.
- **Header**:
  ```json
  {
    "alg": "EdDSA",
    "typ": "JWT",
    "kid": "key-ed25519-v1"
  }
  ```
- **Payload (Claims)**:
  ```json
  {
    "sub": "00000000-0000-0000-0000-000000000001",
    "email": "admin@example.com",
    "type": "access",
    "iat": 1774000000,
    "exp": 1774000900,
    "iss": "windowseven-auth",
    "aud": "windowseven-api"
  }
  ```
- **Authoritative Identity**: The `sub` claim is strictly the authoritative user identity, populating `req.user.id`.
- **Verification Constraints**:
  - Algorithm check: Rejects any algorithm that is not strictly `'EdDSA'` (prevents `alg: none` and algorithm confusion attacks).
  - Signature check: Cryptographically verified against public key.
  - Claim checks: Enforces `exp > now`, `type === 'access'`, `iss === expected`, `aud === expected`, and presence of `sub`.

---

## 6. Refresh Token Lifecycle, Rotation & Theft Detection

### 6.1 Database Schema (`refresh_tokens` Table)
```sql
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE,
    family_id UUID NOT NULL,
    replaced_by_token_id UUID REFERENCES refresh_tokens(id) ON DELETE SET NULL,
    revoked_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

### 6.2 Token Attributes & Persistence
- **Raw Token**: 32 cryptographically secure random bytes generated via `crypto.randomBytes(32).toString('hex')` (64 hex characters).
- **Hashed Persistence**: Raw tokens are **NEVER** stored in PostgreSQL. Only `SHA-256(rawToken)` is stored in `token_hash`.
- **Zero Leakage**: Raw refresh tokens are never returned in JSON response bodies, never logged in audit trails or application logs, and only transmitted via HTTP-only cookies.
- **Absolute Expiry**: 7 days (`expires_at = now + 7 days`). Refresh rotation does not extend the session beyond policy limits.

### 6.3 Transactional Rotation & Concurrency Safety
During rotation (`POST /api/v1/auth/refresh`):
1. Client connects transaction.
2. Row is locked using `SELECT ... FOR UPDATE` on `token_hash`. This serializes concurrent refresh attempts.
3. If token is valid:
   - Successor token is inserted with the same `family_id`.
   - Predecessor token has `revoked_at = NOW()` and `replaced_by_token_id = new_token.id` set.
   - Transaction commits.
4. If two concurrent requests present the same token simultaneously, one acquires the row lock first and succeeds; the second request encounters `revoked_at !== null` and triggers reuse detection.

### 6.4 Token Reuse / Theft Detection
If an incoming refresh token has `revoked_at !== null`:
1. **Theft Incident Triggered**: A previously rotated token was presented, indicating potential token replay or session hijacking.
2. **Family Invalidation**: The query immediately executes:
   ```sql
   UPDATE refresh_tokens SET revoked_at = NOW() WHERE family_id = $familyId AND revoked_at IS NULL;
   ```
3. **Audit Event**: Logs `TOKEN_REUSE_DETECTED`.
4. **Response**: 401 Unauthorized with code `REFRESH_TOKEN_REUSED`.
5. **Repeated Reuse Hardening**: Subsequent presentations of the revoked token consistently fail with `REFRESH_TOKEN_REUSED` and preserve revocation across the entire family.

### 6.5 User Logout Family Revocation Semantics
When a user logs out (`POST /api/v1/auth/logout`):
- The service retrieves the token record and executes `refreshTokenRepo.revokeFamily(tokenRecord.family_id)`.
- **Entire Family Revocation**: Revokes the entire refresh token family, terminating all active and subsequent sessions derived from that login cycle.
- The refresh cookie is cleared with `Max-Age=0`.

---

## 7. Cookie Strategy & CSRF Defense

- **Cookie Attributes**:
  - `Name`: `refreshToken`
  - `HttpOnly`: `true` (prohibits JavaScript access, neutralizing XSS exfiltration).
  - `Secure`: `true` in production (`false` in local testing; configurable via `COOKIE_SECURE`).
  - `SameSite`: `Strict` (configurable via `COOKIE_SAME_SITE`).
  - `Path`: `/api/v1/auth` (restricts cookie transmission exclusively to auth routes).
  - `Max-Age`: `604800` (7 days in seconds).
- **Cookie-Only Ingestion**:
  - Refresh tokens are accepted **exclusively via HTTP-only cookie**.
  - Body-based refresh token acceptance has been removed to eliminate confused-deputy and XSS-injection vectors.
- **CSRF Defense & Origin Allowlisting**:
  - **Allowed Origins Allowlist**: Configurable via `allowedOrigins` parameter or `process.env.ALLOWED_ORIGINS` (comma-separated list).
  - **Strict Origin Check**: State-changing requests (`/refresh`, `/logout`) check incoming `Origin` and `Referer` headers against the allowed origins allowlist.
  - **Disallowed Origins Rejected**: Requests with unapproved origins are rejected with `403 Forbidden` (`CSRF_VALIDATION_FAILED`).
  - **Missing Headers Fallback**: If neither `Origin` nor `Referer` is present (e.g. non-browser automated client), the request must supply custom header `X-Requested-With: XMLHttpRequest` to prove non-simple CORS execution.
  - **CORS Preflight Support**: Full `OPTIONS` handling with credentials enabled for allowed origins.

---

## 8. Endpoint Contracts & Error Semantics

All API responses strictly adhere to the standard envelope:
```json
{
  "success": true,
  "data": { ... },
  "meta": { "timestamp": "2026-09-19T18:45:00.000Z" }
}
```

### Endpoints:
1. `POST /api/v1/auth/register`
   - Request: `{ "email": "user@org.com", "password": "SecurePassword123!" }`
   - Response (`201 Created`): `{ "user": { "id": "...", "email": "user@org.com", "createdAt": "..." } }`
2. `POST /api/v1/auth/login`
   - Request: `{ "email": "user@org.com", "password": "SecurePassword123!" }`
   - Sets Cookie: `refreshToken=<rawToken>; HttpOnly; Path=/api/v1/auth`
   - Response (`200 OK`): `{ "user": { ... }, "accessToken": "..." }`
3. `POST /api/v1/auth/refresh`
   - Cookie ONLY: `refreshToken=<rawToken>`
   - Sets Cookie: Rotated `refreshToken`
   - Response (`200 OK`): `{ "accessToken": "..." }`
   - Body-based rejection: Passing token in JSON body returns `400 INVALID_REFRESH_TOKEN`.
4. `POST /api/v1/auth/logout`
   - Cookie ONLY: `refreshToken=<rawToken>`
   - Revokes Entire Token Family: Invalidates all active and subsequent sessions derived from that family.
   - Clears Cookie: `refreshToken=; Max-Age=0`
   - Response (`200 OK`): `{ "message": "Logged out successfully" }`
5. `GET /api/v1/auth/me`
   - Header: `Authorization: Bearer <accessToken>`
   - Response (`200 OK`): `{ "id": "...", "email": "...", "createdAt": "...", "updatedAt": "..." }`

### Standard Error Codes:
- `VALIDATION_ERROR` (400)
- `WEAK_PASSWORD` (400)
- `INVALID_CREDENTIALS` (401)
- `AUTH_REQUIRED` (401)
- `TOKEN_EXPIRED` (401)
- `TOKEN_INVALID` (401)
- `INVALID_REFRESH_TOKEN` (401)
- `REFRESH_TOKEN_REUSED` (401)
- `CSRF_VALIDATION_FAILED` (403)
- `EMAIL_ALREADY_EXISTS` (409)
- `RATE_LIMITED` (429)

---

## 9. Rate Limiting Foundation

- **Module**: `src/application/middleware/rateLimiter.js` [`IMPLEMENTED` / `VERIFIED`].
- **Mechanics**: In-memory sliding window rate limiter tracking client IP.
- **Default Envelope**: 10 requests per minute per IP for authentication endpoints.
- **Scalability Note (`KNOWN LIMITATION`)**: In-memory rate limiting is process-local. In future multi-node API deployments, the interface will be backed by a distributed Redis sliding window.

---

## 10. Audit Logging Integration

- **Table**: `audit_logs` [`IMPLEMENTED` / `VERIFIED`].
- **Events Audited**:
  - `USER_REGISTERED`: Recorded upon new user account creation.
  - `LOGIN_SUCCEEDED`: Recorded upon valid password verification.
  - `LOGIN_FAILED`: Recorded on invalid credentials (with IP, user agent, failure reason).
  - `TOKEN_REFRESHED`: Recorded on successful refresh rotation.
  - `TOKEN_REUSE_DETECTED`: Recorded when an old token is re-presented.
  - `LOGOUT`: Recorded upon session termination.
- **Reliability**: Registration and token operations write audit records within the same PostgreSQL transaction client.

---

## 11. Environment Configuration

| Variable | Description | Default / Test Fallback |
| :--- | :--- | :--- |
| `JWT_PRIVATE_KEY` | Ed25519 Private Key (PEM string) | Ephemeral in-memory keypair generated on startup |
| `JWT_PUBLIC_KEY` | Ed25519 Public Key (PEM string) | Ephemeral in-memory keypair generated on startup |
| `JWT_KEY_ID` | Key identifier (`kid` claim in header) | `'key-ed25519-v1'` |
| `JWT_ISSUER` | Expected JWT issuer (`iss` claim) | `'windowseven-auth'` |
| `JWT_AUDIENCE` | Expected JWT audience (`aud` claim) | `'windowseven-api'` |
| `ACCESS_TOKEN_TTL` | Access token lifespan in seconds | `900` (15 minutes) |
| `REFRESH_TOKEN_TTL` | Refresh token lifespan in seconds | `604800` (7 days) |
| `COOKIE_SECURE` | Enforce HTTPS on refresh cookies | `true` in production, `false` in development |
| `COOKIE_SAME_SITE` | SameSite cookie attribute | `'Strict'` |
| `ALLOWED_ORIGINS` | Comma-separated list of allowed origins for CORS and CSRF | `''` (empty allowlist / manual configuration) |

---

## 12. Verification & Regression Results

```text
▶ Phase 4B: Authentication Engine & User Identity
  ▶ 1. Password Hashing & Verification (Argon2id) (3 tests) ................. PASS
  ▶ 2. JWT Signing & Verification (EdDSA / Ed25519) (4 tests) .............. PASS
  ▶ 3. User Registration (POST /api/v1/auth/register) (4 tests) ............ PASS
  ▶ 4. User Login (POST /api/v1/auth/login) (4 tests) ...................... PASS
  ▶ 5. Refresh Token Rotation & Family Reuse Detection (5 tests) ........... PASS
  ▶ 6. User Logout (POST /api/v1/auth/logout) (3 tests) .................... PASS
  ▶ 7. Current User Identity (GET /api/v1/auth/me) (4 tests) ............... PASS
  ▶ 8. Security & Secret Hygiene (2 tests) ................................. PASS
  ▶ 9. CSRF Defense & Allowed Origin Enforcement (5 tests) ................. PASS
✔ Phase 4B: Authentication Engine & User Identity (34 tests) ............... PASS

Full Test Suite Total:
ℹ tests 143
ℹ suites 26
ℹ pass 143
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
```

---

## 13. Phase 4C Readiness

The authentication engine provides the exact user identity foundation required for **Phase 4C (REST Core & Tenant Authorization Middleware)**.
- `req.user.id` is reliably populated by `authMiddleware`.
- Phase 4C will build the `tenantMiddleware` to resolve tenant memberships against `req.user.id` and enforce multi-tenant isolation.
