# Phase 3D: Application Pipeline, Policy Engine & Command Migration

This document details the design, architecture, execution pipeline, policy engine, dual authorization, and command migration foundation implemented in **Phase 3D** of the **Windowseven MD** multi-tenant SaaS platform.

---

## 1. Architectural Overview: Transport vs Application

In Phase 3D, the architecture strictly enforces the principle:
> **Business logic lives below the transport/input layer.**

WhatsApp is treated as an input/output transport channel. Incoming normalized events from `EventAdapter` flow through a structured `ApplicationPipeline` into domain services that are completely decoupled from raw Baileys primitives. These domain services are directly reusable by future REST APIs or background automation jobs.

```text
               WhatsApp (Baileys Transport)
                         │
                         ▼
                  ConnectionManager
                         │
                         ▼
                    EventAdapter
                         │
                         ▼
               Application Pipeline
                         │
      ┌──────────────────┴──────────────────┐
      ▼                                     ▼
Event Validation                      Context Resolution
      │                          (tenantId + connectionId + groupId)
      ▼
Managed Group Gate ──(status !== 'MANAGED')──► Bypass (No Policy/Moderation)
      │ (status === 'MANAGED')
      ▼
Message Normalization & Actor Resolution
 (NormalizedMessage, isSenderAdmin, isBotAdmin)
      │
      ├── Is Command?
      │     ├── In CommandRegistry? ──► Dual Authorization ──► CommandHandler ──► Domain Service
      │     └── Non-migrated?       ──► Fall-through to LegacyBridge (no policy run on commands)
      │
      └── Non-Command Message
            │
            ▼
      PolicyEngine (AntiBadword, AntiLink)
            │
            ▼
      PolicyDecision (Deterministic Precedence: KICK > DELETE > WARN > ALLOW)
            │
            ▼
      Application Orchestration
       ├── WarningService (Tracks counts & returns EscalationDecision)
       └── ModerationService
             │
             ▼
      WhatsAppModerationGateway (Narrow Baileys capability wrapper)
```

---

## 2. Pipeline Stages

The `ApplicationPipeline` (`src/application/pipeline/ApplicationPipeline.js`) processes messages through an explicit sequential pipeline with failure isolation:

1. **Event Validation**: Ensures event contains valid message payload, remote JID, and execution context. Non-group messages short-circuit to legacy handlers.
2. **Composite Tenant + Connection Scoped Group Resolution**:
   - Queries `groups` table by `(whatsapp_jid, tenant_id)`.
   - Strictly enforces composite ownership constraint: `group.connection_id === connectionId`.
   - Forged group identifiers belonging to other tenants or connections are rejected (`handled: false, reason: 'unresolved_or_mismatched_group'`).
3. **Managed Group Gate**:
   - Only groups explicitly marked `status = 'MANAGED'` are permitted to execute tenant moderation policies and migrated commands.
   - `DISCOVERED` and `UNMANAGED` groups safely bypass processing without side effects.
4. **Message Normalization & Actor Resolution**:
   - Extracts clean `NormalizedMessage` (command, arguments, mentions, quoted sender).
   - Queries WhatsApp group metadata via `WhatsAppModerationGateway.checkAdminStatus` to determine `isSenderAdmin` and `isBotAdmin`.
   - Builds immutable `ApplicationContext`.
5. **Command Classification vs. Automatic Policies**:
   - If the message is a command (`.warn`, `.mute`, etc.) and registered in `CommandRegistry`:
     - Evaluates required permissions (`requireSenderAdmin`, `requireBotAdmin`).
     - Dispatches to thin `CommandHandler`.
     - Returns `{ handled: true, result }`.
   - If the command is not migrated (e.g. `.ping`, `.alive`, `.sticker`):
     - Returns `{ handled: false, reason: 'unmigrated_command' }`.
     - Ensures automatic policies (links, bad words) are NOT executed on non-migrated commands.
     - Allows safe fall-through to `legacyBridge`.
6. **Automatic Policy Evaluation**:
   - For regular group messages, fetches `group_policies` row from PostgreSQL.
   - Invokes `PolicyEngine.evaluate({ message, groupPolicy, actor })`.
   - If `decision.action !== 'ALLOW'`, deletes the offending message (if bot is admin) and triggers configured action (`DELETE`, `WARN`, `KICK`).
7. **Failure Isolation**:
   - The entire pipeline is wrapped in defensive error-handling. Any unexpected database or socket error logs structured diagnostics and returns `{ handled: false }` without throwing or crashing the Baileys connection.

---

## 3. Execution Context vs. Service Locator

Per architectural guardrails, `ApplicationContext` is an **execution context**, not a service locator.

