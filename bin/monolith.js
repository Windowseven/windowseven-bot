#!/usr/bin/env node

/**
 * Windowseven MD - Unified Monolith Runtime
 * Phase 4G Process Topology: Combined API Plane & Worker Plane
 *
 * Designed for local development and single-container deployments.
 * Composes RestApp and WorkerNode cleanly using shared in-process coordination.
 */
require('dotenv').config();
const os = require('node:os');
const http = require('node:http');
const { Pool } = require('pg');
const { getConnectionString } = require('../src/database/client');
const { verifyRequiredSchema } = require('../src/database/schemaCheck');
const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    WorkerRepository,
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
    ScheduledModerationTaskRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    RefreshTokenRepository,
    AuditLogRepository,
    ConnectionCommandRepository,
} = require('../src/repositories');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PasswordService = require('../src/application/services/PasswordService');
const PlatformService = require('../src/application/services/PlatformService');
const { SubscriptionNotificationService } = require('../src/application/services/SubscriptionNotificationService');
const TenantService = require('../src/application/services/TenantService');
const ConnectionService = require('../src/application/services/ConnectionService');
const GroupService = require('../src/application/services/GroupService');
const PolicyService = require('../src/application/services/PolicyService');
const WarningService = require('../src/application/services/WarningService');
const ModerationService = require('../src/application/services/ModerationService');
const { createRestApp } = require('../src/application/http/RestApp');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const SseGateway = require('../src/application/realtime/SseGateway');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { defaultMetricsRegistry } = require('../src/application/metrics/MetricsRegistry');
const PostgresNotificationListener = require('../src/database/PostgresNotificationListener');

