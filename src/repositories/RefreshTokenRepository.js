/**
 * Windowseven MD Refresh Token Repository
 * Manages persistence, row locking, and lifecycle of refresh tokens.
 */
class RefreshTokenRepository {
    constructor(pool) {
        this.pool = pool;
    }

    /**
     * Inserts a new refresh token record.
     */
    async create({ userId, tokenHash, familyId, expiresAt, replacedByTokenId = null }, client = null) {
        const executor = client || this.pool;
        const sql = `
            INSERT INTO refresh_tokens (user_id, token_hash, family_id, replaced_by_token_id, expires_at)
            VALUES ($1, $2, $3, $4, $5)
            RETURNING id, user_id, token_hash, family_id, replaced_by_token_id, revoked_at, expires_at, created_at;
        `;
        const { rows } = await executor.query(sql, [userId, tokenHash, familyId, replacedByTokenId, expiresAt]);
        return rows[0];
    }

    /**
     * Look up token by SHA-256 hash.
     */
    async findByHash(tokenHash, client = null) {
        const executor = client || this.pool;
        const sql = `
            SELECT id, user_id, token_hash, family_id, replaced_by_token_id, revoked_at, expires_at, created_at
            FROM refresh_tokens
            WHERE token_hash = $1;
        `;
        const { rows } = await executor.query(sql, [tokenHash]);
        return rows[0] || null;
    }

    /**
     * Look up token by hash with row-level lock (FOR UPDATE).
     * Must be called within an active transaction client.
     */
    async findByHashForUpdate(client, tokenHash) {
        if (!client) {
            throw new Error('Transaction client is required for findByHashForUpdate');
        }
        const sql = `
            SELECT id, user_id, token_hash, family_id, replaced_by_token_id, revoked_at, expires_at, created_at
            FROM refresh_tokens
            WHERE token_hash = $1
            FOR UPDATE;
        `;
        const { rows } = await client.query(sql, [tokenHash]);
        return rows[0] || null;
    }

    /**
     * Atomically rotates a refresh token inside a transaction.
     */
    async rotate({ client, oldTokenId, newTokenHash, userId, familyId, expiresAt }) {
        if (!client) {
            throw new Error('Transaction client is required for rotate');
        }

        // 1. Insert new successor token
        const insertSql = `
            INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
            VALUES ($1, $2, $3, $4)
            RETURNING id, user_id, token_hash, family_id, replaced_by_token_id, revoked_at, expires_at, created_at;
        `;
        const { rows: newRows } = await client.query(insertSql, [userId, newTokenHash, familyId, expiresAt]);
        const newToken = newRows[0];

        // 2. Revoke old token and set replaced_by_token_id
        const updateSql = `
            UPDATE refresh_tokens
            SET revoked_at = NOW(),
                replaced_by_token_id = $1
            WHERE id = $2
            RETURNING id, user_id, token_hash, family_id, replaced_by_token_id, revoked_at, expires_at, created_at;
        `;
        const { rows: oldRows } = await client.query(updateSql, [newToken.id, oldTokenId]);

        return {
            oldToken: oldRows[0],
            newToken,
        };
    }

    /**
     * Revokes all tokens belonging to a family (used when token reuse/theft is detected).
     */
    async revokeFamily(familyId, client = null) {
        const executor = client || this.pool;
        const sql = `
            UPDATE refresh_tokens
            SET revoked_at = NOW()
            WHERE family_id = $1 AND revoked_at IS NULL
            RETURNING id;
        `;
        const { rows } = await executor.query(sql, [familyId]);
        return rows.length;
    }

    /**
     * Revokes all active refresh tokens for a user (e.g. on full logout).
     */
    async revokeAllForUser(userId, client = null) {
        const executor = client || this.pool;
        const sql = `
            UPDATE refresh_tokens
            SET revoked_at = NOW()
            WHERE user_id = $1 AND revoked_at IS NULL
            RETURNING id;
        `;
        const { rows } = await executor.query(sql, [userId]);
        return rows.length;
    }
}

module.exports = RefreshTokenRepository;
