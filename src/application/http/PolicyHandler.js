const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');

/**
 * Registers WhatsApp group policy configuration routes.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('../services/PolicyService')} params.policyService
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {Function} params.sendJson
 * @param {Function} params.readJsonBody
 */
function registerPolicyRoutes({
    router,
    policyService,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    sendJson,
    readJsonBody,
}) {
    // -------------------------------------------------------------
    // Get Group Policy
    // Route: GET /api/v1/tenants/:tenantId/groups/:groupId/policies
    // -------------------------------------------------------------
    router.get(
        '/api/v1/tenants/:tenantId/groups/:groupId/policies',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const policy = await policyService.getPolicy(req.tenantContext.tenantId, groupId);
            return sendJson(res, 200, { policy });
        }
    );

    // -------------------------------------------------------------
    // Update Group Policy (Strict validation, rejects unknown keys with 422)
    // Route: PUT /api/v1/tenants/:tenantId/groups/:groupId/policies
    // -------------------------------------------------------------
    router.put(
        '/api/v1/tenants/:tenantId/groups/:groupId/policies',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const body = await readJsonBody(req);
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const policy = await policyService.updatePolicy(
                req.tenantContext.tenantId,
                groupId,
                body,
                {
                    actorUserId: req.user.id,
                    ipAddress,
                    userAgent,
                }
            );

            return sendJson(res, 200, { policy });
        }
    );
}

module.exports = { registerPolicyRoutes };
