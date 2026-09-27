# Phase 4G: Production Process Topology, Cross-Node Transport & Observability Architecture

**Document:** `docs/15_PHASE_4G_ARCHITECTURE.md`  
**Status:** ARCHITECTURE & FORENSIC DESIGN COMPLETE  
**Baseline:** Phase 4F Implementation Verified (`PHASE 4F RBAC CLOSURE VERIFIED`)  
**Author:** Windowseven MD Engineering Core  

---

## 1. Executive Purpose

Phase 4G defines the **Production Process Topology, Cross-Node Control Transport, and Operational Observability** architecture for Windowseven MD.

Phases 4A through 4F successfully specified, implemented, and verified the core domain logic:
* Secure multi-tenant REST API with Ed25519 JWT auth and RBAC (Phases 4A–4C)
* Distributed WhatsApp worker ownership with generation-fenced leases (Phase 4D)
* Group policies, command pipeline, and durable scheduled moderation tasks (Phase 4E)
* Platform administration, tenant lifecycle suspension matrix, and immutable audit logs (Phase 4F)

However, the repository currently lacks the **production process architecture and operational harness** required to run these components reliably in decoupled, production-grade environments:
1. **Process Topology Gap**: `index.js` still contains a monolithic Phase 3B runtime with hardcoded single-connection bootstrapping and aggressive process kills (`process.exit(1)` when RAM > 400MB). There are no independent production entrypoints for the REST API plane (`bin/api.js`) or Worker plane (`bin/worker.js`), nor a unified graceful shutdown coordinator.
2. **Cross-Node Signal Delivery Gap**: `PostgresEventPublisher` and `ConnectionCommandGateway` emit PostgreSQL `pg_notify` signals, but no dedicated subscriber loop listens to PostgreSQL notifications across decoupled nodes. In multi-process deployments, wake-up signals are purely process-local, forcing cross-node convergence to fall back to 5-second polling loops.
3. **Operational Observability Gap**: The Prometheus `/metrics` endpoint promised in Phase 4A Section 17 was deferred from Phase 4F. Operators have `/health/live`, `/health/ready`, and `/api/v1/platform/health`, but lack low-cardinality telemetry for connection states, worker lease saturation, HTTP latency histograms, and database connection pool health.
4. **Worker Capacity & Rebalancing Discipline**: Worker capacity remains an unmeasured assumption (~30–50MB per active Baileys socket). Furthermore, the rebalancing of active WhatsApp WebSockets requires explicit architectural discipline to prevent destructive reconnect storms.

Phase 4G bridges these gaps **without adding unnecessary external dependencies** (no Kafka, Redis, or RabbitMQ), **without modifying verified database schemas**, and **without altering core domain invariants**.

---

## 2. Forensic Baseline of Current System

The current system state as of the Phase 4F RBAC closure verification is:

| Layer | Implementation Component | Verified Status | Invariant / Boundary |
| :--- | :--- | :--- | :--- |
| **Database Schema** | Migrations `001` through `008` | `VERIFIED` | 16 tables in PostgreSQL 18; composite foreign keys for tenant isolation; immutability triggers on audit tables. |
| **Authentication** | `AuthService`, `TokenService`, `PasswordService` | `VERIFIED` | Argon2id password hashing; Ed25519 asymmetric access JWTs; refresh token rotation with family invalidation. |
| **Tenant Routing** | `RestApp`, `HttpRouter`, `tenantMiddleware` | `VERIFIED` | Zero-trust membership resolution (`req.tenantContext`); IDOR defense; hierarchical tenant RBAC (`OWNER > ADMIN > MEMBER`). |
| **Platform Ops** | `PlatformService`, `PlatformHandler`, `platformAuthMiddleware` | `VERIFIED` | Live synchronous DB role verification (`platform_user_roles`); `SUPER_ADMIN` vs `PLATFORM_ADMIN` hierarchy; Option B task pause/resume. |
| **Worker Fencing** | `WorkerNode`, `WorkerLeaseManager`, `whatsapp_connections` | `VERIFIED` | Single-active-socket invariant; atomic lease acquisition (`lease_epoch++`); SQL mutation fencing on all writes. |
| **Socket Engine** | `ConnectionManager`, Baileys `7.0.0-rc14` | `VERIFIED` | Sole `makeWASocket` factory; DB-backed auth credentials & keys; explicit WebSocket teardown (`socket.ws.close()`). |
| **Durable Tasks** | `DurableModerationScheduler`, `connection_commands`, `scheduled_moderation_tasks` | `VERIFIED` | `SELECT FOR UPDATE SKIP LOCKED` claims; crash resilience; `REMOTE_OUTCOME_UNKNOWN` triage; no blind retries. |
| **Test Baseline** | 22 test files, 70 suites, 318 tests | `VERIFIED` | 100% green; serial execution (`--test-concurrency=1`); natural process exit with zero leaked handles. |

---

## 3. Current-State Gap Analysis

