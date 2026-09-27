const EventEmitter = require('node:events');
const { Client } = require('pg');

/**
 * Windowseven MD Dedicated PostgreSQL Notification Listener
 *
 * Maintains a single dedicated persistent PostgreSQL socket connection strictly for
 * LISTEN/NOTIFY reception, avoiding connection starvation in application query pools.
 *
 * NOTE: Notifications are treated strictly as EPHEMERAL wake-up / latency acceleration signals.
 * PostgreSQL tables remain the authoritative source of truth. Polling/reconciliation loops
 * guarantee convergence if a notification is dropped or delayed.
 */
class PostgresNotificationListener extends EventEmitter {
    constructor({
        connectionString,
        channels = ['connection_control_wake', 'tenant_events'],
        logger = console,
        keepaliveIntervalMs = 30000,
        reconnectBaseDelayMs = 100,
        reconnectMaxDelayMs = 10000,
    } = {}) {
        super();
        this.connectionString = connectionString;
        this.channels = Array.isArray(channels) ? [...channels] : [channels];
        this.logger = logger;
        this.keepaliveIntervalMs = keepaliveIntervalMs;
        this.reconnectBaseDelayMs = reconnectBaseDelayMs;
        this.reconnectMaxDelayMs = reconnectMaxDelayMs;

        this.client = null;
        this.isClosed = false;
        this.isConnected = false;
        this.reconnectTimer = null;
        this.keepaliveTimer = null;
        this.reconnectAttempts = 0;
        this.channelHandlers = new Map();

        this.setMaxListeners(100);
    }

    /**
     * Connects the dedicated client and issues LISTEN commands for all configured channels.
     */
    async start() {
        if (this.isClosed) return;
        if (this.isConnected && this.client) return;

        try {
            this._cleanupClient();

            this.client = new Client({
                connectionString: this.connectionString,
                connectionTimeoutMillis: 5000,
            });

            this.client.on('error', (err) => {
                this._handleDisconnect(err);
            });

            this.client.on('end', () => {
                this._handleDisconnect(new Error('PostgreSQL client connection ended unexpectedly'));
            });

            this.client.on('notification', (msg) => {
                this._onNotification(msg);
            });

            await this.client.connect();
            this.isConnected = true;
            this.reconnectAttempts = 0;

            // Issue LISTEN for each channel
            for (const channel of this.channels) {
                // Channel names are safe identifiers from configuration
                const sanitizedChannel = channel.replace(/[^a-zA-Z0-9_]/g, '');
                if (sanitizedChannel) {
                    await this.client.query(`LISTEN ${sanitizedChannel};`);
                }
            }

            this._startKeepalive();
            this.emit('connected');
        } catch (err) {
            this._handleDisconnect(err);
        }
    }

    /**
     * Internal handler for incoming pg_notify events.
     */
    _onNotification(msg) {
        if (!msg || !msg.channel) return;

        let parsedPayload = null;
        if (msg.payload) {
            try {
                parsedPayload = JSON.parse(msg.payload);
            } catch {
                parsedPayload = msg.payload;
            }
        }

        const eventData = {
            channel: msg.channel,
            payload: parsedPayload,
            rawPayload: msg.payload,
            timestamp: new Date().toISOString(),
        };

        // Emit channel-specific event and wildcard
        this.emit(msg.channel, parsedPayload);
        this.emit('notification', eventData);

        // Dispatch to registered channel handlers
        const handlers = this.channelHandlers.get(msg.channel);
        if (handlers) {
            for (const handler of handlers) {
                try {
                    handler(parsedPayload, eventData);
                } catch (handlerErr) {
                    if (this.logger && typeof this.logger.error === 'function') {
                        this.logger.error(`[PostgresNotificationListener] Error in handler for ${msg.channel}:`, handlerErr.message);
                    }
                }
            }
        }
    }

    /**
     * Subscribes a callback to a specific channel.
     *
     * @param {string} channel - Channel name (e.g. 'connection_control_wake')
     * @param {Function} handler - (payload, eventData) => void
     * @returns {Function} unsubscribe function
     */
    subscribe(channel, handler) {
        if (!channel || typeof handler !== 'function') {
            throw new Error('channel and handler function are required to subscribe');
        }

        if (!this.channelHandlers.has(channel)) {
            this.channelHandlers.set(channel, new Set());
        }
        this.channelHandlers.get(channel).add(handler);

        return () => {
            const handlers = this.channelHandlers.get(channel);
            if (handlers) {
                handlers.delete(handler);
                if (handlers.size === 0) {
                    this.channelHandlers.delete(channel);
                }
            }
        };
    }

    /**
     * Internal disconnection handler with exponential backoff & jitter.
     */
    _handleDisconnect(err) {
        if (this.isClosed) return;

        this.isConnected = false;
        this._stopKeepalive();
        this._cleanupClient();

        if (this.logger && typeof this.logger.warn === 'function') {
            this.logger.warn(`[PostgresNotificationListener] Connection lost: ${err?.message || 'unknown error'}. Scheduling reconnect...`);
        }

        this.emit('disconnected', err);

        if (this.reconnectTimer) return;

        // Exponential backoff with random jitter: base * 2^attempts + jitter
        const attempt = this.reconnectAttempts++;
        const expDelay = Math.min(this.reconnectBaseDelayMs * Math.pow(2, attempt), this.reconnectMaxDelayMs);
        const jitter = Math.floor(Math.random() * 200);
        const totalDelay = expDelay + jitter;

        this.reconnectTimer = setTimeout(async () => {
            this.reconnectTimer = null;
            if (this.isClosed) return;
            await this.start().catch(() => {});
        }, totalDelay);

        if (typeof this.reconnectTimer.unref === 'function') {
            this.reconnectTimer.unref();
        }
    }

    _startKeepalive() {
        this._stopKeepalive();
        if (this.keepaliveIntervalMs <= 0) return;

        this.keepaliveTimer = setInterval(async () => {
            if (this.isClosed || !this.isConnected || !this.client) return;
            try {
                await this.client.query('SELECT 1;');
            } catch (keepaliveErr) {
                this._handleDisconnect(keepaliveErr);
            }
        }, this.keepaliveIntervalMs);

        if (typeof this.keepaliveTimer.unref === 'function') {
            this.keepaliveTimer.unref();
        }
    }

    _stopKeepalive() {
        if (this.keepaliveTimer) {
            clearInterval(this.keepaliveTimer);
            this.keepaliveTimer = null;
        }
    }

    _cleanupClient() {
        if (this.client) {
            try {
                this.client.removeAllListeners();
                this.client.end().catch(() => {});
            } catch {}
            this.client = null;
        }
    }

    /**
     * Gracefully stops the listener, unlistens from all channels, and closes the client.
     */
    async stop() {
        this.isClosed = true;
        this.isConnected = false;

        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        this._stopKeepalive();

        if (this.client) {
            try {
                await this.client.query('UNLISTEN *;').catch(() => {});
            } catch {}
            try {
                await this.client.end().catch(() => {});
            } catch {}
            this.client.removeAllListeners();
            this.client = null;
        }

        this.channelHandlers.clear();
        this.removeAllListeners();
    }
}

module.exports = PostgresNotificationListener;
