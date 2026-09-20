const REQUIRED_TABLES = [
    'tenants',
    'whatsapp_connections',
    'groups',
    'group_policies',
    'group_warnings',
    'whatsapp_auth_credentials',
    'whatsapp_auth_keys',
];

/**
 * Verifies that the required database tables exist before runtime startup.
 * Does NOT auto-run migrations; fails closed with an actionable message if schema is missing.
 *
 * @param {import('pg').Pool} pool - PostgreSQL pool
 */
async function verifyRequiredSchema(pool) {
    const { rows } = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name = ANY($1);
    `, [REQUIRED_TABLES]);

    const foundTables = new Set(rows.map((r) => r.table_name));
    const missing = REQUIRED_TABLES.filter((t) => !foundTables.has(t));

    if (missing.length > 0) {
        throw new Error(
            `[Windowseven MD] Required database schema is missing tables: [${missing.join(', ')}]. ` +
            `Please run: npm run db:migrate`
        );
    }
}

module.exports = {
    REQUIRED_TABLES,
    verifyRequiredSchema,
};
