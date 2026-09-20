# 08 — REST API, Authentication & Horizontal Scalability Architecture

**Windowseven MD Multi-Tenant Architecture & Distributed Systems Blueprint**  
**Phase:** 4A — Architecture & Design (Corrected Specification)  
**Author:** Senior Staff Backend Engineer, Distributed Systems Architect & Application Security Engineer  
**Date:** September 2026  
**Status:** APPROVED ARCHITECTURAL SPECIFICATION — DESIGN FIRST (NO CODE IMPLEMENTATION IN THIS PHASE)  
**Implementation Baseline:** 109 automated tests passing across 16 test suites (Phase 3E)  
**Installed Baileys Version:** `@whiskeysockets/baileys@7.0.0-rc14` (Verified via `package-lock.json`)

---

## Terminology & Claim Classification Standard

To ensure absolute engineering integrity and prevent misleading scalability claims, this document adheres to explicit taxonomy:

- **`VERIFIED / OBSERVED`**: Behaviors, constraints, and latencies directly validated in automated test suites or local process runs.
- **`MEASURED`**: Benchmarked metrics with captured profiling data (e.g., Node.js process heap baselines, PostgreSQL query plans).
- **`INITIAL CAPACITY ASSUMPTION`**: Theoretical modeling derived from protocol specifications, memory structures, and network overhead.
- **`ARCHITECTURE TARGET / BENCHMARK TARGET`**: Target operational envelopes designed to be reached through horizontal scale without architectural refactoring.
- **`UNKNOWN`**: Unverified behaviors prior to multi-node stress testing (e.g., WhatsApp server rate-limit ceilings, multi-host network jitter).
- **`DESIGNED`**: Architectural components formally specified but intentionally **NOT YET IMPLEMENTED** in this phase.

---

## Table of Contents

