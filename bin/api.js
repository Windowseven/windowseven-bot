#!/usr/bin/env node

/**
 * Windowseven MD - Standalone REST API Server Daemon
 * Phase 4G Process Topology: API Plane
 */
require('dotenv').config();
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
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const SseGateway = require('../src/application/realtime/SseGateway');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { defaultMetricsRegistry } = require('../src/application/metrics/MetricsRegistry');
const PostgresNotificationListener = require('../src/database/PostgresNotificationListener');

async function createApiDaemon({
    databaseUrl = null,
    port = parseInt(process.env.PORT || '3000', 10),
    host = process.env.HOST || '0.0.0.0',
    logger = console,
    metricsRegistry = defaultMetricsRegistry,
} = {}) {
    const connectionString = databaseUrl || getConnectionString();
    const pool = new Pool({
        connectionString,
        max: parseInt(process.env.PG_POOL_MAX || '20', 10),
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

    // 3. Initialize Shared Gateways & Publishers
    const eventPublisher = new LocalEventPublisher();
    const commandGateway = new ConnectionCommandGateway({ pool });

    // 4. Initialize Domain Services
    const tokenService = new TokenService();
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

    // 5. Start Dedicated PostgreSQL Notification Listener
    const notificationListener = new PostgresNotificationListener({
        connectionString,
        channels: ['tenant_events'],
        logger,
    });

    // Route incoming cross-node events to local event publisher (feeds local SSE clients)
    notificationListener.subscribe('tenant_events', (payload) => {
        if (payload && eventPublisher && typeof eventPublisher.dispatchLocal === 'function') {
            eventPublisher.dispatchLocal(payload);
        }
    });

    await notificationListener.start();

    // 5b. Start Distributed Subscription Notification Service
    const notificationService = new SubscriptionNotificationService({
        pool,
        subscriptionRepo,
        eventPublisher,
        logger,
    });
    const notificationIntervalMs = parseInt(process.env.SUBSCRIPTION_NOTIFICATION_INTERVAL_MS || '60000', 10);
    notificationService.start(notificationIntervalMs);

    // 6. Assemble REST Application
    const realtimeGateway = new SseGateway({ eventPublisher });
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
        sseGateway: realtimeGateway,
        metricsRegistry,
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
        if (logger) logger.log(`[API Daemon] Received ${signal}. Initiating graceful shutdown...`);

        // Bounded 10-second shutdown timeout
        let shutdownTimer = setTimeout(() => {
            if (logger && typeof logger.warn === 'function') {
                logger.warn('[API Daemon] Shutdown timed out after 10000ms. Forcibly destroying remaining sockets.');
            } else if (logger) {
                logger.log('[API Daemon] Shutdown timed out after 10000ms. Forcibly destroying remaining sockets.');
            }
            if (typeof server.closeAllConnections === 'function') {
                server.closeAllConnections();
            }
        }, 10000);
        if (typeof shutdownTimer.unref === 'function') {
            shutdownTimer.unref();
        }

        try {
            // 1. Stop subscription notification service
            if (notificationService && typeof notificationService.stop === 'function') {
                notificationService.stop();
            }

            // 2. Stop accepting new HTTP requests
            const serverClosePromise = new Promise((resolve) => {
                server.close(() => resolve());
            });

            // 3. Close active SSE clients
            if (realtimeGateway && typeof realtimeGateway.closeAll === 'function') {
                realtimeGateway.closeAll();
            }

            // 4. Stop notification listener
            await notificationListener.stop().catch(() => {});

            // 5. Wait for server close to complete
            await serverClosePromise;

            // 6. Drain database pool
            await pool.end().catch(() => {});

            if (logger) logger.log('[API Daemon] Graceful shutdown completed.');
        } finally {
            clearTimeout(shutdownTimer);
        }
    }

    return {
        server,
        pool,
        notificationListener,
        notificationService,
        metricsRegistry,
        realtimeGateway,
        start: () => new Promise((resolve, reject) => {
            server.listen(port, host, (err) => {
                if (err) return reject(err);
                if (logger) logger.log(`[API Daemon] REST API listening on ${host}:${port}`);
                resolve(server);
            });
        }),
        shutdown,
    };
}

if (require.main === module) {
    (async () => {
        try {
            const daemon = await createApiDaemon();
            await daemon.start();

            const onSignal = async (sig) => {
                await daemon.shutdown(sig);
            };

            process.once('SIGTERM', () => onSignal('SIGTERM'));
            process.once('SIGINT', () => onSignal('SIGINT'));
        } catch (err) {
            console.error('[API Daemon] Fatal startup error:', err);
            process.exit(1);
        }
    })();
}

module.exports = {
    createApiDaemon,
};
