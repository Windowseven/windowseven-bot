const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const ApiError = require('../errors/ApiError');
const HttpRouter = require('./HttpRouter');
const { createAuthHandler, parseCookies, serializeCookie } = require('./AuthHandler');
const { createAuthMiddleware } = require('../middleware/authMiddleware');
const { createTenantMiddleware, requireTenantRole } = require('../middleware/tenantMiddleware');
const { registerTenantRoutes } = require('./TenantHandler');
const { registerConnectionRoutes } = require('./ConnectionHandler');
const { registerGroupRoutes } = require('./GroupHandler');
const { registerPolicyRoutes } = require('./PolicyHandler');
const { registerModerationRoutes } = require('./ModerationHandler');
const { registerCommandRoutes } = require('./CommandHandler');
const TenantService = require('../services/TenantService');
const ConnectionService = require('../services/ConnectionService');
const GroupService = require('../services/GroupService');
const PolicyService = require('../services/PolicyService');
const WarningService = require('../services/WarningService');
const PlatformService = require('../services/PlatformService');
const { createPlatformAuthMiddleware, requirePlatformRole } = require('../middleware/platformAuthMiddleware');
const { registerPlatformRoutes } = require('./PlatformHandler');
const { registerAdminRoutes } = require('./AdminHandler');
const { registerCustomerRoutes } = require('./CustomerHandler');
const { defaultMetricsRegistry } = require('../metrics/MetricsRegistry');
const SseGateway = require('../realtime/SseGateway');
const { defaultEventPublisher } = require('../realtime/EventPublisher');
const { defaultCommandGateway } = require('../../whatsapp/control/ConnectionCommandGateway');
const { defaultQrStore } = require('../../whatsapp/control/EphemeralQrStore');
const CustomerPurchaseService = require('../services/CustomerPurchaseService');
const PaymentService = require('../services/PaymentService');
const { TestPaymentGateway } = require('../payments');
const {
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    ConnectionCommandRepository,
    ScheduledModerationTaskRepository,
    IdempotencyRepository,
    WorkerRepository,
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
} = require('../../repositories');

/**
 * Validates or assigns a request ID (X-Request-ID).
 */
function resolveRequestId(req) {
    const headerVal = req.headers['x-request-id'];
    if (headerVal && typeof headerVal === 'string') {
        const trimmed = headerVal.trim();
        // Allow alphanumeric, dashes, and underscores up to 64 chars
        if (/^[a-zA-Z0-9_-]{1,64}$/.test(trimmed)) {
            return trimmed;
        }
    }
    return crypto.randomUUID();
}

/**
 * Normalizes an origin string.
 */
function normalizeOrigin(origin) {
    if (!origin || typeof origin !== 'string') return null;
    return origin.trim().toLowerCase().replace(/\/+$/, '');
}

/**
 * Safely reads and parses JSON payload with strict size limits (max 100KB).
 */
async function readJsonBody(req, limitBytes = 100 * 1024) {
    if (req.body && typeof req.body === 'object') {
        return req.body;
    }

    return new Promise((resolve, reject) => {
        let raw = '';
        let byteLength = 0;
        let hasRejected = false;

        req.on('data', (chunk) => {
            byteLength += chunk.length;
            if (byteLength > limitBytes) {
                if (!hasRejected) {
                    hasRejected = true;
                    reject(ApiError.payloadTooLarge('Payload too large: exceeds 100KB limit', 'PAYLOAD_TOO_LARGE'));
                }
                return; // discard further data without buffering
            }
            if (!hasRejected) {
                raw += chunk;
            }
        });

        req.on('end', () => {
            if (hasRejected) return;
            req.rawBody = raw;
            if (!raw.trim()) {
                resolve({});
                return;
            }
            try {
                resolve(JSON.parse(raw));
            } catch (err) {
                reject(ApiError.badRequest('Malformed JSON payload', 'MALFORMED_JSON', [
                    { message: 'Request body must be valid JSON' },
                ]));
            }
        });

        req.on('error', (err) => {
            if (!hasRejected) {
                reject(err);
            }
        });
    });
}

/**
 * Standard JSON response envelope.
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

/**
 * Standard JSON error response envelope.
 * Strictly suppresses stack traces, SQL queries, and secrets.
 */
