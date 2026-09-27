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
            SELECT id, status, remote_started_at, attempt_count, max_attempts
            FROM connection_commands
            WHERE connection_id = $1
              AND (
                  (status = 'PENDING' AND next_attempt_at <= NOW())
                  OR
                  (status = 'PROCESSING' AND claim_expires_at < NOW())
              )
              AND EXISTS (
                  SELECT 1 FROM tenants t
                  WHERE t.id = connection_commands.tenant_id
                    AND t.status = 'ACTIVE'
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

        // If candidate is a stale processing claim, classify by remote boundary
        if (candidate.status === 'PROCESSING') {
            if (candidate.remote_started_at) {
                // Class B: Remote mutation was initiated. NEVER blind retry!
                await client.query(`
                    UPDATE connection_commands
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
                    UPDATE connection_commands
                    SET status = 'FAILED',
                        last_error = 'EXCEEDED_MAX_ATTEMPTS',
                        updated_at = NOW()
                    WHERE id = $1;
                `, [candidate.id]);
                return null;
            }
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
     * Reaps expired processing commands according to Class A and Class B boundaries.
     * Class A (remote_started_at IS NULL): safely resets to PENDING if attempts remain, or fails.
     * Class B (remote_started_at IS NOT NULL): transitions to REMOTE_OUTCOME_UNKNOWN.
     *
     * @param {import('pg').PoolClient|import('pg').Pool} [dbClient]
     * @param {object} [params]
     * @param {string[]} [params.connectionIds]
     * @returns {Promise<{ classARequeued: number, classAFailed: number, classBUnknown: number }>}
     */
    async reapStaleCommands(dbClient, { connectionIds = null } = {}) {
        const client = dbClient || this.pool;
        const connFilter = Array.isArray(connectionIds) && connectionIds.length > 0
            ? 'AND connection_id = ANY($1)'
            : '';
        const params = Array.isArray(connectionIds) && connectionIds.length > 0 ? [connectionIds] : [];

        // 1. Class A: Expired PROCESSING with attempts remaining and remote_started_at IS NULL -> PENDING
        const classARequeueSql = `
            UPDATE connection_commands
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
            UPDATE connection_commands
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
            UPDATE connection_commands
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
     * Finds a command by ID across the platform.
     */
    async findById(id, dbClient = null) {
        if (!id) return null;
        const client = dbClient || this.pool;
        const sql = `
            SELECT id, tenant_id, connection_id, group_id, command_type, payload,
                   status, attempt_count, max_attempts, last_attempt_at, next_attempt_at,
                   claimed_by_worker_id, claim_epoch, claim_expires_at,
                   remote_started_at, executed_at, result, last_error, created_at, updated_at
            FROM connection_commands
            WHERE id = $1;
        `;
        const { rows } = await client.query(sql, [id]);
        return rows[0] || null;
    }

    /**
     * Finds commands for a connection with status REMOTE_OUTCOME_UNKNOWN eligible for verification.
     */
    async findUnknownCommandsForConnection(dbClient, connectionId) {
        const client = dbClient || this.pool;
        const sql = `
            SELECT * FROM connection_commands
            WHERE connection_id = $1 AND status = 'REMOTE_OUTCOME_UNKNOWN'
              AND (next_attempt_at IS NULL OR next_attempt_at <= NOW())
            ORDER BY created_at ASC;
        `;
        const { rows } = await client.query(sql, [connectionId]);
        return rows;
    }

    /**
     * Atomically records a transient verification attempt for a command in REMOTE_OUTCOME_UNKNOWN.
     * Keeps status as REMOTE_OUTCOME_UNKNOWN and schedules next verification attempt.
     */
    async recordUnknownVerificationAttempt(dbClient, { id, workerId, claimEpoch, error = null, backoffSeconds = 10 }) {
        const client = dbClient || this.pool;
        const sql = `
            UPDATE connection_commands
            SET attempt_count = attempt_count + 1,
                last_error = $4,
                next_attempt_at = NOW() + ($5 || ' seconds')::interval,
                updated_at = NOW()
            WHERE id = $1
              AND status = 'REMOTE_OUTCOME_UNKNOWN'
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id, attempt_count, next_attempt_at;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, error, backoffSeconds]);
        return rows.length === 1;
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c
                WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $2
                  AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id;
        `;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, JSON.stringify(result)]);
        return rows.length === 1;
    }

    /**
     * Claim-fenced stale-generation requeue.
     * Strictly rejects requeueing mutating commands where remote_started_at IS NOT NULL.
     * @returns {Promise<boolean>} True if 1 row updated, false if lost claim or prohibited
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND (remote_started_at IS NULL OR command_type = 'SYNC_GROUPS')
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
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
                  AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
                  AND (
                      (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                      OR
                      (status = 'REMOTE_OUTCOME_UNKNOWN')
                  )
                  AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
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
              AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
              AND (
                  (status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3)
                  OR
                  (status = 'REMOTE_OUTCOME_UNKNOWN')
              )
              AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW())
            RETURNING id, status;
        `;
        const { rows } = await client.query(retrySql, [id, workerId, claimEpoch, error, backoffSeconds]);
        if (rows.length === 0) return false;
        return rows[0].status === 'FAILED' ? 'FAILED' : true;
    }

    async markRemoteOutcomeUnknown(dbClient, { id, workerId, claimEpoch, error = 'REMOTE_OUTCOME_UNKNOWN' }) {
        const client = dbClient || this.pool;
        const sql = `UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', last_error = $4, updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3
            AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id
              AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW()) RETURNING id;`;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch, error]);
        return rows.length === 1;
    }

    async markRemoteStarted(dbClient, { id, workerId, claimEpoch }) {
        const client = dbClient || this.pool;
        const sql = `UPDATE connection_commands SET remote_started_at = COALESCE(remote_started_at, NOW()), updated_at = NOW()
          WHERE id = $1 AND status = 'PROCESSING' AND claimed_by_worker_id = $2 AND claim_epoch = $3
            AND EXISTS (SELECT 1 FROM whatsapp_connections c WHERE c.id = connection_commands.connection_id
              AND c.assigned_worker_id = $2 AND c.lease_epoch = $3 AND c.lease_expires_at > NOW()) RETURNING id;`;
        const { rows } = await client.query(sql, [id, workerId, claimEpoch]);
        return rows.length === 1;
    }

    async markRemoteStartedUnknownForWorker(dbClient, { workerId }) {
        const client = dbClient || this.pool;
        const sql = `UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', last_error = 'DRAIN_GRACE_EXPIRED', updated_at = NOW()
          WHERE status = 'PROCESSING' AND claimed_by_worker_id = $1 AND remote_started_at IS NOT NULL RETURNING id;`;
        const { rows } = await client.query(sql, [workerId]);
        return rows.length;
    }
}

module.exports = ConnectionCommandRepository;
