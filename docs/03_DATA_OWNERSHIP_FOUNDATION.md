# Phase 3A: Data & Ownership Foundation

This document defines the PostgreSQL data model, relational ownership boundaries, migration infrastructure, and tenant isolation architecture implemented in **Phase 3A** of the **Windowseven MD** multi-tenant SaaS transformation.

---

## 1. System Architecture

In the target architecture of Windowseven MD, data isolation starts at the persistence layer:

```text
┌─────────────────────────────────────────────────────────────┐
│                      Future Frontend                        │
└──────────────────────────────┬──────────────────────────────┘
                               │ HTTPS / WSS
┌──────────────────────────────▼──────────────────────────────┐
│                    Windowseven API                          │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│              Application / Core Services                    │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                   Repositories Layer                        │
│          (Mandatory Tenant-Scoped Queries)                  │
└──────────────────────────────┬──────────────────────────────┘
                               │ Parameterized SQL
┌──────────────────────────────▼──────────────────────────────┐
│                      PostgreSQL 18+                         │
│       (Composite FKs & Case-Insensitive Unique Indexes)      │
└─────────────────────────────────────────────────────────────┘
```

During **Phase 3A**, the relational schema, migrations, connection pool, repositories, and isolation tests have been established. The existing Baileys runtime continues to execute safely using its legacy JSON stores while the new database foundation is readied for future phases.

---

## 2. Core Entity Model

The relational schema introduces 6 authoritative domain entities:

### 1. `User` (`users`)
Represents an individual platform account holder.
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `email` (VARCHAR(255), NOT NULL)
- `password_hash` (TEXT, Nullable placeholder for future auth phase)
- `created_at` (TIMESTAMPTZ, default `NOW()`)
- `updated_at` (TIMESTAMPTZ, default `NOW()`)
- **Case-Insensitive Uniqueness**: `CREATE UNIQUE INDEX idx_users_email_lower ON users (LOWER(email));`
  - Guarantees that `Junior@example.com` and `junior@example.com` cannot simultaneously exist.

### 2. `Tenant` (`tenants`)
Represents an isolated customer workspace / organization.
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `name` (VARCHAR(255), NOT NULL)
- `created_at` (TIMESTAMPTZ, default `NOW()`)
- `updated_at` (TIMESTAMPTZ, default `NOW()`)

### 3. `TenantMembership` (`tenant_memberships`)
Associates Users to Tenants with specific access roles.
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `tenant_id` (UUID, Foreign Key -> `tenants.id` ON DELETE CASCADE)
- `user_id` (UUID, Foreign Key -> `users.id` ON DELETE CASCADE)
- `role` (VARCHAR(50), CHECK `role IN ('OWNER', 'ADMIN', 'MEMBER')`)
- `created_at`, `updated_at` (TIMESTAMPTZ)
- **Constraint**: `CONSTRAINT uq_tenant_memberships_user_tenant UNIQUE (user_id, tenant_id)`

### 4. `WhatsAppConnection` (`whatsapp_connections`)
Represents an active or provisioned WhatsApp account connection for a tenant.
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `tenant_id` (UUID, Foreign Key -> `tenants.id` ON DELETE CASCADE)
- `phone_number` (VARCHAR(50), Nullable prior to pairing)
- `display_name` (VARCHAR(255))
- `status` (VARCHAR(50), CHECK `status IN ('CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED')`, default `'CREATED'`)
- `created_at`, `updated_at` (TIMESTAMPTZ)
- **Composite Key Constraint**: `CONSTRAINT uq_whatsapp_connections_tenant_id UNIQUE (tenant_id, id)`
  - Crucial anchor enabling child tables to enforce composite foreign keys.

