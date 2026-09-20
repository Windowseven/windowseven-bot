/**
 * Windowseven MD Worker Repository
 * Manages worker registration, heartbeats, and operational capacity hints.
 *
 * NOTE: Worker capacity is strictly an operational scheduling hint, NOT a platform-wide connection limit.
 */
class WorkerRepository {
    constructor(pool) {
        this.pool = pool;
    }

    _mapRow(row) {
        if (!row) return null;
        return {
            id: row.id,
            hostname: row.hostname,
            status: row.status,
            lastHeartbeatAt: row.last_heartbeat_at,
            capacity: row.capacity,
            activeConnections: row.active_connections,
            metadata: row.metadata,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
        };
    }

    async registerWorker({ id, hostname = null, capacity = 50, status = 'READY', metadata = {} }) {
        if (!id) throw new Error('Worker ID is required');

        const sql = `
            INSERT INTO workers (id, hostname, capacity, status, metadata, last_heartbeat_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, NOW(), NOW())
            ON CONFLICT (id) DO UPDATE SET
                hostname = EXCLUDED.hostname,
                capacity = EXCLUDED.capacity,
                status = EXCLUDED.status,
                metadata = EXCLUDED.metadata,
                last_heartbeat_at = NOW(),
                updated_at = NOW()
            RETURNING *;
        `;

        const { rows } = await this.pool.query(sql, [
            id, hostname, capacity, status, JSON.stringify(metadata),
        ]);
        return this._mapRow(rows[0]);
    }

    async heartbeat({ id, activeConnections = 0 }) {
        if (!id) throw new Error('Worker ID is required');

        const sql = `
            UPDATE workers
            SET last_heartbeat_at = NOW(),
                active_connections = $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING *;
        `;

        const { rows } = await this.pool.query(sql, [activeConnections, id]);
        return this._mapRow(rows[0]);
    }

    async updateStatus(id, status) {
        if (!id || !status) throw new Error('id and status are required');

        const sql = `
            UPDATE workers
            SET status = $1,
                updated_at = NOW()
            WHERE id = $2
            RETURNING *;
        `;

        const { rows } = await this.pool.query(sql, [status, id]);
        return this._mapRow(rows[0]);
    }

    async findById(id) {
        if (!id) return null;
        const sql = `SELECT * FROM workers WHERE id = $1;`;
        const { rows } = await this.pool.query(sql, [id]);
        return this._mapRow(rows[0]);
    }

    async listActiveWorkers({ heartbeatTimeoutSeconds = 30 } = {}) {
        const sql = `
            SELECT *
            FROM workers
            WHERE status != 'OFFLINE'
              AND last_heartbeat_at > NOW() - ($1 || ' seconds')::interval
            ORDER BY active_connections ASC, created_at ASC;
        `;
        const { rows } = await this.pool.query(sql, [String(heartbeatTimeoutSeconds)]);
        return rows.map((r) => this._mapRow(r));
    }

    async markStaleWorkersOffline({ staleThresholdSeconds = 60 } = {}) {
        const sql = `
            UPDATE workers
            SET status = 'OFFLINE',
                updated_at = NOW()
            WHERE status != 'OFFLINE'
              AND last_heartbeat_at < NOW() - ($1 || ' seconds')::interval
            RETURNING id;
        `;
        const { rows } = await this.pool.query(sql, [String(staleThresholdSeconds)]);
        return rows.map((r) => r.id);
    }
}

module.exports = WorkerRepository;