async function createMonolithDaemon({
    databaseUrl = null,
    port = parseInt(process.env.PORT || '3000', 10),
    host = process.env.HOST || '0.0.0.0',
    workerId = process.env.WORKER_ID || `monolith-worker-${os.hostname()}-${process.pid}`,
    capacity = parseInt(process.env.WORKER_CAPACITY || '50', 10),
    drainGraceMs = parseInt(process.env.DRAIN_GRACE_MS || '10000', 10),
    socketFactory = null,
    logger = console,
    metricsRegistry = defaultMetricsRegistry,
} = {}) {
    const connectionString = databaseUrl || getConnectionString();
    const pool = new Pool({
        connectionString,
        max: parseInt(process.env.PG_POOL_MAX || '25', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // 1. Verify PostgreSQL schema
    await verifyRequiredSchema(pool);

    // 2. Initialize Repositories
    const userRepo = new UserRepository(pool);
    const tenantRepo = new TenantRepository(pool);
    const tenantMembershipRepo = new TenantMembershipRepository(pool);
    const whatsAppConnectionRepo = new WhatsAppConnectionRepository(pool);
    const workerRepo = new WorkerRepository(pool);
    const platformRoleRepo = new PlatformRoleRepository(pool);
    const platformAuditRepo = new PlatformAuditRepository(pool);
    const platformIdempotencyRepo = new PlatformIdempotencyRepository(pool);
    const scheduledTaskRepo = new ScheduledModerationTaskRepository(pool);
    const groupRepo = new GroupRepository(pool);
    const groupPolicyRepo = new GroupPolicyRepository(pool);
    const groupWarningRepo = new GroupWarningRepository(pool);
    const refreshTokenRepo = new RefreshTokenRepository(pool);
    const auditLogRepo = new AuditLogRepository(pool);
    const connectionCommandRepo = new ConnectionCommandRepository(pool);

    // 3. Shared In-Process Gateways & Event Publishers
    const eventPublisher = new LocalEventPublisher();
    const commandGateway = new ConnectionCommandGateway({ pool });

    // 4. Initialize Domain Services
    const tokenService = new TokenService();
    const realtimeGateway = new SseGateway({ eventPublisher, tokenService });
    const passwordService = new PasswordService();
    const authService = new AuthService({
        userRepo,
        refreshTokenRepo,
        auditLogRepo,
        tenantRepo,
        tenantMembershipRepo,
        platformRoleRepo,
        tokenService,
        passwordService,
        pool,
    });
    const tenantService = new TenantService({
        pool,
        tenantRepo,
        tenantMembershipRepo,
        userRepo,
        auditLogRepo,
    });
    const connectionService = new ConnectionService({
        pool,
        connRepo: whatsAppConnectionRepo,
        auditLogRepo,
        eventPublisher,
        commandGateway,
    });
    const groupService = new GroupService({
        pool,
        groupRepo,
        connRepo: whatsAppConnectionRepo,
        policyRepo: groupPolicyRepo,
        commandRepo: connectionCommandRepo,
        taskRepo: scheduledTaskRepo,
        auditLogRepo,
        eventPublisher,
        commandGateway,
    });
    const policyService = new PolicyService({
        pool,
        groupRepo,
        policyRepo: groupPolicyRepo,
        auditLogRepo,
        eventPublisher,
    });
    const warningService = new WarningService({
        pool,
        warningRepo: groupWarningRepo,
        groupRepo,
        policyRepo: groupPolicyRepo,
        auditLogRepo,
        eventPublisher,
    });

    const planRepo = new PlanRepository(pool);
    const subscriptionRepo = new SubscriptionRepository(pool);
    const paymentRepo = new PaymentRepository(pool);

    const platformService = new PlatformService({
        pool,
        tenantRepo,
        connRepo: whatsAppConnectionRepo,
        workerRepo,
        platformAuditRepo,
        platformRoleRepo,
        taskRepo: scheduledTaskRepo,
        groupRepo,
        commandGateway,
        eventPublisher,
        metricsRegistry,
        planRepo,
        subscriptionRepo,
        paymentRepo,
    });

    // 5. Initialize WorkerNode
    const connectionManager = new ConnectionManager(pool, socketFactory ? { socketFactory } : {});
    const workerNode = new WorkerNode({
        pool,
        connectionManager,
        connRepo: whatsAppConnectionRepo,
        workerRepo,
        taskRepo: scheduledTaskRepo,
        groupRepo,
        policyRepo: groupPolicyRepo,
        warningRepo: groupWarningRepo,
        auditLogRepo,
        commandRepo: connectionCommandRepo,
        commandGateway,
        eventPublisher,
        workerId,
        capacity,
        drainGraceMs,
        metricsRegistry,
    });

    // 6. Start Dedicated PostgreSQL Notification Listener
    const notificationListener = new PostgresNotificationListener({
        connectionString,
        channels: ['connection_control_wake', 'tenant_events'],
        logger,
    });

    notificationListener.subscribe('connection_control_wake', (payload) => {
        if (payload && commandGateway && typeof commandGateway.dispatchLocal === 'function') {
            commandGateway.dispatchLocal(payload);
        }
    });

    notificationListener.subscribe('tenant_events', (payload) => {
        if (payload && eventPublisher && typeof eventPublisher.dispatchLocal === 'function') {
            eventPublisher.dispatchLocal(payload);
        }
    });

    // 6b. Subscription Notification Service
    const notificationService = new SubscriptionNotificationService({
        pool,
        subscriptionRepo,
        eventPublisher,
        logger,
    });
    const notificationIntervalMs = parseInt(process.env.SUBSCRIPTION_NOTIFICATION_INTERVAL_MS || '60000', 10);

    // 7. Assemble REST Application
    const app = createRestApp({
        pool,
        tokenService,
        authService,
        tenantRepo,
        tenantMembershipRepo,
        userRepo,
        whatsAppConnectionRepo,
        workerRepo,
        platformRoleRepo,
        platformAuditRepo,
        platformIdempotencyRepo,
        platformService,
        tenantService,
        connectionService,
        groupService,
        policyService,
        warningService,
        scheduledTaskRepo,
        groupRepo,
        groupPolicyRepo,
        groupWarningRepo,
        connectionCommandRepo,
        commandGateway,
        eventPublisher,
        metricsRegistry,
        realtimeGateway,
        planRepo,
        subscriptionRepo,
        paymentRepo,
    });

    const server = http.createServer(app);
    server.requestTimeout = 30000;
    server.keepAliveTimeout = 65000;
    server.headersTimeout = 66000;

    let isShuttingDown = false;

    async function shutdown(signal = 'SIGTERM') {
        if (isShuttingDown) return;
        isShuttingDown = true;
        if (logger) logger.log(`[Monolith] Received ${signal}. Initiating graceful shutdown...`);

        // Phase 5C: 10-second bounded shutdown timeout
        const forceTimer = setTimeout(() => {
            if (logger) logger.warn('[Monolith] Graceful shutdown timeout reached (10s). Forcing socket closure.');
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
        }, 10000);
        if (typeof forceTimer.unref === 'function') {
            forceTimer.unref();
        }

        try {
            // 0. Stop subscription notification service
            if (notificationService && typeof notificationService.stop === 'function') {
                notificationService.stop();
            }

            // 1. Immediately terminate active SSE clients
            if (realtimeGateway && typeof realtimeGateway.closeAll === 'function') {
                realtimeGateway.closeAll();
            }

            // 2. Delegate worker teardown strictly to verified WorkerNode.drain()
            await workerNode.drain({ graceMs: drainGraceMs }).catch((err) => {
                if (logger) logger.error(`[Monolith] Error draining worker:`, err.message);
            });

            // 3. Stop notification listener
            await notificationListener.stop().catch(() => {});

            // 4. Close HTTP server and wait for in-flight requests to complete
            await new Promise((resolve) => {
                server.close((err) => {
                    if (err && logger) logger.error('[Monolith] Error closing HTTP server:', err.message);
                    resolve();
                });
            });

            // 5. Drain database pool
            await pool.end().catch(() => {});

            if (logger) logger.log('[Monolith] Graceful shutdown completed.');
        } finally {
            clearTimeout(forceTimer);
        }
    }

    return {
        server,
        workerNode,
        pool,
        notificationListener,
        notificationService,
        metricsRegistry,
        realtimeGateway,
        start: async () => {
            await notificationListener.start();
            await workerNode.start();
            notificationService.start(notificationIntervalMs);
            await new Promise((resolve, reject) => {
                server.listen(port, host, (err) => {
                    if (err) return reject(err);
                    if (logger) logger.log(`[Monolith] REST API listening on ${host}:${port}`);
                    resolve(server);
                });
            });
            if (logger) logger.log(`[Monolith] Monolith runtime active (Worker: ${workerId}, Capacity: ${capacity})`);
        },
        shutdown,
    };
}

if (require.main === module) {
    (async () => {
        try {
            const daemon = await createMonolithDaemon();
            await daemon.start();

            const onSignal = async (sig) => {
                await daemon.shutdown(sig);
            };

            process.once('SIGTERM', () => onSignal('SIGTERM'));
            process.once('SIGINT', () => onSignal('SIGINT'));
        } catch (err) {
            console.error('[Monolith] Fatal startup error:', err);
            process.exit(1);
        }
    })();
}

module.exports = {
    createMonolithDaemon,
};
