const ApiError = require('../errors/ApiError');

/**
 * Windowseven MD Realtime Server-Sent Events (SSE) Gateway
 * Provides strictly tenant-isolated event streams with keepalive, backpressure, and resource bounds.
 *
 * NOTE: SSE is a realtime best-effort projection. PostgreSQL remains the authoritative source of truth.
 */
class SseGateway {
    /**
     * @param {object} params
     * @param {import('./EventPublisher').IEventPublisher} params.eventPublisher
     * @param {number} [params.keepaliveIntervalMs=15000]
     * @param {number} [params.maxClientsPerTenant=50] - Per-process safeguard to prevent slow-client memory exhaustion
     */
    constructor({
        eventPublisher,
        keepaliveIntervalMs = 15000,
        maxClientsPerTenant = 50,
    }) {
        if (!eventPublisher) {
            throw new Error('eventPublisher is required for SseGateway');
        }

        this.eventPublisher = eventPublisher;
        this.keepaliveIntervalMs = keepaliveIntervalMs;
        this.maxClientsPerTenant = maxClientsPerTenant;

        // Map<tenantId, Set<ClientRecord>>
        // ClientRecord: { id, res, keepaliveTimer, isDraining }
        this.tenantClients = new Map();

        // Map<tenantId, unsubscribeFn>
        this.tenantSubscriptions = new Map();
    }

    /**
     * Handles an incoming SSE connection request for an authorized tenant.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {string} tenantId
     */
    handleConnection(req, res, tenantId) {
        if (!tenantId) {
            throw ApiError.badRequest('Tenant ID is required for SSE connection');
        }

        let clients = this.tenantClients.get(tenantId);
        if (!clients) {
            clients = new Set();
            this.tenantClients.set(tenantId, clients);
        }

        // Per-process resource-protection check
        if (clients.size >= this.maxClientsPerTenant) {
            throw ApiError.rateLimited(
                `Max concurrent SSE clients reached for this process node (${this.maxClientsPerTenant}). Reconnect later or distribute across API nodes.`,
                'SSE_CLIENT_LIMIT_REACHED'
            );
        }

        // Disable request/socket timeouts for long-lived SSE streaming
        if (typeof req.setTimeout === 'function') req.setTimeout(0);
        if (typeof res.setTimeout === 'function') res.setTimeout(0);
        if (req.socket && typeof req.socket.setTimeout === 'function') {
            req.socket.setTimeout(0);
        }

        // 1. Set SSE streaming headers
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',
        });

        // 2. Write initial connection acknowledgment
        res.write(`:connected\n\n`);

        const clientId = require('node:crypto').randomUUID();
        const clientRecord = {
            id: clientId,
            res,
            keepaliveTimer: null,
            isDraining: false,
        };

        // 3. Periodic keepalive ping every 15 seconds
        clientRecord.keepaliveTimer = setInterval(() => {
            if (!res.writableEnded) {
                res.write(`:keepalive\n\n`);
            }
        }, this.keepaliveIntervalMs);

        if (typeof clientRecord.keepaliveTimer.unref === 'function') {
            clientRecord.keepaliveTimer.unref();
        }

        clients.add(clientRecord);

        // 4. Subscribe to tenant event channel if this is the first client
        if (!this.tenantSubscriptions.has(tenantId)) {
            const unsub = this.eventPublisher.subscribe(tenantId, (eventEnvelope) => {
                this._broadcastToTenant(tenantId, eventEnvelope);
            });
            this.tenantSubscriptions.set(tenantId, unsub);
        }

        // 5. Clean teardown on client disconnect
        const cleanup = () => {
            if (clientRecord.keepaliveTimer) {
                clearInterval(clientRecord.keepaliveTimer);
                clientRecord.keepaliveTimer = null;
            }

            const currentClients = this.tenantClients.get(tenantId);
            if (currentClients) {
                currentClients.delete(clientRecord);
                if (currentClients.size === 0) {
                    this.tenantClients.delete(tenantId);
                    const unsub = this.tenantSubscriptions.get(tenantId);
                    if (unsub) {
                        unsub();
                        this.tenantSubscriptions.delete(tenantId);
                    }
                }
            }
        };

        req.on('close', cleanup);
        req.on('error', cleanup);
        res.on('error', cleanup);
    }

    /**
     * Broadcasts a sanitized event envelope to all connected SSE clients of that tenant.
     */
    _broadcastToTenant(tenantId, eventEnvelope) {
        const clients = this.tenantClients.get(tenantId);
        if (!clients || clients.size === 0) return;

        // Security check: Never broadcast raw credentials or Signal keys
        const sanitizedData = this._sanitizeEventData(eventEnvelope.data);

        const frame = `event: ${eventEnvelope.eventType}\nid: ${eventEnvelope.id}\ndata: ${JSON.stringify(sanitizedData)}\n\n`;

        for (const client of clients) {
            if (client.res.writableEnded) continue;

            // Backpressure check
            const ok = client.res.write(frame);
            if (!ok && !client.isDraining) {
                client.isDraining = true;
                client.res.once('drain', () => {
                    client.isDraining = false;
                });
            }
        }
    }

    /**
     * Sanitizes data payload to ensure zero secret leakage over SSE streams.
     */
    _sanitizeEventData(data) {
        if (!data || typeof data !== 'object') return data;
        const sanitized = { ...data };

        // Strip any sensitive properties if present
        delete sanitized.keys;
        delete sanitized.creds;
        delete sanitized.credentials;
        delete sanitized.password;
        delete sanitized.refreshToken;
        delete sanitized.token;

        return sanitized;
    }

    /**
     * Active client count for a tenant.
     */
    getClientCount(tenantId) {
        const clients = this.tenantClients.get(tenantId);
        return clients ? clients.size : 0;
    }

    /**
     * Shuts down all active SSE streams.
     */
    closeAll() {
        for (const [tenantId, unsub] of this.tenantSubscriptions.entries()) {
            try { unsub(); } catch (_) {}
        }
        this.tenantSubscriptions.clear();

        for (const clients of this.tenantClients.values()) {
            for (const client of clients) {
                if (client.keepaliveTimer) {
                    clearInterval(client.keepaliveTimer);
                }
                if (!client.res.writableEnded) {
                    try {
                        client.res.end();
                    } catch (_) {}
                }
            }
        }
        this.tenantClients.clear();
    }
}

module.exports = SseGateway;