function sendError(res, statusCode, code, message, details = [], meta = {}) {
    if (res.writableEnded) return;
    res.statusCode = statusCode;
    if (statusCode === 413) {
        res.setHeader('Connection', 'close');
    }
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
            ...meta,
        },
    }));
}

/**
 * Creates the unified REST HTTP Application.
 *
 * @param {object} params
 * @param {import('pg').Pool} params.pool
 * @param {import('../services/TokenService')} params.tokenService
 * @param {import('../services/AuthService')} params.authService
 * @param {import('../../repositories/TenantRepository')} params.tenantRepo
 * @param {import('../../repositories/TenantMembershipRepository')} params.tenantMembershipRepo
 * @param {import('../../repositories/UserRepository')} params.userRepo
 * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
 * @param {import('../../repositories/WhatsAppConnectionRepository')} [params.whatsAppConnectionRepo]
 * @param {string[]} [params.allowedOrigins]
 * @param {object} [params.cookieOptions]
 * @param {Function} [params.rateLimiter]
 */
function createRestApp({
    pool,
    tokenService,
    authService,
    tenantRepo,
    tenantMembershipRepo,
    userRepo,
    auditLogRepo = null,
    whatsAppConnectionRepo = null,
    connectionService = null,
    sseGateway = null,
    commandGateway = defaultCommandGateway,
    eventPublisher = defaultEventPublisher,
    qrStore = defaultQrStore,
    allowedOrigins = [],
    cookieOptions = {},
    rateLimiter = null,
    groupRepo = null,
    groupPolicyRepo = null,
    groupWarningRepo = null,
    connectionCommandRepo = null,
    scheduledTaskRepo = null,
    idempotencyRepo = null,
    groupService = null,
    policyService = null,
    warningService = null,
    workerRepo = null,
    platformRoleRepo = null,
    platformAuditRepo = null,
    platformIdempotencyRepo = null,
    platformService = null,
    planRepo = null,
    subscriptionRepo = null,
    paymentRepo = null,
    customerPurchaseService = null,
    paymentGateway = null,
    paymentService = null,
    metricsRegistry = defaultMetricsRegistry,
}) {
    if (!pool || !tokenService || !authService || !tenantRepo || !tenantMembershipRepo || !userRepo) {
        throw new Error('[createRestApp] pool, tokenService, authService, tenantRepo, tenantMembershipRepo, and userRepo are required');
    }

    // Resolve allowed origins
    const rawOrigins = Array.isArray(allowedOrigins) ? allowedOrigins : (allowedOrigins ? [allowedOrigins] : []);
    const envOrigins = process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',') : [];
    const combinedOrigins = [...rawOrigins, ...envOrigins];
    const allowedOriginsSet = new Set(combinedOrigins.map(normalizeOrigin).filter(Boolean));

    // Middleware instances
    const authMiddleware = createAuthMiddleware(tokenService);
    const tenantMiddleware = createTenantMiddleware({
        tenantMembershipRepo,
        tenantRepo,
        auditLogRepo,
    });

    // Services
    const tenantService = new TenantService({
        pool,
        tenantRepo,
        tenantMembershipRepo,
        userRepo,
        auditLogRepo,
    });

    // Router instance
    const router = new HttpRouter();

    // 1. Health check routes
    router.get('/health/live', (req, res) => {
        return sendJson(res, 200, { status: 'alive' }, { requestId: req.id });
    });

    router.get('/health/ready', async (req, res) => {
        try {
            await pool.query('SELECT 1;');
            return sendJson(res, 200, { status: 'ready', database: 'connected' }, { requestId: req.id });
        } catch (err) {
            return sendError(res, 503, 'SERVICE_UNAVAILABLE', 'Database connection not ready', [], { requestId: req.id });
        }
    });

    // 1b. Prometheus /metrics exposition endpoint
    if (metricsRegistry) {
        // Register dynamic collectors
        if (whatsAppConnectionRepo && typeof whatsAppConnectionRepo.countByActualState === 'function') {
            metricsRegistry.addCollector(async () => {
                const counts = await whatsAppConnectionRepo.countByActualState();
                for (const [state, count] of Object.entries(counts)) {
                    metricsRegistry.whatsappConnectionsTotal.set({ state }, count);
                }
            });
        }

        if (pool) {
            metricsRegistry.addCollector(() => {
                const total = pool.totalCount || 0;
                const idle = pool.idleCount || 0;
                const active = Math.max(0, total - idle);
                const waiting = pool.waitingCount || 0;
                metricsRegistry.pgPoolConnections.set({ state: 'total' }, total);
                metricsRegistry.pgPoolConnections.set({ state: 'idle' }, idle);
                metricsRegistry.pgPoolConnections.set({ state: 'active' }, active);
                metricsRegistry.pgPoolConnections.set({ state: 'waiting' }, waiting);
            });
        }

        router.get('/metrics', async (req, res) => {
            const text = await metricsRegistry.toPrometheusFormat();
            res.statusCode = 200;
            res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
            return res.end(text);
        });
    }

    // 2. Register Tenant Routes
    registerTenantRoutes({
        router,
        tenantService,
        authMiddleware,
        tenantMiddleware,
        requireTenantRole,
        whatsAppConnectionRepo,
        sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
        readJsonBody,
    });

    // 3. Connection Service & Realtime Routes (Phase 4D)
    let connService = connectionService;
    if (!connService && whatsAppConnectionRepo) {
        connService = new ConnectionService({
            pool,
            connRepo: whatsAppConnectionRepo,
            auditLogRepo,
            commandGateway,
            qrStore,
        });
    }

    let realtimeGateway = sseGateway;
    if (!realtimeGateway) {
        realtimeGateway = new SseGateway({ eventPublisher });
    }

    const effectiveIdempotencyRepo = idempotencyRepo || (pool ? new IdempotencyRepository(pool) : null);

    if (connService) {
        registerConnectionRoutes({
            router,
            connectionService: connService,
            sseGateway: realtimeGateway,
            authMiddleware,
            tenantMiddleware,
            requireTenantRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
            idempotencyRepo: effectiveIdempotencyRepo,
            pool,
        });
    }

    // 4. Phase 4E Repositories & Services (Groups, Policies, Moderation, Commands)
    const effectiveGroupRepo = groupRepo || (pool ? new GroupRepository(pool) : null);
    const effectivePolicyRepo = groupPolicyRepo || (pool ? new GroupPolicyRepository(pool) : null);
    const effectiveWarningRepo = groupWarningRepo || (pool ? new GroupWarningRepository(pool) : null);
    const effectiveCommandRepo = connectionCommandRepo || (pool ? new ConnectionCommandRepository(pool) : null);
    const effectiveTaskRepo = scheduledTaskRepo || (pool ? new ScheduledModerationTaskRepository(pool) : null);

    const effectiveGroupService = groupService || (effectiveGroupRepo && whatsAppConnectionRepo ? new GroupService({
        pool,
        groupRepo: effectiveGroupRepo,
        policyRepo: effectivePolicyRepo,
        connRepo: whatsAppConnectionRepo,
        commandRepo: effectiveCommandRepo,
        taskRepo: effectiveTaskRepo,
        auditLogRepo,
        commandGateway,
        eventPublisher,
    }) : null);

    const effectivePolicyService = policyService || (effectiveGroupRepo && effectivePolicyRepo ? new PolicyService({
        pool,
        groupRepo: effectiveGroupRepo,
        policyRepo: effectivePolicyRepo,
        auditLogRepo,
        eventPublisher,
    }) : null);

    const effectiveWarningService = warningService || (effectiveWarningRepo ? new WarningService({
        warningRepo: effectiveWarningRepo,
        policyRepo: effectivePolicyRepo,
        commandRepo: effectiveCommandRepo,
        groupRepo: effectiveGroupRepo,
        commandGateway,
        idempotencyRepo: effectiveIdempotencyRepo,
        pool,
    }) : null);

    if (effectiveGroupService) {
        registerGroupRoutes({
            router,
            groupService: effectiveGroupService,
            authMiddleware,
            tenantMiddleware,
            requireTenantRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });
    }

    if (effectivePolicyService) {
        registerPolicyRoutes({
            router,
            policyService: effectivePolicyService,
            authMiddleware,
            tenantMiddleware,
            requireTenantRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });
    }

    if (effectiveWarningService && effectiveCommandRepo && effectiveGroupRepo && whatsAppConnectionRepo) {
        registerModerationRoutes({
            router,
            pool,
            groupRepo: effectiveGroupRepo,
            connRepo: whatsAppConnectionRepo,
            commandRepo: effectiveCommandRepo,
            warningRepo: effectiveWarningRepo,
            idempotencyRepo: effectiveIdempotencyRepo,
            warningService: effectiveWarningService,
            commandGateway,
            auditLogRepo,
            authMiddleware,
            tenantMiddleware,
            requireTenantRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });
    }

    if (effectiveCommandRepo) {
        registerCommandRoutes({
            router,
            commandRepo: effectiveCommandRepo,
            authMiddleware,
            tenantMiddleware,
            requireTenantRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
        });
    }

    // 5. Phase 4F Platform Administration & Operations
    const effectiveWorkerRepo = workerRepo || (pool ? new WorkerRepository(pool) : null);
    const effectivePlatformRoleRepo = platformRoleRepo || (pool ? new PlatformRoleRepository(pool) : null);
    const effectivePlatformAuditRepo = platformAuditRepo || (pool ? new PlatformAuditRepository(pool) : null);
    const effectivePlatformIdempotencyRepo = platformIdempotencyRepo || (pool ? new PlatformIdempotencyRepository(pool) : null);

    const effectivePlatformService = platformService || (
        pool && tenantRepo && whatsAppConnectionRepo && effectiveWorkerRepo && effectivePlatformAuditRepo && effectivePlatformRoleRepo
            ? new PlatformService({
                pool,
                tenantRepo,
                connRepo: whatsAppConnectionRepo,
                workerRepo: effectiveWorkerRepo,
                platformAuditRepo: effectivePlatformAuditRepo,
                platformRoleRepo: effectivePlatformRoleRepo,
                taskRepo: effectiveTaskRepo,
                groupRepo: effectiveGroupRepo,
                commandRepo: effectiveCommandRepo,
                commandGateway,
                eventPublisher,
            })
            : null
    );

    if (effectivePlatformService && effectivePlatformRoleRepo) {
        const platformAuthMiddleware = createPlatformAuthMiddleware({
            tokenService,
            platformRoleRepo: effectivePlatformRoleRepo,
        });

        registerPlatformRoutes({
            router,
            platformService: effectivePlatformService,
            platformIdempotencyRepo: effectivePlatformIdempotencyRepo,
            eventPublisher,
            pool,
            platformAuthMiddleware,
            requirePlatformRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });

        registerAdminRoutes({
            router,
            platformService: effectivePlatformService,
            platformIdempotencyRepo: effectivePlatformIdempotencyRepo,
            pool,
            platformAuthMiddleware,
            requirePlatformRole,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });

        // 5b. Customer Product Routes (Slice 2A & 2B: /api/v1/me, /api/v1/plans, /api/v1/me/subscription, /api/v1/me/subscriptions/purchase)
        const effectivePlanRepo = planRepo || (effectivePlatformService ? effectivePlatformService.planRepo : (pool ? new PlanRepository(pool) : null));
        const effectiveSubscriptionRepo = subscriptionRepo || (effectivePlatformService ? effectivePlatformService.subscriptionRepo : (pool ? new SubscriptionRepository(pool) : null));
        const effectivePaymentRepo = paymentRepo || (effectivePlatformService ? effectivePlatformService.paymentRepo : (pool ? new PaymentRepository(pool) : null));

        const effectivePaymentGateway = paymentGateway || (
            process.env.NODE_ENV !== 'production'
                ? new TestPaymentGateway()
                : null
        );

        const effectivePaymentService = paymentService || (
            pool && effectivePaymentRepo && effectivePlanRepo && effectiveSubscriptionRepo && effectivePlatformService && effectivePaymentGateway
                ? new PaymentService({
                    pool,
                    paymentRepo: effectivePaymentRepo,
                    planRepo: effectivePlanRepo,
                    subscriptionRepo: effectiveSubscriptionRepo,
                    tenantMembershipRepo,
                    platformService: effectivePlatformService,
                    paymentGateway: effectivePaymentGateway,
                    platformAuditRepo: effectivePlatformAuditRepo,
                })
                : null
        );

        const effectiveCustomerPurchaseService = customerPurchaseService || (
            pool && effectivePlanRepo && effectivePaymentRepo && effectiveSubscriptionRepo && tenantMembershipRepo
                ? new CustomerPurchaseService({
                    pool,
                    planRepo: effectivePlanRepo,
                    paymentRepo: effectivePaymentRepo,
                    subscriptionRepo: effectiveSubscriptionRepo,
                    tenantMembershipRepo,
                    platformService: effectivePlatformService,
                    platformAuditRepo: effectivePlatformAuditRepo,
                    paymentGateway: effectivePaymentGateway,
                })
                : null
        );

        registerCustomerRoutes({
            router,
            authService,
            planRepo: effectivePlanRepo,
            subscriptionRepo: effectiveSubscriptionRepo,
            paymentRepo: effectivePaymentRepo,
            tenantMembershipRepo,
            customerPurchaseService: effectiveCustomerPurchaseService,
            connectionService: connService,
            authMiddleware,
            sendJson: (res, status, data, meta) => sendJson(res, status, data, { requestId: res.req.id, ...meta }),
            readJsonBody,
        });

        router.post(
            '/api/v1/tenants/:tenantId/subscriptions/purchase',
            authMiddleware,
            tenantMiddleware,
            requireTenantRole(['OWNER', 'ADMIN']),
            async (req, res) => {
                const body = await readJsonBody(req);
                if (!body.planId) {
                    throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');
                }
                const result = await effectivePlatformService.createCustomerPurchase({
                    tenantId: req.tenantContext.tenantId,
                    customerUserId: req.user.id,
                    planId: body.planId,
                    provider: body.provider || 'M-PESA',
                });
                return sendJson(res, 201, result, { requestId: req.id });
            }
        );

        router.post(
            '/api/v1/tenants/:tenantId/subscriptions/checkout',
            authMiddleware,
            tenantMiddleware,
            requireTenantRole(['OWNER', 'ADMIN']),
            async (req, res) => {
                const body = await readJsonBody(req);
                if (!body.planId) {
                    throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');
                }
                const purchase = await effectivePlatformService.createCustomerPurchase({
                    tenantId: req.tenantContext.tenantId,
                    customerUserId: req.user.id,
                    planId: body.planId,
                    provider: body.provider || 'M-PESA',
                });
                const activation = await effectivePlatformService.activateSubscriptionFromPayment({
                    paymentId: purchase.payment.id,
                    status: 'SUCCESS',
                });
                return sendJson(res, 201, {
                    payment: activation.payment,
                    subscription: activation.subscription,
                }, { requestId: req.id });
            }
        );

        router.post('/api/v1/payments/callback', async (req, res) => {
            const body = await readJsonBody(req);
            if (effectivePaymentService) {
                const result = await effectivePaymentService.handleCallback({
                    headers: req.headers,
                    body,
                    rawBody: req.rawBody || JSON.stringify(body),
                });
                return sendJson(res, 200, result, { requestId: req.id });
            }

            const ref = body.transactionReference || body.transaction_reference;
            const pid = body.paymentId || body.payment_id;
            if (!ref && !pid) {
                throw ApiError.badRequest('transactionReference or paymentId is required', 'VALIDATION_ERROR');
            }
            const activation = await effectivePlatformService.activateSubscriptionFromPayment({
                paymentId: pid || null,
                transactionReference: ref || null,
                status: body.status || 'SUCCESS',
                failureReason: body.failureReason || body.failure_reason || null,
            });
            return sendJson(res, 200, activation, { requestId: req.id });
        });
    }

    // 6. Auth Handler for /api/v1/auth/*
    if (!authService.tenantRepo && tenantRepo) authService.tenantRepo = tenantRepo;
    if (!authService.tenantMembershipRepo && tenantMembershipRepo) authService.tenantMembershipRepo = tenantMembershipRepo;
    if (!authService.platformRoleRepo && effectivePlatformRoleRepo) authService.platformRoleRepo = effectivePlatformRoleRepo;

    const authHandler = createAuthHandler({
        authService,
        tokenService,
        cookieOptions,
        rateLimiter,
        allowedOrigins: Array.from(allowedOriginsSet),
    });

    /**
     * Primary HTTP Request Listener. Compatible with http.createServer().
     */
    return async function appHandler(req, res) {
        // Assign and attach Request ID correlation header
        const requestId = resolveRequestId(req);
        req.id = requestId;
        res.req = req;
        res.setHeader('X-Request-ID', requestId);

        const parsedUrl = new URL(req.url, 'http://localhost');
        const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';
        const method = req.method.toUpperCase();

        // 0. HTTP Telemetry Instrumentation (Correction 3 & 4)
        if (metricsRegistry) {
            const startTime = process.hrtime.bigint();
            res.on('finish', () => {
                if (pathname === '/metrics') return;
                const durationSec = Number(process.hrtime.bigint() - startTime) / 1e9;
                let route = 'UNKNOWN';
                if (req.routePattern) {
                    route = req.routePattern;
                } else if (pathname.startsWith('/api/v1/auth/')) {
                    const action = pathname.slice('/api/v1/auth/'.length).split('/')[0];
                    route = `/api/v1/auth/${action || ':action'}`;
                } else if (pathname === '/health/live' || pathname === '/health/ready') {
                    route = pathname;
                }

                const resMethod = req.method.toUpperCase();
                const status = String(res.statusCode);

                metricsRegistry.httpRequestsTotal.inc({ method: resMethod, route, status });
                metricsRegistry.httpRequestDuration.observe({ method: resMethod, route }, durationSec);
            });
        }

        // CORS Handling for Allowed Origins
        const reqOrigin = req.headers['origin'];
        if (reqOrigin) {
            const normOrigin = normalizeOrigin(reqOrigin);
            if (allowedOriginsSet.size > 0) {
                if (!allowedOriginsSet.has(normOrigin)) {
                    return sendError(res, 403, 'CSRF_VALIDATION_FAILED', 'Origin not allowed', [], { requestId });
                }
                res.setHeader('Access-Control-Allow-Origin', reqOrigin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Vary', 'Origin');
            }
        }

        // Handle preflight OPTIONS at the app level
        if (method === 'OPTIONS') {
            if (reqOrigin) {
                res.setHeader('Access-Control-Allow-Origin', reqOrigin);
                res.setHeader('Access-Control-Allow-Credentials', 'true');
                res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Request-ID');
                res.setHeader('Access-Control-Max-Age', '86400');
            }
            res.statusCode = 204;
            return res.end();
        }

        try {
            // Static Admin Dashboard Assets
            if (method === 'GET' && (pathname === '/admin' || pathname.startsWith('/admin/'))) {
                const adminDir = path.resolve(__dirname, '../../../public/admin');
                let relPath = (pathname === '/admin' || pathname === '/admin/') ? 'index.html' : pathname.slice('/admin/'.length);
                const safePath = path.normalize(relPath).replace(/^(\.\.[\/\\])+/, '');
                const filePath = path.join(adminDir, safePath);

                if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
                    const ext = path.extname(filePath).toLowerCase();
                    const contentTypes = {
                        '.html': 'text/html; charset=utf-8',
                        '.css': 'text/css; charset=utf-8',
                        '.js': 'application/javascript; charset=utf-8',
                        '.json': 'application/json; charset=utf-8',
                        '.svg': 'image/svg+xml',
                        '.png': 'image/png',
                    };
                    res.statusCode = 200;
                    res.setHeader('Content-Type', contentTypes[ext] || 'text/plain');
                    return fs.createReadStream(filePath).pipe(res);
                }
            }

            // Route /api/v1/auth/* to AuthHandler
            if (pathname.startsWith('/api/v1/auth')) {
                return await authHandler(req, res, async () => {
                    // If authHandler falls through
                    await router.handle(req, res);
                });
            }

            // Route all other paths through HttpRouter
            await router.handle(req, res);
        } catch (err) {
            // Centralized Error Handling
            if (err instanceof ApiError) {
                return sendError(res, err.statusCode, err.code, err.message, err.details, { requestId });
            }

            // Unexpected system error: never leak stack trace or internal details
            return sendError(
                res,
                500,
                'INTERNAL_SERVER_ERROR',
                'An unexpected error occurred',
                [],
                { requestId }
            );
        }
    };
}

module.exports = {
    createRestApp,
    readJsonBody,
    sendJson,
    sendError,
    resolveRequestId,
};
