# WINDOWSEVEN MD — REST CORE & TENANT AUTHORIZATION ARCHITECTURE

**Phase:** 4C — REST Core + Tenant Authorization Middleware  
**Document:** `docs/10_REST_CORE_AND_TENANT_AUTHORIZATION.md`  
**Status:** IMPLEMENTED & VERIFIED  
**Baseline:** Phase 4B Authentication Engine & Identity Foundation  

---

## 1. Executive Summary

Phase 4C establishes the secure REST API foundation, HTTP routing engine, request middleware pipeline, and multi-tenant authorization boundary for Windowseven MD. It builds directly on top of the Phase 4B authentication engine (`req.user`) and implements rigorous defense-in-depth tenant isolation across both the HTTP middleware boundary and the PostgreSQL repository query layer.

Key capabilities delivered in Phase 4C:
- **Zero-Dependency HTTP Router (`HttpRouter`)**: High-performance URI parameter extraction, HTTP method dispatch, RFC 7231-compliant `Allow` header generation on 405 Method Not Allowed, and automated preflight `OPTIONS` handling.
- **REST Application Host (`RestApp`)**: Standardized request lifecycle with CORS, strict 100 KB payload bounds, structured JSON parsing, cryptographically secure `X-Request-ID` tracing, and centralized error sanitization (zero SQL/credential leakage).
- **Tenant Context Resolution Middleware (`createTenantMiddleware`)**: Validates UUID syntax, confirms tenant existence (404 on nonexistent tenant), confirms user membership (403 on unauthorized membership), logs tenant access denial audit records, and attaches an immutable `req.tenantContext` (`Object.freeze`).
- **Hierarchical Role Authorization (`requireTenantRole`)**: Enforces strict privilege tiers (`OWNER: 3 > ADMIN: 2 > MEMBER: 1`) and arbitrary explicit role sets.
- **Atomic Tenant & Membership Workflows (`TenantService`)**: Transactional tenant provisioning (`createTenant` creates tenant, assigns `OWNER`, writes audit log in one transaction), email-normalized member invitations, cross-tenant isolation enforcement, and concurrency-safe sole `OWNER` protection via row-level locking (`SELECT ... FOR UPDATE`).
- **Proof-of-Concept Tenant-Scoped Endpoints**: Minimal read-only connection endpoints demonstrating end-to-end tenant scoping without prematurely introducing WebSocket, QR, or worker orchestration logic.

---

## 2. Request Lifecycle & Architecture Flow

```text
Incoming HTTP Request
       ↓
 [RestApp Handler]
       ↓
 1. Request ID Resolution (Extract or Generate UUIDv4 -> Set X-Request-ID Header)
       ↓
 2. CORS Preflight & Headers Validation
       ↓
 3. Body Streaming & Size Enforcement (Reject if > 100 KB with 413 PAYLOAD_TOO_LARGE)
       ↓
 4. JSON Deserialization (Reject malformed JSON with 400 MALFORMED_JSON)
       ↓
 [HttpRouter Matching]
       ↓
    ├─ Match Path & Method? ──NO──> Path Matches Other Method? ─YES─> 405 METHOD_NOT_ALLOWED (Allow Header)
    │                                                          ─NO──> 404 ROUTE_NOT_FOUND
    ↓ YES
 [Middleware Pipeline]
       ↓
 5. authenticate (Phase 4B JWT Verification -> Sets req.user)
       ↓
 6. resolveTenant (Phase 4C Tenant Middleware)
    ├─ Valid UUID? ──NO──> 400 VALIDATION_ERROR
    ├─ Tenant Exists? ──NO──> 404 TENANT_NOT_FOUND
    ├─ User is Member? ──NO──> Log TENANT_ACCESS_DENIED -> 403 TENANT_ACCESS_DENIED
    ↓ YES
    └─ Attach req.tenantContext = Object.freeze({ tenantId, tenant, membership, role })
       ↓
 7. requireTenantRole (Role Hierarchy Check: OWNER=3, ADMIN=2, MEMBER=1)
    └─ Has Required Role? ──NO──> 403 INSUFFICIENT_PERMISSIONS
       ↓ YES
 8. Route Handler Execution (e.g. TenantHandler, Connection proof endpoints)
       ↓
 9. Repository Layer (Defense-in-Depth Tenant Scoping: WHERE tenant_id = $1)
       ↓
10. Centralized Response Serialization (Envelope: { success, data, meta: { requestId, timestamp } })
```

