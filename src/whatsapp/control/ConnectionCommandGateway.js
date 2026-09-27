const EventEmitter = require('node:events');

/**
 * Windowseven MD Connection Command Gateway
 * Decouples REST API controllers from worker transport.
 *
 * NOTE: Signals sent via this gateway (including PostgreSQL LISTEN/NOTIFY) are treated strictly
 * as ephemeral wake-up / invalidation signals. Workers ALWAYS read authoritative state from
 * PostgreSQL and reconcile state even if a signal is dropped or delayed.
 */
class ConnectionCommandGateway {
    constructor({ pool = null } = {}) {
        this.pool = pool;
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(100);
    }

    /**
     * Sends a control signal for a connection.
     *
     * @param {object} params
     * @param {string} params.command - 'START_CONNECTION' | 'STOP_CONNECTION' | 'RECONNECT_CONNECTION' | 'REFRESH_QR'
     * @param {string} params.tenantId
     * @param {string} params.connectionId
     * @param {object} [params.payload]
     */
    async sendCommand({ command, tenantId = null, connectionId = null, workerId = null, payload = {}, graceMs = null }) {
        if (!command) {
            throw new Error('command is required');
        }
        if (!workerId && (!tenantId || !connectionId)) {
            throw new Error('command, tenantId, and connectionId (or workerId) are required');
        }

        const message = {
            command,
            tenantId,
            connectionId,
            workerId,
            graceMs,
            payload,
            timestamp: new Date().toISOString(),
        };

        // 1. Process-local dispatch (immediate in-process wake-up)
        this.emitter.emit('command', message);
        if (connectionId) {
            this.emitter.emit(`connection:${connectionId}`, message);
        }
        if (workerId) {
            this.emitter.emit(`worker:${workerId}`, message);
        }

        // 2. Ephemeral PostgreSQL NOTIFY wake-up signal (best-effort across distributed nodes)
        if (this.pool && typeof this.pool.query === 'function') {
            try {
                const payloadStr = JSON.stringify({
                    command,
                    tenantId,
                    connectionId,
                    workerId,
                    graceMs,
                });
                // Channel: connection_control_wake
                await this.pool.query(`SELECT pg_notify('connection_control_wake', $1);`, [payloadStr]);
            } catch (notifyErr) {
                // Best effort: dropped NOTIFY signals are safely tolerated because workers
                // periodically reconcile against PostgreSQL authoritative state.
            }
        }

        return message;
    }

    /**
     * Dispatches an incoming wake-up command locally without re-broadcasting to PostgreSQL.
     * Used by PostgresNotificationListener to route incoming cross-node wake-ups to local workers.
     *
     * @param {object} message
     */
    dispatchLocal(message) {
        if (!message || !message.command) return;
        this.emitter.emit('command', message);
        if (message.connectionId) {
            this.emitter.emit(`connection:${message.connectionId}`, message);
        }
        if (message.workerId) {
            this.emitter.emit(`worker:${message.workerId}`, message);
        }
    }

    /**
     * Subscribes a worker or controller to incoming command wake-up signals.
     *
     * @param {Function} handler
     */
    onCommand(handler) {
        this.emitter.on('command', handler);
        return () => this.emitter.off('command', handler);
    }

    /**
     * Registers an active WorkerNode with the control gateway.
     * @param {object} workerNode
     */
    registerWorkerNode(workerNode) {
        if (!workerNode || !workerNode.workerId) return;
        this.workers = this.workers || new Map();
        this.workers.set(workerNode.workerId, workerNode);
    }

    /**
     * Unregisters a WorkerNode on shutdown.
     * @param {string} workerId
     */
    unregisterWorkerNode(workerId) {
        if (this.workers) {
            this.workers.delete(workerId);
        }
    }

    /**
     * Resolves the active in-process WorkerNode instance by workerId.
     * @param {string} workerId
     * @returns {object|null}
     */
    getWorkerNode(workerId) {
        return this.workers ? this.workers.get(workerId) || null : null;
    }

    /**
     * Removes all listeners (used in test teardown).
     */
    removeAllListeners() {
        this.emitter.removeAllListeners();
        if (this.workers) {
            this.workers.clear();
        }
    }
}

// Global default instance for single-node / tests
const defaultCommandGateway = new ConnectionCommandGateway();

module.exports = {
    ConnectionCommandGateway,
    defaultCommandGateway,
};
