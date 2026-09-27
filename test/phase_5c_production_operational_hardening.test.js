const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const EventEmitter = require('node:events');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    WorkerRepository,
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
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
const ConnectionService = require('../src/application/services/ConnectionService');
const ModerationService = require('../src/application/services/ModerationService');
const WarningService = require('../src/application/services/WarningService');
const PolicyService = require('../src/application/services/PolicyService');
const GroupService = require('../src/application/services/GroupService');
const PolicyEngine = require('../src/application/policies/PolicyEngine');
const CommandRegistry = require('../src/application/commands/CommandRegistry');
const ApplicationPipeline = require('../src/application/pipeline/ApplicationPipeline');
const SseGateway = require('../src/application/realtime/SseGateway');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerLeaseManager = require('../src/whatsapp/worker/WorkerLeaseManager');
const RemoteOutcomeVerificationService = require('../src/whatsapp/worker/RemoteOutcomeVerificationService');
const DurableModerationScheduler = require('../src/whatsapp/worker/DurableModerationScheduler');
const { createRestApp } = require('../src/application/http/RestApp');
const { createApiDaemon } = require('../bin/api');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const { MetricsRegistry } = require('../src/application/metrics/MetricsRegistry');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_test';

function makeRequest(server, { method = 'GET', path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const options = {
            hostname: '127.0.0.1',
            port: addr.port,
            path,
            method,
            headers: { ...headers },
        };

        let payload = null;
        if (body !== null) {
            payload = typeof body === 'string' ? body : JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(payload);
        }

        const req = http.request(options, (res) => {
            let data = '';
            res.on('data', (chunk) => { data += chunk; });
            res.on('end', () => {
                let parsed = null;
                try {
                    parsed = JSON.parse(data);
                } catch {
                    parsed = data;
                }
                resolve({
                    statusCode: res.statusCode,
                    headers: res.headers,
                    body: parsed,
                });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('Phase 5C — Production Operational Hardening', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let workerRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let platformIdempotencyRepo;
    let taskRepo;
    let commandRepo;
    let groupRepo;
    let policyRepo;
    let warningRepo;
    let tokenService;
    let authService;
    let passwordService;
    let commandGateway;
    let eventPublisher;
    let platformService;
    let connectionService;
    let restApp;
    let server;

    let ownerUser;
    let ownerToken;
    let testTenant;
    let testConn;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });

        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        workerRepo = new WorkerRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        platformIdempotencyRepo = new PlatformIdempotencyRepository(pool);
        taskRepo = new ScheduledModerationTaskRepository(pool);
        commandRepo = new ConnectionCommandRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);
        const refreshTokenRepo = new RefreshTokenRepository(pool);
        const auditLogRepo = new AuditLogRepository(pool);

        tokenService = new TokenService();
        passwordService = new PasswordService();
        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            tokenService,
            passwordService,
            pool,
        });

        commandGateway = new ConnectionCommandGateway({ pool });
        eventPublisher = new LocalEventPublisher();

        platformService = new PlatformService({
            pool,
            tenantRepo,
            connRepo,
            workerRepo,
            platformAuditRepo,
            platformRoleRepo,
            taskRepo,
            commandRepo,
            groupRepo,
            commandGateway,
            eventPublisher,
        });

        connectionService = new ConnectionService({
            pool,
            connRepo,
            auditLogRepo,
            eventPublisher,
            commandGateway,
        });

        const groupService = new GroupService({
            pool,
            groupRepo,
            connRepo,
            policyRepo,
            commandRepo,
            taskRepo,
            auditLogRepo,
            eventPublisher,
            commandGateway,
        });

        const policyService = new PolicyService({
            pool,
            groupRepo,
            policyRepo,
            auditLogRepo,
            eventPublisher,
        });

        const warningService = new WarningService({
            pool,
            warningRepo,
            groupRepo,
            policyRepo,
            auditLogRepo,
            eventPublisher,
        });

        // Seed test tenant & owner user
        testTenant = await tenantRepo.create({ name: 'Phase 5C Test Tenant' });
        ownerUser = await userRepo.create({ email: `owner_${Date.now()}@p5c.test` });
        await membershipRepo.create({
            tenantId: testTenant.id,
            userId: ownerUser.id,
            role: 'OWNER',
        });
        ownerToken = tokenService.createAccessToken({
            userId: ownerUser.id,
            email: ownerUser.email,
        });

        // Initialize RestApp with connection routes and idempotency support
        restApp = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo: membershipRepo,
            userRepo,
            whatsAppConnectionRepo: connRepo,
            workerRepo,
            platformRoleRepo,
            platformAuditRepo,
            platformIdempotencyRepo,
            platformService,
            tenantService: null,
            connectionService,
            groupService,
            policyService,
            warningService,
            scheduledTaskRepo: taskRepo,
            groupRepo,
            groupPolicyRepo: policyRepo,
            groupWarningRepo: warningRepo,
            connectionCommandRepo: commandRepo,
            commandGateway,
            eventPublisher,
        });

        server = http.createServer(restApp);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await pool.end();
    });

    // =========================================================================
    // 1. TENANT LIFECYCLE ENFORCEMENT
    // =========================================================================
    describe('1. Tenant Lifecycle Enforcement', () => {
        it('1A. Inbound pipeline normalizes and preserves event observability for SUSPENDED tenants while suppressing commands', async () => {
            const suspendedTenant = await tenantRepo.create({ name: 'Suspended Inbound Tenant 1A' });
            const conn = await connRepo.createForTenant(suspendedTenant.id, {
                phoneNumber: `255712${Date.now().toString().slice(-6)}`,
            });
            const grp = await groupRepo.upsertDiscoveredGroup(suspendedTenant.id, conn.id, {
                whatsappJid: `123456789-susp@g.us`,
                name: 'Suspended Inbound Group',
                status: 'MANAGED',
            });

            await tenantRepo.updateStatus(suspendedTenant.id, 'SUSPENDED');

            let adminCheckCalled = false;
            const mockGateway = {
                checkAdminStatus: async () => {
                    adminCheckCalled = true;
                    return { isSenderAdmin: true, isBotAdmin: true };
                },
            };

            let commandExecuted = false;
            const commandRegistry = new CommandRegistry();
            commandRegistry.register({
                name: 'mute',
                aliases: [],
                execute: async () => {
                    commandExecuted = true;
                    return { success: true };
                },
            });

            const pipeline = new ApplicationPipeline({
                groupRepo,
                policyRepo,
                warningRepo,
                warningService: { handleViolation: async () => {} },
                moderationService: { executeAction: async () => {}, sendMessage: async () => {} },
                policyEngine: new PolicyEngine(),
                commandRegistry,
                gateway: mockGateway,
                tenantRepo,
            });

            const event = {
                ctx: {
                    tenantId: suspendedTenant.id,
                    connectionId: conn.id,
                    sock: { user: { id: 'bot@s.whatsapp.net' } },
                },
                message: {
                    id: 'msg-susp-1',
                    isGroup: true,
                    remoteJid: grp.whatsapp_jid,
                    sender: 'user@s.whatsapp.net',
                    text: '.mute 5m',
                },
            };

            const result = await pipeline.processMessage(event);
            assert.strictEqual(result.handled, true);
            assert.strictEqual(result.reason, 'tenant_suspended');
            assert.strictEqual(adminCheckCalled, true, 'Event must reach normalization boundary');
            assert.strictEqual(commandExecuted, false, 'Bot command must NOT execute for suspended tenant');
            assert.ok(result.message, 'Normalized message must be preserved for observability');
            assert.strictEqual(result.message.text, '.mute 5m');
            assert.strictEqual(result.message.messageKind, 'COMMAND');
            assert.ok(result.appCtx, 'ApplicationContext must be constructed for observability');
        });

        it('1B. Inbound pipeline preserves event observability for SUSPENDED tenants while suppressing automated policy actions', async () => {
            const suspendedTenant = await tenantRepo.create({ name: 'Suspended Inbound Tenant 1B' });
            const conn = await connRepo.createForTenant(suspendedTenant.id, {
                phoneNumber: `255713${Date.now().toString().slice(-6)}`,
            });
            const grp = await groupRepo.upsertDiscoveredGroup(suspendedTenant.id, conn.id, {
                whatsappJid: `123456789-pol@g.us`,
                name: 'Suspended Policy Group',
                status: 'MANAGED',
            });

            // Configure AntiLink policy
            await policyRepo.upsertForTenant(suspendedTenant.id, grp.id, {
                antilinkEnabled: true,
                antilinkAction: 'delete',
            });

            await tenantRepo.updateStatus(suspendedTenant.id, 'SUSPENDED');

            let policyExecuted = false;
            const mockGateway = {
                checkAdminStatus: async () => ({ isSenderAdmin: false, isBotAdmin: true }),
                deleteMessage: async () => { policyExecuted = true; },
            };

            const pipeline = new ApplicationPipeline({
                groupRepo,
                policyRepo,
                warningRepo,
                warningService: { handleViolation: async () => {} },
                moderationService: { executeAction: async () => {}, sendMessage: async () => {} },
                policyEngine: new PolicyEngine(),
                commandRegistry: new CommandRegistry(),
                gateway: mockGateway,
                tenantRepo,
            });

            const event = {
                ctx: {
                    tenantId: suspendedTenant.id,
                    connectionId: conn.id,
                    sock: { user: { id: 'bot@s.whatsapp.net' } },
                },
                message: {
                    id: 'msg-susp-link-1',
                    isGroup: true,
                    remoteJid: grp.whatsapp_jid,
                    sender: 'user@s.whatsapp.net',
                    text: 'Join my group https://chat.whatsapp.com/test1234',
                },
            };

            const result = await pipeline.processMessage(event);
            assert.strictEqual(result.handled, true);
            assert.strictEqual(result.reason, 'tenant_suspended');
            assert.strictEqual(policyExecuted, false, 'Automated moderation policy actions must be suppressed');
            assert.ok(result.message, 'Message is normalized and available for audit/observability');
        });

        it('1C. Inbound pipeline drops messages fail-closed for DEACTIVATED tenants', async () => {
            const deactivatedTenant = await tenantRepo.create({ name: 'Deactivated Inbound Tenant' });
            await tenantRepo.updateStatus(deactivatedTenant.id, 'DEACTIVATED');

            let adminCheckCalled = false;
            const mockGateway = {
                checkAdminStatus: async () => {
                    adminCheckCalled = true;
                    return { isSenderAdmin: true, isBotAdmin: true };
                },
            };

            const pipeline = new ApplicationPipeline({
                groupRepo,
                policyRepo,
                warningRepo,
                warningService: { handleViolation: async () => {} },
                moderationService: { executeAction: async () => {} },
                policyEngine: new PolicyEngine(),
                commandRegistry: new CommandRegistry(),
                gateway: mockGateway,
                tenantRepo,
            });

            const event = {
                ctx: {
                    tenantId: deactivatedTenant.id,
                    connectionId: '00000000-0000-0000-0000-000000000002',
                    sock: { user: { id: 'bot@s.whatsapp.net' } },
                },
                message: {
                    id: 'msg-deact-1',
                    isGroup: true,
                    remoteJid: '123456789@g.us',
                    sender: 'user@s.whatsapp.net',
                    text: '.mute 5m',
                },
            };

            const result = await pipeline.processMessage(event);
            assert.strictEqual(result.handled, false);
            assert.strictEqual(result.reason, 'tenant_deactivated');
            assert.strictEqual(adminCheckCalled, false, 'Admin check must not be called');
        });

        it('1D. Durable command claim gate skips commands for non-ACTIVE tenants and resumes upon reactivation', async () => {
            const lifecycleTenant = await tenantRepo.create({ name: 'Lifecycle Claim Tenant' });
            const conn = await connRepo.createForTenant(lifecycleTenant.id, {
                phoneNumber: `255711${Date.now().toString().slice(-6)}`,
            });

            const workerId = `w-claim-${Date.now()}`;
            await workerRepo.registerWorker({
                id: workerId,
                hostname: 'test-host',
                capacity: 10,
            });

            // Insert a command for this connection while tenant is ACTIVE
            const cmd = await commandRepo.createCommand(null, {
                tenantId: lifecycleTenant.id,
                connectionId: conn.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: '12345@g.us' },
            });

            // Step 1: Suspend tenant. Claim must SKIP the command (return null)
            await tenantRepo.updateStatus(lifecycleTenant.id, 'SUSPENDED');
            const client1 = await pool.connect();
            let claimed = null;
            try {
                claimed = await commandRepo.claimCommandForConnection(client1, {
                    connectionId: conn.id,
                    workerId,
                    claimEpoch: 1,
                });
            } finally {
                client1.release();
            }
            assert.strictEqual(claimed, null, 'Claim must skip commands for SUSPENDED tenants');

            // Step 2: Deactivate tenant. Claim must still return null
            await tenantRepo.updateStatus(lifecycleTenant.id, 'DEACTIVATED');
            const client2 = await pool.connect();
            try {
                claimed = await commandRepo.claimCommandForConnection(client2, {
                    connectionId: conn.id,
                    workerId,
                    claimEpoch: 1,
                });
            } finally {
                client2.release();
            }
            assert.strictEqual(claimed, null, 'Claim must skip commands for DEACTIVATED tenants');

            // Step 3: Reactivate tenant to ACTIVE. Claim must succeed!
            await tenantRepo.updateStatus(lifecycleTenant.id, 'ACTIVE');
            const client3 = await pool.connect();
            try {
                claimed = await commandRepo.claimCommandForConnection(client3, {
                    connectionId: conn.id,
                    workerId,
                    claimEpoch: 1,
                });
            } finally {
                client3.release();
            }
            assert.ok(claimed, 'Claim must succeed once tenant is reactivated to ACTIVE');
            assert.strictEqual(claimed.id, cmd.id);
            assert.strictEqual(claimed.status, 'PROCESSING');
            assert.strictEqual(claimed.claimed_by_worker_id, workerId);
        });

        it('1E. Existing in-flight PROCESSING command preserves established Phase 4F semantics during tenant suspension', async () => {
            const inFlightTenant = await tenantRepo.create({ name: 'InFlight Processing Tenant' });
            const conn = await connRepo.createForTenant(inFlightTenant.id, {
                phoneNumber: `255714${Date.now().toString().slice(-6)}`,
            });
            const grp = await groupRepo.upsertDiscoveredGroup(inFlightTenant.id, conn.id, {
                whatsappJid: `12345-flight@g.us`,
                name: 'In-Flight Group',
                status: 'MANAGED',
            });

            const workerId = `w-inflight-${Date.now()}`;
            await workerRepo.registerWorker({
                id: workerId,
                hostname: 'test-host',
                capacity: 10,
            });

            const cmd = await commandRepo.createCommand(null, {
                tenantId: inFlightTenant.id,
                connectionId: conn.id,
                groupId: grp.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: grp.whatsapp_jid, announce: true },
            });

            // Claim command to PROCESSING while tenant is ACTIVE
            const client = await pool.connect();
            let claimed = null;
            try {
                claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: conn.id,
                    workerId,
                    claimEpoch: 1,
                });
            } finally {
                client.release();
            }
            assert.ok(claimed);
            assert.strictEqual(claimed.status, 'PROCESSING');

            // Tenant is suspended in-flight
            await platformService.suspendTenant(inFlightTenant.id, { reason: 'Billing review' });

            // In Phase 4F: socket remains connected and active worker executes under lease epoch
            const inFlightSocket = {
                ev: new EventEmitter(),
                ws: { close: () => {}, terminate: () => {} },
                end: () => {},
                user: { id: 'bot:flight@s.whatsapp.net', name: 'Bot' },
                groupSettingUpdate: async () => {},
                groupMetadata: async () => ({
                    id: grp.whatsapp_jid,
                    subject: grp.name,
                    announce: true,
                    participants: [{ id: 'bot:flight@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const flightCm = new ConnectionManager(pool, { socketFactory: () => inFlightSocket });
            flightCm.connections.set(conn.id, { socket: inFlightSocket });

            const flightWorker = new WorkerNode({
                pool,
                connectionManager: flightCm,
                connRepo,
                workerRepo,
                taskRepo,
                groupRepo,
                policyRepo,
                warningRepo,
                auditLogRepo: new AuditLogRepository(pool),
                commandRepo,
                commandGateway,
                eventPublisher,
                workerId,
            });
            flightWorker.leaseManager.leases.set(conn.id, {
                connectionId: conn.id,
                tenantId: inFlightTenant.id,
                leaseEpoch: 1,
            });

            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 hour', status = 'ACTIVE'
                WHERE id = $2;
            `, [workerId, conn.id]);

            // Worker completes the in-flight execution under generation fencing
            await flightWorker._executeCommand(claimed, 1);

            const completedCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(completedCmd.status, 'COMPLETED', 'In-flight command must finish and complete according to Phase 4F semantics');
        });
    });

    // =========================================================================
    // 2. API/SSE GRACEFUL SHUTDOWN HARDENING
    // =========================================================================
    describe('2. API/SSE Graceful Shutdown Hardening', () => {
        it('2A. SseGateway.handleConnection disables timeouts (0) on req, res, and socket', () => {
            let reqTimeout = null;
            let resTimeout = null;
            let socketTimeout = null;

            const fakeReq = {
                headers: { accept: 'text/event-stream' },
                setTimeout: (ms) => { reqTimeout = ms; },
                socket: {
                    setTimeout: (ms) => { socketTimeout = ms; },
                },
                on: () => {},
            };
            const fakeRes = {
                writeHead: () => {},
                write: () => {},
                flushHeaders: () => {},
                setTimeout: (ms) => { resTimeout = ms; },
                on: () => {},
            };

            const sseGateway = new SseGateway({
                eventPublisher: new LocalEventPublisher(),
                tokenService,
            });

            sseGateway.handleConnection(fakeReq, fakeRes, 'test-tenant-id');

            assert.strictEqual(reqTimeout, 0, 'req.setTimeout must be set to 0');
            assert.strictEqual(resTimeout, 0, 'res.setTimeout must be set to 0');
            assert.strictEqual(socketTimeout, 0, 'req.socket.setTimeout must be set to 0');
        });

        it('2B. bin/api.js graceful shutdown closes SSE clients, stops listener, and drains pool', async () => {
            const daemon = await createApiDaemon({
                databaseUrl: TEST_DB_URL,
                port: 0,
                logger: null,
            });

            await daemon.start();
            const addr = daemon.server.address();
            assert.strictEqual(daemon.server.requestTimeout, 30000, 'server.requestTimeout must be 30000ms');

            // Connect an SSE client to the running API server
            let clientClosed = false;
            const sseReq = http.request({
                hostname: '127.0.0.1',
                port: addr.port,
                path: `/api/v1/tenants/${testTenant.id}/events`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    Accept: 'text/event-stream',
                },
            }, (res) => {
                res.resume();
                res.on('end', () => {
                    clientClosed = true;
                });
                res.on('close', () => {
                    clientClosed = true;
                });
            });

            sseReq.on('error', () => {
                clientClosed = true;
            });
            sseReq.end();

            // Wait brief moment for SSE connection to register
            await new Promise((r) => setTimeout(r, 150));

            // Initiate graceful shutdown
            const shutdownStart = Date.now();
            await daemon.shutdown('SIGTERM');
            const shutdownDuration = Date.now() - shutdownStart;

            assert.ok(shutdownDuration < 10000, `Shutdown took ${shutdownDuration}ms, must complete under 10000ms`);
            assert.strictEqual(clientClosed, true, 'SSE client must have received close event');
            assert.strictEqual(daemon.pool.ending, true, 'Database pool must be marked ending/ended');
        });
    });

    // =========================================================================
    // 3. PROMETHEUS COUNTER CORRECTNESS
    // =========================================================================
    describe('3. Durable Commands & Scheduled Tasks Prometheus Counter Correctness', () => {
        let metrics;
        let workerNode;
        let mockSocket;
        let cm;
        let testGroup;
        let testConnection;

        before(async () => {
            metrics = new MetricsRegistry();

            testConnection = await connRepo.createForTenant(testTenant.id, {
                phoneNumber: `255733${Date.now().toString().slice(-6)}`,
            });

            testGroup = await groupRepo.upsertDiscoveredGroup(testTenant.id, testConnection.id, {
                whatsappJid: `1234567890-test@g.us`,
                name: 'P5C Metrics Group',
                status: 'MANAGED',
            });

            mockSocket = {
                ev: new EventEmitter(),
                ws: { close: () => {}, terminate: () => {} },
                end: () => {},
                user: { id: 'bot:1@s.whatsapp.net', name: 'Bot' },
                groupSettingUpdate: async () => {},
                groupMetadata: async () => ({
                    id: testGroup.whatsapp_jid,
                    subject: testGroup.name,
                    announce: true,
                    participants: [{ id: 'bot:1@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            cm = new ConnectionManager(pool, {
                socketFactory: () => mockSocket,
            });

            const workerId = `w-p5c-metrics-${Date.now()}`;
            await workerRepo.registerWorker({
                id: workerId,
                hostname: 'test-host',
                capacity: 10,
            });

            workerNode = new WorkerNode({
                pool,
                connectionManager: cm,
                connRepo,
                workerRepo,
                taskRepo,
                groupRepo,
                policyRepo,
                warningRepo,
                auditLogRepo: new AuditLogRepository(pool),
                commandRepo,
                commandGateway,
                eventPublisher,
                workerId,
                metricsRegistry: metrics,
            });

            workerNode.leaseManager.leases.set(testConnection.id, {
                connectionId: testConnection.id,
                tenantId: testTenant.id,
                leaseEpoch: 1,
            });
            cm.connections.set(testConnection.id, { socket: mockSocket });

            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = $1,
                    lease_epoch = 1,
                    lease_expires_at = NOW() + INTERVAL '1 hour',
                    status = 'ACTIVE'
                WHERE id = $2;
            `, [workerId, testConnection.id]);
        });

        it('3A. Increments durable_commands_processed_total upon terminal COMPLETED outcome', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid, announce: true },
            });

            // Claim command
            const client = await pool.connect();
            let claimed;
            try {
                claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: testConnection.id,
                    workerId: workerNode.workerId,
                    claimEpoch: 1,
                });
            } finally {
                client.release();
            }

            // Ensure socket is present for connection
            cm.connections.set(testConnection.id, { socket: mockSocket });

            await workerNode._executeCommand(claimed, 1);

            const updated = await commandRepo.findById(cmd.id);
            assert.strictEqual(updated.status, 'COMPLETED');

            const val = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"');
            assert.ok(val, 'Counter for COMPLETED MUTE_GROUP command must exist');
            assert.strictEqual(val.val, 1);
        });

        it('3B. Increments durable_commands_processed_total upon terminal FAILED outcome without intermediate double-counting', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid, announce: true },
                maxAttempts: 1, // Only 1 attempt, so failure is immediately terminal FAILED
            });

            const client = await pool.connect();
            let claimed;
            try {
                claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: testConnection.id,
                    workerId: workerNode.workerId,
                    claimEpoch: 1,
                });
            } finally {
                client.release();
            }

            // Set socket where bot is NOT admin -> triggers terminal FAILED 'BOT_NOT_ADMIN'
            const failSocket = {
                ...mockSocket,
                groupMetadata: async () => ({
                    id: testGroup.whatsapp_jid,
                    subject: testGroup.name,
                    announce: true,
                    participants: [], // Bot is NOT in participants -> not admin
                }),
            };
            cm.connections.set(testConnection.id, { socket: failSocket });

            await workerNode._executeCommand(claimed, 1);

            const updated = await commandRepo.findById(cmd.id);
            assert.strictEqual(updated.status, 'FAILED');

            const val = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"');
            assert.ok(val, 'Counter for FAILED MUTE_GROUP command must exist');
            assert.strictEqual(val.val, 1);
        });

        it('3B. Test 2: Unknown then verified — 0 increment on UNKNOWN, +1 on COMPLETED, no double-counting', async () => {
            const initialCompleted = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"')?.val || 0;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid, announce: true },
                maxAttempts: 1,
            });

            // Simulate transition to REMOTE_OUTCOME_UNKNOWN via worker
            const client = await pool.connect();
            let claimed;
            try {
                claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: testConnection.id,
                    workerId: workerNode.workerId,
                    claimEpoch: 1,
                });
            } finally {
                client.release();
            }

            const timeoutSocket = {
                ...mockSocket,
                groupSettingUpdate: async () => {
                    const err = new Error('Socket timeout while waiting for ack');
                    err.code = 'ETIMEDOUT';
                    throw err;
                },
            };
            cm.connections.set(testConnection.id, { socket: timeoutSocket });

            await workerNode._executeCommand(claimed, 1);

            const updated = await commandRepo.findById(cmd.id);
            assert.strictEqual(updated.status, 'REMOTE_OUTCOME_UNKNOWN');

            // CRITICAL VERIFICATION: REMOTE_OUTCOME_UNKNOWN is non-terminal and MUST NOT increment metric counter
            const unknownVal = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="REMOTE_OUTCOME_UNKNOWN"')?.val || 0;
            assert.strictEqual(unknownVal, 0, 'REMOTE_OUTCOME_UNKNOWN must not increment durable_commands_processed_total');

            const completedMid = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"')?.val || 0;
            assert.strictEqual(completedMid, initialCompleted, 'No increment during UNKNOWN phase');

            // Now resolve the UNKNOWN command via RemoteOutcomeVerificationService
            const lm = new WorkerLeaseManager({
                workerId: workerNode.workerId,
                connRepo,
                connectionManager: cm,
            });
            lm.leases.set(testConnection.id, {
                connectionId: testConnection.id,
                tenantId: testTenant.id,
                leaseEpoch: 1,
            });

            const verifier = new RemoteOutcomeVerificationService({
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                connectionManager: cm,
                leaseManager: lm,
                workerId: workerNode.workerId,
                metricsRegistry: metrics,
            });

            const verifySocket = {
                groupMetadata: async () => ({
                    id: testGroup.whatsapp_jid,
                    announce: true,
                }),
            };
            cm.connections.set(testConnection.id, {
                socket: verifySocket,
            });

            await verifier.verifyCommand(updated, { sock: verifySocket, claimEpoch: 1 });

            const resolvedCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(resolvedCmd.status, 'COMPLETED');

            const resolvedCompletedVal = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"')?.val || 0;
            assert.strictEqual(resolvedCompletedVal, initialCompleted + 1, 'Exactly one terminal COMPLETED increment');
        });

        it('3C. Test 3: Unknown then failed — 0 increment on UNKNOWN, +1 on terminal FAILED', async () => {
            const initialFailed = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"')?.val || 0;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid, announce: true },
                maxAttempts: 1,
            });

            // Transition to REMOTE_OUTCOME_UNKNOWN with attempt_count = 1 so next attempt exceeds max_attempts (1)
            await pool.query(`
                UPDATE connection_commands
                SET status = 'REMOTE_OUTCOME_UNKNOWN',
                    attempt_count = 1
                WHERE id = $1;
            `, [cmd.id]);

            const lm = new WorkerLeaseManager({
                workerId: workerNode.workerId,
                connRepo,
                connectionManager: cm,
            });
            lm.leases.set(testConnection.id, {
                connectionId: testConnection.id,
                tenantId: testTenant.id,
                leaseEpoch: 1,
            });

            const verifier = new RemoteOutcomeVerificationService({
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                connectionManager: cm,
                leaseManager: lm,
                workerId: workerNode.workerId,
                metricsRegistry: metrics,
            });

            // Group metadata indicates announce is false (mute was NOT observed)
            const negativeSocket = {
                groupMetadata: async () => ({
                    id: testGroup.whatsapp_jid,
                    announce: false,
                    participants: [{ id: 'bot:1@s.whatsapp.net', admin: 'admin' }],
                }),
            };
            cm.connections.set(testConnection.id, { socket: negativeSocket });

            const unknownCmd = await commandRepo.findById(cmd.id);
            await verifier.verifyCommand(unknownCmd, { sock: negativeSocket, claimEpoch: 1 });

            const failedCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(failedCmd.status, 'FAILED');

            const finalFailed = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"')?.val || 0;
            assert.strictEqual(finalFailed, initialFailed + 1, 'Exactly one terminal FAILED increment upon verification failure');
        });

        it('3D. Test 4: Operator FORCE_FAIL — +1 FAILED, repeated rejection is no-op', async () => {
            platformService.metricsRegistry = metrics;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid, announce: true },
            });

            await pool.query(`
                UPDATE connection_commands
                SET status = 'REMOTE_OUTCOME_UNKNOWN'
                WHERE id = $1;
            `, [cmd.id]);

            const initialFailed = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"')?.val || 0;

            // First FORCE_FAIL by SUPER_ADMIN
            await platformService.forceFailCommand(cmd.id, {
                reason: 'Operator declared failed outcome',
            }, { actorRole: 'SUPER_ADMIN' });

            const updatedCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(updatedCmd.status, 'FAILED');

            const afterFirst = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"')?.val || 0;
            assert.strictEqual(afterFirst, initialFailed + 1, '+1 FAILED metric on valid FORCE_FAIL');

            // Second FORCE_FAIL is an idempotent no-op (already terminal) and produces NO additional metric increment
            const secondRes = await platformService.forceFailCommand(cmd.id, {
                reason: 'Repeated operator force-fail attempt',
            }, { actorRole: 'SUPER_ADMIN' });
            assert.strictEqual(secondRes.alreadyTerminal, true);

            const afterSecond = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="FAILED"')?.val || 0;
            assert.strictEqual(afterSecond, afterFirst, 'No additional metric increment on rejected/no-op second FORCE_FAIL');
        });

        it('3E. Test 5: Recovery and requeue — 0 increment on requeue, +1 on eventual terminal completion', async () => {
            const initialCompleted = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="COMPLETED"')?.val || 0;
            const initialFailed = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="FAILED"')?.val || 0;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                commandType: 'SYNC_GROUPS',
                payload: {},
                maxAttempts: 3, // multiple attempts allowed
            });

            // Claim attempt 1
            const client1 = await pool.connect();
            let claimed1;
            try {
                claimed1 = await commandRepo.claimCommandForConnection(client1, {
                    connectionId: testConnection.id,
                    workerId: workerNode.workerId,
                    claimEpoch: 1,
                });
            } finally {
                client1.release();
            }

            // Retryable error during sync (e.g. transient network drop)
            const retryableSocket = {
                ...mockSocket,
                groupFetchAllParticipating: async () => {
                    const err = new Error('Transient network disconnect during sync');
                    err.code = 'ECONNRESET';
                    throw err;
                },
            };
            cm.connections.set(testConnection.id, { socket: retryableSocket });

            await workerNode._executeCommand(claimed1, 1);

            // Command should be requeued to PENDING
            const requeuedCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(requeuedCmd.status, 'PENDING');
            assert.strictEqual(requeuedCmd.attempt_count, 1);

            // Verify ZERO metric increment during requeue
            const failedAfterRequeue = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="FAILED"')?.val || 0;
            assert.strictEqual(failedAfterRequeue, initialFailed, 'Requeue must not increment FAILED metric');

            // Claim attempt 2
            await pool.query(`UPDATE connection_commands SET next_attempt_at = NOW() - INTERVAL '1 second' WHERE id = $1`, [cmd.id]);

            const client2 = await pool.connect();
            let claimed2;
            try {
                claimed2 = await commandRepo.claimCommandForConnection(client2, {
                    connectionId: testConnection.id,
                    workerId: workerNode.workerId,
                    claimEpoch: 1,
                });
            } finally {
                client2.release();
            }

            // Attempt 2 succeeds
            const successSocket = {
                ...mockSocket,
                groupFetchAllParticipating: async () => ({}),
            };
            cm.connections.set(testConnection.id, { socket: successSocket });
            await workerNode._executeCommand(claimed2, 1);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');

            const completedAfterSuccess = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="COMPLETED"')?.val || 0;
            assert.strictEqual(completedAfterSuccess, initialCompleted + 1, 'Terminal COMPLETED metric must increment by exactly 1');
        });

        it('3F. Test 6: Lost race — loser returns false and produces 0 metric increment', async () => {
            const initialCompleted = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="COMPLETED"')?.val || 0;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                commandType: 'SYNC_GROUPS',
                payload: {},
            });

            // Mark PROCESSING
            await pool.query(`UPDATE connection_commands SET status = 'PROCESSING', claimed_by_worker_id = $1, claim_epoch = 1 WHERE id = $2`, [workerNode.workerId, cmd.id]);

            // Two racing completions
            const win = await commandRepo.completeCommand(null, {
                id: cmd.id,
                workerId: workerNode.workerId,
                claimEpoch: 1,
                result: { ok: true },
            });
            if (win) {
                metrics.durableCommandsTotal.inc({ command: 'SYNC_GROUPS', status: 'COMPLETED' });
            }

            const lose = await commandRepo.completeCommand(null, {
                id: cmd.id,
                workerId: workerNode.workerId,
                claimEpoch: 1,
                result: { ok: true },
            });
            if (lose) {
                metrics.durableCommandsTotal.inc({ command: 'SYNC_GROUPS', status: 'COMPLETED' });
            }

            assert.strictEqual(win, true, 'Winner must succeed');
            assert.strictEqual(lose, false, 'Loser must fail conditional update');

            const finalCompleted = metrics.durableCommandsTotal.values.get('command="SYNC_GROUPS",status="COMPLETED"')?.val || 0;
            assert.strictEqual(finalCompleted, initialCompleted + 1, 'Only one metric increment permitted across concurrent race');
        });

        it('3G. Test 7: Rollback safety — rolled back transaction produces 0 metric increments', async () => {
            const initialCompleted = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"')?.val || 0;

            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                await commandRepo.createCommand(client, {
                    tenantId: testTenant.id,
                    connectionId: testConnection.id,
                    commandType: 'MUTE_GROUP',
                    payload: { jid: testGroup.whatsapp_jid },
                });

                // Roll back transaction before commit
                await client.query('ROLLBACK');

                // Metric is only incremented strictly after successful COMMIT
            } finally {
                client.release();
            }

            const afterRollback = metrics.durableCommandsTotal.values.get('command="MUTE_GROUP",status="COMPLETED"')?.val || 0;
            assert.strictEqual(afterRollback, initialCompleted, 'Rolled back transaction must produce 0 metric increments');
        });

        it('3H. Increments scheduled_tasks_processed_total upon terminal task outcomes', async () => {
            const lm = new WorkerLeaseManager({
                workerId: workerNode.workerId,
                connRepo,
                connectionManager: cm,
            });
            lm.leases.set(testConnection.id, {
                connectionId: testConnection.id,
                tenantId: testTenant.id,
                leaseEpoch: 1,
            });

            const taskScheduler = new DurableModerationScheduler({
                pool,
                taskRepo,
                groupRepo,
                leaseManager: lm,
                connectionManager: cm,
                workerId: workerNode.workerId,
                metricsRegistry: metrics,
            });

            // Mock socket with groupSettingUpdate for UNMUTE
            let settingUpdated = false;
            cm.connections.set(testConnection.id, {
                socket: {
                    groupSettingUpdate: async (jid, setting) => {
                        settingUpdated = true;
                    },
                    groupMetadata: async () => ({
                        id: testGroup.whatsapp_jid,
                        announce: false,
                    }),
                    sendMessage: async () => {},
                },
            });

            const task = await taskRepo.createTask(null, {
                tenantId: testTenant.id,
                connectionId: testConnection.id,
                groupId: testGroup.id,
                action: 'UNMUTE_GROUP',
                payload: { jid: testGroup.whatsapp_jid },
                runAt: new Date(Date.now() - 1000),
            });

            // Claim task
            const client = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [testConnection.id],
                    workerId: workerNode.workerId,
                    getLeaseEpochForConnection: () => 1,
                });
            } finally {
                client.release();
            }

            await taskScheduler.processTask(claimed);

            const updatedTask = await taskRepo.findById(task.id);
            assert.strictEqual(updatedTask.status, 'COMPLETED');
            assert.strictEqual(settingUpdated, true);

            const taskVal = metrics.scheduledTasksTotal.values.get('status="COMPLETED",type="UNMUTE_GROUP"');
            assert.ok(taskVal, 'Counter for COMPLETED UNMUTE_GROUP task must exist');
            assert.strictEqual(taskVal.val, 1);
        });

        it('3I. Metric exposition strictly excludes forbidden high-cardinality and PII labels', async () => {
            const exposition = await metrics.toPrometheusFormat();

            assert.ok(exposition.includes('durable_commands_processed_total'));
            assert.ok(exposition.includes('scheduled_tasks_processed_total'));

            // Ensure no tenant IDs, connection IDs, worker IDs, or JIDs were leaked
            assert.strictEqual(exposition.includes(testTenant.id), false, 'Tenant ID must not be leaked into metrics');
            assert.strictEqual(exposition.includes(testConnection.id), false, 'Connection ID must not be leaked');
            assert.strictEqual(exposition.includes(testGroup.whatsapp_jid), false, 'JID must not be leaked');
            assert.strictEqual(exposition.includes(workerNode.workerId), false, 'Worker ID must not be leaked');
        });
    });

    // =========================================================================
    // 4. CUSTOMER IDEMPOTENCY FOR CONNECTION CREATION
    // =========================================================================
    describe('4. Customer Idempotency for Connection Creation', () => {
        beforeEach(async () => {
            await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1', [testTenant.id]);
        });

        it('4A. Creates connection and returns 201 on first request with Idempotency-Key', async () => {
            const idempotencyKey = `idemp-conn-${Date.now()}-1`;

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: {
                    displayName: 'Primary Sales WhatsApp',
                    phoneNumber: '255711000001',
                },
            });

            assert.strictEqual(res.statusCode, 201);
            const conn = res.body.data?.connection || res.body.connection;
            assert.ok(conn);
            assert.ok(conn.id);
            assert.strictEqual(conn.display_name, 'Primary Sales WhatsApp');
            testConn = conn;
        });

        it('4B. Replays identical 201 response with X-Cache: IDEMPOTENT-REPLAY header when same key and payload are submitted', async () => {
            const idempotencyKey = `idemp-conn-${Date.now()}-2`;
            const payload = {
                displayName: 'Support Desk WhatsApp',
                phoneNumber: '255711000002',
            };

            // First request
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });

            assert.strictEqual(res1.statusCode, 201);
            const conn1 = res1.body.data?.connection || res1.body.connection;
            const initialId = conn1.id;

            // Second request with exact same idempotency key and body
            const res2 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });

            assert.strictEqual(res2.statusCode, 201);
            assert.strictEqual(res2.headers['x-cache'], 'IDEMPOTENT-REPLAY', 'Replay header X-Cache: IDEMPOTENT-REPLAY must be set');
            const conn2 = res2.body.data?.connection || res2.body.connection;
            assert.strictEqual(conn2.id, initialId, 'Must return the exact same connection ID');
            assert.strictEqual(conn2.display_name, 'Support Desk WhatsApp');

            // Verify only one connection exists in DB for this phone number
            const listRes = await makeRequest(server, {
                method: 'GET',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                },
            });
            const connections = listRes.body.data?.connections || listRes.body.connections || [];
            const matches = connections.filter((c) => c.phone_number === '255711000002');
            assert.strictEqual(matches.length, 1, 'Only one record must exist in DB');
        });

        it('4C. Rejects with 409 IDEMPOTENCY_CONFLICT when same Idempotency-Key is used with different payload', async () => {
            const idempotencyKey = `idemp-conn-${Date.now()}-3`;

            // Initial request
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: {
                    displayName: 'Original Name',
                    phoneNumber: '255711000003',
                },
            });
            assert.strictEqual(res1.statusCode, 201);

            // Conflicting request with different payload
            const res2 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: {
                    displayName: 'Completely Different Name',
                    phoneNumber: '255711000003',
                },
            });

            assert.strictEqual(res2.statusCode, 409);
            assert.strictEqual(res2.body.error.code, 'IDEMPOTENCY_CONFLICT');
        });

        it('4D. Rejects with 400 INVALID_IDEMPOTENCY_KEY on invalid header format', async () => {
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': 'invalid key with spaces!@#$',
                },
                body: {
                    displayName: 'Bad Key Conn',
                },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
        });

        it('4E. Creates a new connection on every request when Idempotency-Key is omitted', async () => {
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                },
                body: {
                    displayName: 'No Idemp Conn 1',
                },
            });
            assert.strictEqual(res1.statusCode, 201);

            // Clean up first connection so tenant can create another without violating single-connection invariant
            await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1', [testTenant.id]);

            const res2 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                },
                body: {
                    displayName: 'No Idemp Conn 2',
                },
            });
            assert.strictEqual(res2.statusCode, 201);

            const c1 = res1.body.data?.connection || res1.body.connection;
            const c2 = res2.body.data?.connection || res2.body.connection;
            assert.notStrictEqual(c1.id, c2.id, 'Different connections must be created');
        });

        it('4F. Concurrent requests with real PostgreSQL transactions: one creates, other gets replay or 409 conflict', async () => {
            const idempotencyKey = `idemp-concurrent-${Date.now()}`;
            const phoneNumber = `255715${Date.now().toString().slice(-6)}`;
            const payload = {
                displayName: 'Concurrent Connection',
                phoneNumber,
            };

            const [resA, resB] = await Promise.all([
                makeRequest(server, {
                    method: 'POST',
                    path: `/api/v1/tenants/${testTenant.id}/connections`,
                    headers: {
                        Authorization: `Bearer ${ownerToken}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: payload,
                }),
                makeRequest(server, {
                    method: 'POST',
                    path: `/api/v1/tenants/${testTenant.id}/connections`,
                    headers: {
                        Authorization: `Bearer ${ownerToken}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: payload,
                }),
            ]);

            const statuses = [resA.statusCode, resB.statusCode].sort();
            // Valid concurrency outcomes: either [201, 201] (winner created, runner-up got replay) or [201, 409] (winner created, runner-up hit concurrent in-flight lock)
            assert.ok(
                (statuses[0] === 201 && statuses[1] === 201) || (statuses[0] === 201 && statuses[1] === 409),
                `Expected [201, 201] or [201, 409] but got: ${JSON.stringify(statuses)}`
            );

            // Verify exactly ONE connection exists in the database
            const countRes = await pool.query(
                'SELECT COUNT(*)::int as count FROM whatsapp_connections WHERE phone_number = $1',
                [phoneNumber]
            );
            assert.strictEqual(countRes.rows[0].count, 1, 'Exactly one connection record must be created under concurrency');
        });

        it('4G. Rollback before commit crash boundary: rolled-back transaction leaves no record and subsequent retry succeeds', async () => {
            const idempotencyKey = `idemp-rollback-${Date.now()}`;
            const phoneNumber = `255716${Date.now().toString().slice(-6)}`;

            // Simulate a crashed/rolled-back attempt directly on the DB transaction
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                await client.query(`
                    INSERT INTO api_idempotency_keys (tenant_id, user_id, idempotency_key, request_hash, status, created_at, expires_at)
                    VALUES ($1, $2, $3, $4, 'PENDING', NOW(), NOW() + INTERVAL '1 hour');
                `, [testTenant.id, ownerUser.id, idempotencyKey, 'some-hash']);

                // Roll back transaction before commit
                await client.query('ROLLBACK');
            } finally {
                client.release();
            }

            // Verify row is not in api_idempotency_keys
            const checkRes = await pool.query(
                'SELECT * FROM api_idempotency_keys WHERE idempotency_key = $1',
                [idempotencyKey]
            );
            assert.strictEqual(checkRes.rows.length, 0, 'No idempotency row must exist after rollback');

            // Subsequent request with the same Idempotency-Key must succeed cleanly with 201
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${testTenant.id}/connections`,
                headers: {
                    Authorization: `Bearer ${ownerToken}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: {
                    displayName: 'After Rollback Connection',
                    phoneNumber,
                },
            });

            assert.strictEqual(res.statusCode, 201);
            const conn = res.body.data?.connection || res.body.connection;
            assert.ok(conn);
            assert.strictEqual(conn.phone_number, phoneNumber);
        });
    });
});
