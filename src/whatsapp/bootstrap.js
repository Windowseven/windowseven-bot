const { getPool, closePool } = require('../database/client');

/**
 * Idempotently resolves or provisions the transitional Tenant and WhatsAppConnection
 * for the Windowseven MD runtime during transition to multi-tenancy.
 *
 * Guarantees:
 * - Never creates duplicate tenants or connections across repeated invocations.
 * - Does NOT use phone number as the tenant identity.
 * - Returns existing records if already provisioned.
 *
 * @param {import('pg').Pool} pool - PostgreSQL pool
 * @param {object} [options] - Optional overrides (phoneNumber, botName)
 * @returns {Promise<{ tenant: object, connection: object }>}
 */
async function bootstrapTransitionalConnection(pool, options = {}) {
    const p = pool || getPool();
    const client = await p.connect();

    try {
        await client.query('BEGIN');

        // 1. Resolve or create transitional workspace tenant
        let tenant;
        const tenantRes = await client.query(
            "SELECT id, name, created_at FROM tenants WHERE name = 'Transitional Workspace' LIMIT 1;"
        );

        if (tenantRes.rows.length > 0) {
            tenant = tenantRes.rows[0];
        } else {
            const insertTenantRes = await client.query(
                "INSERT INTO tenants (name) VALUES ('Transitional Workspace') RETURNING id, name, created_at;"
            );
            tenant = insertTenantRes.rows[0];
        }

        // 2. Resolve or create transitional connection under this tenant
        let connection;
        const connRes = await client.query(
            'SELECT id, tenant_id, phone_number, display_name, status FROM whatsapp_connections WHERE tenant_id = $1 LIMIT 1;',
            [tenant.id]
        );

        if (connRes.rows.length > 0) {
            connection = connRes.rows[0];
        } else {
            const phone = options.phoneNumber || process.env.BOT_PHONE_NUMBER || null;
            const displayName = options.botName || process.env.BOT_NAME || 'Primary Windowseven Bot';
            const insertConnRes = await client.query(
                `INSERT INTO whatsapp_connections (tenant_id, phone_number, display_name, status)
                 VALUES ($1, $2, $3, 'CREATED')
                 RETURNING id, tenant_id, phone_number, display_name, status;`,
                [tenant.id, phone, displayName]
            );
            connection = insertConnRes.rows[0];
        }

        await client.query('COMMIT');
        return { tenant, connection };
    } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Failed to bootstrap transitional connection: ${err.message}`);
    } finally {
        client.release();
    }
}

// CLI handler
if (require.main === module) {
    (async () => {
        try {
            const result = await bootstrapTransitionalConnection();
            console.log('[Windowseven MD Bootstrap] Successfully resolved transitional connection:');
            console.log('  Tenant:', result.tenant);
            console.log('  Connection:', result.connection);
        } catch (err) {
            console.error('[Windowseven MD Bootstrap] Error:', err.message);
            process.exit(1);
        } finally {
            await closePool();
        }
    })();
}

module.exports = {
    bootstrapTransitionalConnection,
};
