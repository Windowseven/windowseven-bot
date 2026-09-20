/**
 * Windowseven MD Authentication Middleware
 * Validates EdDSA Bearer Access Tokens and populates req.user.
 */
function createAuthMiddleware(tokenService) {
    if (!tokenService) {
        throw new Error('[createAuthMiddleware] tokenService is required');
    }

    return (req, res, next) => {
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

        // Authoritative user identity extracted from verified token
        req.user = {
            id: result.payload.sub,
            email: result.payload.email,
        };

        if (typeof next === 'function') {
            next();
        }
    };
}

module.exports = { createAuthMiddleware };
