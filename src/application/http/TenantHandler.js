const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');

/**
 * Registers tenant and tenant-membership routes on the router.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('../services/TenantService')} params.tenantService
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {import('../../repositories/WhatsAppConnectionRepository')} [params.whatsAppConnectionRepo]
 * @param {Function} params.sendJson
 * @param {Function} params.readJsonBody
 */
function registerTenantRoutes({
    router,
    tenantService,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    whatsAppConnectionRepo = null,
    sendJson,
    readJsonBody,
}) {
    // -------------------------------------------------------------
    // Tenant Collection & Creation Routes
    // -------------------------------------------------------------

    // Route: GET /api/v1/tenants (Lists user's tenants)
    router.get('/api/v1/tenants', authMiddleware, async (req, res) => {
        const tenants = await tenantService.listTenantsForUser(req.user.id);
        return sendJson(res, 200, { tenants });
    });

    // Route: POST /api/v1/tenants (Creates tenant, creator assigned as OWNER)
    router.post('/api/v1/tenants', authMiddleware, async (req, res) => {
        const body = await readJsonBody(req);
        const ipAddress = req.ip || req.socket?.remoteAddress || null;
        const userAgent = req.headers['user-agent'] || null;

        const result = await tenantService.createTenant({
            name: body.name,
            userId: req.user.id,
            ipAddress,
            userAgent,
        });

        return sendJson(res, 201, result);
    });

    // -------------------------------------------------------------
    // Tenant-Scoped Routes (/api/v1/tenants/:tenantId)
    // -------------------------------------------------------------

    // Route: GET /api/v1/tenants/:tenantId (Tenant details, requires membership)
    router.get('/api/v1/tenants/:tenantId', authMiddleware, tenantMiddleware, async (req, res) => {
        const tenant = await tenantService.getTenant(req.tenantContext.tenantId);
        return sendJson(res, 200, {
            tenant: {
                ...tenant,
                currentUserRole: req.tenantContext.role,
            },
        });
    });

    // Route: GET /api/v1/tenants/:tenantId/members (List members, requires membership)
    router.get('/api/v1/tenants/:tenantId/members', authMiddleware, tenantMiddleware, async (req, res) => {
        const members = await tenantService.listMembers(req.tenantContext.tenantId);
        return sendJson(res, 200, { members });
    });

    // Route: POST /api/v1/tenants/:tenantId/members (Add member, requires OWNER or ADMIN)
    router.post(
        '/api/v1/tenants/:tenantId/members',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const body = await readJsonBody(req);
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const member = await tenantService.addMember({
                tenantId: req.tenantContext.tenantId,
                targetEmail: body.email,
                role: body.role || 'MEMBER',
                actorUserId: req.user.id,
                actorRole: req.tenantContext.role,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 201, { member });
        }
    );

    // Route: PATCH /api/v1/tenants/:tenantId/members/:userId (Update role, requires OWNER)
    router.patch(
        '/api/v1/tenants/:tenantId/members/:userId',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole('OWNER'),
        async (req, res) => {
            const targetUserId = validateUuid(req.params.userId, 'userId');
            const body = await readJsonBody(req);
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const member = await tenantService.updateMemberRole({
                tenantId: req.tenantContext.tenantId,
                targetUserId,
                newRole: body.role,
                actorUserId: req.user.id,
                actorRole: req.tenantContext.role,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, { member });
        }
    );

    // Route: DELETE /api/v1/tenants/:tenantId/members/:userId (Remove member, OWNER or self)
    router.delete(
        '/api/v1/tenants/:tenantId/members/:userId',
        authMiddleware,
        tenantMiddleware,
        async (req, res) => {
            const targetUserId = validateUuid(req.params.userId, 'userId');
            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const result = await tenantService.removeMember({
                tenantId: req.tenantContext.tenantId,
                targetUserId,
                actorUserId: req.user.id,
                actorRole: req.tenantContext.role,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, result);
        }
    );

}

module.exports = { registerTenantRoutes };
