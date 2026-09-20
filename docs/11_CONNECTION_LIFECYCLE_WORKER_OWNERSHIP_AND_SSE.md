# WINDOWSEVEN MD — WHATSAPP CONNECTION LIFECYCLE, WORKER OWNERSHIP & SSE

**Phase:** 4D — WhatsApp Connection Lifecycle APIs + Worker Ownership Protocol + SSE  
**Document:** `docs/11_CONNECTION_LIFECYCLE_WORKER_OWNERSHIP_AND_SSE.md`  
**Status:** IMPLEMENTED & VERIFIED  
**Baseline:** Phase 4C REST Core & Tenant Authorization Boundary  

---

## 1. Executive Summary

Phase 4D bridges the multi-tenant REST API with the Baileys WhatsApp runtime (`ConnectionManager`), establishing a distributed-systems worker ownership model with generation-fenced leases, desired-vs-actual state reconciliation, secure QR code streaming, Server-Sent Events (SSE) with strict tenant isolation, and durable state persistence in PostgreSQL 18.

### Key Invariants Enforced:
1. **Single-Active-Socket Invariant**: Exactly one active WhatsApp socket may own a connection at any given time across the entire distributed cluster, protected by monotonic `lease_epoch` fencing and PostgreSQL row-level locks.
2. **Hard Reconnect Cancellation**: When a connection is aborted due to lease loss or watchdog trip, all reconnect timers and retry loops are cancelled immediately (`conn.isAborted = true`), preventing stale generations from resurrecting.
3. **Decoupled Control Plane & Ephemeral Wake-up**: REST commands update desired state in PostgreSQL and emit ephemeral wake-up signals (via EventEmitter or PostgreSQL `LISTEN/NOTIFY`). Workers recover and converge state directly from PostgreSQL, guaranteeing correctness even if signals are dropped.
4. **Zero Persistent Raw QR Storage**: QR payloads are treated strictly as sensitive ephemeral authentication material. They are held in memory with a 60-second TTL in `EphemeralQrStore` and streamed via SSE/REST. Raw QR payloads are **never persisted to disk and never logged**.
5. **Multi-Node SSE Event Distribution**: Server-Sent Events streams are tenant-isolated, support multi-node pub/sub via `IEventPublisher`, maintain 15-second keepalive pings (`:keepalive\n\n`), apply per-process client safeguards, and handle socket backpressure cleanly.

---

## 2. Architecture & System Flow

```text
Customer / Dashboard
        ↓ (HTTPS)
 [REST API Layer] ──> Tenant RBAC (OWNER / ADMIN / MEMBER)
        ↓
 [ConnectionService]
   ├─ 1. Mutates desired_state in PostgreSQL ('RUNNING' or 'STOPPED')
   ├─ 2. Emits audit log (e.g. 'CONNECTION_START_REQUESTED')
   └─ 3. Dispatches wake-up signal to ConnectionCommandGateway
        ↓
 [Worker Control Plane]
        ↓ (Signal: START_CONNECTION)
 [WorkerNode]
   ├─ 1. Receives signal or periodic reconciliation tick
   ├─ 2. Queries PostgreSQL for authoritative connection state
   ├─ 3. Executes atomic lease acquisition:
   │      UPDATE whatsapp_connections
   │      SET assigned_worker_id = $workerId, lease_epoch = lease_epoch + 1 ...
   │      WHERE id = $id AND (assigned_worker_id IS NULL OR lease_expires_at < NOW())
   │      RETURNING lease_epoch;
   ├─ 4. Registers lease in WorkerLeaseManager (Heartbeats: 10s, Watchdog: 25s)
   ├─ 5. Transitions actual_state -> 'SOCKET_STARTING'
   └─ 6. Calls ConnectionManager.createConnection() [SOLE makeWASocket FACTORY]
              ↓
        [Baileys Socket]
              ↓
        [EventAdapter] (Normalized Application Events)
              ├─ On QR: EphemeralQrStore (60s in-memory TTL) ──> EventPublisher ──> SSE Gateway
              ├─ On Connect: actual_state -> 'ACTIVE' ──────────> EventPublisher ──> SSE Gateway
              └─ Outbound ops: Fenced with current lease_epoch
```

---

## 3. Desired State vs Actual State Machine

Windowseven MD strictly distinguishes between customer/system intent (`desired_state`) and runtime reality (`actual_state`):

```text
desired_state:
  - STOPPED (Default initial state)
  - RUNNING (Explicitly requested by authorized customer/admin)
```

### Actual Lifecycle State Transitions:

