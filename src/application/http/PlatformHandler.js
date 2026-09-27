const ApiError = require('../errors/ApiError');
const { computePlatformRequestHash } = require('../../repositories/PlatformIdempotencyRepository');
const { requirePlatformRole: defaultRequirePlatformRole } = require('../middleware/platformAuthMiddleware');

/**
 * Registers all Platform Administration & Operations routes under /api/v1/platform/*.
 */
function registerPlatformRoutes({
    router,
    platformService,
    platformIdempotencyRepo = null,
    eventPublisher = null,
    pool = null,
    platformAuthMiddleware,
    requirePlatformRole = defaultRequirePlatformRole,
    sendJson,
    readJsonBody,
}) {
    if (!router || !platformService || !platformAuthMiddleware) {
        throw new Error('router, platformService, and platformAuthMiddleware are required');
    }

    const enforceRole = typeof requirePlatformRole === 'function' ? requirePlatformRole : defaultRequirePlatformRole;

    /**
     * Helper to wrap platform mutation handlers with idempotency support.
     */
    async function handleIdempotentMutation(req, res, actionFn, defaultStatus = 200) {
        const body = await readJsonBody(req);
        const idempotencyKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];

        if (!idempotencyKey || !platformIdempotencyRepo || !pool) {
            const result = await actionFn(body);
            return sendJson(res, defaultStatus, result);
        }

        const trimmedKey = String(idempotencyKey).trim();
        const requestHash = computePlatformRequestHash(req.method, req.url, body);
        const actorUserId = req.platformUser.id;

        const client = await pool.connect();
        let reservation;
        try {
            await client.query('BEGIN');
            reservation = await platformIdempotencyRepo.reserveKey(client, {
                actorUserId,
                idempotencyKey: trimmedKey,
                requestHash,
            });
            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            client.release();
            throw err;
        }

        // Existing idempotency key handled
        if (!reservation.isNew) {
            client.release();
            const existing = reservation.record;
            if (existing.request_hash !== requestHash) {
                throw ApiError.unprocessableEntity(
                    'Idempotency key has already been used with a different request payload.',
                    'IDEMPOTENCY_KEY_MISMATCH'
                );
            }
            if (existing.status === 'PENDING') {
                throw ApiError.conflict(
                    'A request with this idempotency key is currently being processed.',
                    'IDEMPOTENCY_CONFLICT'
                );
            }
            if (existing.status === 'COMPLETED') {
                res.setHeader('X-Cache', 'IDEMPOTENT-REPLAY');
                return sendJson(res, existing.response_status_code || defaultStatus, existing.response_body);
            }
        }

        // Execute actual mutation
        let result;
        try {
            result = await actionFn(body);
        } catch (err) {
            // Remove pending reservation on failure so client can retry
            await pool.query('DELETE FROM platform_idempotency_keys WHERE id = $1;', [reservation.record.id]).catch(() => {});
            client.release();
            throw err;
        }

        // Mark key as COMPLETED
        try {
            await platformIdempotencyRepo.completeKey(client, {
                id: reservation.record.id,
                statusCode: defaultStatus,
                responseBody: result,
            });
        } finally {
            client.release();
        }

        return sendJson(res, defaultStatus, result);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // TENANT MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    // POST /api/v1/platform/tenants - Create new tenant (SUPER_ADMIN only)
    router.post('/api/v1/platform/tenants', platformAuthMiddleware, enforceRole('SUPER_ADMIN'), async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            return platformService.createTenant({
                name: body?.name,
            }, {
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        }, 201);
    });

    // GET /api/v1/platform/tenants - List all tenants
    router.get('/api/v1/platform/tenants', platformAuthMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
        const status = req.query?.status || null;

        const tenants = await platformService.listTenants({ limit, offset, status });
        sendJson(res, 200, { tenants, limit, offset });
    });

    // GET /api/v1/platform/tenants/:id - Get tenant detail
    router.get('/api/v1/platform/tenants/:id', platformAuthMiddleware, async (req, res) => {
        const tenantId = req.params.id;
        const detail = await platformService.getTenantDetail(tenantId);
        sendJson(res, 200, detail);
    });

    // POST /api/v1/platform/tenants/:id/suspend - Suspend tenant (Option B)
    router.post('/api/v1/platform/tenants/:id/suspend', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            const tenantId = req.params.id;
            return platformService.suspendTenant(tenantId, {
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/tenants/:id/reactivate - Reactivate suspended tenant (Option B)
    router.post('/api/v1/platform/tenants/:id/reactivate', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            const tenantId = req.params.id;
            return platformService.reactivateTenant(tenantId, {
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/tenants/:id/deactivate - Deactivate tenant (SUPER_ADMIN only)
    router.post('/api/v1/platform/tenants/:id/deactivate', platformAuthMiddleware, enforceRole('SUPER_ADMIN'), async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            const tenantId = req.params.id;
            return platformService.deactivateTenant(tenantId, {
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // CONNECTION GOVERNANCE
    // ─────────────────────────────────────────────────────────────────────────

    // GET /api/v1/platform/connections - List all connections
    router.get('/api/v1/platform/connections', platformAuthMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
        const status = req.query?.status || null;
        const tenantId = req.query?.tenantId || null;

        const connections = await platformService.listConnections({ limit, offset, status, tenantId });
        sendJson(res, 200, { connections, limit, offset });
    });

    // GET /api/v1/platform/connections/:id - Get connection details
    router.get('/api/v1/platform/connections/:id', platformAuthMiddleware, async (req, res) => {
        const connectionId = req.params.id;
        const conn = await platformService.getConnectionDetail(connectionId);
        sendJson(res, 200, conn);
    });

    // POST /api/v1/platform/connections/:id/disconnect - Force-disconnect connection
    router.post('/api/v1/platform/connections/:id/disconnect', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            if (body && body.confirm !== undefined && !body.confirm) {
                throw ApiError.badRequest('Confirmation required to force-disconnect connection', 'CONFIRMATION_REQUIRED');
            }
            const connectionId = req.params.id;
            return platformService.forceDisconnectConnection(connectionId, {
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/connections/:id/reconnect - Request reconnection
    router.post('/api/v1/platform/connections/:id/reconnect', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            const connectionId = req.params.id;
            return platformService.reconnectConnection(connectionId, {
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // WORKER CLUSTER MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    // GET /api/v1/platform/workers - List workers
    router.get('/api/v1/platform/workers', platformAuthMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);

        const workers = await platformService.listWorkers({ limit, offset });
        sendJson(res, 200, { workers, limit, offset });
    });

    // GET /api/v1/platform/workers/:id - Get worker detail
    router.get('/api/v1/platform/workers/:id', platformAuthMiddleware, async (req, res) => {
        const workerId = req.params.id;
        const worker = await platformService.getWorkerDetail(workerId);
        sendJson(res, 200, worker);
    });

    // POST /api/v1/platform/workers/:id/drain - Trigger worker drain protocol (SUPER_ADMIN only)
    router.post('/api/v1/platform/workers/:id/drain', platformAuthMiddleware, enforceRole('SUPER_ADMIN'), async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            if (body && body.confirm !== undefined && !body.confirm) {
                throw ApiError.badRequest('Confirmation required to drain worker node', 'CONFIRMATION_REQUIRED');
            }
            const workerId = req.params.id;
            return platformService.drainWorker(workerId, {
                graceMs: body?.graceMs || 10000,
                reason: body?.reason || null,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // RELIABILITY & RECOVERY OPERATIONS (Phase 5B)
    // ─────────────────────────────────────────────────────────────────────────

    // GET /api/v1/platform/commands/:id - Get command detail
    router.get('/api/v1/platform/commands/:id', platformAuthMiddleware, async (req, res) => {
        const result = await platformService.getCommandDetail(req.params.id);
        sendJson(res, 200, result);
    });

    // GET /api/v1/platform/tasks/:id - Get task detail
    router.get('/api/v1/platform/tasks/:id', platformAuthMiddleware, async (req, res) => {
        const result = await platformService.getTaskDetail(req.params.id);
        sendJson(res, 200, result);
    });

    // POST /api/v1/platform/commands/:id/probe - Read-only live probe
    router.post('/api/v1/platform/commands/:id/probe', platformAuthMiddleware, async (req, res) => {
        const result = await platformService.probeCommand(req.params.id, {
            actorUserId: req.platformUser.id,
            actorRole: req.platformUser.role,
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
        });
        sendJson(res, 200, result);
    });

    // POST /api/v1/platform/tasks/:id/probe - Read-only live probe
    router.post('/api/v1/platform/tasks/:id/probe', platformAuthMiddleware, async (req, res) => {
        const result = await platformService.probeTask(req.params.id, {
            actorUserId: req.platformUser.id,
            actorRole: req.platformUser.role,
            ipAddress: req.ip || req.socket?.remoteAddress || null,
            userAgent: req.headers['user-agent'] || null,
        });
        sendJson(res, 200, result);
    });

    // POST /api/v1/platform/commands/:id/resolve - Fenced manual resolution
    router.post('/api/v1/platform/commands/:id/resolve', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async () => {
            return platformService.resolveCommand(req.params.id, {
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/tasks/:id/resolve - Fenced manual resolution
    router.post('/api/v1/platform/tasks/:id/resolve', platformAuthMiddleware, async (req, res) => {
        await handleIdempotentMutation(req, res, async () => {
            return platformService.resolveTask(req.params.id, {
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/commands/:id/force-fail - Force fail command (SUPER_ADMIN only)
    router.post('/api/v1/platform/commands/:id/force-fail', platformAuthMiddleware, enforceRole('SUPER_ADMIN'), async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            return platformService.forceFailCommand(req.params.id, {
                reason: body?.reason,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // POST /api/v1/platform/tasks/:id/force-fail - Force fail task (SUPER_ADMIN only)
    router.post('/api/v1/platform/tasks/:id/force-fail', platformAuthMiddleware, enforceRole('SUPER_ADMIN'), async (req, res) => {
        await handleIdempotentMutation(req, res, async (body) => {
            return platformService.forceFailTask(req.params.id, {
                reason: body?.reason,
                actorUserId: req.platformUser.id,
                actorRole: req.platformUser.role,
                ipAddress: req.ip || req.socket?.remoteAddress || null,
                userAgent: req.headers['user-agent'] || null,
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // PLATFORM AUDIT & OBSERVABILITY
    // ─────────────────────────────────────────────────────────────────────────

    // GET /api/v1/platform/audit - Query platform audit logs
    router.get('/api/v1/platform/audit', platformAuthMiddleware, async (req, res) => {
        const limit = Math.min(Math.max(parseInt(req.query?.limit, 10) || 50, 1), 100);
        const offset = Math.max(parseInt(req.query?.offset, 10) || 0, 0);
        const action = req.query?.action || null;
        const targetType = req.query?.targetType || null;
        const targetId = req.query?.targetId || null;
        const targetTenantId = req.query?.targetTenantId || null;
        const actorUserId = req.query?.actorUserId || null;

        const auditLogs = await platformService.queryAuditLogs({
            limit,
            offset,
            action,
            targetType,
            targetId,
            targetTenantId,
            actorUserId,
        });

        sendJson(res, 200, { auditLogs, limit, offset });
    });

    // GET /api/v1/platform/health - Cluster health summary
    router.get('/api/v1/platform/health', platformAuthMiddleware, async (req, res) => {
        const health = await platformService.getClusterHealth();
        sendJson(res, 200, health);
    });

    // GET /api/v1/platform/events - Server-Sent Events stream
    router.get('/api/v1/platform/events', platformAuthMiddleware, (req, res) => {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'Access-Control-Allow-Origin': '*',
        });

        res.write(': connected\n\n');

        let unsubscribe = null;
        if (eventPublisher && typeof eventPublisher.subscribe === 'function') {
            unsubscribe = eventPublisher.subscribe('*', (event) => {
                try {
                    res.write(`event: ${event.eventType || 'platform.event'}\n`);
                    res.write(`data: ${JSON.stringify(event)}\n\n`);
                } catch {
                    // client closed
                }
            });
        }

        const keepAliveTimer = setInterval(() => {
            try {
                res.write(': keepalive\n\n');
            } catch {
                clearInterval(keepAliveTimer);
            }
        }, 15000);

        if (typeof keepAliveTimer.unref === 'function') {
            keepAliveTimer.unref();
        }

        const cleanup = () => {
            clearInterval(keepAliveTimer);
            if (typeof unsubscribe === 'function') {
                unsubscribe();
                unsubscribe = null;
            }
            if (!res.writableEnded) {
                res.end();
            }
        };

        req.on('close', cleanup);
        res.on('close', cleanup);
    });
}

module.exports = { registerPlatformRoutes };
