/**
 * Windowseven MD WhatsApp Connection Repository
 * Multi-tenant scoped repository with atomic lease acquisition, generation fencing, and state reconciliation.
 */
class WhatsAppConnectionRepository {
    constructor(pool) {
        this.pool = pool;
    }

    _mapRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            tenantId: row.tenant_id,
            tenant_id: row.tenant_id,
            phoneNumber: row.phone_number,
            phone_number: row.phone_number,
            displayName: row.display_name,
            display_name: row.display_name,
            status: row.status,
            desiredState: row.desired_state,
            desired_state: row.desired_state,
            actualState: row.actual_state,
            actual_state: row.actual_state,
            assignedWorkerId: row.assigned_worker_id,
            assigned_worker_id: row.assigned_worker_id,
            leaseEpoch: row.lease_epoch ? Number(row.lease_epoch) : 1,
            lease_epoch: row.lease_epoch ? Number(row.lease_epoch) : 1,
            leaseExpiresAt: row.lease_expires_at,
            lease_expires_at: row.lease_expires_at,
            lastStatusAt: row.last_status_at,
            last_status_at: row.last_status_at,
            lastErrorCode: row.last_error_code,
            last_error_code: row.last_error_code,
            lastErrorAt: row.last_error_at,
            last_error_at: row.last_error_at,
            createdAt: row.created_at,
            created_at: row.created_at,
            updatedAt: row.updated_at,
            updated_at: row.updated_at,
        };
    }

    async createForTenant(tenantId, {
        phoneNumber = null,
        displayName = null,
        status = 'CREATED',
        desiredState = 'STOPPED',
        actualState = 'UNASSIGNED',
    } = {}) {
        if (!tenantId) {
            throw new Error('tenantId is required');
        }

        const validStatuses = [
            'CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED',
            'UNASSIGNED', 'LEASE_ACQUIRED', 'SOCKET_STARTING', 'QR_PENDING',
            'AUTHENTICATING', 'ACTIVE', 'SOCKET_STOPPING', 'FAILED',
        ];
        if (status && !validStatuses.includes(status)) {
            throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
        }

        const sql = `
            INSERT INTO whatsapp_connections (
                tenant_id, phone_number, display_name, status, desired_state, actual_state, last_status_at
            )
            VALUES ($1, $2, $3, $4, $5, $6, NOW())
            RETURNING *;
        `;
        const { rows } = await this.pool.query(sql, [
            tenantId, phoneNumber, displayName, status, desiredState, actualState,
        ]);
        return this._mapRow(rows[0]);
    }

    async findByIdForTenant(id, tenantId) {
        if (!id || !tenantId) return null;
        const sql = `
            SELECT *
            FROM whatsapp_connections
            WHERE id = $1 AND tenant_id = $2;
        `;
        const { rows } = await this.pool.query(sql, [id, tenantId]);
        return this._mapRow(rows[0]);
    }

    async findById(id) {
        if (!id) return null;
        const sql = `
            SELECT *
            FROM whatsapp_connections
            WHERE id = $1;
        `;
        const { rows } = await this.pool.query(sql, [id]);
        return this._mapRow(rows[0]);
    }

    async listForTenant(tenantId) {
        if (!tenantId) return [];
        const sql = `
            SELECT *
            FROM whatsapp_connections
            WHERE tenant_id = $1
            ORDER BY created_at ASC;
        `;
        const { rows } = await this.pool.query(sql, [tenantId]);
        return rows.map((r) => this._mapRow(r));
    }

    async updateStatusForTenant(id, tenantId, status) {
        if (!id || !tenantId) return null;
        const validStatuses = [
            'CREATED', 'CONNECTING', 'CONNECTED', 'DISCONNECTED',
            'UNASSIGNED', 'LEASE_ACQUIRED', 'SOCKET_STARTING', 'QR_PENDING',
            'AUTHENTICATING', 'ACTIVE', 'SOCKET_STOPPING', 'FAILED',
        ];
        if (status && !validStatuses.includes(status)) {
            throw new Error(`Invalid status: ${status}. Valid statuses: ${validStatuses.join(', ')}`);
        }
        const sql = `
            UPDATE whatsapp_connections
            SET status = $1, updated_at = NOW(), last_status_at = NOW()
            WHERE id = $2 AND tenant_id = $3
            RETURNING *;
        `;
        const { rows } = await this.pool.query(sql, [status, id, tenantId]);
        return this._mapRow(rows[0]);
    }

    async updateDesiredStateForTenant(id, tenantId, desiredState) {
        if (!id || !tenantId || !desiredState) return null;
        const sql = `
            UPDATE whatsapp_connections
            SET desired_state = $1, updated_at = NOW()
            WHERE id = $2 AND tenant_id = $3
            RETURNING *;
        `;
        const { rows } = await this.pool.query(sql, [desiredState, id, tenantId]);
        return this._mapRow(rows[0]);
    }

    async deleteForTenant(id, tenantId) {
        if (!id || !tenantId) return null;
        const sql = `
            DELETE FROM whatsapp_connections
            WHERE id = $1 AND tenant_id = $2
            RETURNING id;
        `;
        const { rows } = await this.pool.query(sql, [id, tenantId]);
        return rows[0] || null;
    }

    /**
     * Atomically acquires a connection lease for a worker.
     * Enforces monotonic generation fencing by incrementing lease_epoch.
     * Prevents split-brain races via PostgreSQL row-level locks on the updated tuple.
     *
     * @param {object} params
     * @param {string} params.connectionId
     * @param {string} params.tenantId
     * @param {string} params.workerId
     * @param {number} [params.leaseDurationSeconds=30]
     * @returns {Promise<object|null>} The acquired connection or null if acquisition failed
     */
    async acquireLease({ connectionId, tenantId, workerId, leaseDurationSeconds = 30 }) {
        if (!connectionId || !workerId) {
            throw new Error('connectionId and workerId are required for lease acquisition');
        }

        const sql = `
            UPDATE whatsapp_connections
            SET assigned_worker_id = $1,
                lease_epoch = lease_epoch + 1,
                lease_expires_at = NOW() + ($2 || ' seconds')::interval,
                actual_state = 'LEASE_ACQUIRED',
                status = 'CONNECTING',
                updated_at = NOW(),
                last_status_at = NOW()
            WHERE id = $3
              AND (tenant_id = $4 OR $4 IS NULL)
              AND (
                assigned_worker_id IS NULL 
                OR lease_expires_at < NOW() 
                OR assigned_worker_id = $1
              )
            RETURNING *;
        `;

        const { rows } = await this.pool.query(sql, [
            workerId,
            String(leaseDurationSeconds),
            connectionId,
            tenantId || null,
        ]);

        return this._mapRow(rows[0]);
    }

    /**
     * Renews an existing lease heartbeat.
     * Only succeeds if the calling worker matches AND the lease_epoch matches AND lease has not expired.
     *
     * @param {object} params
     * @param {string} params.connectionId
     * @param {string} params.workerId
     * @param {number} params.leaseEpoch
     * @param {number} [params.leaseDurationSeconds=30]
     * @returns {Promise<boolean>} True if heartbeat renewed, false if stale/expired
     */
    async renewLease({ connectionId, workerId, leaseEpoch, leaseDurationSeconds = 30 }) {
        if (!connectionId || !workerId || leaseEpoch === undefined || leaseEpoch === null) {
            throw new Error('connectionId, workerId, and leaseEpoch are required for lease renewal');
        }

        const sql = `
            UPDATE whatsapp_connections
            SET lease_expires_at = NOW() + ($1 || ' seconds')::interval,
                updated_at = NOW()
            WHERE id = $2
              AND assigned_worker_id = $3
              AND lease_epoch = $4
              AND lease_expires_at > NOW()
            RETURNING id, assigned_worker_id, lease_epoch, lease_expires_at;
        `;

        const { rows } = await this.pool.query(sql, [
            String(leaseDurationSeconds),
            connectionId,
            workerId,
            leaseEpoch,
        ]);

        return rows.length > 0;
    }

    /**
     * Releases worker lease upon intentional disconnect, worker shutdown, or handoff.
     */
    async releaseLease({ connectionId, workerId, leaseEpoch }) {
        if (!connectionId || !workerId || leaseEpoch === undefined || leaseEpoch === null) {
            throw new Error('connectionId, workerId, and leaseEpoch are required to release lease');
        }

        const sql = `
            UPDATE whatsapp_connections
            SET assigned_worker_id = NULL,
                lease_expires_at = NULL,
                actual_state = 'UNASSIGNED',
                status = 'DISCONNECTED',
                updated_at = NOW(),
                last_status_at = NOW()
            WHERE id = $1
              AND assigned_worker_id = $2
              AND lease_epoch = $3
            RETURNING id;
        `;

        const { rows } = await this.pool.query(sql, [connectionId, workerId, leaseEpoch]);
        return rows.length > 0;
    }

    /**
     * Generation-fenced state mutation.
     * Ensures an old worker generation cannot overwrite connection state after epoch has advanced.
     *
     * @param {object} params
     * @param {string} params.connectionId
     * @param {string} params.workerId
     * @param {number} params.leaseEpoch
     * @param {string} params.actualState
     * @param {string} [params.status]
     * @param {string} [params.lastErrorCode]
     * @returns {Promise<object|null>} Updated connection or null if stale generation rejected
     */
    async updateActualState({ connectionId, workerId, leaseEpoch, actualState, status = null, lastErrorCode = null }) {
        if (!connectionId || !workerId || leaseEpoch === undefined || leaseEpoch === null || !actualState) {
            throw new Error('connectionId, workerId, leaseEpoch, and actualState are required');
        }

        // Map actualState to legacy status if not explicitly provided
        let compatStatus = status;
        if (!compatStatus) {
            if (actualState === 'ACTIVE') compatStatus = 'CONNECTED';
            else if (['SOCKET_STARTING', 'QR_PENDING', 'AUTHENTICATING', 'LEASE_ACQUIRED'].includes(actualState)) compatStatus = 'CONNECTING';
            else if (['DISCONNECTED', 'SOCKET_STOPPING', 'FAILED', 'UNASSIGNED'].includes(actualState)) compatStatus = 'DISCONNECTED';
            else compatStatus = actualState;
        }

        const sql = `
            UPDATE whatsapp_connections
            SET actual_state = $1,
                status = $2,
                last_error_code = $3::varchar,
                last_error_at = CASE WHEN $3::varchar IS NOT NULL THEN NOW() ELSE last_error_at END,
                last_status_at = NOW(),
                updated_at = NOW()
            WHERE id = $4
              AND assigned_worker_id = $5
              AND lease_epoch = $6
            RETURNING *;
        `;

        const { rows } = await this.pool.query(sql, [
            actualState,
            compatStatus,
            lastErrorCode,
            connectionId,
            workerId,
            leaseEpoch,
        ]);

        return this._mapRow(rows[0]);
    }

    /**
     * Discovers connection records that require reconciliation:
     * 1. desired_state = 'RUNNING' but actual_state != 'ACTIVE' and lease is unassigned or expired
     * 2. desired_state = 'STOPPED' but assigned to this worker and actual_state != 'UNASSIGNED'
     */
    async findReconciliationCandidates({ workerId = null, limit = 50 } = {}) {
        const sql = `
            SELECT *
            FROM whatsapp_connections
            WHERE (
                desired_state = 'RUNNING'
                AND actual_state NOT IN ('ACTIVE', 'SOCKET_STARTING', 'AUTHENTICATING')
                AND (assigned_worker_id IS NULL OR lease_expires_at < NOW() OR assigned_worker_id = $1)
            )
            OR (
                desired_state = 'STOPPED'
                AND assigned_worker_id = $1
                AND actual_state != 'UNASSIGNED'
            )
            ORDER BY updated_at ASC
            LIMIT $2;
        `;

        const { rows } = await this.pool.query(sql, [workerId, limit]);
        return rows.map((r) => this._mapRow(r));
    }
}

module.exports = WhatsAppConnectionRepository;
