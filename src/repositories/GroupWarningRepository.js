const { jidNormalizedUser } = require('@whiskeysockets/baileys');

class GroupWarningRepository {
    constructor(pool) {
        if (!pool) {
            throw new Error('Database pool is required for GroupWarningRepository');
        }
        this.pool = pool;
    }

    /**
     * Normalizes a WhatsApp JID defensively.
     * @param {string} jid
     * @returns {string}
     */
    _normalizeJid(jid) {
        if (!jid || typeof jid !== 'string') return '';
        try {
            return jidNormalizedUser(jid);
        } catch (_) {
            return jid.trim().toLowerCase();
        }
    }

    /**
     * Records a new warning for a participant within a tenant-owned group.
     *
     * @param {string} tenantId - UUID of the tenant
     * @param {string} groupId - UUID of the group
     * @param {object} params - { subjectJid, issuedBy, reason }
     * @param {import('pg').PoolClient} [dbClient] - Optional transaction client
     * @returns {Promise<object>} Created warning record
     */
    async createWarning(tenantId, groupId, { subjectJid, issuedBy, reason = null }, dbClient = null) {
        if (!tenantId || !groupId || !subjectJid || !issuedBy) {
            throw new Error('tenantId, groupId, subjectJid, and issuedBy are required');
        }

        const normalizedSubject = this._normalizeJid(subjectJid);
        const normalizedIssuer = this._normalizeJid(issuedBy);

        const sql = `
            INSERT INTO group_warnings (tenant_id, group_id, subject_jid, issued_by, reason, created_at)
            VALUES ($1, $2, $3, $4, $5, NOW())
            RETURNING id, tenant_id, group_id, subject_jid, issued_by, reason, created_at;
        `;

        const client = dbClient || this.pool;
        const { rows } = await client.query(sql, [
            tenantId,
            groupId,
            normalizedSubject,
            normalizedIssuer,
            reason,
        ]);

        return rows[0];
    }

    /**
     * Counts the total number of warnings for a specific subject in a group.
     *
     * @param {string} tenantId - UUID of the tenant
     * @param {string} groupId - UUID of the group
     * @param {string} subjectJid - WhatsApp JID of the warned member
     * @returns {Promise<number>}
     */
    async countWarningsForSubject(tenantId, groupId, subjectJid) {
        if (!tenantId || !groupId || !subjectJid) return 0;

        const normalizedSubject = this._normalizeJid(subjectJid);

        const sql = `
            SELECT COUNT(*)::int AS count
            FROM group_warnings
            WHERE tenant_id = $1 AND group_id = $2 AND subject_jid = $3;
        `;

        const { rows } = await this.pool.query(sql, [tenantId, groupId, normalizedSubject]);
        return rows[0] ? rows[0].count : 0;
    }

    /**
     * Lists all warnings for a subject in a group, newest first.
     *
     * @param {string} tenantId - UUID of the tenant
     * @param {string} groupId - UUID of the group
     * @param {string} subjectJid - WhatsApp JID of the warned member
     * @returns {Promise<Array<object>>}
     */
    async listWarningsForSubject(tenantId, groupId, subjectJid) {
        if (!tenantId || !groupId || !subjectJid) return [];

        const normalizedSubject = this._normalizeJid(subjectJid);

        const sql = `
            SELECT id, tenant_id, group_id, subject_jid, issued_by, reason, created_at
            FROM group_warnings
            WHERE tenant_id = $1 AND group_id = $2 AND subject_jid = $3
            ORDER BY created_at DESC;
        `;

        const { rows } = await this.pool.query(sql, [tenantId, groupId, normalizedSubject]);
        return rows;
    }

    /**
     * Resets / clears all warnings for a specific subject in a group.
     *
     * @param {string} tenantId - UUID of the tenant
     * @param {string} groupId - UUID of the group
     * @param {string} subjectJid - WhatsApp JID of the warned member
     * @returns {Promise<number>} Number of deleted warnings
     */
    async resetWarningsForSubject(tenantId, groupId, subjectJid) {
        if (!tenantId || !groupId || !subjectJid) return 0;

        const normalizedSubject = this._normalizeJid(subjectJid);

        const sql = `
            DELETE FROM group_warnings
            WHERE tenant_id = $1 AND group_id = $2 AND subject_jid = $3
            RETURNING id;
        `;

        const { rows } = await this.pool.query(sql, [tenantId, groupId, normalizedSubject]);
        return rows.length;
    }

    /**
     * Lists warnings for a group, optionally filtered by subject, with pagination.
     */
    async listWarningsForGroup(tenantId, groupId, { subjectJid = null, limit = 50, offset = 0 } = {}) {
        if (!tenantId || !groupId) return { items: [], total: 0, limit, offset };

        const safeLimit = Math.min(100, Math.max(1, parseInt(limit, 10) || 50));
        const safeOffset = Math.max(0, parseInt(offset, 10) || 0);

        let countSql = `SELECT COUNT(*)::int AS count FROM group_warnings WHERE tenant_id = $1 AND group_id = $2`;
        let selectSql = `
            SELECT id, tenant_id, group_id, subject_jid, issued_by, reason, created_at
            FROM group_warnings
            WHERE tenant_id = $1 AND group_id = $2
        `;
        const params = [tenantId, groupId];

        if (subjectJid) {
            const normalized = this._normalizeJid(subjectJid);
            countSql += ` AND subject_jid = $3`;
            selectSql += ` AND subject_jid = $3`;
            params.push(normalized);
        }

        const countRes = await this.pool.query(countSql, params);
        const total = countRes.rows[0]?.count || 0;

        selectSql += ` ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2};`;
        const { rows } = await this.pool.query(selectSql, [...params, safeLimit, safeOffset]);

        return {
            items: rows,
            total,
            limit: safeLimit,
            offset: safeOffset,
        };
    }

    /**
     * Clears all warnings for an entire group (e.g. on group reset or deletion).
     *
     * @param {string} tenantId - UUID of the tenant
     * @param {string} groupId - UUID of the group
     * @returns {Promise<number>} Number of deleted warnings
     */
    async clearAllWarningsForGroup(tenantId, groupId) {
        if (!tenantId || !groupId) return 0;

        const sql = `
            DELETE FROM group_warnings
            WHERE tenant_id = $1 AND group_id = $2
            RETURNING id;
        `;

        const { rows } = await this.pool.query(sql, [tenantId, groupId]);
        return rows.length;
    }
}

module.exports = GroupWarningRepository;
