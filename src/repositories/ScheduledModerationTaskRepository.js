class ScheduledModerationTaskRepository {
    constructor(pool) {
        if (!pool) throw new Error('[ScheduledModerationTaskRepository] Database pool is required');
        this.pool = pool;
    }

    /**
     * Persists a new scheduled moderation task.
     */
    async createTask(dbClient, { tenantId, groupId, connectionId, action = 'UNMUTE_GROUP', payload = {}, runAt }) {
        if (!tenantId || !groupId || !connectionId || !runAt) {
            throw new Error('tenantId, groupId, connectionId, and runAt are required');
        }

        const sql = `
            INSERT INTO scheduled_moderation_tasks (
                tenant_id, group_id, connection_id, action, payload, run_at, status, next_attempt_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, 'PENDING', NOW())
            RETURNING id, tenant_id, group_id, connection_id, action, payload,
                      run_at, status, attempt_count, max_attempts, next_attempt_at, created_at;
        `;

        const client = dbClient || this.pool;
        const { rows } = await client.query(sql, [
            tenantId,
            groupId,
            connectionId,
            action,
            JSON.stringify(payload),
            runAt,
        ]);
        return rows[0];
    }

    /**
     * Cancels pending scheduled tasks for a group (e.g. on manual unmute or group unmanaged).
     * @param {import('pg').PoolClient|import('pg').Pool} dbClient
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.groupId
     * @param {string} [params.action]
     * @param {boolean} [params.includeProcessing] - If true, marks PROCESSING tasks cancelled too
     */
    async cancelTasksForGroup(dbClient, { tenantId, groupId, action = 'UNMUTE_GROUP', includeProcessing = false }) {
        const client = dbClient || this.pool;
        const statuses = includeProcessing ? ['PENDING', 'PROCESSING'] : ['PENDING'];
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'CANCELLED',
                updated_at = NOW()
            WHERE tenant_id = $1
              AND group_id = $2
              AND action = $3
              AND status = ANY($4)
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [tenantId, groupId, action, statuses]);
        return rows.length;
    }

    /**
     * Checks status of a task immediately before invoking WhatsApp gateway.
     */
    async getTaskStatus(id) {
        const { rows } = await this.pool.query(
            'SELECT status, claimed_by_worker_id, claim_epoch FROM scheduled_moderation_tasks WHERE id = $1;',
            [id]
        );
        return rows[0] || null;
    }

    /**
     * Atomically claims an eligible pending or stale scheduled task for the worker's active connections.
     * Enforces that both run_at <= NOW() AND next_attempt_at <= NOW().
     */
    async claimNextTask(client, { connectionIds, workerId, getLeaseEpochForConnection }) {
        if (!client || !Array.isArray(connectionIds) || connectionIds.length === 0 || !workerId) {
            return null;
        }

        const selectSql = `
            SELECT id, connection_id, attempt_count, max_attempts
            FROM scheduled_moderation_tasks
            WHERE connection_id = ANY($1)
              AND (
                  (status = 'PENDING' AND run_at <= NOW() AND next_attempt_at <= NOW())
                  OR
                  (status = 'PROCESSING' AND claim_expires_at < NOW())
              )
            ORDER BY run_at ASC
            LIMIT 1
            FOR UPDATE SKIP LOCKED;
        `;

        const selected = await client.query(selectSql, [connectionIds]);
        if (selected.rows.length === 0) {
            return null;
        }

        const candidate = selected.rows[0];

        // Terminal retry check for stale processing tasks
        if (candidate.attempt_count >= candidate.max_attempts) {
            await client.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'FAILED',
                    last_error = 'EXCEEDED_MAX_RETRIES',
                    updated_at = NOW()
                WHERE id = $1;
            `, [candidate.id]);
            return null;
        }

        const claimEpoch = typeof getLeaseEpochForConnection === 'function'
            ? getLeaseEpochForConnection(candidate.connection_id)
            : 1;

        const updateSql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'PROCESSING',
                claimed_by_worker_id = $2,
                claim_epoch = $3,
                claim_expires_at = NOW() + INTERVAL '30 seconds',
                attempt_count = attempt_count + 1,
                last_attempt_at = NOW(),
                updated_at = NOW()
            WHERE id = $1
            RETURNING id, tenant_id, group_id, connection_id, action, payload,
                      run_at, status, attempt_count, max_attempts, claim_epoch, claimed_by_worker_id;
        `;

        const { rows } = await client.query(updateSql, [candidate.id, workerId, claimEpoch]);
        return rows[0] || null;
    }

    /**
     * Atomically marks a scheduled task COMPLETED, fenced by workerId and claimEpoch.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async completeTask(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'COMPLETED',
                executed_at = NOW(),
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
     * Claim-fenced stale-generation requeue.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async requeueStaleTask(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
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
     * Atomically marks a scheduled task CANCELLED, fenced by workerId and claimEpoch.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim
     */
    async cancelTask(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'CANCELLED',
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
     * Handles task failure with exponential backoff or terminal failure.
     */
    async failTask(dbClient, { id, workerId, claimEpoch, error, isTerminal = false, backoffSeconds = 10 }) {
        const client = dbClient || this.pool;

        if (isTerminal) {
            const terminalSql = `
                UPDATE scheduled_moderation_tasks
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

        const retrySql = `
            UPDATE scheduled_moderation_tasks
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

module.exports = ScheduledModerationTaskRepository;