---

## 3. Tenant Enumeration & Authorization Semantics

### 3.1 The Policy Matrix

| Scenario | Path Example | Condition | HTTP Status | Error Code | Rationale |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **Case A** | `/api/v1/tenants/:tenantId` | `tenantId` does not exist in DB | **404** | `TENANT_NOT_FOUND` | Direct tenant entity lookup. Conforms to standard REST semantics. |
| **Case B** | `/api/v1/tenants/:tenantId` | `tenantId` exists, but `req.user` is not a member | **403** | `TENANT_ACCESS_DENIED` | Authenticated user is explicitly denied access to a valid foreign tenant. Audit log emitted. |
| **Case C** | `/api/v1/tenants/:tenantId/connections` | User is member of `tenantId` | **200** | — | Returns connections belonging strictly to `tenantId`. |
| **Case D** | `/api/v1/tenants/:tenantId/connections/:connId` | `connId` exists in DB, but belongs to another tenant | **404** | `RESOURCE_NOT_FOUND` | **Anti-Enumeration Guard**: Returning 403 would disclose that `connId` exists in a foreign tenant. Returning 404 treats foreign resources as nonexistent within this tenant. |
| **Case E** | `/api/v1/tenants/:tenantId/connections/:connId` | `connId` does not exist in DB at all | **404** | `RESOURCE_NOT_FOUND` | Identical response to Case D, preventing timing/status-code oracle attacks. |

### 3.2 Anti-Enumeration Design Decision
For sub-resources (e.g., connections, groups, messages, audit logs), an entity belonging to Tenant B accessed under Tenant A MUST ALWAYS return **404 RESOURCE_NOT_FOUND** rather than 403 Forbidden. This ensures that external callers cannot probe UUID existence or map foreign resource identifiers across tenant boundaries.

---

## 4. Tenant Context & Role Authorization

### 4.1 Immutable Tenant Context
Upon successful validation in `createTenantMiddleware`, `req.tenantContext` is attached to the request object and sealed using `Object.freeze`:

```javascript
req.tenantContext = Object.freeze({
  tenantId: tenant.id,
  tenant: Object.freeze({
    id: tenant.id,
    name: tenant.name,
    slug: tenant.slug,
    status: tenant.status
  }),
  membership: Object.freeze({
    id: membership.id,
    userId: membership.userId,
    tenantId: membership.tenantId,
    role: membership.role
  }),
  role: membership.role
});
```
Downstream route handlers or intermediate middlewares cannot tamper with or mutate the resolved identity or membership role.

### 4.2 Role Hierarchy
Tenant authorization enforces three standard roles:
- `OWNER` (Rank: 3): Full operational, billing, member administration, and tenant deletion privileges.
- `ADMIN` (Rank: 2): Operational and member management privileges (cannot manage or assign `OWNER`).
- `MEMBER` (Rank: 1): Standard operational access to tenant resources.

The `requireTenantRole` middleware supports either a minimum hierarchy rank or explicit role arrays:
```javascript
// Minimum role requirement
requireTenantRole('ADMIN') // Allows OWNER and ADMIN; blocks MEMBER with 403

// Explicit role requirement
requireTenantRole(['OWNER']) // Allows OWNER only
```

---

## 5. Concurrency Safety: Sole OWNER Invariant

A critical vulnerability in multi-tenant RBAC systems is the race condition where concurrent requests demote or remove the last remaining `OWNER`, leaving a tenant orphaned without administrative ownership.

Windowseven MD prevents this via **Pessimistic Row-Level Locking** in PostgreSQL:
1. `TenantService.updateMemberRole()` and `TenantService.removeMember()` open a database transaction.
2. The transaction immediately acquires an exclusive lock on the parent tenant row:
   ```sql
   SELECT id FROM tenants WHERE id = $1 FOR UPDATE;
   ```
3. While holding this exclusive lock, the service queries the live owner count:
   ```sql
   SELECT COUNT(*)::int FROM tenant_memberships WHERE tenant_id = $1 AND role = 'OWNER';
   ```
4. If the target member is an `OWNER` and `ownerCount <= 1`, the operation is aborted with:
   - Status: `409 Conflict`
   - Code: `SOLE_OWNER_CANNOT_BE_MODIFIED` or `SOLE_OWNER_CANNOT_BE_REMOVED`
