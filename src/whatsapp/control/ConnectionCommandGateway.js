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
    async sendCommand({ command, tenantId, connectionId, payload = {} }) {
        if (!command || !tenantId || !connectionId) {
            throw new Error('command, tenantId, and connectionId are required');
        }

        const message = {
            command,
            tenantId,
            connectionId,
            payload,
            timestamp: new Date().toISOString(),
        };

        // 1. Process-local dispatch (immediate in-process wake-up)
        this.emitter.emit('command', message);
        this.emitter.emit(`connection:${connectionId}`, message);

        // 2. Ephemeral PostgreSQL NOTIFY wake-up signal (best-effort across distributed nodes)
        if (this.pool && typeof this.pool.query === 'function') {
            try {
                const payloadStr = JSON.stringify({
                    command,
                    tenantId,
                    connectionId,
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
     * Subscribes a worker or controller to incoming command wake-up signals.
     *
     * @param {Function} handler
     */
    onCommand(handler) {
        this.emitter.on('command', handler);
        return () => this.emitter.off('command', handler);
    }

    /**
     * Removes all listeners (used in test teardown).
     */
    removeAllListeners() {
        this.emitter.removeAllListeners();
    }
}

// Global default instance for single-node / tests
const defaultCommandGateway = new ConnectionCommandGateway();

module.exports = {
    ConnectionCommandGateway,
    defaultCommandGateway,
};