```text
                   ┌───────────────┐
                   │  UNASSIGNED   │◄─────────────────────────────┐
                   └───────┬───────┘                              │
                           │ Worker acquires lease (epoch++)      │
                           ▼                                      │
                   ┌───────────────┐                              │
                   │LEASE_ACQUIRED │                              │
                   └───────┬───────┘                              │
                           │ Socket initialization                │ Graceful Release /
                           ▼                                      │ Clean Shutdown
                   ┌───────────────┐                              │
                   │SOCKET_STARTING│                              │
                   └───────┬───────┘                              │
               ┌───────────┴───────────┐                          │
               ▼                       ▼                          │
       ┌───────────────┐       ┌───────────────┐                  │
       │  QR_PENDING   │       │AUTHENTICATING │                  │
       └───────┬───────┘       └───────┬───────┘                  │
               │ Handshake OK          │ Connection open          │
               └───────────┬───────────┘                          │
                           ▼                                      │
                   ┌───────────────┐                              │
                   │    ACTIVE     │                              │
                   └───────┬───────┘                              │
                           │ Heartbeat fails / Watchdog trips /   │
                           │ Stop requested                       │
                           ▼                                      │
                   ┌───────────────┐                              │
                   │SOCKET_STOPPING│                              │
                   └───────┬───────┘                              │
                           │ Socket terminated, lease released    │
                           └──────────────────────────────────────┘
```

Failure paths transition to `FAILED` or `DISCONNECTED` and are picked up by the worker reconciliation loop if `desired_state = 'RUNNING'`.

---

## 4. Worker Ownership, Heartbeat & Generation Fencing

### 4.1 Monotonic `lease_epoch`
Every time a connection is assigned to a worker or reassigned after expiry, `lease_epoch` increments atomically by 1.
The worker caches its assigned `lease_epoch`. Every subsequent database mutation (`updateActualState`, `renewLease`, etc.) binds:
```sql
WHERE id = $connectionId
  AND assigned_worker_id = $workerId
  AND lease_epoch = $expectedEpoch
```
If another worker has claimed the lease, `lease_epoch` has advanced, matching 0 rows and immediately rejecting the stale mutation.

### 4.2 Proactive Heartbeat vs Local Watchdog Failsafe
- **Heartbeat Interval**: 10 seconds.
- **Lease Duration**: 30 seconds (`NOW() + INTERVAL '30 seconds'`).
- **Local Watchdog**: 25 seconds (`WATCHDOG_TIMEOUT_MS = 25000`).

If a worker is partitioned, freezes, or experiences an OS pause:
1. At 25 seconds without a successful renewal, the local watchdog trips unconditionally.
2. The watchdog calls `ConnectionManager.abortConnection(connectionId, 'LEASE_WATCHDOG_TRIPPED')`.
3. The socket is terminated (`.ws.terminate()`), reconnect timers are cancelled, and listeners are stripped.
4. The remaining 5-second grace period guarantees the old worker has completely self-terminated before PostgreSQL observes lease expiration at 30 seconds.

---

## 5. Ephemeral QR Code Security & Zero Persistence

Per architecture requirements:
1. **Zero Database Persistence**: Migration `005` does NOT add raw QR columns to `whatsapp_connections`.
2. **Ephemeral In-Memory Cache**: `EphemeralQrStore` caches QR strings with an automatic 60-second timer (`setTimeout` with `.unref()`).
3. **Automatic Cleanup**: Upon successful WhatsApp connection or disconnection, the QR payload is deleted immediately.
4. **Anti-Enumeration Guard**: `GET /api/v1/tenants/:tenantId/connections/:connId/qr` verifies tenant ownership. Foreign connection lookups return `404 RESOURCE_NOT_FOUND`. Missing or expired QRs return `404 QR_NOT_AVAILABLE`.
5. **Zero Log Leakage**: Raw QR payloads are strictly omitted from application logs and audit trail metadata.

---

## 6. Server-Sent Events (SSE) Realtime Gateway

- **Endpoint**: `GET /api/v1/tenants/:tenantId/events`
- **Transport**: `text/event-stream` with chunked transfer.
- **Authentication & RBAC**: JWT Bearer token required; caller must possess `OWNER`, `ADMIN`, or `MEMBER` role for `:tenantId`.
- **Tenant Scoping**: Clients strictly receive events matching their authorized `tenantId`. Cross-tenant events are excluded.
- **Keep-Alive**: Pings `:keepalive\n\n` every 15 seconds.
- **Backpressure & Clean Teardown**: Checks `res.write()` return status; attaches `drain` listeners when client buffers fill; unregisters on `req.on('close')`.
- **Resource Safeguard**: Maximum 50 concurrent SSE clients per tenant on a single API process node (`MAX_SSE_CLIENTS_PER_TENANT`).

---

## 7. REST API & RBAC Permission Matrix