### 5. `Group` (`groups`)
Represents a WhatsApp group discovered or managed by a WhatsApp connection.
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `tenant_id` (UUID, NOT NULL)
- `connection_id` (UUID, NOT NULL)
- `whatsapp_jid` (VARCHAR(100), NOT NULL, e.g. `120363000000000010@g.us`)
- `name` (VARCHAR(255))
- `status` (VARCHAR(50), CHECK `status IN ('DISCOVERED', 'MANAGED', 'UNMANAGED')`, default `'DISCOVERED'`)
- `created_at`, `updated_at` (TIMESTAMPTZ)
- **Constraints**:
  - `CONSTRAINT fk_groups_connection_tenant FOREIGN KEY (tenant_id, connection_id) REFERENCES whatsapp_connections(tenant_id, id) ON DELETE CASCADE`
  - `CONSTRAINT uq_groups_connection_jid UNIQUE (connection_id, whatsapp_jid)`
  - `CONSTRAINT uq_groups_tenant_id UNIQUE (tenant_id, id)`

### 6. `GroupPolicy` (`group_policies`)
Defines group moderation and automation rules (anti-link, anti-badword, warnings, welcome, goodbye, chatbot).
- `id` (UUID, Primary Key, default `gen_random_uuid()`)
- `tenant_id` (UUID, NOT NULL)
- `group_id` (UUID, NOT NULL UNIQUE)
- `antilink_enabled` (BOOLEAN, default `FALSE`)
- `antilink_action` (VARCHAR(20), CHECK `IN ('delete', 'warn', 'kick')`, default `'delete'`)
- `antibadword_enabled` (BOOLEAN, default `FALSE`)
- `antibadword_action` (VARCHAR(20), CHECK `IN ('delete', 'warn', 'kick')`, default `'delete'`)
- `max_warnings` (INTEGER, CHECK `> 0`, default `3`)
- `warning_action` (VARCHAR(20), CHECK `IN ('warn', 'kick')`, default `'warn'`)
- `welcome_enabled` (BOOLEAN, default `FALSE`), `welcome_message` (TEXT)
- `goodbye_enabled` (BOOLEAN, default `FALSE`), `goodbye_message` (TEXT)
- `chatbot_enabled` (BOOLEAN, default `FALSE`)
- `settings` (JSONB, default `'{}'::jsonb`)
- `created_at`, `updated_at` (TIMESTAMPTZ)
- **Composite Constraint**:
  - `CONSTRAINT fk_group_policies_group_tenant FOREIGN KEY (tenant_id, group_id) REFERENCES groups(tenant_id, id) ON DELETE CASCADE`

---

## 3. Relational Ownership Chain & Invariant Enforcement

The ownership chain strictly follows:
```text
Tenant
  ├── TenantMembership (User ↔ Tenant)
  └── WhatsAppConnection
        └── Group
              └── GroupPolicy
```

### Eliminating Cross-Tenant Mismatch via Composite Foreign Keys
In naive multi-tenant schemas with simple foreign keys:
```text
groups: id, tenant_id, connection_id
```
An application bug could insert:
```text
tenant_id = Tenant A
connection_id = Connection B (owned by Tenant B)
```
In Windowseven MD, this vulnerability is mathematically impossible:
- `whatsapp_connections` declares `UNIQUE (tenant_id, id)`.
- `groups` declares `FOREIGN KEY (tenant_id, connection_id) REFERENCES whatsapp_connections(tenant_id, id)`.
- If an insert or update provides `tenant_id = Tenant A` and `connection_id = Connection B`, PostgreSQL rejects the transaction with code `23503` (`foreign_key_violation`).
- Similarly, `group_policies` enforces `FOREIGN KEY (tenant_id, group_id) REFERENCES groups(tenant_id, id)`. A tenant cannot configure policies for another tenant's group.

---

## 4. Tenant-Scoped Repository Layer