1. [Executive Summary & Architectural Scope](#1-executive-summary--architectural-scope)
2. [Current Application Layer Readiness Assessment](#2-current-application-layer-readiness-assessment)
3. [Split-Plane System Architecture & Real Scalability Units](#3-split-plane-system-architecture--real-scalability-units)
4. [Distributed Connection Ownership & Worker Fencing Strategy](#4-distributed-connection-ownership--worker-fencing-strategy)
5. [Worker Lifecycle & Safe Handoff Protocol](#5-worker-lifecycle--safe-handoff-protocol)
6. [Event Delivery Architecture & Transport Abstraction](#6-event-delivery-architecture--transport-abstraction)
7. [Authentication Architecture & Security Specification](#7-authentication-architecture--security-specification)
8. [Multi-Tenant Authorization & Privilege Separation](#8-multi-tenant-authorization--privilege-separation)
9. [Comprehensive `/api/v1` REST Endpoint Catalog](#9-comprehensive-apiv1-rest-endpoint-catalog)
10. [Database Schema Enhancements (Phase 4 Migrations)](#10-database-schema-enhancements-phase-4-migrations)
11. [Security Architecture & Zero-Trust Defense](#11-security-architecture--zero-trust-defense)
12. [Realtime & Server-Sent Events (SSE) Architecture](#12-realtime--server-sent-events-sse-architecture)
13. [Capacity Assumptions, Sizing Model & Benchmark Plan](#13-capacity-assumptions-sizing-model--benchmark-plan)
14. [Configurable Operational Limits & Media Decoupling](#14-configurable-operational-limits--media-decoupling)
15. [Observability, Prometheus Cardinality Policy & Tracing](#15-observability-prometheus-cardinality-policy--tracing)
16. [Audit Logging Reliability Model](#16-audit-logging-reliability-model)
17. [Phased Implementation Roadmap (4B – 4F)](#17-phased-implementation-roadmap-4b--4f)
18. [Risks, Blockers & Technical Debt](#18-risks-blockers--technical-debt)
19. [Verification & Test Plan](#19-verification--test-plan)

---

## 1. Executive Summary & Architectural Scope

Windowseven MD has completed Phases 1 through 3E, establishing:
- Relational PostgreSQL foundation with composite primary/foreign keys (`tenant_id`, `connection_id`, `group_id`).
- Authoritative Baileys session management (`ConnectionManager`) with Signal keys persisted in PostgreSQL using `@whiskeysockets/baileys@7.0.0-rc14`.
- Normalized event pipeline (`EventAdapter`, `ApplicationPipeline`, `PolicyEngine`) and automated group discovery (`GroupSynchronizer`).
- Migrated moderation commands (`.warn`, `.warnings`, `.resetwarn`, `.antilink`, `.mute`, `.unmute`, `.kick`, `.promote`, `.demote`).
- 109 automated tests passing across 16 test suites.

**Primary Product Requirement**: Windowseven MD must be architected for large-scale multi-tenant operation. The system must not collapse or require fundamental rewrites as tenancy grows from 10 customers to 1,000+ connections.

**Phase 4A Discipline**:
- **DESIGN FIRST**: Zero production routes, controllers, or database migrations are committed in this phase.
- **HEADLESS COMPATIBILITY**: An existing frontend exists; our `/api/v1` REST and SSE contracts are designed independently to serve as an enterprise headless backend.
- **SPLIT-PLANE INDEPENDENCE**: API handling is stateless; WhatsApp socket execution is stateful and distributed.

---

## 2. Current Application Layer Readiness Assessment

### 2.1 Domain Models and Repositories

| Repository / Model | Implementation Status | API Readiness | Architectural Role & Phase 4 Strategy |
| :--- | :--- | :--- | :--- |
| `UserRepository` | Operational (`VERIFIED`) | **Ready** | Used by auth controllers. Needs `updatePassword` method for user profile management. |
| `TenantRepository` | Operational (`VERIFIED`) | **Ready** | Used for tenant registration, workspace configuration, and tenant metadata. |
| `TenantMembershipRepository` | Operational (`VERIFIED`) | **Ready** | Authoritative source for RBAC (`OWNER`, `ADMIN`, `MEMBER`). Used by tenant middleware. |
| `WhatsAppConnectionRepository` | Operational (`VERIFIED`) | **Needs Columns** | Scoped by `tenant_id`. Requires `assigned_worker_id`, `lease_epoch`, and `lease_expires_at` for fencing. |
| `GroupRepository` | Operational (`VERIFIED`) | **Ready** | Read/write group discovery state and management toggle (`MANAGED` vs `UNMANAGED`). |
| `GroupPolicyRepository` | Operational (`VERIFIED`) | **Ready** | 100% database-backed policy storage (`antilink`, `antibadword`, `welcome`, `max_warnings`). Direct API access. |
| `GroupWarningRepository` | Operational (`VERIFIED`) | **Ready** | 100% database-backed warning records and counts. Direct API access. |
| `WarningService` | Operational (`VERIFIED`) | **Ready** | Evaluates warning thresholds against policies. Synchronous database queries; direct API invocation. |
| `ModerationService` | Operational (`VERIFIED`) | **Requires Dispatch** | Performs socket mutations (`muteGroup`, `kickParticipant`). In split-plane, REST nodes must dispatch to active worker. |
| `ConnectionManager` | Operational (`VERIFIED`) | **Worker Tier** | Sole owner of `makeWASocket()`. Bound strictly to WhatsApp Runtime Workers. |
| `GroupSynchronizer` | Operational (`VERIFIED`) | **Worker Tier** | Syncs groups via active socket. API triggers dispatch sync jobs to the leased worker. |
| `WhatsAppAuthCredentialsRepository` | Operational (`VERIFIED`) | **INTERNAL ONLY** | Low-level Signal credentials. **Strictly prohibited** from exposure via REST API. |
| `WhatsAppAuthKeysRepository` | Operational (`VERIFIED`) | **INTERNAL ONLY** | Signal pre-keys. **Strictly prohibited** from exposure via REST API. |

---

## 3. Split-Plane System Architecture & Real Scalability Units

### 3.1 Independent Scalability Units

The architecture defines four distinct units that scale independently without cross-plane coupling:

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        INDEPENDENT SCALABILITY UNITS                   │
├───────────────────┬───────────────────┬────────────────────────────────┤
│ UNIT              │ LIFECYCLE / STATE │ SCALING MECHANISM              │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ 1. API Nodes      │ Stateless HTTP/SSE│ Auto-scaled horizontally (N+1) │
│                   │ No socket access  │ behind reverse proxy / L4 / L7 │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ 2. WhatsApp       │ Stateful Noise    │ Horizontally partitioned:      │
│    Workers        │ Sockets & Ratchets│ Worker 1 owns Connections A..N │
│                   │ Bounded set/worker│ Worker 2 owns Connections N..M │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ 3. PostgreSQL     │ Authoritative     │ Scaled via connection pooler   │
│    Storage        │ Persistent State  │ (PgBouncer) + Primary/Replica  │
├───────────────────┼───────────────────┼────────────────────────────────┤
│ 4. Realtime       │ Ephemeral Event   │ Starts as PostgreSQL NOTIFY;   │
│    Transport      │ Notification Bus  │ Swappable to Redis Streams/NATS│
└───────────────────┴───────────────────┴────────────────────────────────┘
```

### 3.2 Decoupled Topology Diagram

```text
                                  ┌────────────────────────┐
                                  │      Client Tier       │
                                  │  (Web Dashboard / CLI) │
                                  └───────────┬────────────┘
                                              │ HTTPS / SSE
                                              ▼
                                  ┌────────────────────────┐
                                  │ Reverse Proxy / Ingress│
                                  │    (Nginx / Traefik)   │
                                  └───────────┬────────────┘
                                              │
                     ┌────────────────────────┴────────────────────────┐
                     │                                                 │
                     ▼                                                 ▼
        ┌─────────────────────────┐                       ┌─────────────────────────┐
        │     API Node 1          │                       │     API Node 2          │
        │   (Stateless HTTP/SSE)  │                       │   (Stateless HTTP/SSE)  │
        │                         │                       │                         │
        │  * Express/Fastify App  │                       │  * Express/Fastify App  │
        │  * Argon2id Auth & JWT  │                       │  * Argon2id Auth & JWT  │
        │  * Tenant RBAC Gate     │                       │  * Tenant RBAC Gate     │
        │  * SSE Manager (Filter) │                       │  * SSE Manager (Filter) │
        └────────────┬────────────┘                       └────────────┬────────────┘
                     │                                                 │
                     └────────────────────────┬────────────────────────┘
                                              │ SQL & Event Subscription
                                              ▼
                    ======================================================
                    SHARED DATA & MESSAGING TIER (PostgreSQL 15+ / PgBouncer)
                    ------------------------------------------------------
                    * Relational Tables (Tenants, Users, Groups, Policies)
                    * Baileys Auth Store (Credentials & Signal Keys)
                    * Connection Leases & Epoch Generations
                    * Event Publisher Adapter: PostgreSQL `LISTEN / NOTIFY`
                    ======================================================
                                              ▲
                     ┌────────────────────────┴────────────────────────┐
                     │ SQL (Lease Heartbeats & Key Store)              │
                     ▼                                                 ▼
        ┌─────────────────────────┐                       ┌─────────────────────────┐
        │ WhatsApp Worker 1       │                       │ WhatsApp Worker 2       │
        │ (Owns Connections A..N) │                       │ (Owns Connections N..M) │
        │                         │                       │                         │
        │  * Worker ID: worker-01 │                       │  * Worker ID: worker-02 │
        │  * Active Epoch Tracker │                       │  * Active Epoch Tracker │
        │  * ConnectionManager    │                       │  * ConnectionManager    │
        │  * EventAdapter         │                       │  * EventAdapter         │
        │  * ApplicationPipeline  │                       │  * ApplicationPipeline  │
        └────────────┬────────────┘                       └────────────┬────────────┘
                     │                                                 │
                     ▼                                                 ▼
        ┌─────────────────────────┐                       ┌─────────────────────────┐
        │   WhatsApp Net (WAN)    │                       │   WhatsApp Net (WAN)    │
        └─────────────────────────┘                       └─────────────────────────┘
```

---

## 4. Distributed Connection Ownership & Worker Fencing Strategy

### 4.1 The Single-Active-Socket Invariant

> **SYSTEM INVARIANT**: Exactly one active WhatsApp socket may own a connection at any given time across the entire distributed cluster.

WhatsApp enforces cryptographic ratchet sequence progression via the Signal Protocol. If two processes connect simultaneously using the same credentials:
- Inbound messages trigger conflicting ACKs.
- Pre-key ratchets desynchronize permanently.
- WhatsApp servers detect dual authentication and issue an immediate 401/440 logout or permanent account ban.

### 4.2 Why Simple Expiry Leases Fail (The Split-Brain Race)

A simple time-based lease (`assigned_worker_id`, `lease_expires_at`) is **unsafe**:
1. Worker A acquires Connection X (`lease = 30s`).
2. Worker A experiences an OS freeze, GC pause, or network partition for 35s.
3. PostgreSQL observes lease expiration (`now() > lease_expires_at`).
4. Worker B claims Connection X, connects its Baileys socket, and begins handling traffic.
5. Worker A wakes up. Worker A **still holds its open Baileys socket** and attempts to write to WhatsApp and PostgreSQL.
6. **Result**: Dual active sockets, Signal ratchet corruption, and session invalidation.

### 4.3 Generation Fencing via `lease_epoch`

To provide verifiable single-ownership guarantees, we introduce a monotonic `lease_epoch` (fencing token):

```text
Connection Record in PostgreSQL:
  id:                  'c1a2b3c4-...'
  assigned_worker_id:  'worker-02'
  lease_epoch:         184           <-- Monotonically increasing generation
  lease_expires_at:    '2026-09-19T14:30:30Z'
```

#### Fencing Rules & Resolution of Edge Cases:

1. **How does an old worker know it has lost ownership?**
   - **Proactive Check**: On every heartbeat (every 10s), the worker executes an atomic generation query. If 0 rows are updated, the worker immediately recognizes ownership loss.
   - **Reactive Check**: Before any database mutation or outbound WhatsApp dispatch, the worker validates its cached epoch against PostgreSQL.
   - **Lease Expiry Watchdog**: Every worker maintains an in-memory timer set to `lease_duration - grace_period` (e.g. 25s for a 30s lease). If the heartbeat has not successfully confirmed lease renewal within 25 seconds, the worker's internal watchdog **unconditionally trips and terminates the socket locally** without waiting for PostgreSQL.

2. **How does a new worker prevent an old worker from continuing?**
   - The new worker acquires the lease by atomically incrementing `lease_epoch`:
     ```sql
     UPDATE whatsapp_connections
     SET assigned_worker_id = $newWorkerId,
         lease_epoch = lease_epoch + 1,
         lease_expires_at = NOW() + INTERVAL '30 seconds',
         updated_at = NOW()
     WHERE id = $connectionId
       AND (assigned_worker_id IS NULL OR lease_expires_at < NOW())
     RETURNING lease_epoch;
     ```
   - From this instant, all database queries attempted by Worker A with `epoch = 183` will match 0 rows and be rejected.

3. **How is stale ownership detected?**
   - Any worker database operation (e.g., updating group status, persisting warnings, writing Signal keys) includes `AND lease_epoch = $currentEpoch`. If the row count is 0, stale ownership is flagged.

4. **How are stale worker heartbeats rejected?**
   - The heartbeat query explicitly binds the expected epoch:
     ```sql
     UPDATE whatsapp_connections
     SET lease_expires_at = NOW() + INTERVAL '30 seconds'
     WHERE id = $connectionId
       AND assigned_worker_id = $workerId
       AND lease_epoch = $epoch
       AND lease_expires_at > NOW();
     ```
   - If Worker B has incremented the epoch to 184, Worker A's heartbeat (`epoch = 183`) updates 0 rows and fails.

5. **How is socket shutdown triggered after lease loss?**
   - When a heartbeat fails, epoch check fails, or the local lease watchdog trips, the worker invokes `ConnectionManager.abortConnection(connectionId, reason: 'LEASE_LOST')`.
   - The WebSocket is forcibly terminated (`sock.ws.terminate()`), event listeners are stripped, and background timers are cleared.

6. **How do we prevent two workers from legitimately creating sockets?**
   - Sockets are never initialized until the atomic SQL update successfully returns a new `lease_epoch`. PostgreSQL row-level locks on `whatsapp_connections` prevent concurrent lease grants.

7. **What happens during PostgreSQL / network partitions?**
   - If Worker A loses connectivity to PostgreSQL, its heartbeat fails.
   - Within 25 seconds (before the 30-second lease expires in PostgreSQL), Worker A's local lease watchdog trips and forcefully terminates the Baileys socket.
   - Worker B cannot claim the lease until the full 30 seconds elapse, ensuring Worker A has self-terminated before Worker B initializes.

8. **What happens if a worker pauses longer than the lease duration (e.g. 45s GC pause)?**
   - Worker B claims the lease and increments epoch to 184.
   - When Worker A wakes up at $t = 45\text{s}$, its local clock indicates that $45\text{s} > 25\text{s}$ (watchdog expired).
   - Before processing any queued event-loop callbacks, Worker A's watchdog abort handler runs, instantly terminating the socket without sending any data.

---

## 5. Worker Lifecycle & Safe Handoff Protocol

### 5.1 Connection State Machine

```text
      ┌───────────────┐
      │  UNASSIGNED   │◄───────────────────────────┐
      └───────┬───────┘                            │
              │ Worker claims lease (epoch++)      │
              ▼                                    │
      ┌───────────────┐                            │
      │LEASE_ACQUIRED │                            │
      └───────┬───────┘                            │
              │ Initialize Baileys socket          │ Graceful Release /
              ▼                                    │ Clean Shutdown
      ┌───────────────┐                            │
      │SOCKET_STARTING│                            │
      └───────┬───────┘                            │
              │ Noise handshake & Signal pairing   │
              ▼                                    │
      ┌───────────────┐                            │
      │    ACTIVE     │                            │
      └───────┬───────┘                            │
              │ Heartbeat fails OR watchdog trips  │
              ▼                                    │
      ┌───────────────┐                            │
      │SOCKET_STOPPING│                            │
      └───────┬───────┘                            │
              │ Socket terminated, state flushed   │
              └────────────────────────────────────┘
```

### 5.2 Subsystem Impact of Ownership Loss

When a worker loses ownership (`LEASE_LOST`), every subsystem is halted deterministically:

| Subsystem | Action Upon Ownership Loss |
| :--- | :--- |
| **`ConnectionManager`** | Unregisters connection, marks status `STALE`, logs epoch desync. |
| **`Baileys Socket`** | Forcibly closed via `.terminate()`. No further TCP frames or ACKs sent to WhatsApp. |
| **`EventAdapter`** | Disconnects all listeners (`adapter.removeAllListeners()`). Halts event emissions. |
| **`ApplicationPipeline`** | Discards in-flight messages. Returns `{ handled: false, reason: 'lease_lost' }`. |
| **Timers** | Ephemeral mute timers (`setTimeout`) for that connection are immediately cleared via `.unref()` / `clearTimeout`. |
| **Pending Moderation Actions** | In-flight gateway calls (`kickParticipant`, `muteGroup`) are aborted immediately via `AbortController`. |
| **`GroupSynchronizer`** | Aborts active sweeps. Discards pending group bulk inserts. |
| **Outbound WhatsApp Ops** | Outbound queue is purged. No stale messages or policy responses are transmitted. |

---

## 6. Event Delivery Architecture & Transport Abstraction

### 6.1 Ephemeral Notification vs Durable State

To avoid architectural failure, the transport system strictly separates **durable state** from **ephemeral notifications**:

```text
┌────────────────────────────────────────┐       ┌────────────────────────────────────────┐
│             DURABLE STATE              │       │         EPHEMERAL NOTIFICATIONS        │
│          (PostgreSQL Tables)           │       │    (LISTEN/NOTIFY / Redis Streams)     │
├────────────────────────────────────────┤       ├────────────────────────────────────────┤
│ * Authoritative state of record        │       │ * Signaling mechanism only             │
│ * Connection status, groups, policies  │       │ * "State changed" / "New event ready"  │
│ * Warning history & audit logs         │       │ * Best-effort delivery; drops allowed  │
│ * Survives restarts & network drops    │       │ * Client recovers by querying DB       │
└────────────────────────────────────────┘       └────────────────────────────────────────┘
```

**Delivery Guarantees Matrix**:
- **PostgreSQL Relational Tables**: **Durable & ACID Compliant**.
- **PostgreSQL `LISTEN / NOTIFY`**: **Ephemeral & Best-Effort**. Does NOT buffer messages. If an API node is disconnected when a notification fires, the notification is lost.
- **Client Recovery Mechanism**: SSE clients receiving an event notification use it as a trigger to read the latest state from PostgreSQL. If an SSE connection drops and reconnects, it queries `GET /api/v1/tenants/:tenantId/...` to re-synchronize state.

### 6.2 Future Event Bus Abstraction (`IEventPublisher`)

Application logic must **never** call `pg.query('NOTIFY ...')` directly. All events flow through an abstract publisher interface:

```text
Application Pipeline / EventAdapter
                 │
                 ▼
     ┌───────────────────────┐
     │   IEventPublisher     │ (Domain Interface)
     └───────────┬───────────┘
                 │
        ┌────────┴────────────────────────┐
        ▼                                 ▼
┌─────────────────────────┐     ┌─────────────────────────┐
│ PostgresEventPublisher  │     │   RedisEventPublisher   │
│ (Phase 4 Default:       │     │ (Future Target:         │
│  LISTEN / NOTIFY)       │     │  Redis Streams / NATS)  │
└─────────────────────────┘     └─────────────────────────┘
```
**Benefit**: Transitioning from PostgreSQL `NOTIFY` to Redis Streams or NATS in future phases requires zero code changes to `ApplicationPipeline`, `EventAdapter`, or domain services.

---

## 7. Authentication Architecture & Security Specification

### 7.1 JWT Signing: HS256 vs EdDSA Trade-off Analysis

| Metric | HMAC-SHA256 (`HS256`) | Ed25519 (`EdDSA`) / RS256 | Selected Strategy |
| :--- | :--- | :--- | :--- |
| **Key Type** | Symmetric (shared secret) | Asymmetric (Private/Public key pair) | **Phase 4 Target: EdDSA (or RS256)** |
| **Security Surface** | Every API node must possess the signing secret. If one node is compromised, tokens can be forged cluster-wide. | Only the Auth service holds the private key. API nodes only hold the public key for verification. | **Superior Isolation**: Public key verification across API nodes eliminates cluster-wide forgery risk. |
| **Performance** | Extremely fast (< 5 µs verification) | Very fast (< 50 µs verification) | Negligible difference at target load. |
| **Key Rotation** | Requires synchronized deployment of new secret across all nodes. | Public keys can be hosted at `/.well-known/jwks.json` and cached with TTL. | Frictionless zero-downtime rotation. |

### 7.2 Complete Refresh Token Lifecycle & Cookie Security

```text
Browser Client                    API Gateway (Auth Controller)          PostgreSQL
     │                                      │                                 │
     ├─ 1. POST /api/v1/auth/login ────────►│ Verify Argon2id                 │
     │     { email, password }              ├─ Generate Access Token (JWT)    │
     │                                      ├─ Generate Refresh Token (UUIDv4)│
     │                                      │  Hash Token: SHA-256(token)     │
     │                                      ├─ INSERT INTO refresh_tokens ───►│
     │◄─ 2. 200 OK ─────────────────────────┤  (token_hash, family_id, exp)   │
     │     Body: { accessToken }            │                                 │
     │     Cookie: refreshToken (HttpOnly)  │                                 │
     │                                      │                                 │
     ├─ 3. POST /api/v1/auth/refresh ──────►│ Read Cookie: refreshToken       │
     │     Cookie: refreshToken             │ Compute SHA-256(token)          │
     │                                      ├─ SELECT WHERE token_hash = $1 ─►│
     │                                      │                                 │
     │   [SCENARIO A: Valid Token]          │                                 │
     │                                      ├─ Check is_revoked = FALSE       │
     │                                      ├─ Mark old token revoked         │
     │                                      ├─ Issue new token pair (same fam)│
     │                                      ├─ INSERT new token hash ────────►│
     │◄─ Return new accessToken & cookie ───┤                                 │
     │                                      │                                 │
     │   [SCENARIO B: Replay / Theft]       │                                 │
     │                                      ├─ Detected is_revoked = TRUE!    │
     │                                      │  SECURITY ALERT: THEFT DETECTED │
     │                                      ├─ UPDATE refresh_tokens ────────►│
     │                                      │  SET is_revoked = TRUE          │
     │                                      │  WHERE family_id = $familyId    │
     │◄─ 401 Unauthorized (All revoked) ────┤                                 │
```

#### Cookie Security Attributes & CSRF Defense:
- `HttpOnly`: `true` (prevents JavaScript access, mitigating XSS extraction).
- `Secure`: `true` (enforced in all non-local environments; transmitted over TLS only).
- `SameSite`: `Strict` for same-origin deployments; `Lax` with explicit anti-CSRF tokens for split-domain frontends.
- `Path`: `/api/v1/auth` (restricts cookie transmission exclusively to authentication endpoints, reducing leak surface).
- **CSRF Defense**: Non-GET browser requests require a custom header (`X-Requested-With: XMLHttpRequest` or double-submit anti-CSRF token).

---

## 8. Multi-Tenant Authorization & Privilege Separation

### 8.1 SaaS Roles vs WhatsApp Roles

```text
┌────────────────────────────────────────┐       ┌────────────────────────────────────────┐
│             SAAS ROLES                 │       │           WHATSAPP ROLES               │
│  (Database: `tenant_memberships.role`) │       │     (Realtime WhatsApp Protocol)       │
├────────────────────────────────────────┤       ├────────────────────────────────────────┤
│ * OWNER: Full org control, billing,    │       │ * isSenderAdmin: WhatsApp Group Admin  │
│   membership management, delete tenant │       │   (granted inside WhatsApp group chat) │
│ * ADMIN: Manage connections, groups,   │  VS   │ * isBotAdmin: Bot Phone Number is      │
│   policies, moderation, view logs      │       │   Admin (required to kick/mute)        │
│ * MEMBER: View-only dashboard, stats,  │       │                                        │
│   assigned groups (read-only)          │       │                                        │
└────────────────────────────────────────┘       └────────────────────────────────────────┘
```

### 8.2 Canonical Tenant Context Routing

To eliminate ambiguity between headers and route parameters:
- **Canonical Routing Rule**: All resource-scoped REST endpoints **MUST** declare `tenantId` in the URL path:
  ```text
  /api/v1/tenants/:tenantId/...
  ```
- **Context Resolution Flow**:
  1. Authenticated User extracted from verified JWT (`req.user.id`).
  2. `tenantId` extracted from URL route param (`req.params.tenantId`).
  3. Tenant membership query: `SELECT role FROM tenant_memberships WHERE tenant_id = $1 AND user_id = $2`.
  4. If no membership exists, return `403 Forbidden` (or `404 Not Found` to prevent tenancy enumeration).
  5. `req.tenantContext = { tenantId, role }` populated for downstream controllers.
- **Use of `X-Tenant-ID` Header**: Prohibited for resource-scoped routes. Permitted solely on non-resource utility routes (e.g. `GET /api/v1/users/me/preferences`).

---

## 9. Comprehensive `/api/v1` REST Endpoint Catalog

All responses follow a standard envelope: `{ "success": true, "data": { ... }, "meta": { "requestId", "timestamp" } }`.

```text
Authentication:
  POST   /api/v1/auth/register                           (Public)
  POST   /api/v1/auth/login                              (Public)
  POST   /api/v1/auth/refresh                            (Cookie: refreshToken)
  POST   /api/v1/auth/logout                             (Bearer Token + Cookie)
  GET    /api/v1/auth/me                                 (Bearer Token)

Tenant & Member Management:
  GET    /api/v1/tenants                                 (Bearer: Lists user's tenants)
  POST   /api/v1/tenants                                 (Bearer: Creates tenant, user=OWNER)
  GET    /api/v1/tenants/:tenantId/members               (Role: OWNER, ADMIN, MEMBER)
  POST   /api/v1/tenants/:tenantId/members               (Role: OWNER, ADMIN)
  PATCH  /api/v1/tenants/:tenantId/members/:userId       (Role: OWNER)
  DELETE /api/v1/tenants/:tenantId/members/:userId       (Role: OWNER)

WhatsApp Connections:
  GET    /api/v1/tenants/:tenantId/connections           (Role: OWNER, ADMIN, MEMBER)
  POST   /api/v1/tenants/:tenantId/connections           (Role: OWNER, ADMIN)
  GET    /api/v1/tenants/:tenantId/connections/:connId   (Role: OWNER, ADMIN, MEMBER)
  POST   /api/v1/tenants/:tenantId/connections/:connId/connect    (Role: OWNER, ADMIN)
  POST   /api/v1/tenants/:tenantId/connections/:connId/disconnect (Role: OWNER, ADMIN)
  DELETE /api/v1/tenants/:tenantId/connections/:connId   (Role: OWNER)

WhatsApp Groups:
  GET    /api/v1/tenants/:tenantId/connections/:connId/groups     (Role: OWNER, ADMIN, MEMBER)
  POST   /api/v1/tenants/:tenantId/connections/:connId/groups/sync(Role: OWNER, ADMIN)
  PATCH  /api/v1/tenants/:tenantId/groups/:groupId/status        (Role: OWNER, ADMIN)

Group Policies:
  GET    /api/v1/tenants/:tenantId/groups/:groupId/policies       (Role: OWNER, ADMIN, MEMBER)
  PUT    /api/v1/tenants/:tenantId/groups/:groupId/policies       (Role: OWNER, ADMIN)

Warnings & Moderation:
  GET    /api/v1/tenants/:tenantId/groups/:groupId/warnings       (Role: OWNER, ADMIN, MEMBER)
  POST   /api/v1/tenants/:tenantId/groups/:groupId/warnings       (Role: OWNER, ADMIN)
  DELETE /api/v1/tenants/:tenantId/groups/:groupId/warnings       (Role: OWNER, ADMIN)
  POST   /api/v1/tenants/:tenantId/groups/:groupId/moderation/mute   (Role: OWNER, ADMIN)
  POST   /api/v1/tenants/:tenantId/groups/:groupId/moderation/unmute (Role: OWNER, ADMIN)
  POST   /api/v1/tenants/:tenantId/groups/:groupId/moderation/kick   (Role: OWNER, ADMIN)

Audit & Observability:
  GET    /api/v1/tenants/:tenantId/audit-logs            (Role: OWNER, ADMIN)
  GET    /api/v1/tenants/:tenantId/events (SSE)          (Role: OWNER, ADMIN, MEMBER)
  GET    /health/live                                    (Public)
  GET    /health/ready                                   (Public)
  GET    /metrics                                        (Internal / Prometheus)
```

---

## 10. Database Schema Enhancements (Phase 4 Migrations)

### 10.1 Migration `004_api_auth_and_audit.up.sql` (Specification)

```sql
-- 1. Refresh Tokens for Dual-Token Architecture
CREATE TABLE IF NOT EXISTS refresh_tokens (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash VARCHAR(64) NOT NULL UNIQUE, -- SHA-256 hex hash
    family_id UUID NOT NULL,               -- Token family for theft detection
    is_revoked BOOLEAN NOT NULL DEFAULT FALSE,
    expires_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    replaced_by VARCHAR(64)                -- Pointer to successor token hash
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family ON refresh_tokens (family_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires ON refresh_tokens (expires_at);

-- 2. Audit Logs Table for Security & Compliance
CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    action VARCHAR(100) NOT NULL,
    resource_type VARCHAR(100) NOT NULL,
    resource_id VARCHAR(100),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    ip_address VARCHAR(45),
    user_agent TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_created 
    ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor 
    ON audit_logs (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource 
    ON audit_logs (resource_type, resource_id);

-- 3. Connection Lease Fields with Generation Fencing for Horizontal Scaling
ALTER TABLE whatsapp_connections 
    ADD COLUMN IF NOT EXISTS assigned_worker_id VARCHAR(100),
    ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 1,
    ADD COLUMN IF NOT EXISTS lease_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_whatsapp_connections_lease 
    ON whatsapp_connections (assigned_worker_id, lease_epoch, lease_expires_at);
```

---

## 11. Security Architecture & Zero-Trust Defense

### 11.1 Defense-in-Depth Middleware Sequence

```text
Request
  │
  ▼
[ 1. Rate Limiting Middleware ]
  │  - IP Tier: 100 req/min per IP
  │  - Auth Tier: 10 req/min for /api/v1/auth/login
  ▼
[ 2. Security Headers (Helmet) ]
  │  - Strict-Transport-Security: max-age=63072000; includeSubDomains; preload
  │  - Content-Security-Policy, X-Frame-Options: DENY, X-Content-Type-Options: nosniff
  ▼
[ 3. CORS Enforcement ]
  │  - Strict origin whitelist (no wildcard `*` with credentials)
  ▼
[ 4. Authentication Middleware ]
  │  - Validates JWT signature (EdDSA/RS256) & expiration
  │  - Populates req.user = { id, email }
  ▼
[ 5. Canonical Tenant Context Middleware ]
  │  - Extracts tenantId from URL route parameter /:tenantId
  │  - Validates UUID syntax
  │  - Verifies membership in tenant_memberships
  │  - Populates req.tenantContext = { tenantId, role }
  ▼
[ 6. RBAC Role Gate ]
  │  - Enforces minimum role requirement
  ▼
[ 7. Input Validation (Zod Schema) ]
  │  - Strips unknown fields, enforces types, sanitizes strings
  ▼
[ Controller Execution ]
  │  - Composite tenantId queries
  ▼
Response
```

---

## 12. Realtime & Server-Sent Events (SSE) Architecture

### 12.1 Strict Tenant-Scoped Event Pipeline

Under no circumstance may an authenticated user in Tenant A receive realtime events for Tenant B. Raw Baileys protocol events are **never** delivered directly to clients.

```text
┌────────────────────────────────────────────────────────────────────────┐
│                        REALTIME PIPELINE FLOW                          │
│                                                                        │
│  Baileys Socket                                                        │
│         │                                                              │
│         ▼                                                              │
│  EventAdapter (Sanitizes & maps to domain event)                       │
│         │                                                              │
│         ▼                                                              │
│  IEventPublisher (Publishes: tenantId, eventType, payload)             │
│         │                                                              │
│         ▼                                                              │
│  PostgreSQL NOTIFY 'tenant:<tenantId>'                                 │
│         │                                                              │
│         ▼                                                              │
│  API Node SSE Manager (Listening to 'tenant:<tenantId>')               │
│         │                                                              │
│         ▼                                                              │
│  Tenant Filter & RBAC Authorization Check                              │
│         │                                                              │
│         ▼                                                              │
│  Connected Client SSE Stream (text/event-stream)                       │
└────────────────────────────────────────────────────────────────────────┘
```

- **SSE Channel**: `GET /api/v1/tenants/:tenantId/events`
- **Keep-Alive**: Server sends `:keepalive\n\n` comments every 15 seconds.
- **Client Recovery**: Standard browser `EventSource` auto-reconnects with exponential delay. Upon reconnect, client fetches latest database state via REST.

---

## 13. Capacity Assumptions, Sizing Model & Benchmark Plan

### 13.1 Initial Sizing Estimates & Assumptions (Not Measured Evidence)

The following metrics represent **initial engineering estimates** derived from Baileys in-memory data structures, Node.js buffer allocations, and PostgreSQL connection pool sizing. **They are not demonstrated load test results.**

| Metric | Idle Connection (Estimated) | Active (1 msg/s) (Estimated) | Burst (10 msg/s) (Estimated) | Classification |
| :--- | :--- | :--- | :--- | :--- |
| **Node.js Heap RAM** | ~35 – 45 MB | ~55 – 70 MB | ~80 – 100 MB | **Estimated** |
| **vCPU Utilization** | < 0.1% | 1 – 3% | 8 – 15% | **Estimated** |
| **DB Client Leases** | 0 (idle sockets do not hold DB clients) | Bursts of 1 query/msg | Bursts of 5 queries/msg | **Estimated** |

### 13.2 Architecture Targets for Scalability Planning

| Target Stage | Architecture Target | Worker Nodes Target | API Nodes Target | Classification |
| :--- | :--- | :--- | :--- | :--- |
| **Stage 1: Monolith** | 10 – 25 connections | 1 Combined Node (2 vCPU, 4GB) | 1 Combined Node | **Target** |
| **Stage 2: Split-Plane** | 50 – 100 connections | 2 Worker Nodes (2 vCPU, 4GB) | 2 API Nodes (1 vCPU, 2GB) | **Target** |
| **Stage 3: Scaled Plane** | 250 – 500 connections | 5 Worker Nodes (4 vCPU, 8GB) | 3 API Nodes (2 vCPU, 4GB) | **Target** |
| **Stage 4: Enterprise** | 1,000 connections | 10 Worker Nodes (4 vCPU, 16GB)| 4 API Nodes (2 vCPU, 4GB) | **Target** |

### 13.3 Formal Capacity Benchmark Plan

Before claiming proven capacity at any tier, the following benchmark protocol must be executed and recorded:

```text
Benchmark Stages:
  [ ] Stage 1: 10 connections
  [ ] Stage 2: 50 connections
  [ ] Stage 3: 100 connections
  [ ] Stage 4: 250 connections
  [ ] Stage 5: 500 connections
  [ ] Stage 6: 1,000 connections

Metrics Required per Stage:
  - System: CPU usage, RSS Memory, Node.js Heap Used, Event Loop Lag (p50, p95, p99)
  - Database: Active Pool Connections, Connection Wait Time, Query Latency (p95)
  - WhatsApp Network: Handshake Duration, Reconnect Rate, Ping/Pong Latency
  - Application: Message Processing Throughput (msgs/sec), Group Sync Duration, Policy Engine Latency
  - Fault Injection: Worker crash recovery time, lease re-acquisition latency, split-brain zero-count verification
```

---

## 14. Configurable Operational Limits & Media Decoupling

### 14.1 Configurable Resource Limits

Hardcoded connection and workload limits are strictly prohibited. All capacity throttles are environment-configurable:

```text
# Concurrency & Connection Limits
MAX_CONNECTIONS_PER_TENANT=10
MAX_CONNECTIONS_PER_WORKER=50
MAX_GROUPS_PER_CONNECTION=500
MAX_GROUP_SYNC_CONCURRENCY=3

# Reconnect & Pairing Throttles
MAX_PAIRING_ATTEMPTS=5
MAX_RECONNECT_ATTEMPTS=5
RECONNECT_BASE_DELAY_MS=2000
RECONNECT_MAX_DELAY_MS=60000

# Moderation & Ingestion Limits
MAX_MODERATION_REQUESTS_PER_MIN=60
MAX_INBOUND_MESSAGES_PER_SEC_PER_CONN=25
```

### 14.2 Media Workload Decoupling (Non-Blocking Workers)

> **ARCHITECTURAL MANDATE**: WhatsApp Runtime Workers must **never** become general-purpose media processing servers.

Inbound or outbound video transcoding, sticker generation (`ffmpeg`, `jimp`), and audio processing consume massive CPU spikes that stall the Node.js event loop, delaying WebSocket keep-alive pings and triggering disconnect loops.
- **Phase 4 Target Architecture**:
  ```text
  WhatsApp Worker (Receives Media)
            │
            ▼ (Enqueues job)
    Redis / Job Queue
            │
            ▼ (Processes asynchronously)
     Media Worker Node (ffmpeg / GPU)
            │
            ▼ (Returns processed buffer)
  WhatsApp Worker (Transmits to Chat)
  ```
- **Current Phase 4A Discipline**: Media transcoding commands remain unmigrated or rate-limited; socket workers must be protected from synchronous media transcoding loops.

---

## 15. Observability, Prometheus Cardinality Policy & Tracing

### 15.1 Strict Prometheus Cardinality Policy

> **CRITICAL RULE**: Unbounded identifiers (`tenant_id`, `user_id`, `connection_id`, `group_jid`) are **STRICTLY PROHIBITED** as Prometheus metric labels.

High-cardinality labels cause catastrophic memory exhaustion in Prometheus TSDB. Metrics must use low-cardinality enum labels only:

```text
PROHIBITED:
  whatsapp_messages_total{tenant_id="t-1234", connection_id="c-5678"}  <-- DANGEROUS

PERMITTED:
  http_requests_total{method="POST", route="/api/v1/auth/login", status="200"}
  http_request_duration_seconds_bucket{method="GET", route="/api/v1/tenants/:id/connections"}
  whatsapp_connections_total{status="CONNECTED"}
  whatsapp_messages_processed_total{kind="COMMAND"}
  whatsapp_policy_violations_total{policy="antilink", action="delete"}
  db_pool_connections_active
  db_pool_waiting_queries
  node_eventloop_lag_seconds
```
**Tenant-Level Analytics**: Tenant-specific metrics and usage counters must be computed via SQL aggregations on PostgreSQL tables, structured log drains (Elasticsearch/ClickHouse), or distributed tracing (OpenTelemetry).

### 15.2 Structured Logging with Correlation IDs

Pino outputs machine-readable JSON including contextual trace metadata:
```json
{
  "level": 30,
  "time": 1774000100000,
  "pid": 4120,
  "hostname": "api-node-01",
  "reqId": "req_01h8a7b6c5d4e3f2",
  "tenantId": "t1a2b3c4-...",
  "userId": "u1a2b3c4-...",
  "msg": "Group policy updated successfully"
}
```

---

## 16. Audit Logging Reliability Model

### 16.1 Synchronous Audit vs Asynchronous Outbox

Audit logs for high-privilege operations must not be dropped due to application crashes:

1. **Synchronous Audit Persistence (Strict Security Boundary)**:
   - High-privilege administrative actions **MUST** write their audit log within the **exact same database transaction** as the mutation:
     - Tenant member invitation, role modification, or member removal.
     - WhatsApp connection deletion or tenant credentials purge.
     - Group policy changes (`antilink`, `antibadword`, warning thresholds).
     - Manual participant kick or group status changes via API.
   - If the audit record fails to insert, the entire transaction rolls back.

2. **Transactional Outbox / Asynchronous Processing (High-Volume Events)**:
   - Routine, high-throughput events (e.g., automated policy triggers, individual message warning emissions):
     - Written to an `audit_outbox` table or dispatched asynchronously via background worker.
     - Prevents database I/O bottlenecks during high-volume chat spikes.

---

## 17. Phased Implementation Roadmap (4B – 4F)

```text
Phase 4A: Architecture & Design (CURRENT — COMPLETED & REVISED)
   │
   ▼
Phase 4B: Authentication Engine & User Identity
   ├── Argon2id hashing & user registration/login
   ├── Dual-token JWT (EdDSA/RS256 access + refresh token rotation)
   ├── Migration `004_api_auth_and_audit.up.sql` (refresh_tokens, audit_logs)
   └── Unit & integration tests for token lifecycle & family invalidation
   │
   ▼
Phase 4C: REST API Core & Tenant Isolation Middleware
   ├── HTTP server setup with Helmet, CORS, Rate Limiting
   ├── Canonical tenant context routing & zero-trust membership middleware
   ├── Tenant CRUD & membership management endpoints
   └── Cross-tenant IDOR attack penetration tests
   │
   ▼
Phase 4D: Connection Management & Realtime SSE Stream
   ├── Connection CRUD endpoints
   ├── Generation fencing (`lease_epoch`) & worker heartbeat lease loop
   ├── SSE streaming endpoint for QR codes & connection status
   └── Worker crash recovery & fencing verification tests
   │
   ▼
Phase 4E: Policy & Moderation REST Endpoints
   ├── Group status toggle & synchronization endpoints
   ├── GroupPolicy REST endpoints (GET / PUT)
   ├── Warning inspection, issuance, and reset endpoints
   └── Direct moderation dispatch (mute, unmute, kick)
   │
   ▼
Phase 4F: Audit Logging, Metrics & End-to-End Hardening
   ├── Synchronous transaction audit persistence & outbox
   ├── Prometheus `/metrics` endpoint (low-cardinality) & health probes
   └── End-to-end integration tests & capacity baseline verification
```

---

## 18. Risks, Blockers & Technical Debt

1. **Baileys Upstream Volatility**: Verified installed version `@whiskeysockets/baileys@7.0.0-rc14`. Baileys internals are isolated behind `ConnectionManager` and `EventAdapter` on the Worker Plane, ensuring API Plane stability.
2. **Reverse Proxy SSE Timeouts**: Cloud load balancers (AWS ALB, Cloudflare) terminate idle HTTP streams at 60s. Enforced 15-second `:keepalive\n\n` comments guarantee connection survival.
3. **Mute Timers Durability**: In-memory `setTimeout` timers for `.mute <minutes>` do not survive worker restarts. In Phase 4E/4F, scheduled unmutes must be backed by a persistent database-backed queue.

---

## 19. Verification & Test Plan

1. **Automated Unit Tests**:
   - Password hashing and constant-time verification.
   - JWT generation, validation, and expiration.
   - Zod request body schemas and query validations.
2. **Database-Backed Integration Tests**:
   - Complete registration -> login -> refresh -> logout lifecycle.
   - Token theft simulation: Replaying a revoked refresh token revokes all sibling tokens.
   - Cross-tenant IDOR defense: Attempting to access Tenant B's connections/groups/policies with Tenant A's token produces `404/403`.
   - Generation fencing: Simulating Worker A lease expiration and verifying Worker A cannot commit updates after Worker B increments `lease_epoch`.
   - SSE connection and event broadcast verification.
3. **Zero-Regression Guarantee**:
   - All 109 Phase 3E tests must continue to pass with 0 regressions.

---
*End of Phase 4A Corrected Architectural Specification. Ready for review and approval.*