| Method | Endpoint | Allowed Roles | Description | Success Status |
| :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/tenants/:tenantId/connections` | `OWNER`, `ADMIN` | Create connection in `STOPPED` / `UNASSIGNED` state | `201 Created` |
| `GET` | `/api/v1/tenants/:tenantId/connections` | `OWNER`, `ADMIN`, `MEMBER` | List connections for tenant | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/connections/:connId` | `OWNER`, `ADMIN`, `MEMBER` | Get connection status and QR availability flag | `200 OK` |
| `POST` | `/api/v1/tenants/:tenantId/connections/:connId/connect` | `OWNER`, `ADMIN` | Set `desired_state = RUNNING`, wake up worker | `200 OK` |
| `POST` | `/api/v1/tenants/:tenantId/connections/:connId/disconnect` | `OWNER`, `ADMIN` | Set `desired_state = STOPPED`, stop socket | `200 OK` |
| `POST` | `/api/v1/tenants/:tenantId/connections/:connId/reconnect` | `OWNER`, `ADMIN` | Trigger operational restart (keeps `RUNNING`) | `200 OK` |
| `DELETE` | `/api/v1/tenants/:tenantId/connections/:connId` | `OWNER` only | Stops socket, deletes keys/credentials/row, logs audit | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/connections/:connId/qr` | `OWNER`, `ADMIN` | Fetch ephemeral QR payload and expiration | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/events` | `OWNER`, `ADMIN`, `MEMBER` | Realtime SSE event stream for tenant | `200 OK (Stream)` |

---

## 8. Database Migrations (005)

### Migration `005_connection_lifecycle_and_worker_ownership.up.sql`:
1. **Enhanced `whatsapp_connections`**:
   - `desired_state VARCHAR(50) NOT NULL DEFAULT 'STOPPED' CHECK (desired_state IN ('STOPPED', 'RUNNING'))`
   - `actual_state VARCHAR(50) NOT NULL DEFAULT 'UNASSIGNED' CHECK (actual_state IN ('UNASSIGNED', 'LEASE_ACQUIRED', 'SOCKET_STARTING', 'QR_PENDING', 'AUTHENTICATING', 'ACTIVE', 'SOCKET_STOPPING', 'DISCONNECTED', 'FAILED'))`
   - `assigned_worker_id VARCHAR(100)`
   - `lease_epoch BIGINT NOT NULL DEFAULT 1`
   - `lease_expires_at TIMESTAMPTZ`
   - `last_status_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `last_error_code VARCHAR(100)`
   - `last_error_at TIMESTAMPTZ`
   - Added indexes: `idx_whatsapp_connections_lease`, `idx_whatsapp_connections_reconciliation`, `idx_whatsapp_connections_tenant_lifecycle`.
2. **`workers` Table**:
   - `id VARCHAR(100) PRIMARY KEY`
   - `hostname VARCHAR(255)`
   - `status VARCHAR(50) NOT NULL DEFAULT 'STARTING' CHECK (status IN ('STARTING', 'READY', 'DRAINING', 'STOPPING', 'OFFLINE'))`
   - `last_heartbeat_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`
   - `capacity INT NOT NULL DEFAULT 50` (Scheduling hint, NOT a platform ceiling)
   - `active_connections INT NOT NULL DEFAULT 0`
   - `metadata JSONB NOT NULL DEFAULT '{}'::jsonb`

---

## 9. Sizing Model & Capacity Classification Standard

| Classification | Meaning | Items |
| :--- | :--- | :--- |
| **MEASURED** | Empirically verified under load tests | 24 focused Phase 4D tests passing (2.0s); 207 total suite tests passing (38.5s); PostgreSQL row locking latency ~25ms |
| **ARCHITECTURE TARGET** | Engineering goal for horizontal split plane | 100–250 concurrent connections per worker node; 500–1,000 cluster connections |
| **SCHEDULING HINT** | Operational recommendation per worker process | `workers.capacity = 50` (Used for worker load distribution, never rejects connections) |
| **SAFEGUARD BOUND** | Per-process memory protection limit | `MAX_SSE_CLIENTS_PER_TENANT = 50` per API node; 100KB HTTP body payload limit |
| **UNKNOWN** | Requires dedicated soak and load testing | Maximum Baileys socket memory retention over 30 days; Signal session ratchet degradation under high churn |
| **KNOWN LIMITATION** | Architectural constraint documented for future phases | In-memory ephemeral timers (`setTimeout`) do not survive process restarts; persistent cron/queue scheduled for future phases |

---

## 10. Audit Logging Security Verification

All critical lifecycle events are durably recorded in `audit_logs`:
- `CONNECTION_CREATED`
- `CONNECTION_START_REQUESTED`
- `CONNECTION_STOP_REQUESTED`
- `CONNECTION_RECONNECT_REQUESTED`
- `CONNECTION_DELETED`
- `WORKER_LEASE_ACQUIRED`
- `WORKER_LEASE_LOST`
- `STALE_GENERATION_REJECTED`
- `TENANT_ACCESS_DENIED`

Sensitive authentication credentials, Signal pre-keys, and raw QR payloads are **strictly excluded** from all audit log records.