### 3.1 What Production Capability Is Still Missing?
1. **Decoupled Process Entrypoints**:
   - `src/application/http/RestApp.js` exposes `createRestApp()`, but no standalone CLI script boots the HTTP server in an isolated process with configurable port (`PORT`), host binding, keep-alive headers, and signal handlers.
   - `src/whatsapp/worker/WorkerNode.js` defines the worker state machine, but no standalone CLI script boots the worker node daemon in an isolated process with host registration, worker ID generation, and lease reconciliation.
2. **Cross-Node Notification Listener (`PostgresNotificationListener`)**:
   - `ConnectionCommandGateway` sends `pg_notify('connection_control_wake', ...)`.
   - `PostgresEventPublisher` sends `pg_notify('tenant_events', ...)`.
   - **Gap**: Neither API nodes nor Worker nodes maintain a dedicated PostgreSQL client running `LISTEN`. Cross-process wake-up signals are dropped at the database level, forcing workers to rely exclusively on the fallback 5,000ms reconciliation poll.
3. **Prometheus Telemetry Endpoint**:
   - No `GET /metrics` route exists. External monitoring infrastructure (Prometheus, Grafana, Datadog) cannot scrape standard metrics.
4. **Production Monolith Runner (`bin/monolith.js`)**:
   - For single-server or developer deployments, there is no unified runner that cleanly boots both the API plane and the Worker plane within a single process while honoring graceful shutdown.

### 3.2 What Architecture Was Explicitly Deferred from Phase 4A–4F?
1. **Prometheus `/metrics` Endpoint**: Explicitly scheduled in Phase 4A Section 17, deferred during Phase 4F platform focus.
2. **Support User Impersonation**: Explicitly deferred in Phase 4F Section 24; platform inspection endpoints provide sufficient auditability.
3. **Partitioned Rolling Audit Archives**: Explicitly deferred in Phase 4F Section 24 until audit log volume exceeds 1,000,000 records.
4. **Automated Worker Rebalancing**: Discussed in Phase 4D; deferred pending explicit rebalancing architecture design.

### 3.3 What Known Limitations Remain?
1. **Worker Capacity is an ASSUMPTION**: The capacity figure (e.g., 50 connections per 2 vCPU / 4GB node) is an engineering estimate based on ~30–50MB heap per Baileys socket. It has not been subjected to empirical load benchmarking.
2. **Physical Socket Liveness Post-Crash is UNKNOWN**: Software cannot physically verify remote TCP state after a kernel panic or hard SIGKILL. The system relies entirely on database lease expiration (`lease_expires_at`) and the `SOCKET_STOPPING` barrier.
3. **Transitional Legacy Bridge**: 92 legacy commands remain unmigrated in `commands/`, and `lib/lightweight_store` is shared across sockets. However, SaaS tenants are strictly insulated from legacy execution via `ApplicationPipeline` and `status = 'MANAGED'` gating.

---

## 4. Explicit Phase 4G Scope

Phase 4G is strictly scoped to **Runtime Convergence, Production Process Topology, Cross-Node Transport & Observability**:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                          PHASE 4G ARCHITECTURAL SCOPE                        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Production Process Topology & Executables                                │
│    • bin/api.js: Dedicated REST API Plane server daemon                     │
│    • bin/worker.js: Dedicated Distributed WhatsApp Worker daemon            │
│    • bin/monolith.js: Unified combined single-node runner                   │
│    • Graceful shutdown coordinator (SIGINT/SIGTERM, drain, pool drainage)   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Cross-Node PostgreSQL LISTEN/NOTIFY Transport                            │
│    • PostgresNotificationListener: Dedicated persistent LISTEN connection   │
│    • Auto-reconnect with exponential backoff & jitter                       │
│    • Dispatches connection_control_wake to local WorkerNode                 │
│    • Dispatches tenant_events to local SseGateway                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Operational Telemetry & Prometheus Metrics                               │
│    • GET /metrics: Low-cardinality Prometheus exposition format 0.0.4       │
│    • Zero external dependencies (native Node.js text formatting)            │
│    • Gauges: connection states, active worker leases, DB pool stats         │
│    • Counters & Histograms: HTTP requests, command throughput, task rates   │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Worker Placement & Dwell-and-Drain Policy                                │
│    • Formalization of non-disruptive worker placement                       │
│    • Prohibition of aggressive active-socket rebalancing                    │
│    • Controlled maintenance drain protocol via Phase 4F DRAIN_WORKER        │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Failure-Injection & Split-Plane Concurrency Tests                        │
│    • Multi-process split-plane integration tests                            │
│    • Cross-process LISTEN/NOTIFY wake-up verification                       │
│    • Prometheus metrics format & scrape validation                          │
│    • Graceful SIGTERM/SIGINT teardown tests with natural exit               │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 5. Explicit Non-Goals (Strictly Out of Scope)

