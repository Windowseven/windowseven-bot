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

    async setKeys(tenantId, connectionId, data) {
        if (!tenantId || !connectionId || !data || typeof data !== 'object') {
            throw new Error('tenantId, connectionId, and valid data object are required');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const upsertSql = `
                INSERT INTO whatsapp_auth_keys (tenant_id, connection_id, key_type, key_id, key_value)
                VALUES ($1, $2, $3, $4, $5)
                ON CONFLICT (connection_id, key_type, key_id)
                DO UPDATE SET
                    tenant_id = EXCLUDED.tenant_id,
                    key_value = EXCLUDED.key_value,
                    updated_at = NOW();
            `;

            const deleteSql = `
                DELETE FROM whatsapp_auth_keys
                WHERE tenant_id = $1 AND connection_id = $2 AND key_type = $3 AND key_id = $4;
            `;

            for (const category of Object.keys(data)) {
                const categoryKeys = data[category] || {};
                for (const keyId of Object.keys(categoryKeys)) {
                    const value = categoryKeys[keyId];
                    if (value !== null && value !== undefined) {
                        const serialized = JSON.stringify(value, BufferJSON.replacer);
                        await client.query(upsertSql, [tenantId, connectionId, category, keyId, serialized]);
                    } else {
                        await client.query(deleteSql, [tenantId, connectionId, category, keyId]);
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

    async deleteKeysForConnection(tenantId, connectionId) {
        if (!tenantId || !connectionId) return 0;
        const sql = `
            DELETE FROM whatsapp_auth_keys
            WHERE tenant_id = $1 AND connection_id = $2;
        `;
        try {
            const res = await this.pool.query(sql, [tenantId, connectionId]);
            return res.rowCount || 0;
        } catch (err) {
            throw new Error(`Database error deleting keys for connection ${connectionId}: ${err.message}`);
        }
    }
}

module.exports = WhatsAppAuthKeysRepository;
