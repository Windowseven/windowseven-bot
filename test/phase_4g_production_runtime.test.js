const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const EventEmitter = require('node:events');
const { Pool, Client } = require('pg');

const { migrateUp } = require('../src/database/migrator');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
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
const { createRestApp } = require('../src/application/http/RestApp');
const { createApiDaemon } = require('../bin/api');
const { createWorkerDaemon } = require('../bin/worker');
const { createMonolithDaemon } = require('../bin/monolith');
const PostgresNotificationListener = require('../src/database/PostgresNotificationListener');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const { MetricsRegistry, METRIC_ALLOWLISTS, FORBIDDEN_LABEL_KEYS } = require('../src/application/metrics/MetricsRegistry');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_test';

function makeMockSocketFactory() {
    return () => {
        const ev = new EventEmitter();
        return {
            ev,
            ws: { close: () => {}, terminate: () => {} },
            end: () => {},
            user: { id: 'mockbot:1@s.whatsapp.net', name: 'MockBot' },
        };
    };
}

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
                    raw: data,
                });
            });
        });

        req.on('error', reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe('Phase 4G: Production Process Topology, Cross-Node Transport & Observability', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let workerRepo;
    let tokenService;
    let authService;
    let passwordService;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        await migrateUp(pool);

        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        workerRepo = new WorkerRepository(pool);
        tokenService = new TokenService();
        passwordService = new PasswordService();
        const refreshTokenRepo = new RefreshTokenRepository(pool);
        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            tokenService,
            passwordService,
            pool,
        });
    });

    after(async () => {
        if (pool) {
            await pool.query('TRUNCATE TABLE workers, whatsapp_connections, tenants, users CASCADE;').catch(() => {});
            await pool.end();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Process Topology: Standalone API Daemon (bin/api.js)
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Standalone REST API Daemon (bin/api.js)', () => {
        let apiDaemon;

        before(async () => {
            apiDaemon = await createApiDaemon({
                databaseUrl: TEST_DB_URL,
                port: 0,
                host: '127.0.0.1',
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await apiDaemon.start();
        });

        after(async () => {
            if (apiDaemon) {
                await apiDaemon.shutdown('SIGTERM');
            }
        });

        it('should boot independently without worker runtime and serve health endpoints', async () => {
            const res = await makeRequest(apiDaemon.server, { method: 'GET', path: '/health/live' });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, 'alive');

            const readyRes = await makeRequest(apiDaemon.server, { method: 'GET', path: '/health/ready' });
            assert.strictEqual(readyRes.statusCode, 200);
            assert.strictEqual(readyRes.body.data.status, 'ready');
            assert.strictEqual(readyRes.body.data.database, 'connected');
        });

        it('should serve Prometheus /metrics in standard 0.0.4 text format', async () => {
            const res = await makeRequest(apiDaemon.server, { method: 'GET', path: '/metrics' });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.headers['content-type'].includes('text/plain'));
            assert.ok(res.headers['content-type'].includes('version=0.0.4'));
            assert.ok(typeof res.raw === 'string');
            assert.ok(res.raw.includes('http_requests_total'));
            assert.ok(res.raw.includes('http_request_duration_seconds'));
            assert.ok(res.raw.includes('pg_pool_connections'));
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Process Topology: Standalone WhatsApp Worker Daemon (bin/worker.js)
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Standalone WhatsApp Worker Daemon (bin/worker.js)', () => {
        let workerDaemon;
        const testWorkerId = `test-worker-daemon-${Date.now()}`;

        before(async () => {
            workerDaemon = await createWorkerDaemon({
                databaseUrl: TEST_DB_URL,
                workerId: testWorkerId,
                capacity: 25,
                drainGraceMs: 2000,
                socketFactory: makeMockSocketFactory(),
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await workerDaemon.start();
        });

        it('should register worker node in database with READY status and capacity hint', async () => {
            const row = await workerRepo.findById(testWorkerId);
            assert.ok(row);
            assert.strictEqual(row.id, testWorkerId);
            assert.strictEqual(row.status, 'READY');
            assert.strictEqual(row.capacity, 25);
        });

        it('should delegate shutdown strictly to WorkerNode.drain() (Correction 1)', async () => {
            assert.strictEqual(workerDaemon.workerNode.status, 'READY');
            await workerDaemon.shutdown('SIGTERM');
            assert.strictEqual(workerDaemon.workerNode.status, 'OFFLINE');

            const row = await workerRepo.findById(testWorkerId);
            assert.strictEqual(row.status, 'OFFLINE');
        });

        it('should handle duplicate shutdown signals idempotently without second drain', async () => {
            // Second call to shutdown should be a no-op
            await workerDaemon.shutdown('SIGINT');
            assert.strictEqual(workerDaemon.workerNode.status, 'OFFLINE');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Process Topology: Unified Monolith Runtime (bin/monolith.js)
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Unified Monolith Runtime (bin/monolith.js)', () => {
        let monolith;
        const monoWorkerId = `test-monolith-worker-${Date.now()}`;

        before(async () => {
            monolith = await createMonolithDaemon({
                databaseUrl: TEST_DB_URL,
                port: 0,
                host: '127.0.0.1',
                workerId: monoWorkerId,
                capacity: 30,
                drainGraceMs: 2000,
                socketFactory: makeMockSocketFactory(),
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await monolith.start();
        });

        after(async () => {
            if (monolith) {
                await monolith.shutdown('SIGTERM');
            }
        });

        it('should compose API and Worker planes in a single process without conflict', async () => {
            // Verify REST API is operational
            const res = await makeRequest(monolith.server, { method: 'GET', path: '/health/live' });
            assert.strictEqual(res.statusCode, 200);

            // Verify WorkerNode is active
            assert.strictEqual(monolith.workerNode.status, 'READY');
            const row = await workerRepo.findById(monoWorkerId);
            assert.ok(row);
            assert.strictEqual(row.status, 'READY');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Cross-Node PostgreSQL Notification Listener & Transport
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Cross-Node Notification Listener & Transport (Correction 2 & 5)', () => {
        let listenerNodeB;
        let commandGatewayNodeA;
        let eventPublisherNodeA;

        before(async () => {
            commandGatewayNodeA = new ConnectionCommandGateway({ pool });
            eventPublisherNodeA = new LocalEventPublisher();

            listenerNodeB = new PostgresNotificationListener({
                connectionString: TEST_DB_URL,
                channels: ['connection_control_wake', 'tenant_events'],
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await listenerNodeB.start();
        });

        after(async () => {
            if (listenerNodeB) {
                await listenerNodeB.stop();
            }
        });

        it('should receive connection_control_wake from Node A on Node B listener', async () => {
            const receivedPromise = new Promise((resolve) => {
                const unsub = listenerNodeB.subscribe('connection_control_wake', (payload) => {
                    unsub();
                    resolve(payload);
                });
            });

            await commandGatewayNodeA.sendCommand({
                command: 'START_CONNECTION',
                tenantId: 'd0000000-0000-0000-0000-000000000001',
                connectionId: 'c0000000-0000-0000-0000-000000000001',
            });

            const received = await receivedPromise;
            assert.ok(received);
            assert.strictEqual(received.command, 'START_CONNECTION');
            assert.strictEqual(received.connectionId, 'c0000000-0000-0000-0000-000000000001');
        });

        it('should receive tenant_events from Node A on Node B listener', async () => {
            const receivedPromise = new Promise((resolve) => {
                const unsub = listenerNodeB.subscribe('tenant_events', (payload) => {
                    unsub();
                    resolve(payload);
                });
            });

            const testEvent = {
                id: 'evt-test-1',
                tenantId: 'd0000000-0000-0000-0000-000000000001',
                eventType: 'connection.status.changed',
                data: { status: 'CONNECTED' },
                timestamp: new Date().toISOString(),
            };

            // Broadcast via pg_notify directly
            await pool.query(`SELECT pg_notify('tenant_events', $1);`, [JSON.stringify(testEvent)]);

            const received = await receivedPromise;
            assert.ok(received);
            assert.strictEqual(received.id, 'evt-test-1');
            assert.strictEqual(received.eventType, 'connection.status.changed');
        });

        it('should safely handle malformed JSON notifications without crashing', async () => {
            let errorEmitted = false;
            listenerNodeB.subscribe('connection_control_wake', (payload, raw) => {
                // Should pass raw string if not JSON
                assert.strictEqual(typeof raw.rawPayload, 'string');
                errorEmitted = true;
            });

            await pool.query(`SELECT pg_notify('connection_control_wake', 'NOT_VALID_JSON{{{');`);
            await new Promise((r) => setTimeout(r, 100));
            assert.strictEqual(errorEmitted, true);
        });

        it('should handle disconnect, auto-reconnect with jitter, and re-register LISTEN channels', async () => {
            let reconnected = false;
            listenerNodeB.once('connected', () => {
                reconnected = true;
            });

            // Simulate network disconnect on active client
            if (listenerNodeB.client) {
                listenerNodeB.client.emit('error', new Error('Simulated network drop'));
            }

            // Wait for exponential backoff + reconnect
            for (let i = 0; i < 40; i++) {
                if (reconnected && listenerNodeB.isConnected) break;
                await new Promise((r) => setTimeout(r, 100));
            }
            assert.strictEqual(listenerNodeB.isConnected, true);

            // Verify notifications still work post-reconnect
            const receivedPromise = new Promise((resolve) => {
                const unsub = listenerNodeB.subscribe('connection_control_wake', (payload) => {
                    unsub();
                    resolve(payload);
                });
            });

            await pool.query(`SELECT pg_notify('connection_control_wake', '{"reconnected":true}');`);
            const postRecv = await receivedPromise;
            assert.strictEqual(postRecv.reconnected, true);
        });

        it('should maintain keepalive ping without crashing', async () => {
            const shortKeepaliveListener = new PostgresNotificationListener({
                connectionString: TEST_DB_URL,
                channels: ['connection_control_wake'],
                keepaliveIntervalMs: 50,
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await shortKeepaliveListener.start();
            assert.strictEqual(shortKeepaliveListener.isConnected, true);

            // Wait for at least 2 keepalive ticks
            await new Promise((r) => setTimeout(r, 150));
            assert.strictEqual(shortKeepaliveListener.isConnected, true);
            await shortKeepaliveListener.stop();
        });

        it('should safely stop during reconnect backoff and prevent subsequent reconnection', async () => {
            const backoffListener = new PostgresNotificationListener({
                connectionString: TEST_DB_URL,
                channels: ['connection_control_wake'],
                reconnectBaseDelayMs: 200,
                logger: { log: () => {}, warn: () => {}, error: () => {} },
            });
            await backoffListener.start();

            // Trigger disconnect
            backoffListener.client.emit('error', new Error('Disconnect for stop test'));
            assert.ok(backoffListener.reconnectTimer !== null);

            // Call stop during reconnect backoff
            await backoffListener.stop();
            assert.strictEqual(backoffListener.isClosed, true);
            assert.strictEqual(backoffListener.reconnectTimer, null);

            // Ensure no resurrection happens
            await new Promise((r) => setTimeout(r, 300));
            assert.strictEqual(backoffListener.isConnected, false);
            assert.strictEqual(backoffListener.client, null);
        });

        it('should demonstrate durable convergence when notification is suppressed/missed (Section 6)', async () => {
            // 1. Setup tenant and connection in DB
            const convTenant = await tenantRepo.create({ name: 'Convergence Tenant' });
            const convConn = await connRepo.createForTenant(convTenant.id, {
                displayName: 'Convergence Bot',
                desiredState: 'STOPPED',
            });

            const mockCm = new ConnectionManager(pool, { socketFactory: makeMockSocketFactory() });
            const convWorker = new WorkerNode({
                pool,
                connectionManager: mockCm,
                connRepo,
                workerRepo,
                taskRepo: new ScheduledModerationTaskRepository(pool),
                groupRepo: new GroupRepository(pool),
                policyRepo: new GroupPolicyRepository(pool),
                warningRepo: new GroupWarningRepository(pool),
                auditLogRepo: new AuditLogRepository(pool),
                commandRepo: new ConnectionCommandRepository(pool),
                commandGateway: new ConnectionCommandGateway({ pool }),
                eventPublisher: new LocalEventPublisher(),
                workerId: 'worker-convergence-test',
                capacity: 5,
                drainGraceMs: 1000,
            });

            await convWorker.start();

            try {
                // 2. Change durable PostgreSQL state directly WITHOUT sending connection_control_wake
                await pool.query(
                    `UPDATE whatsapp_connections SET desired_state = 'RUNNING' WHERE id = $1;`,
                    [convConn.id]
                );

                // 3. Worker does NOT receive any NOTIFY wake-up.
                // 4. Trigger the regular periodic reconciliation loop directly
                await convWorker.reconcile();

                // 5. Verify the worker eventually converged to the durable PostgreSQL state
                const row = await connRepo.findById(convConn.id);
                assert.strictEqual(row.assignedWorkerId, 'worker-convergence-test');
                assert.ok(row.leaseEpoch >= 1);
            } finally {
                await convWorker.drain({ graceMs: 500 }).catch(() => {});
                await mockCm.shutdown().catch(() => {});
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Prometheus Telemetry & Cardinality Controls (Correction 3 & 4)
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Prometheus Telemetry & Allowlist Safety (Correction 3 & 4)', () => {
        let registry;

        beforeEach(() => {
            registry = new MetricsRegistry();
        });

        it('should enforce strict allowlist per metric and strip unlisted labels (Correction 3)', () => {
            // Valid labels
            registry.httpRequestsTotal.inc({
                method: 'GET',
                route: '/api/v1/platform/tenants',
                status: '200',
                // Forbidden / unlisted labels:
                tenant_id: 'tenant-1234',
                user_id: 'user-5678',
                phone_number: '+1234567890',
                unlisted_tag: 'malicious',
            });

            const text = registry.httpRequestsTotal.toPrometheusFormat();

            // Must include allowlisted keys
            assert.ok(text.includes('method="GET"'));
            assert.ok(text.includes('route="/api/v1/platform/tenants"'));
            assert.ok(text.includes('status="200"'));

            // Must NOT include forbidden or unlisted keys
            assert.strictEqual(text.includes('tenant_id'), false);
            assert.strictEqual(text.includes('user_id'), false);
            assert.strictEqual(text.includes('phone_number'), false);
            assert.strictEqual(text.includes('unlisted_tag'), false);
        });

        it('should format histograms with buckets, sum, and count accurately', () => {
            registry.httpRequestDuration.observe({ method: 'GET', route: '/health/live' }, 0.045);
            registry.httpRequestDuration.observe({ method: 'GET', route: '/health/live' }, 0.150);

            const text = registry.httpRequestDuration.toPrometheusFormat();
            assert.ok(text.includes('http_request_duration_seconds_bucket{method="GET",route="/health/live",le="0.05"} 1'));
            assert.ok(text.includes('http_request_duration_seconds_bucket{method="GET",route="/health/live",le="0.25"} 2'));
            assert.ok(text.includes('http_request_duration_seconds_bucket{method="GET",route="/health/live",le="+Inf"} 2'));
            assert.ok(text.includes('http_request_duration_seconds_count{method="GET",route="/health/live"} 2'));
            assert.ok(text.includes('http_request_duration_seconds_sum{method="GET",route="/health/live"} 0.195'));
        });

        it('should capture normalized route templates in HTTP requests via RestApp (Correction 4)', async () => {
            const app = createRestApp({
                pool,
                tokenService,
                authService,
                tenantRepo,
                tenantMembershipRepo: membershipRepo,
                userRepo,
                metricsRegistry: registry,
            });

            const srv = http.createServer(app);
            await new Promise((r) => srv.listen(0, '127.0.0.1', r));

            try {
                // Request known route
                await makeRequest(srv, { method: 'GET', path: '/health/live' });

                // Request non-existent route
                await makeRequest(srv, { method: 'GET', path: '/non-existent-path-12345' });

                const metricsOutput = await registry.toPrometheusFormat();

                // Normalized route template should appear
                assert.ok(metricsOutput.includes('route="/health/live"'));

                // Non-existent route must be labeled UNKNOWN, NOT the raw URL
                assert.ok(metricsOutput.includes('route="UNKNOWN"'));
                assert.strictEqual(metricsOutput.includes('non-existent-path-12345'), false);
            } finally {
                await new Promise((r) => srv.close(r));
            }
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Dwell-and-Drain Worker Placement & Invariant Preservation
    // ─────────────────────────────────────────────────────────────────────────
    describe('6. Dwell-and-Drain Worker Placement & Takeover Invariants', () => {
        let workerNode1;
        let workerNode2;
        let testTenant;
        let testConn;

        let cm1;
        let cm2;

        before(async () => {
            testTenant = await tenantRepo.create({ name: 'Dwell Test Tenant' });
            testConn = await connRepo.createForTenant(testTenant.id, {
                displayName: 'Dwell Bot',
                desiredState: 'RUNNING',
            });

            cm1 = new ConnectionManager(pool, { socketFactory: makeMockSocketFactory() });
            cm2 = new ConnectionManager(pool, { socketFactory: makeMockSocketFactory() });

            workerNode1 = new WorkerNode({
                pool,
                connectionManager: cm1,
                connRepo,
                workerRepo,
                taskRepo: new ScheduledModerationTaskRepository(pool),
                groupRepo: new GroupRepository(pool),
                policyRepo: new GroupPolicyRepository(pool),
                warningRepo: new GroupWarningRepository(pool),
                auditLogRepo: new AuditLogRepository(pool),
                commandRepo: new ConnectionCommandRepository(pool),
                commandGateway: new ConnectionCommandGateway({ pool }),
                eventPublisher: new LocalEventPublisher(),
                workerId: 'worker-placement-1',
                capacity: 10,
                drainGraceMs: 2000,
            });

            workerNode2 = new WorkerNode({
                pool,
                connectionManager: cm2,
                connRepo,
                workerRepo,
                taskRepo: new ScheduledModerationTaskRepository(pool),
                groupRepo: new GroupRepository(pool),
                policyRepo: new GroupPolicyRepository(pool),
                warningRepo: new GroupWarningRepository(pool),
                auditLogRepo: new AuditLogRepository(pool),
                commandRepo: new ConnectionCommandRepository(pool),
                commandGateway: new ConnectionCommandGateway({ pool }),
                eventPublisher: new LocalEventPublisher(),
                workerId: 'worker-placement-2',
                capacity: 10,
                drainGraceMs: 2000,
            });

            await workerNode1.start();
            await workerNode2.start();
        });

        after(async () => {
            if (workerNode1) await workerNode1.drain({ graceMs: 1000 }).catch(() => {});
            if (workerNode2) await workerNode2.drain({ graceMs: 1000 }).catch(() => {});
            if (cm1) await cm1.shutdown().catch(() => {});
            if (cm2) await cm2.shutdown().catch(() => {});
        });

        it('should assign unassigned connection to Worker 1 and DWELL without live migration', async () => {
            // Worker 1 reconciles and acquires lease
            await workerNode1.reconcile();
            const connAfter1 = await connRepo.findById(testConn.id);
            assert.strictEqual(connAfter1.assignedWorkerId, 'worker-placement-1');
            const initialEpoch = connAfter1.leaseEpoch;

            // Worker 2 reconciles: MUST NOT steal or rebalance active connection (Dwell policy)
            await workerNode2.reconcile();
            const connAfter2 = await connRepo.findById(testConn.id);
            assert.strictEqual(connAfter2.assignedWorkerId, 'worker-placement-1');
            assert.strictEqual(connAfter2.leaseEpoch, initialEpoch);
        });

        it('should release connection on Worker 1 drain, allowing Worker 2 takeover', async () => {
            // Worker 1 enters DRAINING -> releases lease
            await workerNode1.drain({ graceMs: 500 });
            assert.strictEqual(workerNode1.status, 'OFFLINE');

            // Worker 2 reconciles and claims newly available connection
            await workerNode2.reconcile();
            const connAfterTakeover = await connRepo.findById(testConn.id);
            assert.strictEqual(connAfterTakeover.assignedWorkerId, 'worker-placement-2');
            assert.ok(connAfterTakeover.leaseEpoch > 1);
        });

        it('should strictly reject stale worker writes after lease epoch increment', async () => {
            // Stale worker (worker-placement-1) attempts to update state with old leaseEpoch = 1
            const writeResult = await connRepo.updateActualState({
                connectionId: testConn.id,
                workerId: 'worker-placement-1',
                leaseEpoch: 1,
                actualState: 'ACTIVE',
            });
            // 0 rows updated because active lease_epoch belongs to worker-placement-2
            assert.strictEqual(writeResult, null);

            const activeRow = await connRepo.findById(testConn.id);
            assert.strictEqual(activeRow.assignedWorkerId, 'worker-placement-2');
        });
    });
});
