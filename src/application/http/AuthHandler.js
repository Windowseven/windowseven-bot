const url = require('node:url');
const AuthError = require('../errors/AuthError');
const { createRateLimiter } = require('../middleware/rateLimiter');
const { createAuthMiddleware } = require('../middleware/authMiddleware');

/**
 * Cookie parsing and serialization utilities.
 */
function parseCookies(cookieHeader) {
    const list = {};
    if (!cookieHeader) return list;
    cookieHeader.split(';').forEach((cookie) => {
        const parts = cookie.split('=');
        if (parts.length >= 2) {
            const name = parts[0].trim();
            const val = parts.slice(1).join('=').trim();
            list[name] = decodeURIComponent(val);
        }
    });
    return list;
}

function serializeCookie(name, val, options = {}) {
    let str = `${name}=${encodeURIComponent(val)}`;
    if (options.maxAge != null) str += `; Max-Age=${options.maxAge}`;
    if (options.domain) str += `; Domain=${options.domain}`;
    if (options.path) str += `; Path=${options.path}`;
    if (options.expires) str += `; Expires=${options.expires.toUTCString()}`;
    if (options.httpOnly) str += '; HttpOnly';
    if (options.secure) str += '; Secure';
    if (options.sameSite) {
        const s = String(options.sameSite).toLowerCase();
        if (s === 'lax') str += '; SameSite=Lax';
        else if (s === 'strict') str += '; SameSite=Strict';
        else if (s === 'none') str += '; SameSite=None';
    }
    return str;
}

/**
 * Reads and parses JSON body from an incoming HTTP request.
 */
async function readJsonBody(req) {
    if (req.body && typeof req.body === 'object') {
        return req.body;
    }

    return new Promise((resolve, reject) => {
        let raw = '';
        req.on('data', (chunk) => {
            raw += chunk;
            // Prevent payload overflow (max 100KB)
            if (raw.length > 100 * 1024) {
                reject(new AuthError('Payload too large', 'PAYLOAD_TOO_LARGE', 413));
            }
        });
        req.on('end', () => {
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(new AuthError('Invalid JSON payload', 'MALFORMED_JSON', 400));
            }
        });
        req.on('error', (err) => reject(err));
    });
}

/**
 * Standard JSON response envelopes.
 */
function sendJson(res, statusCode, data, meta = {}) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        success: true,
        data,
        meta: {
            timestamp: new Date().toISOString(),
            ...meta,
        },
    }));
}

function sendError(res, statusCode, code, message, details = []) {
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
        success: false,
        error: {
            code,
            message,
            details,
        },
        meta: {
            timestamp: new Date().toISOString(),
        },
    }));
}

function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;
    return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Creates the HTTP request handler for Phase 4B authentication endpoints.
 * Compatible with standard Node.js http.createServer(), Express, and Connect.
 */
