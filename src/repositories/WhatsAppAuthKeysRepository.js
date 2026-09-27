const { BufferJSON } = require('@whiskeysockets/baileys');

class WhatsAppAuthKeysRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async getKeys(tenantId, connectionId, keyType, keyIds) {
        if (!tenantId || !connectionId || !keyType || !Array.isArray(keyIds)) {
            throw new Error('tenantId, connectionId, keyType, and keyIds array are required');
        }

        if (keyIds.length === 0) {
            return {};
        }

        const sql = `
            SELECT key_id, key_value
            FROM whatsapp_auth_keys
            WHERE tenant_id = $1
              AND connection_id = $2
              AND key_type = $3
              AND key_id = ANY($4);
        `;

        let rows;
        try {
            const res = await this.pool.query(sql, [tenantId, connectionId, keyType, keyIds]);
            rows = res.rows;
        } catch (err) {
            throw new Error(`Database error fetching keys for connection ${connectionId}: ${err.message}`);
        }

        const result = {};
        for (const row of rows) {
            try {
                result[row.key_id] = JSON.parse(row.key_value, BufferJSON.reviver);
            } catch (err) {
                const corruptionError = new Error(`Corrupted key ${row.key_id} (${keyType}) for connection ${connectionId}: cannot deserialize`);
                corruptionError.isCorrupted = true;
                throw corruptionError;
            }
        }
        return result;
    }

    async setKeys(tenantId, connectionId, data, fence) {
        if (!tenantId || !connectionId || !data || typeof data !== 'object') {
            throw new Error('tenantId, connectionId, and valid data object are required');
        }

        if (!fence?.workerId || fence.leaseEpoch === undefined || fence.leaseEpoch === null) {
            throw new Error('workerId and leaseEpoch are required for worker-owned Signal key persistence');
        }
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const upsertSql = `
                INSERT INTO whatsapp_auth_keys (tenant_id, connection_id, key_type, key_id, key_value)
                SELECT $1, $2, $3, $4, $5
                FROM whatsapp_connections c
                WHERE c.id = $2 AND c.tenant_id = $1
                  AND c.assigned_worker_id = $6 AND c.lease_epoch = $7 AND c.lease_expires_at > NOW()
                ON CONFLICT (connection_id, key_type, key_id)
                DO UPDATE SET
                    key_value = EXCLUDED.key_value,
                    updated_at = NOW()
                WHERE EXISTS (SELECT 1 FROM whatsapp_connections c
                    WHERE c.id = whatsapp_auth_keys.connection_id AND c.tenant_id = whatsapp_auth_keys.tenant_id
                      AND c.assigned_worker_id = $6 AND c.lease_epoch = $7 AND c.lease_expires_at > NOW())
                RETURNING id;
            `;

            const deleteSql = `
                DELETE FROM whatsapp_auth_keys
                WHERE tenant_id = $1 AND connection_id = $2 AND key_type = $3 AND key_id = $4
                  AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = $2 AND c.tenant_id = $1
                    AND c.assigned_worker_id = $5 AND c.lease_epoch = $6 AND c.lease_expires_at > NOW())
                RETURNING id;
            `;

            for (const category of Object.keys(data)) {
                const categoryKeys = data[category] || {};
                for (const keyId of Object.keys(categoryKeys)) {
                    const value = categoryKeys[keyId];
                    if (value !== null && value !== undefined) {
                        const serialized = JSON.stringify(value, BufferJSON.replacer);
                        const result = await client.query(upsertSql, [tenantId, connectionId, category, keyId, serialized, fence.workerId, fence.leaseEpoch]);
                        if (!result.rowCount) throw new Error('Signal key persistence rejected: stale or missing worker lease');
                    } else {
                        const result = await client.query(deleteSql, [tenantId, connectionId, category, keyId, fence.workerId, fence.leaseEpoch]);
                        // Deleting an absent key is valid only after current ownership is proven.
                        if (!result.rowCount) {
                            const ownership = await client.query('SELECT 1 FROM whatsapp_connections WHERE id = $1 AND tenant_id = $2 AND assigned_worker_id = $3 AND lease_epoch = $4 AND lease_expires_at > NOW()', [connectionId, tenantId, fence.workerId, fence.leaseEpoch]);
                            if (!ownership.rowCount) throw new Error('Signal key deletion rejected: stale or missing worker lease');
                        }
                    }
                }
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK');
            throw new Error(`Database error saving keys for connection ${connectionId}: ${err.message}`);
        } finally {
            client.release();
        }
    }

    async deleteKeysForConnection(tenantId, connectionId, fence) {
        if (!tenantId || !connectionId) return 0;
        if (!fence?.workerId || fence.leaseEpoch === undefined || fence.leaseEpoch === null) throw new Error('workerId and leaseEpoch are required for worker-owned Signal key deletion');
        const sql = `
            DELETE FROM whatsapp_auth_keys
            WHERE tenant_id = $1 AND connection_id = $2
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = $2 AND c.tenant_id = $1 AND c.assigned_worker_id = $3 AND c.lease_epoch = $4 AND c.lease_expires_at > NOW());
        `;
        try {
            const res = await this.pool.query(sql, [tenantId, connectionId, fence.workerId, fence.leaseEpoch]);
            return res.rowCount || 0;
        } catch (err) {
            throw new Error(`Database error deleting keys for connection ${connectionId}: ${err.message}`);
        }
    }
}

module.exports = WhatsAppAuthKeysRepository;