5. Concurrent requests attempting to demote or remove owners for the same tenant are serialized at the database engine level, eliminating race conditions.

---

## 6. Repository-Level Defense-in-Depth Scoping

HTTP middleware is the first line of defense, but repository-level scoping is mandatory to prevent accidental data leaks if a handler forgets middleware or mishandles query params.

In `ConnectionRepository`:
```javascript
async findByIdForTenant(id, tenantId) {
  const result = await this.pool.query(
    'SELECT * FROM connections WHERE id = $1 AND tenant_id = $2',
    [id, tenantId]
  );
  return result.rows[0] ? this._mapRow(result.rows[0]) : null;
}
```
Every query that reads, updates, or deletes sub-resources explicitly binds `tenant_id = $2`. Cross-tenant record leakage is prevented even in the event of an internal logic bug.

---

## 7. Standard API Contract & Centralized Error Format

All REST responses adhere to a uniform JSON envelope:

### Success Response
```json
{
  "success": true,
  "data": { ... },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-09-19T16:30:00.000Z"
  }
}
```

### Error Response
```json
{
  "success": false,
  "error": {
    "code": "TENANT_ACCESS_DENIED",
    "message": "User is not a member of this tenant"
  },
  "meta": {
    "requestId": "550e8400-e29b-41d4-a716-446655440000",
    "timestamp": "2026-09-19T16:30:00.000Z"
  }
}
```

### Security Sanitization Rules
- No stack traces are ever exposed in HTTP responses.
- Internal errors return status `500` with code `INTERNAL_ERROR` and a generic message.
- Raw PostgreSQL database errors (e.g. `23505 unique_violation`, table names, column constraints) are intercepted and translated into clean, structured `ApiError` instances before reaching the client.

---

## 8. Endpoint Inventory & Classification Table

| Method | Endpoint | Auth | Required Role | Description | Success Code |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `POST` | `/api/v1/tenants` | JWT | None (User) | Create new tenant; creator assigned `OWNER` atomically | `201 Created` |
| `GET` | `/api/v1/tenants` | JWT | None (User) | List all tenants where authenticated user has membership | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId` | JWT | `MEMBER` | Retrieve tenant details and caller membership info | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/members` | JWT | `MEMBER` | List all members in the tenant | `200 OK` |
| `POST` | `/api/v1/tenants/:tenantId/members` | JWT | `ADMIN` | Add registered user by email (ADMIN cannot assign OWNER) | `201 Created` |
| `PATCH` | `/api/v1/tenants/:tenantId/members/:userId` | JWT | `ADMIN` | Update member role (Protected by row-level lock) | `200 OK` |
| `DELETE` | `/api/v1/tenants/:tenantId/members/:userId` | JWT | `ADMIN` | Remove member from tenant (Protected by row-level lock) | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/connections` | JWT | `MEMBER` | List WhatsApp connections belonging to tenant | `200 OK` |
| `GET` | `/api/v1/tenants/:tenantId/connections/:connId` | JWT | `MEMBER` | Get connection by ID (Scoped; 404 if foreign) | `200 OK` |

---

## 9. Scalability & Architectural Assertions

1. **Stateless API Gateway**: The HTTP router and REST application maintain zero in-memory session state. Scaling horizontally across arbitrary cluster nodes requires only a standard L7 load balancer (e.g., NGINX, AWS ALB, Cloudflare).
2. **No Arbitrary Tenant Ceilings**: Tenant and membership schemas are backed by indexed PostgreSQL UUID columns (`idx_tenant_memberships_user`, `idx_tenant_memberships_tenant`). The system scales seamlessly with database storage and connection pool provisioning.
3. **Audit Trail Integrity**: Tenant provisioning, membership modifications, and security boundary violations (`TENANT_ACCESS_DENIED`) write structured records to the `audit_logs` table with actor and tenant tagging.

---

## 10. Phase 4D Handoff & Boundary Enforcement

The REST Core and Tenant Authorization boundary is formally closed and verified.
- **Strict Boundary**: No WhatsApp connection lifecycle actions (QR streaming, pairing code, Baileys socket initiation, disconnect/reconnect) or worker orchestration were introduced in Phase 4C.
- **Phase 4D Scope**: Connection lifecycle management, worker ownership protocol, and QR event streaming will build strictly upon these verified tenant middleware contracts.
