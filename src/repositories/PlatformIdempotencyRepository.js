const crypto = require('node:crypto');

/**
 * Recursively sorts keys of an object to produce deterministic canonical JSON.
 * @param {any} val
 * @returns {any}
 */
function canonicalizeJson(val) {
    if (val === null || typeof val !== 'object') {
        return val;
    }
    if (Array.isArray(val)) {
        return val.map(canonicalizeJson);
    }
    const sortedKeys = Object.keys(val).sort();
    const result = {};
    for (const key of sortedKeys) {
        result[key] = canonicalizeJson(val[key]);
    }
    return result;
}

/**
 * Computes deterministic SHA-256 hash for an HTTP request in the platform domain.
 * @param {string} method
 * @param {string} route
 * @param {object|null} body
 * @returns {string}
 */
function computePlatformRequestHash(method, route, body = null) {
    const normMethod = (method || '').trim().toUpperCase();
    const normRoute = (route || '').trim().toLowerCase();
    const canonBody = body ? JSON.stringify(canonicalizeJson(body)) : '';
    return crypto.createHash('sha256')
        .update(`${normMethod}:${normRoute}:${canonBody}`)
        .digest('hex');
}

class PlatformIdempotencyRepository {
    constructor(pool) {
        if (!pool) throw new Error('[PlatformIdempotencyRepository] Database pool is required');
        this.pool = pool;
    }

    /**
     * Atomically reserves a platform-scoped idempotency key.
     * Must be called within a database transaction client or pool.
     *
     * @param {import('pg').PoolClient|import('pg').Pool} dbClient
     * @param {object} params
     * @param {string} params.actorUserId
     * @param {string} params.idempotencyKey
     * @param {string} params.requestHash
     * @returns {Promise<{ isNew: boolean, record: object }>}
     */
    async reserveKey(dbClient, { actorUserId, idempotencyKey, requestHash }) {
        if (!actorUserId || !idempotencyKey || !requestHash) {
            throw new Error('actorUserId, idempotencyKey, and requestHash are required');
        }

        const insertSql = `
            INSERT INTO platform_idempotency_keys (
                actor_user_id, idempotency_key, request_hash, status, created_at, expires_at
            )
            VALUES ($1, $2, $3, 'PENDING', NOW(), NOW() + INTERVAL '24 hours')
            ON CONFLICT (actor_user_id, idempotency_key)
            DO NOTHING
            RETURNING id, actor_user_id, idempotency_key, request_hash, status, created_at, expires_at;
        `;

        const { rows } = await dbClient.query(insertSql, [actorUserId, idempotencyKey, requestHash]);
        if (rows.length > 0) {
            return { isNew: true, record: rows[0] };
        }

        // Conflict: fetch existing record
        const selectSql = `
            SELECT id, actor_user_id, idempotency_key, request_hash, status,
                   response_status_code, response_body, created_at, expires_at
            FROM platform_idempotency_keys
            WHERE actor_user_id = $1 AND idempotency_key = $2;
        `;
        const existing = await dbClient.query(selectSql, [actorUserId, idempotencyKey]);
        return { isNew: false, record: existing.rows[0] };
    }

    /**
     * Completes an idempotency key with its response code and body.
     *
     * @param {import('pg').PoolClient|import('pg').Pool} dbClient
     * @param {object} params
     * @param {string} params.id
     * @param {number} params.statusCode
     * @param {object} params.responseBody
     */
    async completeKey(dbClient, { id, statusCode, responseBody }) {
        const sql = `
            UPDATE platform_idempotency_keys
            SET status = 'COMPLETED',
                response_status_code = $1,
                response_body = $2::jsonb
            WHERE id = $3
            RETURNING id, status, response_status_code, response_body;
        `;
        const { rows } = await dbClient.query(sql, [statusCode, JSON.stringify(responseBody || {}), id]);
        return rows[0];
    }
}

module.exports = {
    PlatformIdempotencyRepository,
    computePlatformRequestHash,
    canonicalizeJson,
};
