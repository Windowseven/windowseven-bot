class ConnectionCommandRepository {
    constructor(pool) {
        if (!pool) throw new Error('[ConnectionCommandRepository] Database pool is required');
        this.pool = pool;
    }

    /**
     * Persists a new durable command. Can be called with a transaction client or pool.
     */
    async createCommand(dbClient, { tenantId, connectionId, groupId = null, commandType, payload = {}, requestedByUserId = null }) {
        if (!tenantId || !connectionId || !commandType) {
            throw new Error('tenantId, connectionId, and commandType are required');
        }

        const sql = `
            INSERT INTO connection_commands (
                tenant_id, connection_id, group_id, command_type, payload,
                requested_by_user_id, status, next_attempt_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
            RETURNING id, tenant_id, connection_id, group_id, command_type, payload,
                      status, attempt_count, max_attempts, next_attempt_at, created_at;
        `;

        const client = dbClient || this.pool;
        const { rows } = await client.query(sql, [
            tenantId,
            connectionId,
            groupId,
            commandType,
            JSON.stringify(payload),
            requestedByUserId,
        ]);
        return rows[0];
    }

    /**
     * Finds a command by ID strictly scoped to a tenant (for polling / status retrieval).
     */
    async findByIdForTenant(id, tenantId) {
        if (!id || !tenantId) return null;
        const sql = `
            SELECT id, tenant_id, connection_id, group_id, command_type, payload,
                   status, attempt_count, max_attempts, last_attempt_at, next_attempt_at,
                   claimed_by_worker_id, claim_epoch, claim_expires_at,
                   executed_at, result, last_error, created_at, updated_at
            FROM connection_commands
            WHERE id = $1 AND tenant_id = $2;
        `;
        const { rows } = await this.pool.query(sql, [id, tenantId]);
        return rows[0] || null;
    }

    /**
     * Atomically claims an eligible pending command or recovers a stale processing command.
     * Uses FOR UPDATE SKIP LOCKED to prevent concurrent workers from claiming the same row.
     *
     * @param {import('pg').PoolClient} client
     * @param {object} params
     * @param {string} params.connectionId
     * @param {string} params.workerId
     * @param {number} params.claimEpoch
     * @returns {Promise<object|null>} Claimed command or null
     */
    async claimCommandForConnection(client, { connectionId, workerId, claimEpoch }) {
        if (!client || !connectionId || !workerId || !claimEpoch) {
            throw new Error('client, connectionId, workerId, and claimEpoch are required');
        }

        const selectSql = `
            SELECT id, attempt_count, max_attempts
            FROM connection_commands
            WHERE connection_id = $1
              AND (
                  (status = 'PENDING' AND next_attempt_at <= NOW())
                  OR
                  (status = 'PROCESSING' AND claim_expires_at < NOW())
              )
            ORDER BY created_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
        `;

        const selected = await client.query(selectSql, [connectionId]);
        if (selected.rows.length === 0) {
            return null;
        }

        const candidate = selected.rows[0];

        // If stale processing claim has exceeded max attempts, fail it instead of re-claiming
        if (candidate.attempt_count >= candidate.max_attempts) {
            await client.query(`
                UPDATE connection_commands
                SET status = 'FAILED',
                    last_error = 'EXCEEDED_MAX_RETRIES',
                    updated_at = NOW()
                WHERE id = $1;
            `, [candidate.id]);
            return null;
        }

        const updateSql = `
            UPDATE connection_commands
            SET status = 'PROCESSING',
                claimed_by_worker_id = $2,
                claim_epoch = $3,
                claim_expires_at = NOW() + INTERVAL '30 seconds',
                attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, tenant_id, connection_id, group_id, command_type, payload,
                      status, attempt_count, max_attempts, claim_epoch, claimed_by_worker_id;
        `;

        const { rows } = await client.query(updateSql, [candidate.id, workerId, claimEpoch]);
        return rows[0] || null;
    }

    /**
     * Atomically marks a command COMPLETED, fenced by workerId and claimEpoch.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async completeCommand(dbClient, { id, workerId, claimEpoch, result = {} }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE connection_commands
            SET status = 'COMPLETED',
                executed_at = NOW(),
                result = $4,
                updated_at = NOW()
            WHERE id = $1
              AND status = 'PROCESSING'
              AND claimed_by_worker_id = $2
              AND claim_epoch = $3
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, JSON.stringify(result)]);
        return rows.length === 1;
    }

    /**
     * Claim-fenced stale-generation requeue (Correction 2).
     * Only succeeds if the worker still holds the exact claim.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async requeueStaleCommand(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE connection_commands
            SET status = 'PENDING',
                claimed_by_worker_id = NULL,
                claim_epoch = NULL,
                claim_expires_at = NULL,
                next_attempt_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
              AND status = 'PROCESSING'
              AND claimed_by_worker_id = $2
              AND claim_epoch = $3
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch]);
        return rows.length === 1;
    }

    /**
     * Handles command failure with exponential backoff or terminal failure.
     * Claim-fenced: verifies workerId and claimEpoch.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async failCommand(dbClient, { id, workerId, claimEpoch, error, isTerminal = false, backoffSeconds = 5 }) {
        const client = dbClient || this.pool;

        if (isTerminal) {
            const terminalSql = `
                UPDATE connection_commands
                SET status = 'FAILED',
                    last_error = $4,
                    updated_at = NOW()
                WHERE id = $1
                  AND status = 'PROCESSING'
                  AND claimed_by_worker_id = $2
                  AND claim_epoch = $3
                RETURNING id;
            `;
            const { rows } = await client.query(terminalSql, [id, workerId, claimEpoch, error]);
            return rows.length === 1;
        }

        // Retryable: return to PENDING with next_attempt_at in the future
        const retrySql = `
            UPDATE connection_commands
            SET status = CASE 
                    WHEN attempt_count >= max_attempts THEN 'FAILED'
                    ELSE 'PENDING'
                END,
                claimed_by_worker_id = NULL,
                claim_epoch = NULL,
                claim_expires_at = NULL,
                next_attempt_at = NOW() + ($5 || ' seconds')::interval,
                last_error = $4,
                updated_at = NOW()
            WHERE id = $1
              AND status = 'PROCESSING'
              AND claimed_by_worker_id = $2
              AND claim_epoch = $3
            RETURNING id, status;
        `;
        const { rows } = await client.query(retrySql, [id, workerId, claimEpoch, error, backoffSeconds]);
        return rows.length === 1;
    }
}

module.exports = ConnectionCommandRepository;
