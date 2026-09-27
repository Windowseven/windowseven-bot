/**
 * Windowseven MD Platform Audit Repository
 * Append-only immutable log for all platform operator actions.
 */
class PlatformAuditRepository {
    constructor(pool) {
        if (!pool) {
            throw new Error('[PlatformAuditRepository] Database pool is required');
        }
        this.pool = pool;
    }

    /**
     * Appends a new immutable platform audit record.
     * @param {object} params
     * @param {string|null} [params.actorUserId]
     * @param {string} params.actorRole
     * @param {string} params.action
     * @param {string} params.targetType
     * @param {string} params.targetId
     * @param {string|null} [params.targetTenantId]
     * @param {string|null} [params.reason]
     * @param {object} [params.metadata]
     * @param {string|null} [params.ipAddress]
     * @param {string|null} [params.userAgent]
     * @param {import('pg').PoolClient|null} [client]
     */
    async record({
        actorUserId = null,
        actorRole,
        action,
        targetType,
        targetId,
        targetTenantId = null,
        reason = null,
        metadata = {},
        ipAddress = null,
        userAgent = null,
    }, client = null) {
        if (!actorRole || !action || !targetType || !targetId) {
            throw new Error('actorRole, action, targetType, and targetId are required for platform audit log');
        }

        const executor = client || this.pool;
        const sql = `
            INSERT INTO platform_audit_logs (
                actor_user_id, actor_role, action, target_type, target_id,
                target_tenant_id, reason, metadata, ip_address, user_agent, created_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
            RETURNING id, actor_user_id, actor_role, action, target_type, target_id,
                      target_tenant_id, reason, metadata, ip_address, user_agent, created_at;
        `;

        const { rows } = await executor.query(sql, [
            actorUserId,
            actorRole,
            action,
            targetType,
            String(targetId),
            targetTenantId,
            reason,
            JSON.stringify(metadata || {}),
            ipAddress,
            userAgent,
        ]);

        return rows[0];
    }

    /**
     * Queries platform audit logs with pagination and filtering.
     * @param {object} [params]
     * @param {number} [params.limit=50]
     * @param {number} [params.offset=0]
     * @param {string|null} [params.action]
     * @param {string|null} [params.targetType]
     * @param {string|null} [params.targetId]
     * @param {string|null} [params.targetTenantId]
     * @param {string|null} [params.actorUserId]
     */
    async list({
        limit = 50,
        offset = 0,
        action = null,
        targetType = null,
        targetId = null,
        targetTenantId = null,
        actorUserId = null,
    } = {}) {
        let sql = `
            SELECT id, actor_user_id, actor_role, action, target_type, target_id,
                   target_tenant_id, reason, metadata, ip_address, user_agent, created_at
            FROM platform_audit_logs
        `;

        const conditions = [];
        const params = [];

        if (action) {
            params.push(action);
            conditions.push(`action = $${params.length}`);
        }
        if (targetType) {
            params.push(targetType);
            conditions.push(`target_type = $${params.length}`);
        }
        if (targetId) {
            params.push(String(targetId));
            conditions.push(`target_id = $${params.length}`);
        }
        if (targetTenantId) {
            params.push(targetTenantId);
            conditions.push(`target_tenant_id = $${params.length}`);
        }
        if (actorUserId) {
            params.push(actorUserId);
            conditions.push(`actor_user_id = $${params.length}`);
        }

        if (conditions.length > 0) {
            sql += ` WHERE ${conditions.join(' AND ')}`;
        }

        params.push(limit, offset);
        sql += ` ORDER BY created_at DESC LIMIT $${params.length - 1} OFFSET $${params.length};`;

        const { rows } = await this.pool.query(sql, params);
        return rows;
    }

    /**
     * Finds a single platform audit entry by ID.
     * @param {string} id
     */
    async findById(id) {
        if (!id) return null;
        const sql = `SELECT * FROM platform_audit_logs WHERE id = $1;`;
        const { rows } = await this.pool.query(sql, [id]);
        return rows[0] || null;
    }
}

module.exports = PlatformAuditRepository;
