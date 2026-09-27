# Phase 4F P0 Distributed-Security Hardening

## 1. Executive Summary & Hardening Scope

This document details the architectural, distributed-systems, and security hardening implemented in Windowseven MD prior to commencing Phase 4F (Platform Administration & Operations). All P0 distributed-systems and command execution risks have been addressed and verified with deterministic regression tests.

---

## 2. Exhaustive Worker-Write Fencing Inventory

PostgreSQL serves as the single source of authoritative truth for connection ownership and cluster state. A worker node is authorized to mutate connection-owned resources *only* while its lease `(assigned_worker_id, lease_epoch, lease_expires_at)` remains active and valid in the database.

Every production write path that affects connection state, discovered groups, auth keys, credentials, commands, or scheduled tasks enforces SQL-level fence predicates:

| Subsystem | File & Repository Method | SQL Fence Predicate | Failure Behavior on Fence Trip |
| :--- | :--- | :--- | :--- |
| **Group Discovery** | `GroupRepository.upsertDiscoveredGroupForWorker` | `EXISTS (SELECT 1 FROM whatsapp_connections WHERE id = $connId AND assigned_worker_id = $workerId AND lease_epoch = $leaseEpoch AND lease_expires_at > NOW())` | Query returns `null`; mutation aborted; worker stops processing group. |
| **Group Status** | `GroupRepository.updateStatusForWorker` | `EXISTS (SELECT 1 FROM whatsapp_connections WHERE id = $connId AND assigned_worker_id = $workerId AND lease_epoch = $leaseEpoch AND lease_expires_at > NOW())` | Query returns `null`; 0 rows affected. |
| **Baileys Credentials** | `WhatsAppAuthCredentialsRepository.upsertCredentials` | `EXISTS (SELECT 1 FROM whatsapp_connections WHERE id = $connId AND assigned_worker_id = $workerId AND lease_epoch = $leaseEpoch AND lease_expires_at > NOW())` | Returns `null`; auth state write rejected; preventing split-brain session corruption. |
| **Baileys Signal Keys** | `WhatsAppAuthKeysRepository.setKeys` | `EXISTS (SELECT 1 FROM whatsapp_connections WHERE id = $connId AND assigned_worker_id = $workerId AND lease_epoch = $leaseEpoch AND lease_expires_at > NOW())` | Returns `false`; Signal pre-key mutations rejected. |
| **Durable Commands** | `ConnectionCommandRepository.completeCommand` / `failCommand` / `requeueStaleCommand` | `claimed_by_worker_id = $workerId AND claim_epoch = $claimEpoch AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $workerId AND c.lease_epoch = $claimEpoch AND c.lease_expires_at > NOW())` | 0 rows affected; returns `false`; stale generation cannot alter command state. |
| **Scheduled Moderation Tasks** | `ScheduledModerationTaskRepository.completeTask` / `failTask` / `cancelTask` / `requeueStaleTask` | `claimed_by_worker_id = $workerId AND claim_epoch = $claimEpoch AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $workerId AND c.lease_epoch = $claimEpoch AND c.lease_expires_at > NOW())` | 0 rows affected; returns `false`; prevents stale worker from executing or completing scheduled unmuting. |

---

## 3. Worker Drain State Machine & Race Safety

Worker lifecycle follows a strictly ordered, idempotent state transition:

```text
       ┌──────────┐
       │  READY   │
       └────┬─────┘
            │ workerNode.drain({ graceMs })
            ▼
       ┌──────────┐
       │ DRAINING │  ◄── Immediate lease renewal stop; reconcile timer cleared; scheduler stopped
       └────┬─────┘
            │ Wait for inFlight.size === 0 (or graceMs expires)
            │ If grace expires: mark in-flight remote_started_at -> REMOTE_OUTCOME_UNKNOWN
            │ Set actual_state = 'SOCKET_STOPPING'
            │ Disconnect local socket & release DB leases
            ▼
       ┌──────────┐
       │ OFFLINE  │
       └──────────┘
```

