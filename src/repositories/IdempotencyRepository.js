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
 * Computes deterministic SHA-256 hash for an HTTP request.
 * @param {string} method
 * @param {string} route
 * @param {object|null} body
 * @returns {string}
 */
function computeRequestHash(method, route, body = null) {
    const normMethod = (method || '').trim().toUpperCase();
    const normRoute = (route || '').trim().toLowerCase();
    const canonBody = body ? JSON.stringify(canonicalizeJson(body)) : '';
    return crypto.createHash('sha256')
        .update(`${normMethod}:${normRoute}:${canonBody}`)
        .digest('hex');
}

class IdempotencyRepository {
    constructor(pool) {
        if (!pool) throw new Error('[IdempotencyRepository] Database pool is required');
        this.pool = pool;
    }

    /**
     * Atomically reserves an idempotency key.
     * Must be called within a database transaction client or pool.
     *
     * @param {import('pg').PoolClient|import('pg').Pool} dbClient
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.userId
     * @param {string} params.idempotencyKey
     * @param {string} params.requestHash
     * @returns {Promise<{ isNew: boolean, record: object }>}
     */
    async reserveKey(dbClient, { tenantId, userId, idempotencyKey, requestHash }) {
        if (!tenantId || !userId || !idempotencyKey || !requestHash) {
            throw new Error('tenantId, userId, idempotencyKey, and requestHash are required');
        }

        const insertSql = `
            INSERT INTO api_idempotency_keys (
                tenant_id, user_id, idempotency_key, request_hash, status, created_at, expires_at
            )
            VALUES ($1, $2, $3, $4, 'PENDING', NOW(), NOW() + INTERVAL '24 hours')
            ON CONFLICT (tenant_id, user_id, idempotency_key)
            DO NOTHING
            RETURNING id, tenant_id, user_id, idempotency_key, request_hash, status, created_at, expires_at;
        `;

        const { rows } = await dbClient.query(insertSql, [tenantId, userId, idempotencyKey, requestHash]);
        if (rows.length > 0) {
            return { isNew: true, record: rows[0] };
        }

        // Conflict: fetch existing record
        const selectSql = `
            SELECT id, tenant_id, user_id, idempotency_key, request_hash, status,
                   response_status_code, response_body, created_at, expires_at
            FROM api_idempotency_keys
            WHERE tenant_id = $1 AND user_id = $2 AND idempotency_key = $3;
        `;
        const existing = await dbClient.query(selectSql, [tenantId, userId, idempotencyKey]);
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
            UPDATE api_idempotency_keys
            SET status = 'COMPLETED',
                response_status_code = $2,
                response_body = $3
            WHERE id = $1
            RETURNING id, status, response_status_code;
        `;
        const { rows } = await dbClient.query(sql, [id, statusCode, JSON.stringify(responseBody)]);
        return rows[0] || null;
    }

    /**
     * Deletes an idempotency key (e.g. on early validation abort).
     */
    async deleteKey(dbClient, id) {
        await dbClient.query('DELETE FROM api_idempotency_keys WHERE id = $1;', [id]);
    }
}

module.exports = {
    IdempotencyRepository,
    canonicalizeJson,
    computeRequestHash,
};
