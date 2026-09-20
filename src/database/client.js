const { Pool } = require('pg');
require('dotenv').config();

let pool = null;

function getConnectionString() {
    if (process.env.NODE_ENV === 'test' && process.env.TEST_DATABASE_URL) {
        return process.env.TEST_DATABASE_URL;
    }
    return process.env.DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_dev';
}

function getPool(customUrl) {
    if (customUrl) {
        return new Pool({ connectionString: customUrl });
    }
    if (!pool) {
        const connectionString = getConnectionString();
        pool = new Pool({
            connectionString,
            max: 10,
            idleTimeoutMillis: 30000,
            connectionTimeoutMillis: 5000,
        });

        pool.on('error', (err) => {
            console.error('[Windowseven MD] Unexpected PostgreSQL pool error:', err.message);
        });
    }
    return pool;
}

async function query(text, params) {
    const p = getPool();
    return p.query(text, params);
}

async function getClient() {
    const p = getPool();
    return p.connect();
}

async function closePool() {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

module.exports = {
    getPool,
    query,
    getClient,
    closePool,
    getConnectionString,
};