### Invariants:
1. **Idempotency**: `workerNode.drain()` caches and returns a memoized promise instance (`this._drainPromise`). Concurrent calls await the same teardown flow.
2. **Immediate Stop of Lease Renewals**: `this.leaseManager.stop()` is invoked at the very start of draining. Leases are not renewed during drain.
3. **No New Claims**: `reconcileTimer` is cleared, `this.scheduler.stop()` is called, and `reconcile()` short-circuits when status is `DRAINING`.
4. **Bounded Drain Grace**: In-flight executions are permitted up to `drainGraceMs` (default 10,000ms) to complete normally. If the grace period expires, any command or task with `remote_started_at` is marked `REMOTE_OUTCOME_UNKNOWN` with error `DRAIN_GRACE_EXPIRED`.
5. **Exact-One-Socket Barrier**: Before releasing leases in PostgreSQL, the worker sets `actual_state = 'SOCKET_STOPPING'`. `findReconciliationCandidates` strictly excludes `SOCKET_STOPPING` from acquisition by any other worker until teardown completes.

---

## 4. Remote-Outcome Crash/Restart Semantics (`REMOTE_OUTCOME_UNKNOWN`)

When a mutation request crosses the network boundary to WhatsApp (e.g. `groupSettingUpdate` or `groupParticipantsUpdate`), the outcome may have occurred remotely even if the worker crashes or times out before receiving confirmation.

1. **Explicit Modeling**: Column `remote_started_at TIMESTAMPTZ` records the timestamp immediately prior to invoking the gateway.
2. **Crash Transition**: If execution fails after `remote_started_at`, the record is marked `REMOTE_OUTCOME_UNKNOWN` instead of `FAILED`.
3. **No Blind Retries**:
   - `connection_commands`: `claimCommandForConnection` selects only `status = 'PENDING'`. `REMOTE_OUTCOME_UNKNOWN` commands are never re-claimed by replacement workers.
   - `scheduled_moderation_tasks`: `claimNextTask` selects only `status = 'PENDING'`. `REMOTE_OUTCOME_UNKNOWN` tasks are never re-claimed by replacement workers.
   - **KICK**: Never retried automatically, avoiding duplicate expulsion attempts.
   - **MUTE / UNMUTE**: Exposed to tenant operators and administrators for reconciliation rather than assumed idempotent.

---

## 5. Shell-Boundary Security Audit & Remediation

All 11 occurrences of `child_process` across the codebase were audited. Shell string execution (`child_process.exec`) was completely eliminated in favor of argument arrays (`execFile` / `spawn`):

| File | Prior Implementation | Hardened Implementation | Status |
| :--- | :--- | :--- | :--- |
| `commands/anime.js` | `child_process.exec(ffmpegCmd)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `commands/attp.js` | `child_process.spawn('ffmpeg', args)` | Preserved argument-array `spawn` | **VERIFIED SECURE** |
| `commands/emojimix.js` | `child_process.exec(ffmpegCommand)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `commands/igs.js` | 4 calls to `child_process.exec(cmd)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `commands/sticker.js` | 3 calls to `child_process.exec(cmd)` + duplicate fallback | `child_process.execFile('ffmpeg', args)` + duplicate removed | **REMEDIATED** |
| `commands/sticker-alt.js` | `child_process.exec(cmd)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `commands/stickercrop.js` | 2 calls to `child_process.exec(cmd)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `commands/stickertelegram.js` | `child_process.exec(ffmpegCommand)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `lib/converter.js` | `child_process.spawn('ffmpeg', args)` | Preserved argument-array `spawn` | **VERIFIED SECURE** |
| `lib/myfunc2.js` | `child_process.exec(cmd)` | `child_process.execFile('ffmpeg', args)` | **REMEDIATED** |
| `lib/sticker.js` | Unused `exec` and `execAsync` imports | Unused imports removed | **REMEDIATED** |

**Zero** production command code paths invoke `/bin/sh` or evaluate arbitrary command strings.

---

