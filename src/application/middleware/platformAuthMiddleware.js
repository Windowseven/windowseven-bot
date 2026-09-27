/**
 * Windowseven MD Platform Authorization Middleware
 * Enforces cryptographic token verification + synchronous database role verification.
 * Does NOT trust JWT claims alone: queries platform_user_roles on every request for sub-millisecond revocation.
 */
const PLATFORM_ROLE_HIERARCHY = {
    ADMIN: 2,
    SUPER_ADMIN: 2,
    PLATFORM_ADMIN: 1,
};

function createPlatformAuthMiddleware({ tokenService, platformRoleRepo, requiredRole = null }) {
    if (!tokenService || !platformRoleRepo) {
        throw new Error('[createPlatformAuthMiddleware] tokenService and platformRoleRepo are required');
    }

    return async function platformAuthMiddleware(req, res, next) {
        const authHeader = req.headers['authorization'] || req.headers['Authorization'];

        if (!authHeader) {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'AUTH_REQUIRED',
                    message: 'Authentication is required. Please provide a Bearer access token.',
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        const parts = authHeader.trim().split(/\s+/);
        if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'TOKEN_INVALID',
                    message: 'Malformed authorization header. Expected "Bearer <token>".',
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        const token = parts[1];
        const result = tokenService.verifyAccessToken(token);

        if (!result.valid) {
            const isExpired = result.error && result.error.includes('expired');
            res.statusCode = 401;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: isExpired ? 'TOKEN_EXPIRED' : 'TOKEN_INVALID',
                    message: isExpired ? 'Access token has expired. Please refresh your session.' : (result.error || 'Invalid token'),
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        const userId = result.payload.sub;

        // Synchronous DB verification of active platform role (sub-millisecond revocation)
        const roles = await platformRoleRepo.findRolesByUserId(userId);
        if (!roles || roles.length === 0) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'PLATFORM_ACCESS_DENIED',
                    message: 'Platform administrator privilege required or role has been revoked.',
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        let highestRole = null;
        if (roles.includes('ADMIN')) {
            highestRole = 'ADMIN';
        } else if (roles.includes('SUPER_ADMIN')) {
            highestRole = 'SUPER_ADMIN';
        } else if (roles.includes('PLATFORM_ADMIN')) {
            highestRole = 'PLATFORM_ADMIN';
        }

        // Role hierarchy enforcement if specific role is required
        if (requiredRole) {
            const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
            const hasExplicit = allowed.some((r) => roles.includes(r));
            const userRank = PLATFORM_ROLE_HIERARCHY[highestRole] || 0;
            const requiredRank = typeof requiredRole === 'string' ? (PLATFORM_ROLE_HIERARCHY[requiredRole] || 0) : 0;

            if (!hasExplicit && userRank < requiredRank) {
                res.statusCode = 403;
                res.setHeader('Content-Type', 'application/json');
                return res.end(JSON.stringify({
                    success: false,
                    error: {
                        code: 'INSUFFICIENT_PLATFORM_ROLE',
                        message: `Insufficient platform role. Requires ${Array.isArray(requiredRole) ? requiredRole.join(' or ') : requiredRole}.`,
                    },
                    meta: { timestamp: new Date().toISOString() },
                }));
            }
        }

        // Attach verified immutable platform identity to request
        req.platformUser = Object.freeze({
            id: userId,
            email: result.payload.email,
            role: highestRole,
            roles: Object.freeze([...roles]),
        });

        // Also set req.user for common logging/auditing compatibility
        req.user = {
            id: userId,
            email: result.payload.email,
        };

        if (typeof next === 'function') {
            await next();
        }
    };
}

/**
 * Standalone middleware to enforce required platform role rank on already-authenticated platform requests.
 * Runs downstream of platformAuthMiddleware (which populates req.platformUser).
 *
 * @param {string|string[]} requiredRole - Minimum role required (e.g. 'SUPER_ADMIN') or array of accepted roles.
 */
function requirePlatformRole(requiredRole) {
    return function platformRoleMiddleware(req, res, next) {
        if (!req.platformUser) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'PLATFORM_ACCESS_DENIED',
                    message: 'Platform administrator privilege required or role has been revoked.',
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        const allowed = Array.isArray(requiredRole) ? requiredRole : [requiredRole];
        const userRoles = req.platformUser.roles || [];
        const hasExplicit = allowed.some((r) => userRoles.includes(r));
        const userRank = PLATFORM_ROLE_HIERARCHY[req.platformUser.role] || 0;
        const requiredRank = typeof requiredRole === 'string' ? (PLATFORM_ROLE_HIERARCHY[requiredRole] || 0) : 0;

        if (!hasExplicit && userRank < requiredRank) {
            res.statusCode = 403;
            res.setHeader('Content-Type', 'application/json');
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: 'INSUFFICIENT_PLATFORM_ROLE',
                    message: `Insufficient platform role. Requires ${Array.isArray(requiredRole) ? requiredRole.join(' or ') : requiredRole}.`,
                },
                meta: { timestamp: new Date().toISOString() },
            }));
        }

        if (typeof next === 'function') {
            next();
        }
    };
}

module.exports = {
    createPlatformAuthMiddleware,
    requirePlatformRole,
    PLATFORM_ROLE_HIERARCHY,
};