The following items are **STRICTLY PROHIBITED** from Phase 4G:
1. **NO External Message Brokers**: DO NOT introduce Redis, Kafka, RabbitMQ, or NATS. PostgreSQL `LISTEN/NOTIFY` + `SKIP LOCKED` queues are fully sufficient.
2. **NO Schema Migrations**: Migration 008 is complete and comprehensive. Phase 4G requires **ZERO** database schema changes.
3. **NO Aggressive WebSocket Rebalancing**: DO NOT implement automated rebalancing of active WhatsApp connections between healthy workers. Rebalancing active sockets forces reconnect storms, invalidates encryption pre-keys, and triggers WhatsApp anti-spam bans.
4. **NO Legacy Command Migration**: DO NOT migrate the 92 non-moderation legacy commands (media scrapers, games, AI). They remain in `commands/` behind the transitional bridge.
5. **NO Production Security Downgrades**: Argon2id, Ed25519 JWT, generation fencing (`worker_id + lease_epoch`), and `SOCKET_STOPPING` barriers remain completely untouched.
6. **NO Frontend Modifications**: Phase 4G is purely a backend infrastructure and operability phase.

---

## 6. Actor Model & Authority Boundary Preservation

Phase 4G maintains strict, zero-trust actor boundaries:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                             ACTOR BOUNDARY MODEL                            │
├──────────────────────────────────┬──────────────────────────────────────────┤
│ Actor                            │ Permitted Authority & Capabilities       │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Windowseven User                 │ Authenticates via /api/v1/auth/*;        │
│                                  │ No tenant access without membership.     │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Tenant Member (MEMBER)           │ Read-only access to scoped tenant data;  │
│                                  │ Cannot modify policies or connections.   │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Tenant Administrator (ADMIN)     │ Manages group policies & moderation;     │
│                                  │ Cannot remove sole OWNER or billing.     │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Tenant Owner (OWNER)             │ Full control over tenant resources;      │
│                                  │ Protected sole-owner invariant.          │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Platform Admin (PLATFORM_ADMIN)  │ Cross-tenant inspection, suspension;     │
│                                  │ CANNOT deactivate tenant or drain worker.│
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Platform Root (SUPER_ADMIN)      │ Full cluster control, worker drain,      │
│                                  │ tenant deactivation.                     │
├──────────────────────────────────┼──────────────────────────────────────────┤
│ Worker Node (Non-Human Daemon)   │ Operates exclusively under lease epoch;  │
│                                  │ Fenced by SQL predicates; No HTTP auth.  │
└──────────────────────────────────┴──────────────────────────────────────────┘
```

---

## 7. System Architecture & Process Topology

### 7.1 Split-Plane Deployment Topologies

Windowseven MD supports three distinct operational topologies using identical underlying code:

```text
TOPOLOGY 1: COMBINED MONOLITH (Development & Small Deployments: < 25 connections)
┌─────────────────────────────────────────────────────────────────────────────┐
│ Node.js Monolith Process (bin/monolith.js)                                  │
│  ├─ RestApp HTTP Server (port 3000)                                         │
│  ├─ WorkerNode Daemon (in-process)                                          │
│  └─ LocalEventPublisher & LocalCommandGateway                               │
└─────────────────────────────────────────────────────────────────────────────┘

TOPOLOGY 2: DECOUPLED SPLIT-PLANE (Production Standard: 25 - 500 connections)
┌─────────────────────────────────────────┐   ┌─────────────────────────────────────────┐
│ API Node (bin/api.js)                   │   │ Worker Node 1 (bin/worker.js)           │
│  ├─ RestApp HTTP Server                 │   │  ├─ WorkerNode (leases 1..50)           │
│  ├─ SseGateway (SSE to clients)         │   │  ├─ ConnectionManager                   │
│  └─ PostgresNotificationListener        │   │  └─ PostgresNotificationListener        │
└──────────────────┬──────────────────────┘   └───────────────────┬─────────────────────┘
                   │                                              │
                   └──────────────────────┬───────────────────────┘
                                          ▼
                         ┌─────────────────────────────────┐
                         │ PostgreSQL 18 Primary Cluster   │
                         │  ├─ State: Tables 001 - 008     │
                         │  ├─ Queues: SKIP LOCKED tables  │
                         │  └─ Wake-up: pg_notify channels │
                         └─────────────────────────────────┘

TOPOLOGY 3: HORIZONTALLY SCALED CLUSTER (Enterprise: 500+ connections)
┌──────────────┐ ┌──────────────┐   ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
│ API Node 1   │ │ API Node 2   │   │ Worker Node 1│ │ Worker Node 2│ │ Worker Node N│
│ (Stateless)  │ │ (Stateless)  │   │ (Cap: 50)    │ │ (Cap: 50)    │ │ (Cap: 50)    │
└──────┬───────┘ └──────┬───────┘   └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
       │                │                  │                │                │
       └────────────────┴──────────────────┼────────────────┴────────────────┘
                                           ▼
                               ┌───────────────────────┐
                               │ PostgreSQL 18 Primary │
                               └───────────────────────┘
```

### 7.2 Process Entrypoints Specification

Each entrypoint has an explicit contract and single responsibility:

#### 1. `bin/api.js` (REST API Server)
* **Configuration**: `PORT` (default 3000), `HOST` (default `0.0.0.0`), `DATABASE_URL`.
* **Initialization**:
  1. Validates PostgreSQL connectivity via `client.query('SELECT 1')`.
  2. Runs `verifyRequiredSchema(pool)`.
  3. Initializes repositories and domain services.
  4. Starts `PostgresNotificationListener` to bridge cluster events to `SseGateway`.
  5. Binds `RestApp` HTTP server to `HOST:PORT`.
* **Shutdown Sequence**:
  1. Catches `SIGTERM` / `SIGINT`.
  2. Stops accepting new HTTP connections (`server.close()`).
  3. Sends `503 Service Unavailable` on `/health/ready`.
  4. Closes active SSE connections cleanly (`res.end()`).
  5. Terminates `PostgresNotificationListener`.
  6. Drains database pool (`pool.end()`).
  7. Exits process with code 0.

#### 2. `bin/worker.js` (Distributed Worker Node)
* **Configuration**: `WORKER_ID` (default `worker-<hostname>-<pid>`), `WORKER_CAPACITY` (default 50), `DRAIN_GRACE_MS` (default 10000), `DATABASE_URL`.
* **Initialization**:
  1. Validates PostgreSQL connectivity.
  2. Runs `verifyRequiredSchema(pool)`.
  3. Instantiates `WorkerNode` with `WorkerRepository`, `ConnectionCommandGateway`, and `DurableModerationScheduler`.
  4. Starts `PostgresNotificationListener` listening on channel `connection_control_wake`.
  5. Calls `workerNode.start()`.
* **Shutdown Sequence**:
  1. Catches `SIGTERM` / `SIGINT`.
  2. Immediately invokes `workerNode.drain({ graceMs: DRAIN_GRACE_MS })`.
  3. Awaits in-flight command completion or grace period expiration.
  4. Disconnects managed Baileys sockets (`socket.ws.close()`).
  5. Releases active database leases (`releaseLease`).
  6. Terminates `PostgresNotificationListener`.
  7. Drains database pool (`pool.end()`).
  8. Exits process with code 0.

#### 3. `bin/monolith.js` (Combined Development Runner)
* Combines `bin/api.js` and `bin/worker.js` in a single Node.js runtime for local development and single-container deployments.
* Shares a single `pg.Pool` instance and uses `LocalEventPublisher` / `LocalCommandGateway` with fallback to `PostgresNotificationListener`.

---

## 8. Cross-Node Event & Control-Plane Transport

### 8.1 The Ephemeral Wake-up vs Durable State Boundary

A core architectural invariant of Windowseven MD is:
> **PostgreSQL tables are the sole authoritative source of truth. PostgreSQL `LISTEN/NOTIFY` is strictly an ephemeral wake-up mechanism.**

* If a `NOTIFY` signal is lost (network drop, buffer overflow, subscriber reconnecting), **zero data is lost**.
* Nodes always read authoritative state from PostgreSQL.
* Periodic polling loops (reconciliation at 5s, scheduler at 5s) guarantee eventual convergence even in the total absence of notifications.

### 8.2 `PostgresNotificationListener` Architecture

To enable instant cross-process reactions without polling lag, Phase 4G introduces `PostgresNotificationListener`:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                    PostgresNotificationListener Architecture                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Dedicated PostgreSQL Client (Single Persistent Socket)                    │
│    │                                                                        │
│    ├──> Executes: LISTEN connection_control_wake                            │
│    ├──> Executes: LISTEN tenant_events                                      │
│    │                                                                        │
│    └──> Event: client.on('notification', (msg) => { ... })                  │
│           │                                                                 │
│           ├── If channel === 'connection_control_wake':                     │
│           │     Dispatch to local ConnectionCommandGateway emitter          │
│           │                                                                 │
│           └── If channel === 'tenant_events':                               │
│                 Dispatch to local SseGateway emitter                        │
│                                                                             │
│  Fault-Tolerance & Lifecycle:                                               │
│    • Heartbeat / keepalive: Periodic SELECT 1 every 30s                     │
│    • Auto-reconnect on socket error or connection drop:                     │
│        Backoff: min(100ms * 2^attempt, 10000ms) + jitter                   │
│    • Clean teardown: Executes UNLISTEN *; client.end()                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 8.3 Channels & Payloads

1. **Channel `connection_control_wake`**:
   - **Emitter**: `ConnectionCommandGateway.sendCommand()`
   - **Payload**: JSON string `< 7500` bytes:
     ```json
     {
       "command": "START_CONNECTION" | "STOP_CONNECTION" | "RECONNECT_CONNECTION" | "DRAIN_WORKER",
       "tenantId": "uuid",
       "connectionId": "uuid",
       "workerId": "worker-id",
       "timestamp": "ISO-8601"
     }
     ```
   - **Receiver**: `WorkerNode` filters messages:
     - If `workerId` matches this worker, or `workerId === null` (broadcast), triggers immediate reconciliation for `connectionId`.

2. **Channel `tenant_events`**:
   - **Emitter**: `PostgresEventPublisher.publish()`
   - **Payload**: JSON string `< 7500` bytes containing normalized event envelope (`tenantId`, `eventType`, `data`, `timestamp`).
   - **Receiver**: `SseGateway` forwards event to connected HTTP clients matching `tenantId`.

### 8.4 Why External Message Brokers Are Rejected

| Technology | Architectural Evaluation | Verdict |
| :--- | :--- | :--- |
| **Kafka** | Excessive complexity for group management; requires ZooKeeper/KRaft; partition key management across tenants is non-trivial; external operational burden. | **REJECTED** |
| **RabbitMQ** | Introduces an external stateful broker; requires separate clustering and HA; duplicate failure domain. | **REJECTED** |
| **Redis Pub/Sub** | In-memory only; no durability; introduces additional container/dependency without solving any problem that PostgreSQL `LISTEN/NOTIFY` + tables does not already solve. | **REJECTED** |
| **PostgreSQL 18 Native** | Already deployed; single operational boundary; zero added infrastructure; ACID transactional atomicity on all data writes; built-in `LISTEN/NOTIFY` for wake-ups. | **APPROVED & PRESERVED** |

---

## 9. Scalability & Worker Placement Analysis

### 9.1 The Fallacy of Aggressive WebSocket Rebalancing

In distributed systems handling stateless HTTP requests, load rebalancing dynamically shifts requests to the least-utilized node.

**In WhatsApp socket orchestration, dynamic rebalancing of active connections is catastrophic:**
1. A Baileys WhatsApp connection maintains a persistent, encrypted WebSocket connection directly to Meta's servers.
2. Migrating an active connection to another worker requires:
   - Forcibly severing the active TCP connection.
   - Flusing and transferring Noise protocol encryption state.
   - Performing a cryptographic TLS handshake and authentication exchange from a new IP/process.
3. WhatsApp's security infrastructure aggressively flags rapid reconnects and IP flapping as suspicious bot behavior, leading to phone number bans.
4. **Conclusion**: Active WhatsApp WebSockets must **dwell** on their assigned worker for the lifetime of the session.

### 9.2 The "Dwell-and-Drain" Worker Placement Policy

Phase 4G formalizes the **Dwell-and-Drain** placement model:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                      DWELL-AND-DRAIN PLACEMENT POLICY                       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Placement (Dwell):                                                       │
│    • Unassigned connections are claimed by workers during reconciliation.   │
│    • Workers claim connections only up to their configured capacity:        │
│        activeLeases < capacity                                              │
│    • Once acquired, a connection DWELLS on that worker indefinitely as long │
│      as the worker remains healthy and heartbeat renewals succeed.          │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. Eviction (Controlled Drain):                                             │
│    • Sockets are NEVER forcefully moved during normal steady-state operation│
│    • Sockets move ONLY under two conditions:                                │
│      a) Worker Failure: Worker crashes or loses DB lease -> successor claims│
│      b) Planned Maintenance: Operator issues POST .../workers/:id/drain     │
│         -> Worker gracefully drains sockets and marks them available.       │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 9.3 Worker Capacity Characterization

Capacity claims must be classified rigorously:

| Metric | Classification | Target / Status | Architectural Note |
| :--- | :--- | :--- | :--- |
| **Max Sockets per Worker** | `ASSUMPTION` | 50 active sockets | Based on Node.js 4GB heap and ~30–50MB per Baileys instance. |
| **Heartbeat Interval** | `DESIGNED` | 10 seconds | Evaluated by `WorkerLeaseManager`. |
| **Lease TTL (Database)** | `DESIGNED` | 30 seconds | `lease_expires_at = NOW() + INTERVAL '30 seconds'`. |
| **Watchdog Timeout** | `DESIGNED` | 25 seconds | Trips before lease expiration to initiate local teardown. |
| **Reconcile Interval** | `DESIGNED` | 5 seconds | Periodic fallback poll. |
| **Empirical RAM / Socket** | `UNKNOWN` | Pending Benchmark | Must be measured in Phase 4G benchmark test with active group traffic. |

### 9.4 PostgreSQL Contention & Connection Pool Sizing

To prevent database connection exhaustion under multi-node scaling:
* **API Nodes**:
  - Connection Pool Size: `max: 20` per API instance.
  - Usage: Short-lived transactional queries (REST requests).
* **Worker Nodes**:
  - Connection Pool Size: `max: 10` per Worker instance.
  - Dedicated Listener Connection: `1` client strictly reserved for `PostgresNotificationListener`.
  - Usage: Heartbeat updates (batched or lightweight), command claims (`SKIP LOCKED`), and scheduler queries.
* **PostgreSQL Server Max Connections**:
  - Formula: $\text{Total Connections} = (N_{\text{api}} \times 20) + (N_{\text{worker}} \times 11) + 10 \text{ (admin reserve)}$
  - For 2 API nodes + 4 Worker nodes: $(2 \times 20) + (4 \times 11) + 10 = 94$ connections (well within PostgreSQL default `max_connections = 100`).

---

## 10. Operational Telemetry & Observability Architecture

### 10.1 Prometheus `/metrics` Specification

Phase 4G implements a lightweight, zero-dependency Prometheus exposition format (`text/plain; version=0.0.4`) endpoint at:
`GET /metrics`

#### Security Boundary:
* In production, `GET /metrics` is exposed either:
  1. On an internal management port (e.g. `PORT + 1` or `9090`), OR
  2. Guarded by basic auth / internal VPC IP filtering.
* For default RestApp mounting, `GET /metrics` is available publicly or via platform token depending on `METRICS_PROTECTED` env var (defaults to open for standard Prometheus scrape scraping).

### 10.2 Metric Taxonomy (Strictly Low-Cardinality)

All metric labels must be strictly bounded. **Forbidden in labels**: User IDs, Tenant IDs, Phone Numbers, Group JIDs, Message Content.

```text
# ─────────────────────────────────────────────────────────────────────────────
# 1. PROCESS & SYSTEM METRICS
# ─────────────────────────────────────────────────────────────────────────────
# HELP process_cpu_seconds_total Total user and system CPU time spent in seconds.
# TYPE process_cpu_seconds_total counter
process_cpu_seconds_total 12.45

# HELP process_resident_memory_bytes Resident memory size in bytes.
# TYPE process_resident_memory_bytes gauge
process_resident_memory_bytes 142606336

# HELP nodejs_eventloop_lag_seconds Current event loop lag in seconds.
# TYPE nodejs_eventloop_lag_seconds gauge
nodejs_eventloop_lag_seconds 0.0012

# ─────────────────────────────────────────────────────────────────────────────
# 2. HTTP REST METRICS
# ─────────────────────────────────────────────────────────────────────────────
# HELP http_requests_total Total number of HTTP requests processed.
# TYPE http_requests_total counter
http_requests_total{method="GET",route="/api/v1/tenants",status="200"} 412
http_requests_total{method="POST",route="/api/v1/auth/login",status="401"} 18

# HELP http_request_duration_seconds HTTP request latencies in seconds.
# TYPE http_request_duration_seconds histogram
http_request_duration_seconds_bucket{le="0.05"} 380
http_request_duration_seconds_bucket{le="0.1"} 410
http_request_duration_seconds_bucket{le="0.5"} 430
http_request_duration_seconds_bucket{le="+Inf"} 430
http_request_duration_seconds_sum 12.84
http_request_duration_seconds_count 430

# ─────────────────────────────────────────────────────────────────────────────
# 3. WHATSAPP CONNECTION & WORKER METRICS
# ─────────────────────────────────────────────────────────────────────────────
# HELP whatsapp_connections_total Number of connections by actual state.
# TYPE whatsapp_connections_total gauge
whatsapp_connections_total{state="ACTIVE"} 24
whatsapp_connections_total{state="SOCKET_STARTING"} 2
whatsapp_connections_total{state="QR_PENDING"} 1
whatsapp_connections_total{state="SOCKET_STOPPING"} 0
whatsapp_connections_total{state="DISCONNECTED"} 3
whatsapp_connections_total{state="UNASSIGNED"} 5

# HELP worker_active_leases Number of active connection leases held by this worker.
# TYPE worker_active_leases gauge
worker_active_leases 24

# HELP worker_capacity Maximum connection capacity configured for this worker.
# TYPE worker_capacity gauge
worker_capacity 50

# ─────────────────────────────────────────────────────────────────────────────
# 4. DATABASE & QUEUE METRICS
# ─────────────────────────────────────────────────────────────────────────────
# HELP pg_pool_connections Current PostgreSQL pool connection count.
# TYPE pg_pool_connections gauge
pg_pool_connections{state="total"} 10
pg_pool_connections{state="idle"} 8
pg_pool_connections{state="active"} 2

# HELP durable_commands_processed_total Total durable commands executed.
# TYPE durable_commands_processed_total counter
durable_commands_processed_total{command="MUTE_GROUP",status="SUCCESS"} 145
durable_commands_processed_total{command="KICK_PARTICIPANT",status="FAILED"} 2

# HELP scheduled_tasks_processed_total Total scheduled moderation tasks executed.
# TYPE scheduled_tasks_processed_total counter
scheduled_tasks_processed_total{type="UNMUTE_GROUP",status="SUCCESS"} 88
```

---

## 11. API Contract Additions

Phase 4G introduces exactly one read-only endpoint on the REST API:

### `GET /metrics`
* **Protocol**: HTTP/1.1 or HTTP/2
* **Method**: `GET`
* **Path**: `/metrics`
* **Headers**: `Accept: text/plain`
* **Response Status**: `200 OK`
* **Content-Type**: `text/plain; version=0.0.4; charset=utf-8`
* **Response Body**: Standard Prometheus text exposition format (see Section 10.2).
* **Error States**:
  - `500 Internal Server Error` if metrics collector experiences unexpected error.
* **Rate Limiting**: Excluded from default API user rate limiting to prevent scraper drops.

---

## 12. Database Design & Schema Assessment

### 12.1 Schema Assessment
A rigorous forensic audit of migrations `001` through `008` confirms:
> **Zero database schema modifications are required for Phase 4G.**

Existing tables and indexes already support all Phase 4G requirements:
* `workers`: Stores heartbeat, status (`READY`, `DRAINING`, `OFFLINE`), capacity, and active lease count.
* `whatsapp_connections`: Stores `assigned_worker_id`, `lease_epoch`, `lease_expires_at`, `desired_state`, `actual_state`.
* `connection_commands`: Supports `SKIP LOCKED` durable commands.
* `scheduled_moderation_tasks`: Supports Option B `PAUSED` and `PENDING` states.
* `platform_audit_logs`: Immutable audit trail for all operational commands.

### 12.2 Index Verification
The following indexes are already in place and support high-frequency worker queries:
* `idx_whatsapp_connections_reconcile`: Supports `findReconciliationCandidates`.
* `idx_workers_status_heartbeat`: Supports cluster health checks.
* `idx_connection_commands_claim`: Supports command claiming.
* `idx_scheduled_tasks_claim`: Supports scheduler task claiming.

---

## 13. Distributed-System Failure-Mode Matrix

Phase 4G defines deterministic behavior for all distributed failure scenarios:

| Failure Scenario | Exact Point of Failure | System Behavior & Mitigation | Resulting State |
| :--- | :--- | :--- | :--- |
| **Worker Crash A** | Worker dies before claiming a connection | Lease remains unassigned or expires. Other workers pick it up on next reconcile tick (within 5s). | Clean takeover; 0 duplicate sockets. |
| **Worker Crash B** | Worker dies with active Baileys socket | Lease expires after 30s (`lease_expires_at < NOW()`). Successor worker claims lease (`lease_epoch++`). Meta severs prior TCP socket when successor connects. | Single active socket restored in $\le 35\text{s}$. |
| **Worker Crash C** | Worker dies after dispatching remote WhatsApp kick, before DB commit | Task/command remains with `remote_started_at` set. Recovery reconciler detects expired lease and marks `REMOTE_OUTCOME_UNKNOWN`. **Zero blind retries.** | Flagged for operator review; no duplicate kick loops. |
| **API Crash A** | API node crashes before DB transaction commits | PostgreSQL rolls back uncommitted transaction. Client receives connection reset / 502 from proxy. | Zero database side effects. |
| **API Crash B** | API node crashes after commit, before `pg_notify` wake-up | Mutation is persisted in PostgreSQL. Workers detect state change on next periodic reconciliation tick (within 5s). | Eventual consistency guaranteed in $\le 5\text{s}$. |
| **PostgreSQL Outage** | PostgreSQL is temporarily unreachable | 1. API returns 503 on `/health/ready`.<br>2. Worker watchdog detects missing lease renewals and aborts local sockets (`isAborted = true`).<br>3. `PostgresNotificationListener` enters exponential reconnect backoff. | System fails closed safely; resumes automatically upon DB recovery. |
| **Worker Network Partition (Worker $\leftrightarrow$ DB)** | Worker cannot reach PostgreSQL, but can reach WhatsApp | 1. Proactive lease heartbeats fail.<br>2. Watchdog timer trips at 25s.<br>3. Worker executes hard abort on local socket (`socket.ws.close()`).<br>4. At 30s, PostgreSQL lease expires, permitting successor claim. | Split-brain prevented via watchdog barrier. |
| **WhatsApp Network Partition (Worker $\leftrightarrow$ WhatsApp)** | Worker can reach PostgreSQL, but loses WhatsApp connectivity | 1. Baileys emits `connection.update` with `DisconnectReason`.<br>2. If temporary: Baileys attempts internal reconnect under valid lease.<br>3. If permanent/logged out: Worker transitions `actual_state -> DISCONNECTED`. | Database reflects actual state accurately. |
| **Stale Worker Generation** | Zombie worker awakens after long GC pause and attempts to write | SQL predicates check `assigned_worker_id = $workerId AND lease_epoch = $leaseEpoch AND lease_expires_at > NOW()`. Zero rows updated. Worker detects zero-row update and aborts immediately. | Stale write rejected; zero data corruption. |
| **PostgreSQL NOTIFY Dropped** | High cluster traffic causes `pg_notify` buffer drop | `PostgresNotificationListener` misses the signal. Worker and API continue running periodic 5s polling ticks. | Correctness unaffected; latency bounded by 5s. |

---

## 14. Security Threat Model & Mitigations

| Threat | Attack Vector | Architectural Control in Phase 4G |
| :--- | :--- | :--- |
| **Metrics Data Leakage** | Scraping `/metrics` exposes customer phone numbers or message text | Strict low-cardinality enforcement. Zero PII, phone numbers, JIDs, or user IDs permitted in metric labels or values. |
| **Denial of Service via Metrics** | Attacker spams `GET /metrics` to exhaust CPU/memory | Metric generation computes pre-aggregated gauges in memory with constant $O(1)$ allocation; rate-limited or restricted to management network. |
| **Zombie Worker Hijacking** | A drained or unassigned worker attempts to command sockets | SQL write fencing rejects any write where `lease_epoch` does not match the active DB owner. |
| **Unauthorized Process Termination** | Unauthorized user calls shutdown/drain endpoints | Protected by Phase 4F RBAC: `POST .../drain` requires live `SUPER_ADMIN` platform role. |
| **Unbounded Worker Memory Leak** | Baileys message store consumes unbounded heap | Legacy store replaced/isolated; `MAX_MESSAGES` bounded; explicit `socket.ws.close()` prevents WebSocket memory retention. |

---

## 15. Test Strategy & Verification Plan

Phase 4G must be verified through rigorous automated testing:

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│                            PHASE 4G TEST STRATEGY                           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 1. Process Daemon & Entrypoint Unit Tests                                   │
│    • Test bin/api.js startup, port binding, and clean SIGTERM teardown      │
│    • Test bin/worker.js startup, host registration, and clean SIGTERM drain │
│    • Test bin/monolith.js unified lifecycle                                 │
├─────────────────────────────────────────────────────────────────────────────┤
│ 2. PostgresNotificationListener Integration Tests                           │
│    • Test dedicated client connection, LISTEN, NOTIFY reception             │
│    • Test auto-reconnect backoff on simulated PostgreSQL socket drop        │
│    • Test payload delivery to local EventPublisher and CommandGateway       │
├─────────────────────────────────────────────────────────────────────────────┤
│ 3. Prometheus Telemetry & Scrape Contract Tests                             │
│    • Validate GET /metrics response matches Prometheus 0.0.4 text format    │
│    • Verify metric accuracy (connection states, worker leases, DB pool)     │
│    • Verify strict absence of PII or high-cardinality labels in output      │
├─────────────────────────────────────────────────────────────────────────────┤
│ 4. Multi-Process Split-Plane Concurrency Tests                              │
│    • Spawn isolated API process + isolated Worker process in test runner    │
│    • Issue REST command on API node -> verify Worker executes via NOTIFY    │
│    • Verify zero reliance on shared memory between API and Worker           │
├─────────────────────────────────────────────────────────────────────────────┤
│ 5. Full Repository Regression Suite                                         │
│    • All 22 test files and 318 existing tests must continue to pass 100%    │
│    • Serial execution (--test-concurrency=1)                                │
│    • Zero handle leaks; natural exit code 0                                 │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 16. Migration Strategy

Since Phase 4G introduces **zero database schema changes**:
* **Database Migration**: No `up.sql` or `down.sql` migrations are required.
* **Code Migration**:
  - `package.json` scripts updated to provide distinct run targets:
    - `"start:api"`: `node bin/api.js`
    - `"start:worker"`: `node bin/worker.js`
    - `"start:monolith"`: `node bin/monolith.js`
    - `"start"`: Defaults to `bin/monolith.js` for seamless backward compatibility.
  - Legacy `index.js` deprecated in favor of `bin/monolith.js`.

---

## 17. Rollout / Rollback Strategy

1. **Rollout Sequence**:
   - Step 1: Deploy code containing Phase 4G entrypoints and `PostgresNotificationListener`.
   - Step 2: In staging, verify `bin/api.js` and `bin/worker.js` run as independent processes.
   - Step 3: Verify Prometheus scraper can successfully pull from `GET /metrics`.
   - Step 4: Promote to production in split-plane topology.
2. **Rollback Sequence**:
   - If an issue is encountered, revert `package.json` to point `"start"` back to previous runner.
   - Because no database schema migrations occurred, rollback requires zero database downtime.

---

## 18. Definition of Done

Phase 4G implementation will be considered complete ONLY when:
* [ ] `bin/api.js` boots the REST API server and handles `SIGTERM` gracefully.
* [ ] `bin/worker.js` boots the worker node, executes heartbeats, and drains gracefully on `SIGTERM`.
* [ ] `bin/monolith.js` boots both services for single-node operation.
* [ ] `PostgresNotificationListener` is implemented, tested with simulated drops, and actively delivers cross-process signals.
* [ ] `GET /metrics` produces valid Prometheus text format telemetry with zero PII.
* [ ] Dedicated Phase 4G test suite passes 100%.
* [ ] Full regression suite (318+ tests) passes with natural exit code 0.

---

## 19. Known UNKNOWNs & Capacity Assumptions

1. **Empirical Socket Memory Footprint** (`UNKNOWN`):
   - The assumption that 1 worker can handle 50 active Baileys sockets within 4GB RAM is plausible but unverified under realistic group message throughput.
   - Resolution: Phase 4G benchmark tests will empirically profile heap growth under sustained load.
2. **Physical Socket Teardown Post-Crash** (`UNKNOWN`):
   - TCP liveness cannot be guaranteed if the host abruptly dies.
   - Resolution: Architectural reliance on the 30-second database lease expiry and successor `lease_epoch` fencing guarantees logical single-ownership regardless of physical socket state.

---

## 20. Final Architecture Gate

### Gate Verification Checklist:
1. Executive Purpose established? **YES**
2. Forensic Baseline verified? **YES**
3. Gap Analysis completed? **YES**
4. Scope strictly bounded to process topology, cross-node transport & metrics? **YES**
5. Non-goals strictly defined (no external brokers, no schema changes)? **YES**
6. Distributed-system failure modes analyzed? **YES**
7. Telemetry privacy and low-cardinality enforced? **YES**
8. Zero violations of frozen invariants from Phase 2–4F? **YES**

> **`PHASE 4G ARCHITECTURE VERIFIED — READY FOR IMPLEMENTATION PLANNING`**