function createAuthHandler({
    authService,
    tokenService,
    cookieOptions = {},
    rateLimiter = null,
    allowedOrigins = [],
}) {
    if (!authService || !tokenService) {
        throw new Error('[createAuthHandler] authService and tokenService are required');
    }

    // Resolve allowed origins from explicit options or environment
    const rawOrigins = Array.isArray(allowedOrigins)
        ? allowedOrigins
        : (allowedOrigins ? [allowedOrigins] : []);
    const envOrigins = process.env.ALLOWED_ORIGINS
        ? process.env.ALLOWED_ORIGINS.split(',')
        : [];
    const combinedOrigins = [...rawOrigins, ...envOrigins];
    const allowedOriginsSet = new Set(
        combinedOrigins.map(normalizeOrigin).filter(Boolean)
    );

    const defaultCookieConfig = {
        httpOnly: true,
        secure: cookieOptions.secure !== undefined ? cookieOptions.secure : (process.env.NODE_ENV === 'production'),
        sameSite: cookieOptions.sameSite || (process.env.COOKIE_SAME_SITE || 'Strict'),
        path: cookieOptions.path || '/api/v1/auth',
        maxAge: 7 * 24 * 60 * 60, // 7 days in seconds
        ...cookieOptions,
    };

    const authMiddleware = createAuthMiddleware(tokenService);
    const authRateLimiter = rateLimiter || createRateLimiter({
        windowMs: 60 * 1000,
        maxRequests: 10,
    });

    return async function authHandler(req, res, next) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
        const method = req.method.toUpperCase();

        const ipAddress = req.ip || req.headers['x-forwarded-for'] || req.socket?.remoteAddress || null;
        const userAgent = req.headers['user-agent'] || null;

        // CORS Preflight (OPTIONS) Handling for auth routes
        if (method === 'OPTIONS' && pathname.startsWith('/api/v1/auth')) {
            const reqOrigin = req.headers['origin'];
            if (reqOrigin) {
                const normOrigin = normalizeOrigin(reqOrigin);
                if (allowedOriginsSet.size > 0 && !allowedOriginsSet.has(normOrigin)) {
                    return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Origin not allowed');
                }
                res.setHeader('Access-Control-Allow-Origin', reqOrigin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
                res.setHeader('Access-Control-Max-Age', '86400');
            }
            res.statusCode = 204;
            return res.end();
        }

        // Attach CORS headers and validate Origin header if present
        const reqOrigin = req.headers['origin'];
        if (reqOrigin && pathname.startsWith('/api/v1/auth')) {
            const normOrigin = normalizeOrigin(reqOrigin);
            if (allowedOriginsSet.size > 0) {
                if (!allowedOriginsSet.has(normOrigin)) {
                    return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Origin not allowed');
                }
                res.setHeader('Access-Control-Allow-Origin', reqOrigin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Vary', 'Origin');
            }
        }

        // Route: POST /api/v1/auth/register
        if (method === 'POST' && pathname === '/api/v1/auth/register') {
            return authRateLimiter(req, res, async () => {
                try {
                    const body = await readJsonBody(req);
                    const result = await authService.register({
                        email: body.email,
                        password: body.password,
                        ipAddress,
                        userAgent,
                    });
                    return sendJson(res, 201, result);
                } catch (err) {
                    if (err instanceof AuthError) {
                        return sendError(res, err.statusCode, err.code, err.message, err.details);
                    }
                    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
                }
            });
        }

        // Route: POST /api/v1/auth/login
        if (method === 'POST' && pathname === '/api/v1/auth/login') {
            return authRateLimiter(req, res, async () => {
                try {
                    const body = await readJsonBody(req);
                    const result = await authService.login({
                        email: body.email,
                        password: body.password,
                        ipAddress,
                        userAgent,
                    });

                    // Set secure HTTP-only refresh cookie
                    const cookieStr = serializeCookie('refreshToken', result.refreshToken, defaultCookieConfig);
                    res.setHeader('Set-Cookie', cookieStr);

                    return sendJson(res, 200, {
                        user: result.user,
                        accessToken: result.accessToken,
                    });
                } catch (err) {
                    if (err instanceof AuthError) {
                        return sendError(res, err.statusCode, err.code, err.message, err.details);
                    }
                    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
                }
            });
        }

        // Route: POST /api/v1/auth/refresh
        if (method === 'POST' && pathname === '/api/v1/auth/refresh') {
            return authRateLimiter(req, res, async () => {
                try {
                    const cookies = parseCookies(req.headers['cookie']);
                    const rawRefreshToken = cookies.refreshToken;

                    if (!rawRefreshToken) {
                        return sendError(res, 400, 'INVALID_REFRESH_TOKEN', 'Refresh token is required via cookie');
                    }

                    // CSRF Validation for cookie-based authentication
                    const origin = req.headers['origin'];
                    const referer = req.headers['referer'];
                    const requestedWith = req.headers['x-requested-with'];

                    let refererOrigin = null;
                    if (referer) {
                        try {
                            refererOrigin = new URL(referer).origin.toLowerCase();
                        } catch (e) {}
                    }

                    if (allowedOriginsSet.size > 0) {
                        if (origin) {
                            if (!allowedOriginsSet.has(normalizeOrigin(origin))) {
                                return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Origin not allowed');
                            }
                        } else if (refererOrigin) {
                            if (!allowedOriginsSet.has(refererOrigin)) {
                                return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Referer origin not allowed');
                            }
                        } else if (!requestedWith) {
                            return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Missing CSRF protection header for cookie refresh');
                        }
                    } else {
                        // Fallback defense-in-depth when allowedOrigins is not explicitly configured
                        if (!origin && !referer && !requestedWith) {
                            return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Missing CSRF protection header for cookie refresh');
                        }
                    }

                    const result = await authService.refresh({
                        rawRefreshToken,
                        ipAddress,
                        userAgent,
                    });

                    // Set rotated refresh cookie
                    const cookieStr = serializeCookie('refreshToken', result.refreshToken, defaultCookieConfig);
                    res.setHeader('Set-Cookie', cookieStr);

                    return sendJson(res, 200, {
                        accessToken: result.accessToken,
                    });
                } catch (err) {
                    if (err instanceof AuthError) {
                        return sendError(res, err.statusCode, err.code, err.message, err.details);
                    }
                    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
                }
            });
        }

        // Route: POST /api/v1/auth/logout
        if (method === 'POST' && pathname === '/api/v1/auth/logout') {
            try {
                const cookies = parseCookies(req.headers['cookie']);
                const rawRefreshToken = cookies.refreshToken || null;

                // CSRF check on logout if origin/referer is supplied
                const origin = req.headers['origin'];
                const referer = req.headers['referer'];
                if (allowedOriginsSet.size > 0) {
                    if (origin && !allowedOriginsSet.has(normalizeOrigin(origin))) {
                        return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Origin not allowed');
                    }
                    if (referer) {
                        try {
                            const refOrigin = new URL(referer).origin.toLowerCase();
                            if (!allowedOriginsSet.has(refOrigin)) {
                                return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Referer origin not allowed');
                            }
                        } catch (e) {}
                    }
                }

                if (rawRefreshToken) {
                    await authService.logout({
                        rawRefreshToken,
                        ipAddress,
                        userAgent,
                    });
                }

                // Clear refresh cookie
                const clearCookieStr = serializeCookie('refreshToken', '', {
                    ...defaultCookieConfig,
                    maxAge: 0,
                    expires: new Date(0),
                });
                res.setHeader('Set-Cookie', clearCookieStr);

                return sendJson(res, 200, { message: 'Logged out successfully' });
            } catch (err) {
                if (err instanceof AuthError) {
                    return sendError(res, err.statusCode, err.code, err.message, err.details);
                }
                return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
            }
        }

        // Route: GET /api/v1/auth/me
        if (method === 'GET' && pathname === '/api/v1/auth/me') {
            return authMiddleware(req, res, async () => {
                try {
                    const result = await authService.getMe(req.user.id);
                    return sendJson(res, 200, result);
                } catch (err) {
                    if (err instanceof AuthError) {
                        return sendError(res, err.statusCode, err.code, err.message, err.details);
                    }
                    return sendError(res, 500, 'INTERNAL_SERVER_ERROR', 'An unexpected error occurred');
                }
            });
        }

        // Fallthrough if not an auth route
        if (typeof next === 'function') {
            return next();
        }

        res.statusCode = 404;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            success: false,
            error: {
                code: 'ROUTE_NOT_FOUND',
                message: `Route ${method} ${pathname} not found`,
            },
            meta: { timestamp: new Date().toISOString() },
        }));
    };
}

module.exports = {
    createAuthHandler,
    parseCookies,
    serializeCookie,
};
