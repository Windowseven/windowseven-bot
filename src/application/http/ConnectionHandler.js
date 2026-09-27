const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');
const { computeRequestHash } = require('../../repositories/IdempotencyRepository');

/**
 * Registers WhatsApp connection lifecycle and realtime SSE routes.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('../services/ConnectionService')} params.connectionService
 * @param {import('../realtime/SseGateway')} params.sseGateway
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {Function} params.sendJson
 * @param {Function} params.readJsonBody
 * @param {import('../../repositories/IdempotencyRepository').IdempotencyRepository} [params.idempotencyRepo]
 * @param {import('pg').Pool} [params.pool]
 */
function registerConnectionRoutes({
    router,
    connectionService,
    sseGateway,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    sendJson,
    readJsonBody,
    idempotencyRepo = null,
    pool = null,
}) {
    // -------------------------------------------------------------
    // Realtime Server-Sent Events (SSE) Route
    // -------------------------------------------------------------
    // Route: GET /api/v1/tenants/:tenantId/events
    router.get(
        '/api/v1/tenants/:tenantId/events',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        (req, res) => {
            sseGateway.handleConnection(req, res, req.tenantContext.tenantId);
        }
    );

    // -------------------------------------------------------------
    // WhatsApp Connections Collection Routes
    // -------------------------------------------------------------

    // Route: GET /api/v1/tenants/:tenantId/connections (Lists connections, MEMBER, ADMIN, OWNER)
    router.get(
        '/api/v1/tenants/:tenantId/connections',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const connections = await connectionService.listConnections(req.tenantContext.tenantId);
            return sendJson(res, 200, { connections });
        }
    );

    // Route: POST /api/v1/tenants/:tenantId/connections (Creates connection, ADMIN or OWNER)
    router.post(
        '/api/v1/tenants/:tenantId/connections',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const body = await readJsonBody(req);
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;
            const tenantId = req.tenantContext.tenantId;
            const userId = req.user.id;

            const rawKey = req.headers['idempotency-key'] || req.headers['Idempotency-Key'];
            const idempotencyKey = rawKey && typeof rawKey === 'string' ? rawKey.trim() : null;

            if (idempotencyKey) {
                if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) {
                    throw ApiError.badRequest('Invalid Idempotency-Key header format', 'INVALID_IDEMPOTENCY_KEY');
                }
            }

            if (idempotencyKey && idempotencyRepo && pool) {
                const normRoute = (req.url || '').split('?')[0].trim().toLowerCase();
                const requestHash = computeRequestHash(req.method, normRoute, body);

                const client = await pool.connect();
                let shouldRollback = true;
                try {
                    await client.query('BEGIN');

                    const { isNew, record } = await idempotencyRepo.reserveKey(client, {
                        tenantId,
                        userId,
                        idempotencyKey,
                        requestHash,
                    });

                    if (!isNew) {
                        await client.query('ROLLBACK');
                        shouldRollback = false;

                        if (record.request_hash !== requestHash) {
                            throw ApiError.conflict(
                                'Idempotency key has already been used with a different request payload or route',
                                'IDEMPOTENCY_CONFLICT'
                            );
                        }

                        if (record.status === 'PENDING') {
                            throw ApiError.conflict(
                                'A request with this idempotency key is currently processing',
                                'IDEMPOTENCY_CONFLICT'
                            );
                        }

                        if (record.status === 'COMPLETED') {
                            res.setHeader('X-Cache', 'IDEMPOTENT-REPLAY');
                            return sendJson(res, record.response_status_code || 201, record.response_body);
                        }

                        throw ApiError.conflict('Idempotency key collision in invalid state', 'IDEMPOTENCY_CONFLICT');
                    }

                    // Authoritative creator: create connection inside the transaction
                    const connection = await connectionService.createConnection({
                        tenantId,
                        phoneNumber: body.phoneNumber || null,
                        displayName: body.displayName || null,
                        actorUserId: userId,
                        ipAddress,
                        userAgent,
                    }, client);

                    const responseBody = { connection };
                    await idempotencyRepo.completeKey(client, {
                        id: record.id,
                        statusCode: 201,
                        responseBody,
                    });

                    await client.query('COMMIT');
                    shouldRollback = false;

                    return sendJson(res, 201, responseBody);
                } catch (err) {
                    if (shouldRollback) {
                        await client.query('ROLLBACK').catch(() => {});
                    }
                    throw err;
                } finally {
                    client.release();
                }
            }

            const connection = await connectionService.createConnection({
                tenantId,
                phoneNumber: body.phoneNumber || null,
                displayName: body.displayName || null,
                actorUserId: userId,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 201, { connection });
        }
    );

    // -------------------------------------------------------------
    // Single WhatsApp Connection Entity Routes
    // -------------------------------------------------------------

    // Route: GET /api/v1/tenants/:tenantId/connections/:connId (Gets connection, MEMBER, ADMIN, OWNER)
    router.get(
        '/api/v1/tenants/:tenantId/connections/:connId',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const connection = await connectionService.getConnection(req.tenantContext.tenantId, connId, {
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });
            return sendJson(res, 200, { connection });
        }
    );

    // Route: POST /api/v1/tenants/:tenantId/connections/:connId/connect (Starts connection, ADMIN, OWNER)
    router.post(
        '/api/v1/tenants/:tenantId/connections/:connId/connect',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const connection = await connectionService.startConnection({
                tenantId: req.tenantContext.tenantId,
                connectionId: connId,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, { connection, message: 'Connection start requested' });
        }
    );

    // Route: POST /api/v1/tenants/:tenantId/connections/:connId/disconnect (Stops connection, ADMIN, OWNER)
    router.post(
        '/api/v1/tenants/:tenantId/connections/:connId/disconnect',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const connection = await connectionService.stopConnection({
                tenantId: req.tenantContext.tenantId,
                connectionId: connId,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, { connection, message: 'Connection stop requested' });
        }
    );

    // Route: POST /api/v1/tenants/:tenantId/connections/:connId/reconnect (Reconnects connection, ADMIN, OWNER)
    router.post(
        '/api/v1/tenants/:tenantId/connections/:connId/reconnect',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const connection = await connectionService.reconnectConnection({
                tenantId: req.tenantContext.tenantId,
                connectionId: connId,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, { connection, message: 'Connection reconnect requested' });
        }
    );

    // Route: DELETE /api/v1/tenants/:tenantId/connections/:connId (Deletes connection, OWNER only)
    router.delete(
        '/api/v1/tenants/:tenantId/connections/:connId',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole('OWNER'),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const result = await connectionService.deleteConnection({
                tenantId: req.tenantContext.tenantId,
                connectionId: connId,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, result);
        }
    );

    // Route: GET /api/v1/tenants/:tenantId/connections/:connId/qr (Fetches ephemeral QR, ADMIN, OWNER)
    router.get(
        '/api/v1/tenants/:tenantId/connections/:connId/qr',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const qrEntry = await connectionService.getQrCode(req.tenantContext.tenantId, connId, {
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });
            return sendJson(res, 200, qrEntry);
        }
    );
}

module.exports = { registerConnectionRoutes };
