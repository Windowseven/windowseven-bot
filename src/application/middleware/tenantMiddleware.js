const ApiError = require('../errors/ApiError');
const { validateUuid } = require('../http/validation');

const ROLE_HIERARCHY = {
    OWNER: 3,
    ADMIN: 2,
    MEMBER: 1,
};

/**
 * Windowseven MD Tenant Context Middleware
 * Enforces the authoritative identity-to-tenant-context boundary:
 * req.user.id -> tenant_memberships -> verified req.tenantContext.
 */
function createTenantMiddleware({ tenantMembershipRepo, tenantRepo, auditLogRepo = null }) {
    if (!tenantMembershipRepo || !tenantRepo) {
        throw new Error('[createTenantMiddleware] tenantMembershipRepo and tenantRepo are required');
    }

    return async function tenantMiddleware(req, res, next) {
        if (!req.user || !req.user.id) {
            throw ApiError.unauthorized('Authentication required to access tenant resources', 'AUTH_REQUIRED');
        }

        const rawTenantId = req.params?.tenantId || req.params?.id;
        if (!rawTenantId) {
            throw ApiError.badRequest('Tenant ID parameter is required in URL path', 'MISSING_TENANT_ID');
        }

        const tenantId = validateUuid(rawTenantId, 'tenantId');

        // 1. Verify tenant existence in database
        const tenant = await tenantRepo.findById(tenantId);
        if (!tenant) {
            throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
        }

        // 1b. Enforce tenant lifecycle status boundaries
        if (tenant.status === 'DEACTIVATED') {
            throw ApiError.forbidden('Tenant has been deactivated', 'TENANT_DEACTIVATED');
        }

        const isReadOperation = req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS';
        if (tenant.status === 'SUSPENDED' && !isReadOperation) {
            throw ApiError.forbidden('Tenant is suspended. Mutating operations are disabled.', 'TENANT_SUSPENDED');
        }

        // 2. Authoritative membership verification against authenticated user
        const membership = await tenantMembershipRepo.findByTenantAndUser(tenantId, req.user.id);
        if (!membership) {
            if (auditLogRepo) {
                await auditLogRepo.create({
                    tenantId,
                    actorUserId: req.user.id,
                    action: 'UNAUTHORIZED_TENANT_ACCESS_ATTEMPT',
                    resourceType: 'TENANT',
                    resourceId: tenantId,
                    metadata: { path: req.url, method: req.method },
                    ipAddress: req.ip || req.socket?.remoteAddress || null,
                    userAgent: req.headers['user-agent'] || null,
                }).catch(() => {});
            }

            throw ApiError.forbidden('Access to this tenant is denied', 'TENANT_ACCESS_DENIED');
        }

        // 3. Attach immutable verified tenant execution context
        req.tenantContext = Object.freeze({
            tenantId: membership.tenant_id,
            userId: req.user.id,
            role: membership.role,
            membershipId: membership.id,
            tenantName: tenant.name,
            tenantStatus: tenant.status || 'ACTIVE',
        });

        if (typeof next === 'function') {
            await next();
        }
    };
}

/**
 * Reusable role authorization middleware.
 * Supports explicit role lists or hierarchical role enforcement (OWNER > ADMIN > MEMBER).
 *
 * @param {string|string[]} requiredRole - Minimum role required, or array of acceptable roles.
 */
function requireTenantRole(requiredRole) {
    return function roleMiddleware(req, res, next) {
        if (!req.tenantContext) {
            throw ApiError.internal('Tenant context has not been resolved. Ensure tenantMiddleware runs first.');
        }

        const userRole = req.tenantContext.role;

        if (Array.isArray(requiredRole)) {
            if (!requiredRole.includes(userRole)) {
                throw ApiError.forbidden('Insufficient permissions for this operation', 'INSUFFICIENT_ROLE');
            }
        } else {
            const userRank = ROLE_HIERARCHY[userRole] || 0;
            const requiredRank = ROLE_HIERARCHY[requiredRole] || 0;

            if (userRank < requiredRank) {
                throw ApiError.forbidden('Insufficient permissions for this operation', 'INSUFFICIENT_ROLE');
            }
        }

        if (typeof next === 'function') {
            next();
        }
    };
}

module.exports = {
    createTenantMiddleware,
    requireTenantRole,
    ROLE_HIERARCHY,
};
