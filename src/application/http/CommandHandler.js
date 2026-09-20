const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');

/**
 * Registers connection command status polling routes.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('../../repositories/ConnectionCommandRepository')} params.commandRepo
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {Function} params.sendJson
 */
function registerCommandRoutes({
    router,
    commandRepo,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    sendJson,
}) {
    // -------------------------------------------------------------
    // Poll Command Status
    // Route: GET /api/v1/tenants/:tenantId/commands/:commandId
    // -------------------------------------------------------------
    router.get(
        '/api/v1/tenants/:tenantId/commands/:commandId',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const commandId = validateUuid(req.params.commandId, 'commandId');
            const command = await commandRepo.findByIdForTenant(commandId, req.tenantContext.tenantId);

            if (!command) {
                throw ApiError.notFound('Command not found', 'RESOURCE_NOT_FOUND');
            }

            return sendJson(res, 200, { command });
        }
    );
}

module.exports = { registerCommandRoutes };
