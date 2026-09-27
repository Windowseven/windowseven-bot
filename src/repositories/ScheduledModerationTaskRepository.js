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
            'SELECT status, claimed_by_worker_id, claim_epoch, remote_started_at FROM scheduled_moderation_tasks WHERE id = $1;',
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
            SELECT id, status, remote_started_at, connection_id, attempt_count, max_attempts
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

        // If candidate is a stale processing claim, classify by remote boundary
        if (candidate.status === 'PROCESSING') {
            if (candidate.remote_started_at) {
                // Class B: Remote mutation was initiated. NEVER blind retry!
                await client.query(`
                    UPDATE scheduled_moderation_tasks
                    SET status = 'REMOTE_OUTCOME_UNKNOWN',
                        last_error = 'CLAIM_EXPIRED_REMOTE_OUTCOME_UNKNOWN',
                        updated_at = NOW()
                    WHERE id = $1;
                `, [candidate.id]);
                return null;
            }

            // Class A: Remote mutation was never initiated
            if (candidate.attempt_count >= candidate.max_attempts) {
                await client.query(`
                    UPDATE scheduled_moderation_tasks
                    SET status = 'FAILED',
                        last_error = 'EXCEEDED_MAX_ATTEMPTS',
                        updated_at = NOW()
                    WHERE id = $1;
                `, [candidate.id]);
                return null;
            }
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
     * Reaps expired processing scheduled tasks according to Class A and Class B boundaries.
     * Class A (remote_started_at IS NULL): safely resets to PENDING if attempts remain, or fails.
     * Class B (remote_started_at IS NOT NULL): transitions to REMOTE_OUTCOME_UNKNOWN.
     *
     * @param {import('pg').PoolClient|import('pg').Pool} [dbClient]
     * @param {object} [params]
     * @param {string[]} [params.connectionIds]
     * @returns {Promise<{ classARequeued: number, classAFailed: number, classBUnknown: number }>}
     */
    async reapStaleTasks(dbClient, { connectionIds = null } = {}) {
        const client = dbClient || this.pool;
        const connFilter = Array.isArray(connectionIds) && connectionIds.length > 0
            ? 'AND connection_id = ANY($1)'
            : '';
        const params = Array.isArray(connectionIds) && connectionIds.length > 0 ? [connectionIds] : [];

        // 1. Class A: Expired PROCESSING with attempts remaining and remote_started_at IS NULL -> PENDING
        const classARequeueSql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'PENDING',
                claimed_by_worker_id = NULL,
                claim_epoch = NULL,
                claim_expires_at = NULL,
                next_attempt_at = NOW(),
                updated_at = NOW()
            WHERE status = 'PROCESSING'
              AND claim_expires_at < NOW()
              AND remote_started_at IS NULL
              AND attempt_count < max_attempts
              ${connFilter}
            RETURNING id;
        `;
        const resA = await client.query(classARequeueSql, params);

        // 2. Class A Terminal: Expired PROCESSING with attempts exhausted and remote_started_at IS NULL -> FAILED
        const classAFailSql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'FAILED',
                last_error = 'EXCEEDED_MAX_ATTEMPTS',
                updated_at = NOW()
            WHERE status = 'PROCESSING'
              AND claim_expires_at < NOW()
              AND remote_started_at IS NULL
              AND attempt_count >= max_attempts
              ${connFilter}
            RETURNING id;
        `;
        const resAFail = await client.query(classAFailSql, params);

        // 3. Class B: Expired PROCESSING with remote_started_at IS NOT NULL -> REMOTE_OUTCOME_UNKNOWN
        const classBSql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'REMOTE_OUTCOME_UNKNOWN',
                last_error = 'CLAIM_EXPIRED_REMOTE_OUTCOME_UNKNOWN',
                updated_at = NOW()
            WHERE status = 'PROCESSING'
              AND claim_expires_at < NOW()
              AND remote_started_at IS NOT NULL
              ${connFilter}
            RETURNING id;
        `;
        const resB = await client.query(classBSql, params);

        return {
            classARequeued: resA.rows.length,
            classAFailed: resAFail.rows.length,
            classBUnknown: resB.rows.length,
        };
    }

    /**
     * Finds a scheduled moderation task by ID across the platform.
     */
    async findById(id, dbClient = null) {
        if (!id) return null;
        const client = dbClient || this.pool;
        const sql = `
            SELECT id, tenant_id, group_id, connection_id, action, payload, run_at,
                   status, attempt_count, max_attempts, last_attempt_at, next_attempt_at,
                   claimed_by_worker_id, claim_epoch, claim_expires_at,
                   remote_started_at, executed_at, last_error, created_at, updated_at
            FROM scheduled_moderation_tasks
            WHERE id = $1;
        `;
        const { rows } = await client.query(sql, [id]);
        return rows[0] || null;
    }

    /**
     * Finds tasks for a connection with status REMOTE_OUTCOME_UNKNOWN eligible for verification.
     */
    async findUnknownTasksForConnection(dbClient, connectionId) {
        const client = dbClient || this.pool;
        const sql = `
            SELECT * FROM scheduled_moderation_tasks
            WHERE connection_id = $1 AND status = 'REMOTE_OUTCOME_UNKNOWN'
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            ORDER BY run_at ASC;
        `;
        const { rows } = await client.query(sql, [connectionId]);
        return rows;
    }

    /**
     * Atomically records a transient verification attempt for a task in REMOTE_OUTCOME_UNKNOWN.
     * Keeps status as REMOTE_OUTCOME_UNKNOWN and schedules next verification attempt.
     */
    async recordUnknownTaskVerificationAttempt(dbClient, { id, workerId, claimEpoch, error = null, backoffSeconds = 10 }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET attempt_count = attempt_count + 1,
                last_error = $4,
                next_attempt_at = NOW() + ($5 || ' seconds')::interval,
                updated_at = NOW()
            WHERE id = $1
              AND status = 'REMOTE_OUTCOME_UNKNOWN'
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id, attempt_count, next_attempt_at;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, error, backoffSeconds]);
        return rows.length === 1;
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch]);
        return rows.length === 1;
    }

    /**
     * Claim-fenced stale-generation requeue.
     * Strictly rejects requeueing mutating tasks where remote_started_at IS NOT NULL.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim or prohibited
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND remote_started_at IS NULL
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
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
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
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
                  AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
                  AND (
                      (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                      OR
                      (status = 'REMOTE_OUTCOME_UNKNOWN')
                  )
                  AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id, status;
        `;
        const { rows } = await client.query(retrySql, [id, workerId, claimEpoch, error, backoffSeconds]);
        if (rows.length === 0) return false;
        return rows[0].status === 'FAILED' ? 'FAILED' : true;
    }

    async markRemoteOutcomeUnknown(dbClient, { id, workerId, claimEpoch, error = 'REMOTE_OUTCOME_UNKNOWN' }) {
        const client = dbClient || this.pool;
        const sql = `UPDATE scheduled_moderation_tasks SET status = 'REMOTE_OUTCOME_UNKNOWN', last_error = $4, updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3
            AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW()) RETURNING id;`;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, error]);
        return rows.length === 1;
    }

    async markRemoteStarted(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `UPDATE scheduled_moderation_tasks SET remote_started_at = COALESCE(remote_started_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3
            AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = scheduled_moderation_tasks.connection_id
              AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW()) RETURNING id;`;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch]); return rows.length === 1;
    }

    async markRemoteStartedUnknownForWorker(dbClient, { workerId }) {
        const client = dbClient || this.pool;
        const { rows } = await client.query(`UPDATE scheduled_moderation_tasks SET status = 'REMOTE_OUTCOME_UNKNOWN', last_error = 'DRAIN_GRACE_EXPIRED', updated_at = NOW() WHERE status = 'PROCESSING' AND claimed_by_worker_id = $1 AND remote_started_at IS NOT NULL RETURNING id`, [workerId]);
        return rows.length;
    }

    /**
     * Pauses all PENDING scheduled moderation tasks for a tenant.
     * @param {import('pg').PoolClient|import('pg').Pool} [dbClient]
     * @param {string} tenantId
     * @returns {Promise<number>} Number of tasks paused
     */
    async pauseTasksForTenant(dbClient, tenantId) {
        if (!tenantId) throw new Error('tenantId is required');
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'PAUSED',
                updated_at = NOW()
            WHERE tenant_id = $1
              AND status = 'PENDING'
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [tenantId]);
        return rows.length;
    }

    /**
     * Resumes all PAUSED scheduled moderation tasks for a tenant back to PENDING.
     * Sets next_attempt_at = NOW() so overdue tasks are evaluated immediately.
     * @param {import('pg').PoolClient|import('pg').Pool} [dbClient]
     * @param {string} tenantId
     * @returns {Promise<number>} Number of tasks resumed
     */
    async resumeTasksForTenant(dbClient, tenantId) {
        if (!tenantId) throw new Error('tenantId is required');
        const client = dbClient || this.pool;
        const sql = `
            UPDATE scheduled_moderation_tasks
            SET status = 'PENDING',
                next_attempt_at = NOW(),
                updated_at = NOW()
            WHERE tenant_id = $1
              AND status = 'PAUSED'
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [tenantId]);
        return rows.length;
    }
}

module.exports = ScheduledModerationTaskRepository;
