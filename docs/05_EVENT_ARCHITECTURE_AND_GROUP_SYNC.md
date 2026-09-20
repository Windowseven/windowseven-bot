# Phase 3C: EventAdapter, Execution Context & Group Synchronization

This document details the design, architecture, normalized event model, execution context, and group synchronization engine implemented in **Phase 3C** of the **Windowseven MD** multi-tenant SaaS platform.

---

## 1. Architectural Overview & Event Flow

Prior to Phase 3C, Baileys socket events were bound haphazardly to `main.js`, and `lib/lightweight_store.js` listened directly to raw socket event emitters.

In Phase 3C, **`EventAdapter`** is introduced as the **single authoritative boundary** between the raw Baileys WhatsApp transport and internal application logic.

```text
Baileys WhatsApp Transport (Raw Socket)
   │
   ├── Raw Baileys Events ('messages.upsert', 'group-participants.update', etc.)
   │
   ▼
EventAdapter (Sole Raw Event Listener)
   │
   ├── Defensive Extraction & Normalization
   ├── Immutably bound to ExecutionContext (tenantId, connectionId, sock, db)
   │
   ├── Normalized Event Emission:
   │     ├── message.received
   │     ├── group.participants.changed
   │     ├── group.discovered
   │     ├── group.updated
   │     ├── connection.status.changed
   │     ├── message.reaction
   │     ├── call.received
   │     ├── contacts.updated
   │     └── chats.set
   │
   ├──► GroupSynchronizer (Background Group Lifecycle Engine)
   │       ├── Initial discovery sweep: groupFetchAllParticipating()
   │       ├── Idempotent PostgreSQL upsert (Preserves MANAGED status)
   │       ├── Bot removal detection (Transitions to UNMANAGED)
   │       └── Strict Failure Isolation (errors never drop the socket)
   │
   └──► LegacyBridge (Transitional Compatibility Layer)
           ├── Normalizes events for legacy main.js (handleMessages, handleGroupParticipantUpdate)
           └── Updates lightweight_store without raw socket event binding
```

---

## 2. Invariants & Guardrails Established in Phase 3C

1. **Sole Socket Event Listener**: `EventAdapter` is the only component listening to Baileys socket data events (`messages.upsert`, `group-participants.update`, `groups.upsert`, `groups.update`, etc.). No application logic, store, or command handler calls `sock.ev.on(...)`.
2. **ExecutionContext Immutability**: All downstream event handlers receive an immutable `ExecutionContext` containing `tenantId`, `connectionId`, `sock`, and `db`.
3. **Restricted `sock` Scope**: `ctx.sock` is provided strictly as a transitional infrastructure transport capability for the adapter and bridge. Business logic and core services MUST NOT depend on raw socket primitives or invoke `ctx.sock.sendMessage()` directly.
4. **Preservation of Managed State**: Once a group is marked `MANAGED` by a tenant, subsequent background discovery sweeps will **never** downgrade it to `DISCOVERED`.
5. **Accurate Bot Removal Detection**: A group is transitioned to `UNMANAGED` if and only if the participant removed matches the bot's own WhatsApp identity (`jidNormalizedUser(botJid) === jidNormalizedUser(removedJid)`). Removing ordinary group members does not alter group management state.
6. **Failure Isolation**: Group synchronization runs in the background. Network timeouts or database errors during discovery or participant updates are safely caught, logged, and isolated—they never terminate the WhatsApp socket or trigger disconnect loops.

---

## 3. Normalized Event Vocabulary

Every normalized event emitted by `EventAdapter` contains an immutable `ctx` reference (`ExecutionContext`) and a structured payload:

| Normalized Event Name | Originating Raw Baileys Event | Payload Structure | Description |
| :--- | :--- | :--- | :--- |
| `message.received` | `messages.upsert` | `{ ctx, message: { id, remoteJid, sender, isGroup, text, messageType, timestamp, fromMe }, raw }` | Cleanly parsed incoming/outgoing message with normalized text extraction across plain, extended, media caption, and ephemeral formats. |
| `group.participants.changed` | `group-participants.update` | `{ ctx, groupJid, action: 'add'\|'remove'\|'promote'\|'demote'\|'unknown', participants: [string], author, raw }` | Group membership modifications with normalized actions. |
| `group.discovered` | `groups.upsert` | `{ ctx, group: { id, name, description, owner, creationTime, participantCount, raw } }` | New group discovered via real-time update. |
| `group.updated` | `groups.update` | `{ ctx, update: { id, name, description, raw } }` | Metadata updates (subject, description, settings) for an existing group. |
| `connection.status.changed` | `connection.update` | `{ ctx, status: 'connecting'\|'open'\|'closed'\|'unknown', qr, error, isNewLogin, raw }` | Normalized connection lifecycle changes. |
| `message.reaction` | `messages.reaction` | `{ ctx, reaction: { key, text, sender }, raw }` | Reaction updates to existing messages. |
| `call.received` | `call` | `{ ctx, calls: [{ id, from, status, isVideo }], raw }` | Incoming voice or video calls. |
| `contacts.updated` | `contacts.update` | `{ ctx, contacts: [{ id, name }], raw }` | Contact address book updates. |
| `chats.set` | `chats.set` | `{ ctx, chats: [{ id, subject }], raw }` | Chat collection sync. |

---

## 4. ExecutionContext Design

