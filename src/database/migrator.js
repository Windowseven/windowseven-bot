const fs = require('fs');
const path = require('path');
const { getPool, closePool } = require('./client');

const MIGRATIONS_DIR = path.resolve(__dirname, 'migrations');

async function ensureMigrationTable(client) {
    await client.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id SERIAL PRIMARY KEY,
            name VARCHAR(255) NOT NULL UNIQUE,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);
}

async function getAppliedMigrations(client) {
    await ensureMigrationTable(client);
    const { rows } = await client.query('SELECT name, applied_at FROM schema_migrations ORDER BY id ASC;');
    return rows;
}

async function migrateUp(targetPool) {
    const pool = targetPool || getPool();
    const client = await pool.connect();
    const appliedList = [];

    try {
        await ensureMigrationTable(client);
        const appliedRows = await getAppliedMigrations(client);
        const appliedNames = new Set(appliedRows.map((r) => r.name));

        const files = fs.readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith('.up.sql'))
            .sort();

        for (const file of files) {
            const migrationName = file.replace(/\.up\.sql$/, '');
            if (!appliedNames.has(migrationName)) {
                const filePath = path.join(MIGRATIONS_DIR, file);
                const sql = fs.readFileSync(filePath, 'utf8');

                await client.query('BEGIN');
                try {
                    await client.query(sql);
                    await client.query('INSERT INTO schema_migrations (name) VALUES ($1);', [migrationName]);
                    await client.query('COMMIT');
                    appliedList.push(migrationName);
                } catch (err) {
                    await client.query('ROLLBACK');
                    throw new Error(`Failed to apply migration ${file}: ${err.message}`);
                }
            }
        }
        return appliedList;
    } finally {
        client.release();
    }
}

async function migrateDown(targetPool, steps = 1) {
    const pool = targetPool || getPool();
    const client = await pool.connect();
    const rolledBackList = [];

    try {
        await ensureMigrationTable(client);
        const { rows } = await client.query(
            'SELECT name FROM schema_migrations ORDER BY id DESC LIMIT $1;',
            [steps]
        );

        for (const row of rows) {
            const migrationName = row.name;
            const downFileName = `${migrationName}.down.sql`;
            const filePath = path.join(MIGRATIONS_DIR, downFileName);

            if (!fs.existsSync(filePath)) {
                throw new Error(`Rollback script not found: ${downFileName}`);
            }

            const sql = fs.readFileSync(filePath, 'utf8');

            await client.query('BEGIN');
            try {
                await client.query(sql);
                await client.query('DELETE FROM schema_migrations WHERE name = $1;', [migrationName]);
                await client.query('COMMIT');
                rolledBackList.push(migrationName);
            } catch (err) {
                await client.query('ROLLBACK');
                throw new Error(`Failed to rollback migration ${downFileName}: ${err.message}`);
            }
        }
        return rolledBackList;
    } finally {
        client.release();
    }
}

async function getMigrationStatus(targetPool) {
    const pool = targetPool || getPool();
    const client = await pool.connect();

    try {
        await ensureMigrationTable(client);
        const appliedRows = await getAppliedMigrations(client);
        const appliedMap = new Map(appliedRows.map((r) => [r.name, r.applied_at]));

        const allUpFiles = fs.readdirSync(MIGRATIONS_DIR)
            .filter((f) => f.endsWith('.up.sql'))
            .sort();

        return allUpFiles.map((file) => {
            const name = file.replace(/\.up\.sql$/, '');
            const applied = appliedMap.has(name);
            return {
                name,
                applied,
                appliedAt: appliedMap.get(name) || null,
            };
        });
    } finally {
        client.release();
    }
}

// CLI handler
if (require.main === module) {
    const command = process.argv[2] || 'up';
    (async () => {
        try {
            if (command === 'up') {
                const applied = await migrateUp();
                console.log(`[Windowseven MD Migrator] Applied ${applied.length} migration(s):`, applied);
            } else if (command === 'down') {
                const steps = parseInt(process.argv[3] || '1', 10);
                const rolledBack = await migrateDown(null, steps);
                console.log(`[Windowseven MD Migrator] Rolled back ${rolledBack.length} migration(s):`, rolledBack);
            } else if (command === 'status') {
                const status = await getMigrationStatus();
                console.log('[Windowseven MD Migrator] Status:');
                status.forEach((s) => {
                    console.log(`  [${s.applied ? 'APPLIED' : 'PENDING'}] ${s.name} ${s.appliedAt ? `(${s.appliedAt.toISOString()})` : ''}`);
                });
            } else {
                console.error(`Unknown command: ${command}. Use 'up', 'down', or 'status'.`);
                process.exit(1);
            }
        } catch (err) {
            console.error('[Windowseven MD Migrator] Error:', err.message);
            process.exit(1);
        } finally {
            await closePool();
        }
    })();
}

module.exports = {
    MIGRATIONS_DIR,
    migrateUp,
    migrateDown,
    getMigrationStatus,
};