All domain access is encapsulated in `src/repositories/`:
- [`UserRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/UserRepository.js)
- [`TenantRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/TenantRepository.js)
- [`TenantMembershipRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/TenantMembershipRepository.js)
- [`WhatsAppConnectionRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/WhatsAppConnectionRepository.js)
- [`GroupRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/GroupRepository.js)
- [`GroupPolicyRepository`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/repositories/GroupPolicyRepository.js)

### Security Rules:
1. **Mandatory Tenant Context**: All queries accessing tenant-owned entities require `tenantId`.
2. **Forged ID Protection**: Methods use `WHERE id = $1 AND tenant_id = $2`. Supplying a valid resource UUID that belongs to another tenant returns `null` or affects 0 rows.
3. **No Cross-Tenant Leaks**: Listing queries filter strictly by `WHERE tenant_id = $1`.

---

## 5. Migration Strategy

- **Canonical Location**: `src/database/migrations/`
  - `001_initial_schema.up.sql`
  - `001_initial_schema.down.sql`
- **Migration Runner**: [`src/database/migrator.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/src/database/migrator.js)
  - Tracks migrations in `schema_migrations`.
  - Transaction-safe (`BEGIN ... COMMIT / ROLLBACK`).
  - Supports npm commands:
    ```bash
    npm run db:migrate        # Apply pending migrations
    npm run db:migrate:down   # Rollback the last migration
    npm run db:status         # Inspect migration status
    ```

---

## 6. Test Strategy & Database Isolation

- Unit and isolation tests run against an isolated PostgreSQL instance via `TEST_DATABASE_URL` (defaulting to port 5433 test database).
- Tests never touch production or development databases.
- The test suite validates:
  - Fresh migration UP -> DOWN -> UP lifecycle reproducibility.
  - Case-insensitive email uniqueness.
  - Role validation and membership uniqueness.
  - Database-level composite foreign key rejection on mismatched tenant/resource relationships.
  - Cross-tenant read access denial.
  - Forged-ID attack rejections on update, upsert, and delete operations.
  - Proper scoping of collection queries.

---

## 7. Legacy Data Mapping & Transitional Status

| Legacy File | Current Content | Future SaaS Destination | Migration Action in Phase 3A |
| :--- | :--- | :--- | :--- |
| `data/owner.json` | `[]` (sanitized) | `User` + `TenantMembership(role='OWNER')` | Preserved untouched for legacy fallback |
| `data/premium.json` | `[]` (sanitized) | Subscription / Plan tier | Preserved untouched for legacy fallback |
| `data/userGroupData.json` | JSON objects for antilink, welcome, goodbye, warnings | `GroupPolicy` (tenant-scoped) | Preserved untouched; schema is ready for future ingestion |
| `data/warnings.json` | `{ [groupId]: { [userId]: count } }` | Group moderation violation ledger | Preserved untouched |
| `data/antidelete.json` | `{ "enabled": false }` | Connection/Tenant policy | Preserved untouched |
| `data/autoread.json` | `{ "enabled": false }` | Connection policy | Preserved untouched |
| `data/autotyping.json` | `{ "enabled": false }` | Connection policy | Preserved untouched |
| `data/autoStatus.json` | `{ "enabled": false }` | Connection policy | Preserved untouched |

> [!IMPORTANT]
> The legacy runtime (`index.js`, `main.js`, `commands/*`) still uses its existing persistence. PostgreSQL is the authoritative foundation for the upcoming multi-tenant engine, but is NOT yet attached to the legacy single-bot runtime.

---

## 8. Explicit Non-Goals for Phase 3A

The following architectural components are strictly deferred to subsequent phases:
- **ConnectionManager**: Baileys socket pooling and multi-connection orchestration (Phase 3B).
- **Baileys DB Auth State**: Signal key storage and WhatsApp auth session tables (Phase 3B).
- **EventAdapter & Message Dispatcher**: Tenant-scoped Baileys event adapters (Phase 3C).
- **REST API & Auth**: Express server, JWT tokens, user signup/login endpoints (API Phase).
- **Frontend Dashboard**: User management and pairing UI (Frontend Phase).
- **Command Migration**: Refactoring individual bot commands to consume DB repositories (Feature Phase).
