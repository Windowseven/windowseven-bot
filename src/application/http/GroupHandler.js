const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');

/**
 * Registers WhatsApp group management routes.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('../services/GroupService')} params.groupService
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {Function} params.sendJson
 * @param {Function} params.readJsonBody
 */
function registerGroupRoutes({
    router,
    groupService,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    sendJson,
    readJsonBody,
}) {
    // -------------------------------------------------------------
    // Groups Collection for a Connection
    // Route: GET /api/v1/tenants/:tenantId/connections/:connId/groups
    // -------------------------------------------------------------
    router.get(
        '/api/v1/tenants/:tenantId/connections/:connId/groups',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const result = await groupService.listGroupsForConnection(
                req.tenantContext.tenantId,
                connId,
                {
                    status: req.query.status || null,
                    limit: req.query.limit,
                    offset: req.query.offset,
                }
            );
            return sendJson(res, 200, result);
        }
    );

    // -------------------------------------------------------------
    // Single Group Entity
    // Route: GET /api/v1/tenants/:tenantId/groups/:groupId
    // -------------------------------------------------------------
    router.get(
        '/api/v1/tenants/:tenantId/groups/:groupId',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const group = await groupService.getGroup(req.tenantContext.tenantId, groupId);
            return sendJson(res, 200, { group });
        }
    );

    // -------------------------------------------------------------
    // Trigger On-Demand Group Synchronization
    // Route: POST /api/v1/tenants/:tenantId/connections/:connId/groups/sync
    // -------------------------------------------------------------
    router.post(
        '/api/v1/tenants/:tenantId/connections/:connId/groups/sync',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const connId = validateUuid(req.params.connId, 'connId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const result = await groupService.requestGroupSync(
                req.tenantContext.tenantId,
                connId,
                {
                    actorUserId: req.user.id,
                    ipAddress,
                    userAgent,
                }
            );

            return sendJson(res, 202, result);
        }
    );

    // -------------------------------------------------------------
    // Update Group Status (MANAGED / UNMANAGED)
    // Route: PATCH /api/v1/tenants/:tenantId/groups/:groupId/status
    // -------------------------------------------------------------
    router.patch(
        '/api/v1/tenants/:tenantId/groups/:groupId/status',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const body = await readJsonBody(req);

            if (!body || !body.status) {
                throw ApiError.badRequest('status field is required', 'VALIDATION_ERROR');
            }

            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const group = await groupService.updateGroupStatus(
                req.tenantContext.tenantId,
                groupId,
                body.status,
                {
                    actorUserId: req.user.id,
                    ipAddress,
                    userAgent,
                }
            );

            return sendJson(res, 200, { group });
        }
    );
}

module.exports = { registerGroupRoutes };