Located at [`src/whatsapp/ExecutionContext.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/whatsapp/ExecutionContext.js):

```javascript
const ctx = createExecutionContext({
    tenantId: 'uuid',
    connectionId: 'uuid',
    sock: socket,
    db: pool
});
```

- **Validation**: Requires non-empty `tenantId`, `connectionId`, and active `sock`.
- **Deep Immutability**: `Object.freeze()` prevents tampering or reassignment across handlers.
- **Tenant Context**: Propagates authoritative tenant boundaries to all downstream services.

---

## 5. GroupSynchronizer Engine

Located at [`src/whatsapp/GroupSynchronizer.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/whatsapp/GroupSynchronizer.js):

### A. Discovery Sweep on Socket Open
When `ConnectionManager` detects `connection === 'open'`, it invokes `synchronizer.syncAllParticipatingGroups()`.

1. Calls `socket.groupFetchAllParticipating()`.
2. Normalizes group records (metadata, subject, creation time, participant count).
3. Batches idempotent upserts to PostgreSQL `groups` table:
   ```sql
   INSERT INTO groups (
       id, tenant_id, connection_id, whatsapp_group_id, name,
       status, is_announcement, participant_count, created_at, updated_at
   ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW(), NOW())
   ON CONFLICT (tenant_id, whatsapp_group_id) DO UPDATE SET
       name = EXCLUDED.name,
       participant_count = EXCLUDED.participant_count,
       status = CASE WHEN groups.status = 'MANAGED' THEN 'MANAGED' ELSE EXCLUDED.status END,
       updated_at = NOW();
   ```
4. Emits `groups.synchronized` with summary count.

### B. Status Preservation Guarantee
A customer marks a group as `MANAGED` to enable moderation policies. The SQL conditional `CASE WHEN groups.status = 'MANAGED' THEN 'MANAGED' ELSE EXCLUDED.status END` guarantees that periodic discovery sweeps or reconnect syncs will **never overwrite** `MANAGED` status back to `DISCOVERED`.

### C. Bot Removal Detection
`GroupSynchronizer` listens to `group.participants.changed`:
1. If `action === 'remove'`:
2. Extracts bot identity using Baileys helper: `const botJid = jidNormalizedUser(ctx.sock.user?.id)`.
3. Checks if any removed participant matches: `participants.some(p => jidNormalizedUser(p) === botJid)`.
4. If true: Updates PostgreSQL status to `UNMANAGED`.
5. If an ordinary member was removed, group status remains unchanged.

### D. Real-time Incremental Sync
Listens to `group.discovered` and `group.updated` emitted by `EventAdapter` to record new groups and update titles/descriptions in PostgreSQL without requiring full discovery sweeps.

---

## 6. Legacy Bridge Compatibility

Located at [`src/whatsapp/legacyBridge.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/whatsapp/legacyBridge.js):

- Directly replaces legacy socket bindings in `main.js`.
- Binds strictly to `EventAdapter` normalized events (`message.received`, `group.participants.changed`, `call.received`).
- Dispatches parsed messages into `handleMessages(socket, chatUpdate, true)`.
- Updates `lightweight_store` contacts, chats, and recent messages via normalized events rather than raw socket listeners.
- Provides standard compatibility helpers: `socket.decodeJid()`, `socket.getName()`, `socket.serializeM()`.

---

## 7. Test Verification & Coverage

The test suite thoroughly covers all Phase 3C components:

| Test Suite | Tests | Scope |
| :--- | :--- | :--- |
| `test/event_adapter.test.js` | 9 | Immutability, text parsing, group messages, malformed data safety, participant updates, group upserts, connection updates, cross-connection event isolation. |
| `test/group_synchronizer.test.js` | 6 | Full discovery sweep, idempotency, `MANAGED` preservation across sweeps, bot removal detection, cross-tenant group isolation, background sync error containment. |
| `test/database_auth_state.test.js` | 7 | Signal keys, credentials persistence, cross-tenant auth isolation, fail-closed validation. |
| `test/connection_manager.test.js` | 7 | Socket lifecycle, duplicate prevention, tenant mismatch rejection, failure isolation, backoff reconnects. |
| `test/migrations.test.js` | 7 | UP/DOWN lifecycle, case-insensitive email uniqueness, composite foreign keys. |
| `test/cross_tenant_isolation.test.js` | 6 | IDOR/forged ID prevention across all repository operations. |
| `test/command_graceful_fallback.test.js` | 4 | API fallback without API keys. |
| `test/config_and_identity.test.js` | 3 | Rebranding and PII sanitization. |
| `test/security_hygiene.test.js` | 6 | Dangerous commands neutralized, .gitignore, .env hygiene. |
| **Total** | **55 passing** | **9 suites, 0 failures, 0 skipped** |

---

## 8. Phase Scope Boundary & Deferred Work

### Completed in Phase 3C:
- [x] Immutable `ExecutionContext` factory.
- [x] Normalized `EventAdapter` implementing sole socket listener pattern.
- [x] Idempotent `GroupSynchronizer` with `MANAGED` status preservation and bot removal detection.
- [x] Strict failure isolation for background tasks.
- [x] Migration of legacy bridge to consume normalized events.
- [x] Complete test coverage (55 tests passing).

### Deferred to Phase 3D (Not in Phase 3C):
- Group Policy Engine & Enforcement (anti-link, anti-spam, mute, kick policies).
- Tenant moderation rules execution against `GroupPolicy` records.
- Command migration into modular execution pipelines.
- Multi-connection scaling & clustering.
- REST API / JWT / SSE endpoints.
