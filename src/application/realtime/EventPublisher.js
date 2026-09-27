const EventEmitter = require('node:events');

/**
 * Windowseven MD Realtime Event Publisher
 * Abstract interface for multi-node event distribution.
 *
 * Provides normalized application domain event distribution across API nodes and workers.
 */
class IEventPublisher {
    async publish({ tenantId, eventType, data, timestamp = new Date().toISOString() }) {
        throw new Error('publish() must be implemented');
    }

    subscribe(tenantId, callback) {
        throw new Error('subscribe() must be implemented');
    }

    unsubscribe(tenantId, callback) {
        throw new Error('unsubscribe() must be implemented');
    }
}

/**
 * In-process Event Publisher using EventEmitter.
 * Used for single-node deployment, local testing, and fast local optimization.
 */
class LocalEventPublisher extends IEventPublisher {
    constructor() {
        super();
        this.emitter = new EventEmitter();
        this.emitter.setMaxListeners(200);
    }

    async publish(firstArg, eventType, data, timestamp = new Date().toISOString()) {
        let envelopeData;
        if (typeof firstArg === 'object' && firstArg !== null) {
            envelopeData = firstArg;
        } else {
            envelopeData = { tenantId: firstArg, eventType, data, timestamp };
        }

        const {
            tenantId,
            eventType: type,
            data: payload,
            timestamp: ts = new Date().toISOString(),
        } = envelopeData;

        if (!tenantId || !type) {
            throw new Error('tenantId and eventType are required to publish event');
        }

        const envelope = {
            id: require('node:crypto').randomUUID(),
            tenantId,
            eventType: type,
            data: payload,
            timestamp: ts,
        };

        // Emit to tenant-specific channel and wildcard channel
        this.emitter.emit(`tenant:${tenantId}`, envelope);
        this.emitter.emit('event', envelope);
        return envelope;
    }

    /**
     * Dispatches an incoming event locally to subscribers without broadcasting to PostgreSQL.
     * Used by PostgresNotificationListener to route incoming cross-node events to local SSE clients.
     *
     * @param {object} envelope - Normalized event envelope { id, tenantId, eventType, data, timestamp }
     */
    dispatchLocal(envelope) {
        if (!envelope || !envelope.tenantId || !envelope.eventType) return;
        this.emitter.emit(`tenant:${envelope.tenantId}`, envelope);
        this.emitter.emit('event', envelope);
    }

    subscribe(tenantId, callback) {
        if (typeof tenantId === 'function') {
            const cb = tenantId;
            this.emitter.on('event', cb);
            return () => this.emitter.off('event', cb);
        }
        if (!tenantId || typeof callback !== 'function') {
            throw new Error('tenantId and callback function are required to subscribe');
        }

        const channel = tenantId === '*' ? 'event' : `tenant:${tenantId}`;
        this.emitter.on(channel, callback);
        return () => this.emitter.off(channel, callback);
    }

    unsubscribe(tenantId, callback) {
        if (typeof tenantId === 'function') {
            this.emitter.off('event', tenantId);
            return;
        }
        const channel = tenantId === '*' ? 'event' : `tenant:${tenantId}`;
        this.emitter.off(channel, callback);
    }

    removeAllListeners() {
        this.emitter.removeAllListeners();
    }
}

/**
 * PostgreSQL LISTEN/NOTIFY Event Publisher.
 * Enables cross-process event broadcasting across multiple API nodes and workers.
 *
 * NOTE: Used as an ephemeral notification signal. Authoritative state remains in PostgreSQL.
 */
class PostgresEventPublisher extends LocalEventPublisher {
    constructor(pool) {
        super();
        this.pool = pool;
    }

    async publish({ tenantId, eventType, data, timestamp = new Date().toISOString() }) {
        // First emit locally for listeners on this node
        const envelope = await super.publish({ tenantId, eventType, data, timestamp });

        // Then broadcast via PostgreSQL NOTIFY for listeners on other nodes
        if (this.pool && typeof this.pool.query === 'function') {
            try {
                const payloadStr = JSON.stringify(envelope);
                // PostgreSQL NOTIFY payload limit is 8000 bytes. Ensure payload is bounded.
                if (payloadStr.length < 7500) {
                    await this.pool.query(`SELECT pg_notify('tenant_events', $1);`, [payloadStr]);
                }
            } catch (err) {
                // Best-effort: failures in NOTIFY do not throw to caller
            }
        }

        return envelope;
    }
}

const defaultEventPublisher = new LocalEventPublisher();

module.exports = {
    IEventPublisher,
    LocalEventPublisher,
    PostgresEventPublisher,
    defaultEventPublisher,
};
