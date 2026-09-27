#!/usr/bin/env node

/**
 * Windowseven MD - Standalone WhatsApp Worker Node Daemon
 * Phase 4G Process Topology: Worker Plane
 *
 * Adheres strictly to Correction 1: Worker shutdown reuses the verified Phase 4F WorkerNode.drain() protocol.
 * Adheres strictly to Correction 2: PostgresNotificationListener dispatches incoming wake-ups via CommandGateway only.
 */
require('dotenv').config();
const os = require('node:os');
const { Pool } = require('pg');
const { getConnectionString } = require('../src/database/client');
const { verifyRequiredSchema } = require('../src/database/schemaCheck');
const {
    WhatsAppConnectionRepository,
    WorkerRepository,
    ScheduledModerationTaskRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    AuditLogRepository,
    ConnectionCommandRepository,
} = require('../src/repositories');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const { defaultMetricsRegistry } = require('../src/application/metrics/MetricsRegistry');
const PostgresNotificationListener = require('../src/database/PostgresNotificationListener');

async function createWorkerDaemon({
    databaseUrl = null,
    workerId = process.env.WORKER_ID || `worker-${os.hostname()}-${process.pid}`,
    capacity = parseInt(process.env.WORKER_CAPACITY || '50', 10),
    drainGraceMs = parseInt(process.env.DRAIN_GRACE_MS || '10000', 10),
    socketFactory = null,
    logger = console,
    metricsRegistry = defaultMetricsRegistry,
} = {}) {
    const connectionString = databaseUrl || getConnectionString();
    const pool = new Pool({
        connectionString,
        max: parseInt(process.env.PG_WORKER_POOL_MAX || '10', 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 5000,
    });

    // 1. Verify PostgreSQL schema
    await verifyRequiredSchema(pool);

    // 2. Initialize Repositories
    const connRepo = new WhatsAppConnectionRepository(pool);
    const workerRepo = new WorkerRepository(pool);
    const taskRepo = new ScheduledModerationTaskRepository(pool);
    const groupRepo = new GroupRepository(pool);
    const policyRepo = new GroupPolicyRepository(pool);
    const warningRepo = new GroupWarningRepository(pool);
    const auditLogRepo = new AuditLogRepository(pool);
    const commandRepo = new ConnectionCommandRepository(pool);

    // 3. Initialize Shared Gateways & Publishers
    const eventPublisher = new LocalEventPublisher();
    const commandGateway = new ConnectionCommandGateway({ pool });
    const connectionManager = new ConnectionManager(pool, socketFactory ? { socketFactory } : {});

    // 4. Instantiate WorkerNode (reusing verified Phase 4D/4E/4F state machine)
    const workerNode = new WorkerNode({
        pool,
        connectionManager,
        connRepo,
        workerRepo,
        taskRepo,
        groupRepo,
        policyRepo,
        warningRepo,
        auditLogRepo,
        commandRepo,
        commandGateway,
        eventPublisher,
        metricsRegistry,
        workerId,
        capacity,
        drainGraceMs,
    });

    // 5. Start Dedicated PostgreSQL Notification Listener
    const notificationListener = new PostgresNotificationListener({
        connectionString,
        channels: ['connection_control_wake'],
        logger,
    });

    // Correction 2: connection_control_wake only triggers local wake-up / dispatch
    notificationListener.subscribe('connection_control_wake', (payload) => {
        if (payload && commandGateway && typeof commandGateway.dispatchLocal === 'function') {
            commandGateway.dispatchLocal(payload);
        }
    });

    let isShuttingDown = false;

    async function shutdown(signal = 'SIGTERM') {
        if (isShuttingDown) return;
        isShuttingDown = true;
        if (logger) logger.log(`[Worker Daemon] Received ${signal}. Executing verified WorkerNode.drain()...`);

        // Correction 1: Delegate shutdown strictly to the existing verified WorkerNode.drain()
        await workerNode.drain({ graceMs: drainGraceMs }).catch((err) => {
            if (logger) logger.error(`[Worker Daemon] Error during drain:`, err.message);
        });

        // Stop notification listener
        await notificationListener.stop().catch(() => {});

        // Drain database pool
        await pool.end().catch(() => {});

        if (logger) logger.log('[Worker Daemon] Graceful shutdown completed.');
    }

    return {
        workerNode,
        pool,
        notificationListener,
        metricsRegistry,
        start: async () => {
            await notificationListener.start();
            await workerNode.start();
            if (logger) logger.log(`[Worker Daemon] WorkerNode ${workerId} started (capacity: ${capacity})`);
        },
        shutdown,
    };
}

if (require.main === module) {
    (async () => {
        try {
            const daemon = await createWorkerDaemon();
            await daemon.start();

            const onSignal = async (sig) => {
                await daemon.shutdown(sig);
            };

            process.once('SIGTERM', () => onSignal('SIGTERM'));
            process.once('SIGINT', () => onSignal('SIGINT'));
        } catch (err) {
            console.error('[Worker Daemon] Fatal startup error:', err);
            process.exit(1);
        }
    })();
}

module.exports = {
    createWorkerDaemon,
};
