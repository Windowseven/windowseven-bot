const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');

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

            const connection = await connectionService.createConnection({
                tenantId: req.tenantContext.tenantId,
                phoneNumber: body.phoneNumber || null,
                displayName: body.displayName || null,
                actorUserId: req.user.id,
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