## 6. Multi-Tenant Scheduled-Task Isolation & Suspension Policy (Option B)

### Isolation:
- Composite foreign keys enforce that a scheduled task's `tenant_id`, `connection_id`, and `group_id` must match a valid `groups` entity. Mismatched tenant IDs fail at the database level.
- Cross-tenant status queries, task creation, and cancellations are rejected with zero affected rows.
- Unmanaging a group under Tenant A only cancels Tenant A's tasks, leaving other tenants' tasks untouched.

### Suspension Policy (Option B — Pause & Resume):
- Migration `007_worker_fencing_and_remote_outcomes.up.sql` includes `'PAUSED'` in `scheduled_moderation_tasks_status_check`.
- `ScheduledModerationTaskRepository.pauseTasksForTenant(client, tenantId)` transitions all `PENDING` tasks for a tenant to `PAUSED`.
- `claimNextTask` queries only `status = 'PENDING'`, automatically skipping all `PAUSED` tasks even when `run_at <= NOW()`.
- Pre-gateway check in `DurableModerationScheduler.processTask` verifies `fresh.status !== 'PAUSED'`, aborting processing if paused after claim.
- `ScheduledModerationTaskRepository.resumeTasksForTenant(client, tenantId)` transitions `PAUSED` tasks back to `PENDING` and resets `next_attempt_at = NOW()` for immediate evaluation.

---

## 7. Authoritative Ownership vs Physical Socket Liveness

The Windowseven MD architecture distinguishes between database ownership, generation fencing, runtime teardown, and physical socket liveness:

| Dimension | Architectural Layer | Classification | Guarantee / Semantic |
| :--- | :--- | :--- | :--- |
| **Authoritative Generation Ownership** | PostgreSQL `whatsapp_connections` row (`assigned_worker_id`, `lease_epoch`, `lease_expires_at`) | `VERIFIED` | At most one worker node holds an active lease for any given connection at any instant in time. |
| **Stale-Generation Database Fencing** | SQL mutation predicates (`WHERE assigned_worker_id = $workerId AND lease_epoch = $claimEpoch AND lease_expires_at > NOW()`) | `VERIFIED` | Prior worker generations cannot mutate connection state, auth credentials, Signal keys, commands, or scheduled tasks after a lease epoch change. |
| **Runtime Teardown Initiation** | `WorkerNode.drain()` and `ConnectionManager.disconnectConnection()` | `VERIFIED` | An active worker gracefully shuts down sockets via `socket.end()`, `socket.ws.close()`, and unregisters them from local memory upon drain or force disconnect. |
| **Exact-One-Socket Acquisition Barrier** | `WhatsAppConnectionRepository.findReconciliationCandidates` | `VERIFIED` | Connections in `actual_state = 'SOCKET_STOPPING'` are strictly excluded from reconciliation candidate queries. Successor workers cannot acquire a connection while teardown is in progress. |
| **Physical Socket Liveness After Failure** | Operating System / TCP / WhatsApp Infrastructure | `UNKNOWN` / `NOT GUARANTEED` | In the event of catastrophic failure (SIGKILL, power failure, host crash, kernel panic), software cannot prove physical TCP/WebSocket connection termination. authoritativeness relies on lease expiration and fencing barriers. |

---

## 8. Complete Worker-Write Inventory Repository-Wide

Every mutating database operation originating from a background worker process has been inspected:

1. **`whatsapp_connections`**:
   - `acquireLease`: Requires unassigned or expired lease or same worker; updates `assigned_worker_id`, `lease_expires_at`, increments `lease_epoch`.
   - `renewLease`: Fenced by `assigned_worker_id = $workerId` and `lease_epoch = $leaseEpoch`. If 0 rows updated, renewal fails and worker stops managing connection.
   - `releaseLease`: Fenced by `assigned_worker_id = $workerId` and `lease_epoch = $leaseEpoch`.
   - `updateHeartbeat`: Fenced by `assigned_worker_id = $workerId` and `lease_epoch = $leaseEpoch`.
   - `updateActualState`: Fenced by `assigned_worker_id = $workerId` and `lease_epoch = $leaseEpoch`.
