/**
 * Windowseven MD In-Memory Rate Limiter Foundation
 * Process-local sliding window rate limiter designed for interface parity with future distributed stores.
 *
 * NOTE ON SCALABILITY: This foundation is currently process-local and suitable for single-node development
 * and integration testing. In multi-node horizontal production clusters, this interface should be
 * backed by an atomic distributed store (e.g. Redis sliding window or Token Bucket).
 */
function createRateLimiter({
    windowMs = 60 * 1000,
    maxRequests = 10,
    keyGenerator = (req) => req.ip || req.socket?.remoteAddress || '127.0.0.1',
    errorCode = 'RATE_LIMITED',
    errorMessage = 'Too many requests, please try again later.',
} = {}) {
    const hits = new Map();

    // Periodic sweep to prevent unbounded memory growth
    const sweepInterval = setInterval(() => {
        const now = Date.now();
        for (const [key, timestamps] of hits.entries()) {
            const valid = timestamps.filter((t) => now - t < windowMs);
            if (valid.length === 0) {
                hits.delete(key);
            } else {
                hits.set(key, valid);
            }
        }
    }, windowMs).unref();

    const limiter = (req, res, next) => {
        const key = keyGenerator(req);
        const now = Date.now();
        const timestamps = hits.get(key) || [];

        // Prune older than windowMs
        const recent = timestamps.filter((t) => now - t < windowMs);

        if (recent.length >= maxRequests) {
            res.statusCode = 429;
            res.setHeader('Content-Type', 'application/json');
            res.setHeader('Retry-After', Math.ceil(windowMs / 1000));
            return res.end(JSON.stringify({
                success: false,
                error: {
                    code: errorCode,
                    message: errorMessage,
                },
                meta: {
                    timestamp: new Date().toISOString(),
                },
            }));
        }

        recent.push(now);
        hits.set(key, recent);

        if (typeof next === 'function') {
            next();
        }
    };

    // Helper for test teardown
    limiter.reset = () => {
        hits.clear();
    };

    limiter.destroy = () => {
        clearInterval(sweepInterval);
        hits.clear();
    };

    return limiter;
}

module.exports = { createRateLimiter };
