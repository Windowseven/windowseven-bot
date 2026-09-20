const ApiError = require('../errors/ApiError');

/**
 * Windowseven MD Lightweight Zero-Dependency HTTP Router
 * Supports parameterized routes, middleware chains, method handling, 404 and 405.
 */
class HttpRouter {
    constructor() {
        this.routes = [];
    }

    /**
     * Registers a route pattern for a specific HTTP method.
     */
    add(method, pathPattern, ...handlers) {
        if (!method || !pathPattern) {
            throw new Error('Method and pathPattern are required');
        }

        const flatHandlers = handlers.flat().filter(Boolean);
        if (flatHandlers.length === 0) {
            throw new Error(`At least one handler is required for ${method} ${pathPattern}`);
        }

        // Normalize path pattern (remove trailing slash except root)
        const normalizedPattern = pathPattern === '/' ? '/' : pathPattern.replace(/\/+$/, '');

        // Extract parameter names and build matching regex
        const paramNames = [];
        const regexStr = normalizedPattern
            .replace(/\/:([a-zA-Z0-9_]+)/g, (_, paramName) => {
                paramNames.push(paramName);
                return '/([^/]+)';
            });

        const regex = new RegExp(`^${regexStr}$`);

        this.routes.push({
            method: method.toUpperCase(),
            pattern: normalizedPattern,
            regex,
            paramNames,
            handlers: flatHandlers,
        });

        return this;
    }

    get(path, ...handlers) { return this.add('GET', path, ...handlers); }
    post(path, ...handlers) { return this.add('POST', path, ...handlers); }
    put(path, ...handlers) { return this.add('PUT', path, ...handlers); }
    patch(path, ...handlers) { return this.add('PATCH', path, ...handlers); }
    delete(path, ...handlers) { return this.add('DELETE', path, ...handlers); }
    options(path, ...handlers) { return this.add('OPTIONS', path, ...handlers); }

    /**
     * Resolves and executes matching route for an incoming request.
     *
     * @param {import('node:http').IncomingMessage} req
     * @param {import('node:http').ServerResponse} res
     * @param {Function} [onNotFound]
     */
    async handle(req, res, onNotFound = null) {
        const parsedUrl = new URL(req.url, 'http://localhost');
        const pathname = parsedUrl.pathname === '/' ? '/' : parsedUrl.pathname.replace(/\/+$/, '');
        const method = req.method.toUpperCase();

        // Extract query parameters into req.query
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());

        const allowedMethods = new Set();
        let matchedRoute = null;
        let matchedParams = {};

        for (const route of this.routes) {
            const match = pathname.match(route.regex);
            if (match) {
                allowedMethods.add(route.method);
                if (route.method === method) {
                    matchedRoute = route;
                    // Extract named parameters
                    const values = match.slice(1);
                    matchedParams = {};
                    route.paramNames.forEach((name, i) => {
                        matchedParams[name] = decodeURIComponent(values[i]);
                    });
                    break;
                }
            }
        }

        // 1. Exact route and method match
        if (matchedRoute) {
            req.params = Object.assign(req.params || {}, matchedParams);
            return this.executeChain(matchedRoute.handlers, req, res);
        }

        // 2. Path matched other methods: 405 Method Not Allowed
        if (allowedMethods.size > 0) {
            // Handle automatic OPTIONS preflight
            if (method === 'OPTIONS') {
                const methods = Array.from(allowedMethods).join(', ');
                res.statusCode = 204;
                res.setHeader('Allow', methods);
                res.setHeader('Access-Control-Allow-Methods', methods);
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Request-ID');
                return res.end();
            }

            const allowHeader = Array.from(allowedMethods).sort().join(', ');
            res.setHeader('Allow', allowHeader);
            throw ApiError.methodNotAllowed(`Method ${method} not allowed for ${pathname}`);
        }

        // 3. No match found: 404
        if (typeof onNotFound === 'function') {
            return onNotFound(req, res);
        }

        throw ApiError.notFound(`Route ${method} ${pathname} not found`, 'ROUTE_NOT_FOUND');
    }

    /**
     * Executes an array of middleware/handler functions sequentially.
     * Supports both async handlers and synchronous callback-style middleware (next()).
     */
    async executeChain(handlers, req, res) {
        let index = 0;

        return new Promise((resolve, reject) => {
            const next = (err) => {
                if (err) {
                    return reject(err);
                }
                if (index >= handlers.length) {
                    return resolve();
                }
                const handler = handlers[index++];
                try {
                    const result = handler(req, res, next);
                    if (result && typeof result.then === 'function') {
                        result.catch(reject);
                    }
                } catch (syncErr) {
                    reject(syncErr);
                }
            };

            next();
        });
    }
}

module.exports = HttpRouter;