```javascript
class ApplicationContext {
    tenantId;       // UUID
    connectionId;   // UUID
    group;          // { id, whatsappJid, name, status }
    actor;          // { senderJid, isSenderAdmin, isBotAdmin }
    message;        // NormalizedMessage instance
}
```

- Context does **not** expose raw database clients or unrestricted socket instances.
- Domain services (`WarningService`, `ModerationService`) are injected explicitly into command handlers and the pipeline.

---

## 4. Managed vs. Discovered Groups

| Status | Definition | Policy Execution | Command Execution |
| :--- | :--- | :---: | :---: |
| `DISCOVERED` | Group detected via `groupFetchAllParticipating()` or real-time event. Stored in DB, but customer has not activated management. | ❌ Disabled | ❌ Disabled |
| `MANAGED` | Explicitly selected and enabled by tenant in PostgreSQL. | ✅ Enabled | ✅ Enabled |
| `UNMANAGED` | Bot was removed from group or management was explicitly deactivated. | ❌ Disabled | ❌ Disabled |

---

## 5. Dual Authorization Model

The application strictly separates **SaaS Tenant Role** from **WhatsApp Group Privileges**:

1. **SaaS Authorization**:
   - `TenantMembership`: `OWNER`, `ADMIN`, `MEMBER`.
   - Controls SaaS account settings, billing, connections, and policy configuration.
2. **WhatsApp Group Privileges**:
   - `isSenderAdmin`: Is the sender an administrator of the WhatsApp group?
   - `isBotAdmin`: Is the connected WhatsApp bot account an administrator of the WhatsApp group?
3. **Security Invariant**:
   - A SaaS `OWNER` cannot execute WhatsApp moderation actions (such as `.mute`, `.kick`, `.promote`) in a group unless the connected bot is a WhatsApp administrator of that group.
   - Administrative exemptions from auto-moderation policies (AntiLink, AntiBadword) apply strictly to WhatsApp group administrators (`isSenderAdmin`), never inferred from SaaS roles.

---

## 6. Policy Engine & Deterministic Precedence

Located at `src/application/policies/PolicyEngine.js`:
- Pure evaluation layer: consumes `(message, groupPolicy, actor)` and returns `PolicyDecision`.
- Zero side effects: does **not** invoke `WhatsAppModerationGateway` directly.
- **Deterministic Precedence**:
  When multiple rules trigger on a single message (e.g. a message contains both a prohibited URL and a prohibited word):
  $$\text{KICK (4)} > \text{DELETE (3)} > \text{WARN (2)} > \text{NO\_ACTION (1)} > \text{ALLOW (0)}$$
  The decision with highest severity takes precedence. If severity is identical, the primary security rule (`AntiBadword`) takes precedence over content restriction (`AntiLink`).

---

## 7. Decoupled Warning Escalation

Located at `src/application/services/WarningService.js`:
- Warnings are persisted in PostgreSQL (`group_warnings` table created in Migration 003).
- Does **not** perform WhatsApp actions directly.
- Returns structured `EscalationDecision`:
  ```javascript
  {
      warning: object,
      warningCount: number,
      maxWarnings: number,
      shouldEscalate: boolean,
      escalationAction: 'kick'
  }
  ```
- Application pipeline or command orchestrator inspects `shouldEscalate` and coordinates with `ModerationService` to kick participants.

---

## 8. Narrow Infrastructure Boundary: `WhatsAppModerationGateway`

Located at `src/gateways/WhatsAppModerationGateway.js`:
Application and domain services **never** import or manipulate raw Baileys socket methods. The gateway exposes only explicit, safe operations:
- `deleteMessage(chatJid, messageKey)`
- `sendTextMessage(chatJid, text, options)`
- `kickParticipant(chatJid, participantJid)` (includes self-kick protection)
- `muteGroup(chatJid)` (`groupSettingUpdate(chatJid, 'announcement')`)
- `unmuteGroup(chatJid)` (`groupSettingUpdate(chatJid, 'not_announcement')`)
- `promoteParticipant(chatJid, participantJid)`
- `demoteParticipant(chatJid, participantJid)`
- `checkAdminStatus(chatJid, participantJid)`

---

## 9. Command Migration Matrix