2. **`groups`**:
   - `upsertDiscoveredGroupForWorker`: Fenced by active lease on `whatsapp_connections`.
   - `updateStatusForWorker`: Fenced by active lease on `whatsapp_connections`.
3. **`group_participants`**:
   - `syncParticipants`: Executed within `GroupSynchronizer` while holding active connection lease.
4. **Baileys Auth State**:
   - `WhatsAppAuthCredentialsRepository.upsertCredentials`: Fenced by active lease on `whatsapp_connections`.
   - `WhatsAppAuthKeysRepository.setKeys`: Fenced by active lease on `whatsapp_connections`.
5. **`connection_commands`**:
   - `claimCommandForConnection`: Fenced via `SELECT FOR UPDATE SKIP LOCKED` and verifies `c.assigned_worker_id = $workerId AND c.lease_epoch = $claimEpoch`.
   - `completeCommand`, `failCommand`, `requeueStaleCommand`, `markRemoteOutcomeUnknown`: All fenced by `claimed_by_worker_id = $workerId AND claim_epoch = $claimEpoch AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = ... AND c.assigned_worker_id = $workerId AND c.lease_epoch = $claimEpoch AND c.lease_expires_at > NOW())`.
6. **`scheduled_moderation_tasks`**:
   - `claimNextTask`: Fenced via `SELECT FOR UPDATE SKIP LOCKED` on active connections with matching lease epoch.
   - `completeTask`, `failTask`, `cancelTask`, `requeueStaleTask`, `markRemoteOutcomeUnknown`: All fenced by worker ID, claim epoch, and active lease check on `whatsapp_connections`.
7. **`audit_logs` & `events`**:
   - Append-only audit and event logging. Worker operations record audit events upon status transitions.

---

## 9. API Idempotency Contract & UNMUTE Alignment

1. **Storage Constraint**:
   - `uq_api_idempotency_tenant_user_key`: Enforces `UNIQUE (tenant_id, user_id, idempotency_key)`.
2. **Reservation Protocol**:
   - Requests with an `Idempotency-Key` header atomically insert into `api_idempotency_keys` with `status = 'PENDING'`.
   - If a duplicate key arrives:
     - Different payload or route: `422 IDEMPOTENCY_KEY_MISMATCH`.
     - Concurrent request while `PENDING`: `409 IDEMPOTENCY_CONFLICT`.
     - Completed previous request: `202 Accepted` with cached response payload and header `X-Cache: IDEMPOTENT-REPLAY`.
3. **UNMUTE Alignment**:
   - `POST /api/v1/tenants/:tenantId/groups/:groupId/moderation/unmute` is fully aligned with the idempotency reservation protocol.
   - Initial call creates 1 command; replay returns the identical cached response; concurrent calls yield exactly 1 durable command; mismatched payload returns 422.

---

## 10. Residual Risks & Operational Boundaries

1. **Host / Machine Death**: If a worker node crashes ungracefully (kernel panic, power loss), the local process cannot run teardown hooks. The physical Baileys TCP socket remains in whatever state the network stack leaves it until WhatsApp drops the connection or the lease expires. Authoritative state is guarded by PostgreSQL fencing; physical socket termination is unprovable.
2. **Upstream WhatsApp Protocol Disconnects**: Disconnects originating from WhatsApp's servers are handled via `ConnectionManager`. If a disconnect occurs mid-operation, `REMOTE_OUTCOME_UNKNOWN` prevents unsafe automated retry loops.
3. **Destructive Operations Retry Rule**: Operations in `REMOTE_OUTCOME_UNKNOWN` are classified as `NOT_SAFE_TO_AUTOMATICALLY_RETRY` (e.g. `KICK_PARTICIPANT`) and `CONDITIONALLY_RETRYABLE` (e.g. `MUTE_GROUP`, `UNMUTE_GROUP` subject to manual operator verification). Automated systems never blindly re-execute unknown outcomes.
