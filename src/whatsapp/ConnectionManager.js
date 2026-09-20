const {
    default: makeWASocket,
    DisconnectReason,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    delay,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const NodeCache = require('node-cache');
const { getPool, closePool } = require('../database/client');
const {
    WhatsAppConnectionRepository,
    WhatsAppAuthCredentialsRepository,
    WhatsAppAuthKeysRepository,
} = require('../repositories');
const { useDatabaseAuthState } = require('./DatabaseAuthState');
const { createExecutionContext } = require('./ExecutionContext');
const EventAdapter = require('./EventAdapter');
const GroupSynchronizer = require('./GroupSynchronizer');
const { createPipeline } = require('../application/createPipeline');

class ConnectionManager {
    constructor(pool) {
        this.pool = pool || getPool();
        this.connRepo = new WhatsAppConnectionRepository(this.pool);
        this.credsRepo = new WhatsAppAuthCredentialsRepository(this.pool);
        this.keysRepo = new WhatsAppAuthKeysRepository(this.pool);
        this.groupSynchronizer = new GroupSynchronizer(this.pool);

        // In-memory registry: Map<connectionId, RuntimeConnection>
        this.connections = new Map();
        this.isShuttingDown = false;
    }

    /**
     * Retrieves an active connection by its connection UUID.
     * @param {string} connectionId
     * @returns {object|null}
     */
    getConnection(connectionId) {
        return this.connections.get(connectionId) || null;
    }

    /**
     * Checks if a connection is currently registered in memory.
     * @param {string} connectionId
     * @returns {boolean}
     */
    hasConnection(connectionId) {
        return this.connections.has(connectionId);
    }

    /**
     * Lists all currently registered active connections.
     * @returns {Array<{ connectionId: string, tenantId: string, status: string, lifecycleState: string }>}
     */
    listActiveConnections() {
        const list = [];
        for (const [connectionId, conn] of this.connections.entries()) {
            list.push({
                connectionId,
                tenantId: conn.tenantId,
                status: conn.status,
                lifecycleState: conn.lifecycleState,
            });
        }
        return list;
    }

    /**
     * Creates, registers, and starts a managed Baileys connection scoped to (tenantId, connectionId).
     *
     * @param {string} tenantId - Tenant UUID
     * @param {string} connectionId - Connection UUID
     * @param {object} [options] - Additional socket / bridge options
     * @returns {Promise<object>} The RuntimeConnection record
     */
    async createConnection(tenantId, connectionId, options = {}) {
        if (this.isShuttingDown) {
            throw new Error('[ConnectionManager] Cannot create connection: manager is shutting down');
        }
        if (!tenantId || !connectionId) {
            throw new Error('tenantId and connectionId are required');
        }

        // 1. Prevent duplicate registration
        if (this.connections.has(connectionId)) {
            throw new Error(`[ConnectionManager] Connection ${connectionId} is already registered`);
        }

        // 2. Validate tenant ownership against PostgreSQL
        const dbConn = await this.connRepo.findByIdForTenant(connectionId, tenantId);
        if (!dbConn) {
            throw new Error(`[ConnectionManager] Connection ${connectionId} not found for tenant ${tenantId}`);
        }

        // 3. Load DB-backed Auth State (Fails closed on error/corruption)
        const { state, saveCreds } = await useDatabaseAuthState(tenantId, connectionId, {
            credsRepo: this.credsRepo,
            keysRepo: this.keysRepo,
        });

        // 4. Runtime connection record
        const runtimeConn = {
            tenantId,
            connectionId,
            socket: null,
            status: 'CREATED',
            lifecycleState: 'STARTING',
            reconnectTimer: null,
            reconnectAttempts: 0,
            options,
            saveCreds,
            state,
        };

        this.connections.set(connectionId, runtimeConn);

        // 5. Initialize the Baileys socket
        await this._startSocket(runtimeConn);

        return runtimeConn;
    }

    /**
     * Internal: Instantiates the Baileys socket and hooks lifecycle listeners.
     */
    async _startSocket(runtimeConn) {
        if (this.isShuttingDown || runtimeConn.isAborted) {
            return null;
        }

        const { tenantId, connectionId, state, saveCreds, options } = runtimeConn;

        try {
            await this.connRepo.updateStatusForTenant(connectionId, tenantId, 'CONNECTING');
            runtimeConn.status = 'CONNECTING';

            let version;
            try {
                const versionInfo = await fetchLatestBaileysVersion();
                version = versionInfo.version;
            } catch (_) {
                // Fallback default if offline / test environment
                version = [2, 3000, 1015901307];
            }

            if (this.isShuttingDown || runtimeConn.isAborted) {
                return null;
            }

            const logger = pino({ level: 'silent' });
            const msgRetryCounterCache = new NodeCache();

            // Sole authoritative makeWASocket instantiation
            const socket = makeWASocket({
                version,
                logger,
                printQRInTerminal: options.printQRInTerminal !== false && !options.pairingCode,
                browser: options.browser || ['Ubuntu', 'Chrome', '20.0.04'],
                auth: {
                    creds: state.creds,
                    keys: makeCacheableSignalKeyStore(state.keys, logger),
                },
                markOnlineOnConnect: true,
                generateHighQualityLinkPreview: true,
                syncFullHistory: false,
                msgRetryCounterCache,
                defaultQueryTimeoutMs: 60000,
                connectTimeoutMs: 60000,
                keepAliveIntervalMs: 10000,
                ...(options.socketOverrides || {}),
            });

            if (this.isShuttingDown || runtimeConn.isAborted) {
                try {
                    if (socket.ev && typeof socket.ev.removeAllListeners === 'function') socket.ev.removeAllListeners();
                    if (socket.ws && typeof socket.ws.terminate === 'function') socket.ws.terminate();
                    else if (typeof socket.end === 'function') socket.end();
                } catch (_) {}
                return null;
            }

            runtimeConn.socket = socket;

            // 1. Credentials update listener
            socket.ev.on('creds.update', async () => {
                try {
                    await saveCreds();
                } catch (err) {
                    console.error(`[ConnectionManager] Failed saving creds for connection ${connectionId}:`, err.message);
                }
            });

            // 2. Connection update listener
            socket.ev.on('connection.update', async (update) => {
                await this._handleConnectionUpdate(runtimeConn, update);
            });

            // 3. Create immutable ExecutionContext
            const ctx = createExecutionContext({
                tenantId,
                connectionId,
                socket,
                pool: this.pool,
                repositories: {
                    connRepo: this.connRepo,
                    credsRepo: this.credsRepo,
                    keysRepo: this.keysRepo,
                    groupRepo: this.groupSynchronizer.groupRepo,
                },
            });
            runtimeConn.ctx = ctx;

            // 4. Instantiate EventAdapter as the single normalization boundary
            const adapter = new EventAdapter(ctx);
            runtimeConn.adapter = adapter;

            // 5. Connect GroupSynchronizer to normalized group events
            adapter.on('group.discovered', (ev) => this.groupSynchronizer.handleGroupDiscovered(ctx, ev));
            adapter.on('group.updated', (ev) => this.groupSynchronizer.handleGroupUpdated(ctx, ev));
            adapter.on('group.participants.changed', (ev) => this.groupSynchronizer.handleGroupParticipantsChanged(ctx, ev));

            // 6. Instantiate ApplicationPipeline
            let pipeline = null;
            try {
                pipeline = createPipeline({ pool: this.pool, socket });
                runtimeConn.pipeline = pipeline;
            } catch (pErr) {
                console.error(`[ConnectionManager] Failed initializing ApplicationPipeline for ${connectionId}:`, pErr.message);
            }

            // 7. Attach compatibility bridge (receives adapter, context, and pipeline)
            if (typeof options.attachBridge === 'function') {
                try {
                    options.attachBridge(adapter, { tenantId, connectionId, pipeline });
                } catch (err) {
                    console.error(`[ConnectionManager] Error in event bridge for ${connectionId}:`, err.message);
                }
            }

            return socket;
        } catch (err) {
            runtimeConn.lifecycleState = 'FAILED';
            runtimeConn.status = 'DISCONNECTED';
            await this.connRepo.updateStatusForTenant(connectionId, tenantId, 'DISCONNECTED').catch(() => {});
            throw new Error(`[ConnectionManager] Failed starting socket for ${connectionId}: ${err.message}`);
        }
    }

    /**
     * Internal: Handles Baileys connection.update events.
     */
    async _handleConnectionUpdate(runtimeConn, update) {
        if (this.isShuttingDown || runtimeConn.isAborted) return;
        const { connection, lastDisconnect, qr } = update;
        const { tenantId, connectionId, options } = runtimeConn;

        if (qr && typeof options.onQR === 'function') {
            options.onQR(qr);
        }

        if (connection === 'connecting') {
            runtimeConn.status = 'CONNECTING';
            runtimeConn.lifecycleState = 'CONNECTING';
        }

        if (connection === 'open') {
            runtimeConn.status = 'CONNECTED';
            runtimeConn.lifecycleState = 'RUNNING';
            runtimeConn.reconnectAttempts = 0;

            await this.connRepo.updateStatusForTenant(connectionId, tenantId, 'CONNECTED').catch(() => {});

            // Trigger failure-isolated group discovery synchronization in background
            if (runtimeConn.ctx) {
                this.groupSynchronizer.syncAllParticipatingGroups(runtimeConn.ctx).catch((err) => {
                    console.error(`[ConnectionManager] Background group sync error for ${connectionId}:`, err.message);
                });
            }

            if (typeof options.onConnect === 'function') {
                options.onConnect(runtimeConn.socket);
            }
        }

        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const isLoggedOut = statusCode === DisconnectReason.loggedOut || statusCode === 401;
            const isBadSession = statusCode === DisconnectReason.badSession;

            runtimeConn.status = 'DISCONNECTED';
            runtimeConn.lifecycleState = 'STOPPED';

            await this.connRepo.updateStatusForTenant(connectionId, tenantId, 'DISCONNECTED').catch(() => {});

            if (this.isShuttingDown) {
                return;
            }

            // Fatal disconnect classification
            if (isLoggedOut || isBadSession) {
                console.warn(`[ConnectionManager] Connection ${connectionId} terminated with fatal status ${statusCode}. Reconnect aborted.`);
                // Clean up credentials on explicit logout
                if (isLoggedOut) {
                    await this.credsRepo.deleteCredentials(tenantId, connectionId).catch(() => {});
                }
                return;
            }

            // Recoverable disconnect -> controlled exponential backoff
            this._scheduleReconnect(runtimeConn);
        }
    }

    /**
     * Internal: Controlled exponential backoff reconnect.
     */
    _scheduleReconnect(runtimeConn) {
        if (this.isShuttingDown || runtimeConn.isAborted) return;

        const maxAttempts = runtimeConn.options.maxReconnectAttempts || 5;
        if (runtimeConn.reconnectAttempts >= maxAttempts) {
            console.error(`[ConnectionManager] Connection ${runtimeConn.connectionId} reached max reconnect attempts (${maxAttempts}). Stopping.`);
            runtimeConn.lifecycleState = 'FAILED';
            return;
        }

        runtimeConn.reconnectAttempts++;
        runtimeConn.lifecycleState = 'RECONNECTING';

        const baseDelay = 1000 * Math.pow(2, runtimeConn.reconnectAttempts - 1);
        const jitter = Math.floor(Math.random() * 500);
        const retryDelay = Math.min(baseDelay + jitter, 30000);

        console.log(`[ConnectionManager] Scheduling reconnect for ${runtimeConn.connectionId} in ${retryDelay}ms (attempt ${runtimeConn.reconnectAttempts}/${maxAttempts})`);

        if (runtimeConn.reconnectTimer) {
            clearTimeout(runtimeConn.reconnectTimer);
        }

        runtimeConn.reconnectTimer = setTimeout(async () => {
            if (this.isShuttingDown || runtimeConn.isAborted) return;
            try {
                await this._startSocket(runtimeConn);
            } catch (err) {
                if (runtimeConn.isAborted) return;
                console.error(`[ConnectionManager] Reconnect error for ${runtimeConn.connectionId}:`, err.message);
                this._scheduleReconnect(runtimeConn);
            }
        }, retryDelay);
    }

    /**
     * Forcibly aborts a connection upon lease loss or fencing failure.
     * Guaranteed to cancel reconnect timers and prevent resurrection of stale generation.
     *
     * @param {string} connectionId
     * @param {string} [reason='LEASE_LOST']
     * @returns {Promise<boolean>}
     */
    async abortConnection(connectionId, reason = 'LEASE_LOST') {
        const conn = this.connections.get(connectionId);
        if (!conn) return false;

        // 1. Mark connection permanently aborted to block any scheduled or async reconnect
        conn.isAborted = true;

        // 2. Clear any pending reconnect timer and reset retry state
        if (conn.reconnectTimer) {
            clearTimeout(conn.reconnectTimer);
            conn.reconnectTimer = null;
        }
        conn.reconnectAttempts = 0;
        conn.lifecycleState = 'FAILED';
        conn.status = 'DISCONNECTED';

        // 3. Strip all event listeners from EventAdapter to halt event processing
        if (conn.adapter && typeof conn.adapter.removeAllListeners === 'function') {
            try {
                conn.adapter.removeAllListeners();
            } catch (_) {}
        }

        // 4. Strip Baileys socket listeners and terminate underlying WebSocket immediately
        if (conn.socket) {
            try {
                if (conn.socket.ev && typeof conn.socket.ev.removeAllListeners === 'function') {
                    conn.socket.ev.removeAllListeners();
                }
                if (conn.socket.ws && typeof conn.socket.ws.terminate === 'function') {
                    conn.socket.ws.terminate();
                } else if (typeof conn.socket.end === 'function') {
                    conn.socket.end(new Error(`Connection aborted: ${reason}`));
                }
            } catch (_) {}
        }

        // 5. Remove from in-memory connection registry
        this.connections.delete(connectionId);
        return true;
    }

    /**
     * Gracefully disconnects and unregisters a single connection.
     */
    async disconnectConnection(connectionId, reason = 'manual_disconnect') {
        const conn = this.connections.get(connectionId);
        if (!conn) return false;

        conn.isAborted = true; // Prevent automatic reconnect upon socket close
        if (conn.reconnectTimer) {
            clearTimeout(conn.reconnectTimer);
            conn.reconnectTimer = null;
        }

        conn.lifecycleState = 'STOPPED';
        conn.status = 'DISCONNECTED';

        if (conn.socket) {
            try {
                conn.socket.end(new Error(reason));
            } catch (_) {}
        }

        await this.connRepo.updateStatusForTenant(connectionId, conn.tenantId, 'DISCONNECTED').catch(() => {});
        this.connections.delete(connectionId);
        return true;
    }

    /**
     * Gracefully shuts down all managed connections and closes the PostgreSQL pool.
     */
    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;

        const closePromises = [];
        for (const [connectionId, conn] of this.connections.entries()) {
            if (conn.reconnectTimer) {
                clearTimeout(conn.reconnectTimer);
                conn.reconnectTimer = null;
            }
            conn.lifecycleState = 'STOPPED';
            conn.status = 'DISCONNECTED';

            if (conn.socket) {
                try {
                    conn.socket.end(new Error('Manager shutting down'));
                } catch (_) {}
            }
            closePromises.push(
                this.connRepo.updateStatusForTenant(connectionId, conn.tenantId, 'DISCONNECTED').catch(() => {})
            );
        }

        await Promise.all(closePromises);
        this.connections.clear();
    }
}

module.exports = ConnectionManager;