| Command | Aliases | Description | Authority | Status |
| :--- | :--- | :--- | :--- | :--- |
| `.warn` | `.warning` | Issues formal warning to a member; kicks on threshold | `WarningService` + `group_warnings` (PostgreSQL) | **Migrated** |
| `.warnings` | `.warns`, `.checkwarn` | Retrieves active warning count for user | `WarningService` + `group_warnings` (PostgreSQL) | **Migrated** |
| `.resetwarn` | `.clearwarn`, `.resetwarns` | Resets warnings for a member | `WarningService` + `group_warnings` (PostgreSQL) | **Migrated** |
| `.antilink` | — | Configures group anti-link protection (`on`, `off`, `set`, `get`) | `GroupPolicyRepository` (PostgreSQL) | **Migrated** |
| `.mute` | `.silence` | Sets group announcement mode (optionally timed) | `ModerationService` + Gateway | **Migrated** |
| `.unmute` | — | Disables group announcement mode | `ModerationService` + Gateway | **Migrated** |
| `.kick` | `.remove` | Removes participant from group | `ModerationService` + Gateway | **Migrated** |
| `.promote` | `.admin` | Promotes group member to admin | `ModerationService` + Gateway | **Migrated** |
| `.demote` | `.unadmin` | Demotes admin to regular member | `ModerationService` + Gateway | **Migrated** |
| `.ping`, `.alive`, `.help`, etc. | — | Informational/utility commands | `legacyBridge` $\to$ `main.js` | **Legacy (Unchanged)** |
| `.update`, `.clearsession` | — | Dangerous infrastructure commands | Neutralized in Phase 2 | **Neutralized** |

---

## 10. Legacy Bridge Coexistence & Elimination of Dual Execution

In `src/whatsapp/legacyBridge.js`:
```javascript
// Phase 3D: Application Pipeline processing
if (pipeline) {
    const pipelineRes = await pipeline.processMessage(event);
    if (pipelineRes && pipelineRes.handled) {
        // Migrated capability handled authoritatively by Application Pipeline.
        // Short-circuit to prevent duplicate execution in legacy main.js!
        return;
    }
}
```
- When a migrated command or policy fires, `handled === true` causes an immediate return.
- `main.js` never executes for migrated commands.
- Non-migrated utility commands (`.ping`, `.alive`, etc.) return `handled === false` and continue to work seamlessly via `legacyBridge`.

---

## 11. Test Coverage & Verification

Executed via Node.js native test runner against live PostgreSQL:

| Suite | Tests | Scope |
| :--- | :---: | :--- |
| `test/group_warning_repository.test.js` | 4 | CRUD, counts, resets, composite foreign key constraints, cross-tenant isolation. |
| `test/policy_engine.test.js` | 6 | AntiLink, AntiBadword, admin exemptions, deterministic precedence (KICK > DELETE > WARN). |
| `test/moderation_services.test.js` | 5 | WarningService escalation decisions, ModerationService dual authorization & managed group gate. |
| `test/migrated_commands.test.js` | 4 | CommandRegistry lookup, aliases, Antilink, Warn/Warnings/ResetWarn, Kick/Promote/Demote. |
| `test/application_pipeline.test.js` | 5 | ManagedGroupGate, AntiLink auto-warn, admin command execution, unmigrated command pass-through, failure isolation. |
| `test/cross_tenant_policy_isolation.test.js` | 4 | Forged group IDs, mismatched connection attacks, cross-tenant policy/warning mutation rejection. |
| `test/migration_and_schema.test.js` | 7 | UP $\to$ DOWN $\to$ UP lifecycle across 001, 002, 003, case-insensitive email, composite foreign keys. |
| `test/baileys_auth.test.js` | 7 | Signal keys, credentials persistence, BufferJSON fidelity, cross-tenant auth isolation. |
| `test/connection_manager.test.js` | 7 | Lifecycle, duplicate prevention, tenant mismatch rejection, backoff reconnects, shutdown. |
| `test/event_adapter.test.js` | 9 | Immutability, text extraction, group messages, malformed data safety, participant updates. |
| `test/group_synchronizer.test.js` | 6 | Discovery sweep, idempotency, `MANAGED` status preservation, bot removal detection. |
| `test/security.test.js` | 6 | Neutralized dangerous commands, .gitignore, .env hygiene. |
| `test/tenant_isolation.test.js` | 6 | Cross-tenant IDOR rejection on connections, groups, policies. |
| `test/command_security.test.js` | 4 | Graceful fallback when API keys are missing. |
| `test/config.test.js` | 3 | Rebranding and PII sanitization. |
| **Total** | **83 passing** | **15 suites, 0 failures, 0 skipped** |

---

## 12. Known Limitations & Deferred Work

- **Full Command Migration**: Only the priority moderation subset (9 commands) was migrated in Phase 3D. 80+ legacy utility, entertainment, and media commands remain in `commands/` and are serviced through the legacy bridge.
- **REST API / Dashboard**: No HTTP routes, JWT authentication, or webhooks have been implemented yet (scheduled for future phases).
- **Automated Anti-Spam / Rate-Limiting Engine**: Basic policy engine exists; sophisticated message rate calculation is deferred to Phase 3E.
