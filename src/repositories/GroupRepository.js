class GroupRepository {
    constructor(pool) {
        this.pool = pool;
    }

    // System/bootstrap provisioning only. Worker event paths must use
    // upsertDiscoveredGroupForWorker(), which SQL-fences the mutation.
    async upsertDiscoveredGroup(tenantId, connectionId, { whatsappJid, name = null, status = 'DISCOVERED' } = {}) {
        if (!tenantId || !connectionId || !whatsappJid) {
            throw new Error('tenantId, connectionId, and whatsappJid are required');
        }
        const validStatuses = ['DISCOVERED', 'MANAGED', 'UNMANAGED'];
        if (!validStatuses.includes(status)) {
            throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
        }
        const sql = `
            INSERT INTO groups (tenant_id, connection_id, whatsapp_jid, name, status)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (connection_id, whatsapp_jid)
            DO UPDATE SET
                name = COALESCE(EXCLUDED.name, groups.name),
                status = CASE
                    WHEN groups.status = 'MANAGED' THEN 'MANAGED'
                    ELSE EXCLUDED.status
                END,
                updated_at = NOW()
            RETURNING id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at;
        `;
        const { rows } = await this.pool.query(sql, [tenantId, connectionId, whatsappJid, name, status]);
        return rows[0];
    }

    async upsertDiscoveredGroupForWorker(tenantId, connectionId, group, fence) {
        if (!fence?.workerId || fence.leaseEpoch === undefined || fence.leaseEpoch === null) throw new Error('workerId and leaseEpoch are required');
        const { whatsappJid, name = null, status = 'DISCOVERED' } = group || {};
        const sql = `INSERT INTO groups (tenant_id, connection_id, whatsapp_jid, name, status)
          SELECT $1, $2, $3, $4, $5 FROM whatsapp_connections c
           WHERE c.id = $2 AND c.tenant_id = $1 AND c.assigned_worker_id = $6 AND c.lease_epoch = $7 AND c.lease_expires_at > NOW()
          ON CONFLICT (connection_id, whatsapp_jid) DO UPDATE SET name = COALESCE(EXCLUDED.name, groups.name),
            status = CASE WHEN groups.status = 'MANAGED' THEN 'MANAGED' ELSE EXCLUDED.status END, updated_at = NOW()
          WHERE EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = groups.connection_id AND c.tenant_id = groups.tenant_id
            AND c.assigned_worker_id = $6 AND c.lease_epoch = $7 AND c.lease_expires_at > NOW())
          RETURNING id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at;`;
        const { rows } = await this.pool.query(sql, [tenantId, connectionId, whatsappJid, name, status, fence.workerId, fence.leaseEpoch]);
        return rows[0] || null;
    }

    async findByIdForTenant(id, tenantId) {
        if (!id || !tenantId) return null;
        const sql = `
            SELECT id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at
            FROM groups
            WHERE id = $1 AND tenant_id = $2;
        `;
        const { rows } = await this.pool.query(sql, [id, tenantId]);
        return rows[0] || null;
    }

    async findByJidForTenant(whatsappJid, tenantId) {
        if (!whatsappJid || !tenantId) return null;
        const sql = `
            SELECT id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at
            FROM groups
            WHERE whatsapp_jid = $1 AND tenant_id = $2;
        `;
        const { rows } = await this.pool.query(sql, [whatsappJid, tenantId]);
        return rows[0] || null;
    }

    async listForTenant(tenantId, filter = {}) {
        if (!tenantId) return [];
        let sql = `
            SELECT id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at
            FROM groups
            WHERE tenant_id = $1
        `;
        const params = [tenantId];

        if (filter.status) {
            params.push(filter.status);
            sql += ` AND status = $${params.length}`;
        }
        if (filter.connectionId) {
            params.push(filter.connectionId);
            sql += ` AND connection_id = $${params.length}`;
        }

        sql += ' ORDER BY created_at ASC;';
        const { rows } = await this.pool.query(sql, params);
        return rows;
    }

    async listByConnectionForTenant(connectionId, tenantId) {
        return this.listForTenant(tenantId, { connectionId });
    }

    async updateStatusForTenant(id, tenantId, status) {
        if (!id || !tenantId) return null;
        const validStatuses = ['DISCOVERED', 'MANAGED', 'UNMANAGED'];
        if (!validStatuses.includes(status)) {
            throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
        }
        const sql = `
            UPDATE groups
            SET status = $1, updated_at = NOW()
            WHERE id = $2 AND tenant_id = $3
            RETURNING id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at;
        `;
        const { rows } = await this.pool.query(sql, [status, id, tenantId]);
        return rows[0] || null;
    }

    async updateStatusForWorker(id, tenantId, status, { workerId, leaseEpoch }) {
        const sql = `UPDATE groups g SET status = $1, updated_at = NOW()
          WHERE g.id = $2 AND g.tenant_id = $3
            AND EXISTS (SELECT 1 FROM whatsapp_connections c
              WHERE c.id = g.connection_id AND c.tenant_id = g.tenant_id
                AND c.assigned_worker_id = $4 AND c.lease_epoch = $5 AND c.lease_expires_at > NOW())
          RETURNING id, tenant_id, connection_id, whatsapp_jid, name, status, created_at, updated_at;`;
        const { rows } = await this.pool.query(sql, [status, id, tenantId, workerId, leaseEpoch]);
        return rows[0] || null;
    }

    async deleteForTenant(id, tenantId) {
        if (!id || !tenantId) return null;
        const sql = `
            DELETE FROM groups
            WHERE id = $1 AND tenant_id = $2
            RETURNING id;
        `;
        const { rows } = await this.pool.query(sql, [id, tenantId]);
        return rows[0] || null;
    }
}

module.exports = GroupRepository;
