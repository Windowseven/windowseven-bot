const { BufferJSON } = require('@whiskeysockets/baileys');

class WhatsAppAuthCredentialsRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async upsertCredentials(tenantId, connectionId, creds) {
        if (!tenantId || !connectionId || !creds) {
            throw new Error('tenantId, connectionId, and creds are required');
        }

        let serialized;
        try {
            serialized = JSON.stringify(creds, BufferJSON.replacer);
        } catch (err) {
            throw new Error(`Failed to serialize Baileys credentials: ${err.message}`);
        }

        const sql = `
            INSERT INTO whatsapp_auth_credentials (tenant_id, connection_id, credentials)
            VALUES ($1, $2, $3)
            ON CONFLICT (connection_id)
            DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                credentials = EXCLUDED.credentials,
                updated_at = NOW()
            RETURNING connection_id, tenant_id, updated_at;
        `;

        try {
            const { rows } = await this.pool.query(sql, [tenantId, connectionId, serialized]);
            return rows[0];
        } catch (err) {
            throw new Error(`Database error saving credentials for connection ${connectionId}: ${err.message}`);
        }
    }

    async getCredentials(tenantId, connectionId) {
        if (!tenantId || !connectionId) {
            throw new Error('tenantId and connectionId are required');
        }

        const sql = `
            SELECT credentials, updated_at
            FROM whatsapp_auth_credentials
            WHERE tenant_id = $1 AND connection_id = $2;
        `;

        let rows;
        try {
            const res = await this.pool.query(sql, [tenantId, connectionId]);
            rows = res.rows;
        } catch (err) {
            throw new Error(`Database error loading credentials for connection ${connectionId}: ${err.message}`);
        }

        if (!rows || rows.length === 0) {
            return null; // Explicitly: no credentials exist
        }

        try {
            const creds = JSON.parse(rows[0].credentials, BufferJSON.reviver);
            return creds;
        } catch (err) {
            // Stored credentials exist but cannot be parsed - fail closed!
            const corruptionError = new Error(`Corrupted credentials stored for connection ${connectionId}: cannot deserialize`);
            corruptionError.isCorrupted = true;
            throw corruptionError;
        }
    }

    async deleteCredentials(tenantId, connectionId) {
        if (!tenantId || !connectionId) return null;
        const sql = `
            DELETE FROM whatsapp_auth_credentials
            WHERE tenant_id = $1 AND connection_id = $2
            RETURNING connection_id;
        `;
        try {
            const { rows } = await this.pool.query(sql, [tenantId, connectionId]);
            return rows[0] || null;
        } catch (err) {
            throw new Error(`Database error deleting credentials for connection ${connectionId}: ${err.message}`);
        }
    }
}

module.exports = WhatsAppAuthCredentialsRepository;
