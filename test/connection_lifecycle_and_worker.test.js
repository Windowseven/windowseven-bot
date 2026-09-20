const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    WorkerRepository,
    AuditLogRepository,
    RefreshTokenRepository,
} = require('../src/repositories');

const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PasswordService = require('../src/application/services/PasswordService');
const ConnectionService = require('../src/application/services/ConnectionService');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerLeaseManager = require('../src/whatsapp/worker/WorkerLeaseManager');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { EphemeralQrStore } = require('../src/whatsapp/control/EphemeralQrStore');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const SseGateway = require('../src/application/realtime/SseGateway');
const { createRestApp } = require('../src/application/http/RestApp');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Phase 4D: WhatsApp Connection Lifecycle, Worker Ownership & SSE', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let workerRepo;
    let auditLogRepo;
    let tokenService;
    let authService;
    let connectionService;
    let connectionManager;
    let commandGateway;
    let eventPublisher;
    let qrStore;
    let sseGateway;
    let server;
    let baseUrl;

    // Test fixtures
    let userOwnerA, userAdminA, userMemberA, userOwnerB;
    let tenantA, tenantB;
    let tokenOwnerA, tokenAdminA, tokenMemberA, tokenOwnerB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        workerRepo = new WorkerRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        const refreshTokenRepo = new RefreshTokenRepository(pool);

        const passwordService = new PasswordService();
        tokenService = new TokenService({ jwtSecret: 'test-phase-4d-secret-32-chars-long!!' });
        authService = new AuthService({ userRepo, refreshTokenRepo, passwordService, tokenService, pool });

        commandGateway = new ConnectionCommandGateway({ pool });
        eventPublisher = new LocalEventPublisher();
        qrStore = new EphemeralQrStore();
        sseGateway = new SseGateway({ eventPublisher, keepaliveIntervalMs: 500, maxClientsPerTenant: 10 });
        connectionManager = new ConnectionManager(pool);

        connectionService = new ConnectionService({
            pool,
            connRepo,
            auditLogRepo,
            commandGateway,
            qrStore,
        });

        const app = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo: membershipRepo,
            userRepo,
            auditLogRepo,
            whatsAppConnectionRepo: connRepo,
            connectionService,
            sseGateway,
            commandGateway,
            eventPublisher,
            qrStore,
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Cleanup fixtures
        await pool.query('DELETE FROM workers;');
        await pool.query('DELETE FROM whatsapp_connections;');
        await pool.query('DELETE FROM tenants CASCADE;');
        await pool.query('DELETE FROM users CASCADE;');

        // Create Users
        userOwnerA = await userRepo.create({ email: 'owner-a@example.com' });
        userAdminA = await userRepo.create({ email: 'admin-a@example.com' });
        userMemberA = await userRepo.create({ email: 'member-a@example.com' });
        userOwnerB = await userRepo.create({ email: 'owner-b@example.com' });

        // Create Tenants
        tenantA = await tenantRepo.create({ name: 'Acme Tenant A', slug: 'acme-tenant-a' });
        tenantB = await tenantRepo.create({ name: 'Beta Tenant B', slug: 'beta-tenant-b' });

        // Assign Memberships
        await membershipRepo.create({ tenantId: tenantA.id, userId: userOwnerA.id, role: 'OWNER' });
        await membershipRepo.create({ tenantId: tenantA.id, userId: userAdminA.id, role: 'ADMIN' });
        await membershipRepo.create({ tenantId: tenantA.id, userId: userMemberA.id, role: 'MEMBER' });
        await membershipRepo.create({ tenantId: tenantB.id, userId: userOwnerB.id, role: 'OWNER' });

        // Generate Access Tokens
        tokenOwnerA = tokenService.createAccessToken({ userId: userOwnerA.id, email: userOwnerA.email });
        tokenAdminA = tokenService.createAccessToken({ userId: userAdminA.id, email: userAdminA.email });
        tokenMemberA = tokenService.createAccessToken({ userId: userMemberA.id, email: userMemberA.email });
        tokenOwnerB = tokenService.createAccessToken({ userId: userOwnerB.id, email: userOwnerB.email });
    });

    after(async () => {
        qrStore.clearAll();
        sseGateway.closeAll();
        commandGateway.removeAllListeners();
        eventPublisher.removeAllListeners();
        await connectionManager.shutdown();
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
    });

    function request(method, path, { headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, baseUrl);
            const req = http.request(url, { method, headers }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed });
                });
            });
            req.on('error', reject);
            if (body) {
                req.setHeader('Content-Type', 'application/json');
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    // =========================================================================
    // 1. ConnectionManager Abort & Reconnect Cancellation (Amendment 5)
    // =========================================================================
    describe('1. ConnectionManager Abort & Reconnect Cancellation', () => {
        it('should cancel reconnect timers and set isAborted = true upon abortConnection()', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Abort Test Conn' });

            // Simulate registering a runtime connection with active reconnect timer
            const runtimeConn = {
                tenantId: tenantA.id,
                connectionId: conn.id,
                status: 'CONNECTING',
                lifecycleState: 'RECONNECTING',
                reconnectTimer: setTimeout(() => {}, 60000),
                reconnectAttempts: 2,
                isAborted: false,
                socket: {
                    ev: { removeAllListeners: () => {} },
                    ws: { terminate: () => {} },
                },
            };

            connectionManager.connections.set(conn.id, runtimeConn);
            assert.strictEqual(connectionManager.hasConnection(conn.id), true);

            // Execute abortConnection
            const aborted = await connectionManager.abortConnection(conn.id, 'FENCING_FAILURE');
            assert.strictEqual(aborted, true);
            assert.strictEqual(runtimeConn.isAborted, true);
            assert.strictEqual(runtimeConn.reconnectTimer, null);
            assert.strictEqual(runtimeConn.reconnectAttempts, 0);
            assert.strictEqual(connectionManager.hasConnection(conn.id), false);

            // Verify that calling _scheduleReconnect on aborted connection does nothing
            connectionManager._scheduleReconnect(runtimeConn);
            assert.strictEqual(runtimeConn.reconnectTimer, null, 'Reconnect must not be scheduled on aborted connection');
        });

        it('Abort vs Reconnect Race: racing reconnect attempt during or after abort bails out with no socket creation', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Race Conn' });

            const runtimeConn = {
                tenantId: tenantA.id,
                connectionId: conn.id,
                status: 'CONNECTING',
                lifecycleState: 'RECONNECTING',
                reconnectTimer: null,
                reconnectAttempts: 1,
                isAborted: false,
                state: { creds: {}, keys: {} },
                options: {},
                socket: null,
            };

            connectionManager.connections.set(conn.id, runtimeConn);

            // Abort connection
            await connectionManager.abortConnection(conn.id, 'FENCING_TRIPPED');
            assert.strictEqual(runtimeConn.isAborted, true);

            // Simulate delayed reconnect callback attempting to execute _startSocket
            const result = await connectionManager._startSocket(runtimeConn);
            assert.strictEqual(result, null, '_startSocket must immediately return null if runtime is aborted');
            assert.strictEqual(connectionManager.connections.has(conn.id), false);
        });
    });

    // =========================================================================
    // 2. Atomic Lease Acquisition & Concurrency Protection (Amendment 4)
    // =========================================================================
    describe('2. Atomic Lease Acquisition & Concurrency Protection', () => {
        it('Lease Race: concurrent acquisition attempts by two workers must result in exactly ONE winner', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Lease Race Test' });

            // Worker Alpha and Worker Beta attempt concurrent acquisition
            const [resultAlpha, resultBeta] = await Promise.all([
                connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-alpha' }),
                connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-beta' }),
            ]);

            const winnerCount = (resultAlpha ? 1 : 0) + (resultBeta ? 1 : 0);
            assert.strictEqual(winnerCount, 1, 'Exactly one worker must win the lease race');

            const winner = resultAlpha || resultBeta;
            assert.ok(winner);
            assert.strictEqual(winner.actualState, 'LEASE_ACQUIRED');
            assert.strictEqual(winner.leaseEpoch, 2); // Initial default was 1, incremented to 2

            // Verify database state reflects the winner
            const inDb = await connRepo.findById(conn.id);
            assert.strictEqual(inDb.assignedWorkerId, winner.assignedWorkerId);
            assert.strictEqual(inDb.leaseEpoch, 2);
        });

        it('Epoch Monotonicity: repeated acquisitions strictly increment lease_epoch', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Monotonic Epoch Test' });
            assert.strictEqual(conn.leaseEpoch, 1);

            // First acquisition: 1 -> 2
            const acq1 = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-1' });
            assert.strictEqual(acq1.leaseEpoch, 2);

            // Release lease
            await connRepo.releaseLease({ connectionId: conn.id, workerId: 'worker-1', leaseEpoch: 2 });

            // Second acquisition: 2 -> 3
            const acq2 = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-2' });
            assert.strictEqual(acq2.leaseEpoch, 3);

            // Release lease
            await connRepo.releaseLease({ connectionId: conn.id, workerId: 'worker-2', leaseEpoch: 3 });

            // Third acquisition: 3 -> 4
            const acq3 = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-3' });
            assert.strictEqual(acq3.leaseEpoch, 4);
        });

        it('Stale Heartbeat Rejection: worker with old epoch cannot renew lease', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Heartbeat Stale Test' });

            // Worker 1 acquires at epoch 2
            await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-1' });

            // Worker 1 renews heartbeat with valid epoch 2 -> SUCCESS
            const renewOk = await connRepo.renewLease({ connectionId: conn.id, workerId: 'worker-1', leaseEpoch: 2 });
            assert.strictEqual(renewOk, true);

            // Worker 1 attempts heartbeat with stale epoch 1 -> REJECTED
            const renewStale = await connRepo.renewLease({ connectionId: conn.id, workerId: 'worker-1', leaseEpoch: 1 });
            assert.strictEqual(renewStale, false);

            // Other worker attempts heartbeat with epoch 2 -> REJECTED (wrong worker)
            const renewWrongWorker = await connRepo.renewLease({ connectionId: conn.id, workerId: 'worker-other', leaseEpoch: 2 });
            assert.strictEqual(renewWrongWorker, false);
        });

        it('Stale Mutation Rejection: database update with stale epoch returns null', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Fenced Mutation Test' });
            await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-1' }); // epoch 2

            // Valid update with current epoch 2 -> SUCCESS
            const validUpdate = await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: 'worker-1',
                leaseEpoch: 2,
                actualState: 'ACTIVE',
            });
            assert.ok(validUpdate);
            assert.strictEqual(validUpdate.actualState, 'ACTIVE');

            // Stale update with epoch 1 -> REJECTED
            const staleUpdate = await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: 'worker-1',
                leaseEpoch: 1,
                actualState: 'FAILED',
            });
            assert.strictEqual(staleUpdate, null, 'Stale generation mutation must return null');

            // Verify state remained ACTIVE
            const inDb = await connRepo.findById(conn.id);
            assert.strictEqual(inDb.actualState, 'ACTIVE');
        });

        it('Section 5 Scenario: Worker A (epoch 7) -> Worker B acquires (epoch 8) -> Worker A rejected -> Worker B accepted', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Section 5 Fencing' });

            // Fast forward epoch to 7 via sequential acquisitions
            for (let i = 0; i < 5; i++) {
                const acq = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: `init-${i}` });
                await connRepo.releaseLease({ connectionId: conn.id, workerId: `init-${i}`, leaseEpoch: acq.leaseEpoch });
            }

            // Worker A acquires at epoch 7
            const acqA = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-a' });
            assert.strictEqual(acqA.leaseEpoch, 7);
            assert.strictEqual(acqA.assignedWorkerId, 'worker-a');

            // Worker A sets ACTIVE state at epoch 7
            const activeA = await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: 'worker-a',
                leaseEpoch: 7,
                actualState: 'ACTIVE',
            });
            assert.ok(activeA);
            assert.strictEqual(activeA.actualState, 'ACTIVE');

            // Force lease expiration for handoff simulation
            await pool.query(`UPDATE whatsapp_connections SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`, [conn.id]);

            // Worker B acquires connection at epoch 8
            const acqB = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-b' });
            assert.strictEqual(acqB.leaseEpoch, 8);
            assert.strictEqual(acqB.assignedWorkerId, 'worker-b');

            // Worker A (stale at epoch 7) attempts state mutation -> REJECTED (returns null)
            const staleMutation = await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: 'worker-a',
                leaseEpoch: 7,
                actualState: 'ACTIVE',
            });
            assert.strictEqual(staleMutation, null, 'Stale generation (epoch 7) mutation must return null');

            // Worker A attempts heartbeat renewal at epoch 7 -> REJECTED (returns false)
            const staleHeartbeat = await connRepo.renewLease({
                connectionId: conn.id,
                workerId: 'worker-a',
                leaseEpoch: 7,
            });
            assert.strictEqual(staleHeartbeat, false, 'Stale generation (epoch 7) heartbeat must return false');

            // Worker B (authoritative at epoch 8) attempts mutation -> ACCEPTED
            const validMutationB = await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: 'worker-b',
                leaseEpoch: 8,
                actualState: 'ACTIVE',
            });
            assert.ok(validMutationB, 'Current generation (epoch 8) mutation must succeed');
            assert.strictEqual(validMutationB.leaseEpoch, 8);
            assert.strictEqual(validMutationB.assignedWorkerId, 'worker-b');
        });

        it('Section 9 Scenario: Stale Worker Recovery / Handoff prevents stale worker from regaining authority', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Section 9 Recovery' });

            // 1. Worker A acquires lease
            const acqA = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-stale-a' });
            const initialEpoch = acqA.leaseEpoch;

            // 2. Worker A heartbeat expires, marked offline, lease expires
            await workerRepo.registerWorker({ id: 'worker-stale-a', hostname: 'host-a', capacity: 50 });
            await pool.query(`UPDATE workers SET last_heartbeat_at = NOW() - interval '15 seconds' WHERE id = 'worker-stale-a'`);
            await pool.query(`UPDATE whatsapp_connections SET lease_expires_at = NOW() - interval '5 seconds' WHERE id = $1`, [conn.id]);
            await workerRepo.markStaleWorkersOffline({ staleThresholdSeconds: 5 }); // Mark stale

            const workerAStatus = await workerRepo.findById('worker-stale-a');
            assert.strictEqual(workerAStatus.status, 'OFFLINE');

            // 3. Worker B acquires lease (increments epoch)
            const acqB = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'worker-b' });
            assert.strictEqual(acqB.leaseEpoch, initialEpoch + 1);
            assert.strictEqual(acqB.assignedWorkerId, 'worker-b');

            // 4. Worker A wakes up and attempts to renew or acquire
            const renewAttempt = await connRepo.renewLease({
                connectionId: conn.id,
                workerId: 'worker-stale-a',
                leaseEpoch: initialEpoch,
            });
            assert.strictEqual(renewAttempt, false, 'Stale worker cannot renew lease');

            const reacquireAttempt = await connRepo.acquireLease({
                connectionId: conn.id,
                tenantId: tenantA.id,
                workerId: 'worker-stale-a',
            });
            assert.strictEqual(reacquireAttempt, null, 'Stale worker cannot re-acquire active lease owned by Worker B');
        });
    });

    // =========================================================================
    // 3. Worker Lease Manager & Watchdog Failsafe
    // =========================================================================
    describe('3. Worker Lease Manager & Watchdog Failsafe', () => {
        it('should trip local watchdog and abort connection if heartbeat is not renewed', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Watchdog Test' });
            const acquired = await connRepo.acquireLease({ connectionId: conn.id, tenantId: tenantA.id, workerId: 'watchdog-worker' });

            let leaseLostFired = false;
            let leaseLostReason = null;

            const testLeaseManager = new WorkerLeaseManager({
                workerId: 'watchdog-worker',
                connRepo,
                connectionManager,
                auditLogRepo,
                watchdogTimeoutMs: 50, // Short watchdog for fast test
                heartbeatIntervalMs: 200, // Heartbeat slower than watchdog
            });

            const leaseLostPromise = new Promise((resolve) => {
                testLeaseManager.once('lease_lost', (ev) => {
                    resolve(ev);
                });
            });

            testLeaseManager.registerLease({
                connectionId: acquired.id,
                tenantId: acquired.tenantId,
                leaseEpoch: acquired.leaseEpoch,
            });

            assert.strictEqual(testLeaseManager.hasLease(conn.id), true);

            // Await watchdog tripping and event firing
            const lostEvent = await leaseLostPromise;

            assert.ok(lostEvent);
            assert.strictEqual(lostEvent.reason, 'LEASE_WATCHDOG_TRIPPED');
            assert.strictEqual(testLeaseManager.hasLease(conn.id), false);

            testLeaseManager.stop();
        });
    });

    // =========================================================================
    // 4. State Reconciliation & Missed Signal Recovery (Amendment 3 & 7)
    // =========================================================================
    describe('4. State Reconciliation & Missed Signal Recovery', () => {
        it('Worker reconciliation loop discovers RUNNING connection in DB even if NOTIFY was missed', async () => {
            const conn = await connRepo.createForTenant(tenantA.id, { displayName: 'Reconciliation Test' });
            // Set desired_state = RUNNING directly in DB (simulating missed wake-up signal)
            await connRepo.updateDesiredStateForTenant(conn.id, tenantA.id, 'RUNNING');

            const worker = new WorkerNode({
                workerId: 'recon-worker-1',
                connectionManager,
                connRepo,
                workerRepo,
                auditLogRepo,
                commandGateway,
                eventPublisher,
                qrStore,
                reconcileIntervalMs: 100,
            });

            assert.strictEqual(worker.leaseManager.hasLease(conn.id), false);

            // Run explicit reconciliation
            await worker.reconcile();

            // Verify worker discovered the connection and acquired the lease
            assert.strictEqual(worker.leaseManager.hasLease(conn.id), true);
            const inDb = await connRepo.findById(conn.id);
            assert.strictEqual(inDb.assignedWorkerId, 'recon-worker-1');
            assert.strictEqual(inDb.actualState, 'SOCKET_STARTING');

            await worker.shutdown();
        });
    });

    // =========================================================================
    // 5. REST Connection Lifecycle APIs & Tenant RBAC (Amendment 6, 10, 11)
    // =========================================================================
    describe('5. REST Connection Lifecycle APIs & Tenant RBAC', () => {
        let createdConnId;

        it('5.1 MEMBER role is rejected from creating a connection (403)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections`, {
                headers: { 'Authorization': `Bearer ${tokenMemberA}` },
                body: { displayName: 'Unauthorized Conn' },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'INSUFFICIENT_ROLE');
        });

        it('5.2 ADMIN role can create a connection (201 Created)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { displayName: 'Sales Line 1', phoneNumber: '+1234567890' },
            });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.connection.id);
            assert.strictEqual(res.body.data.connection.desired_state, 'STOPPED');
            assert.strictEqual(res.body.data.connection.actual_state, 'UNASSIGNED');
            createdConnId = res.body.data.connection.id;
        });

        it('5.3 MEMBER role can list connections (200 OK)', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections`, {
                headers: { 'Authorization': `Bearer ${tokenMemberA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(Array.isArray(res.body.data.connections));
            assert.ok(res.body.data.connections.some((c) => c.id === createdConnId));
        });

        it('5.4 ADMIN role can request connect (desired_state -> RUNNING)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections/${createdConnId}/connect`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.desired_state, 'RUNNING');

            const inDb = await connRepo.findById(createdConnId);
            assert.strictEqual(inDb.desiredState, 'RUNNING');
        });

        it('5.5 ADMIN role can request disconnect (desired_state -> STOPPED)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections/${createdConnId}/disconnect`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.desired_state, 'STOPPED');

            const inDb = await connRepo.findById(createdConnId);
            assert.strictEqual(inDb.desiredState, 'STOPPED');
        });

        it('5.6 Reconnect command preserves desired_state = RUNNING (Amendment 6)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections/${createdConnId}/reconnect`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.desired_state, 'RUNNING');
        });

        it('5.7 ADMIN role is rejected from deleting connection (403, requires OWNER)', async () => {
            const res = await request('DELETE', `/api/v1/tenants/${tenantA.id}/connections/${createdConnId}`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'INSUFFICIENT_ROLE');
        });

        it('5.8 OWNER role can delete connection (200 OK)', async () => {
            const res = await request('DELETE', `/api/v1/tenants/${tenantA.id}/connections/${createdConnId}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.success, true);
            assert.strictEqual(res.body.data.deletedConnectionId, createdConnId);

            const inDb = await connRepo.findById(createdConnId);
            assert.strictEqual(inDb, null);
        });

        it('5.9 DELETE connection permanently deletes auth credentials and keys while audit records survive', async () => {
            const deleteTarget = await connRepo.createForTenant(tenantA.id, { displayName: 'Cascade Target' });

            // Seed mock credentials and keys in DB
            await pool.query(
                `INSERT INTO whatsapp_auth_credentials (tenant_id, connection_id, credentials) VALUES ($1, $2, $3)`,
                [tenantA.id, deleteTarget.id, '{"creds":"secret"}']
            );
            await pool.query(
                `INSERT INTO whatsapp_auth_keys (tenant_id, connection_id, key_type, key_id, key_value) VALUES ($1, $2, $3, $4, $5)`,
                [tenantA.id, deleteTarget.id, 'pre-key', '1', '{"key":"secret"}']
            );

            // Owner deletes connection via REST
            const res = await request('DELETE', `/api/v1/tenants/${tenantA.id}/connections/${deleteTarget.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });
            assert.strictEqual(res.status, 200);

            // Verify connection is deleted
            const connInDb = await connRepo.findById(deleteTarget.id);
            assert.strictEqual(connInDb, null);

            // Verify Baileys credentials and keys were cascade-deleted
            const credsInDb = await pool.query(`SELECT * FROM whatsapp_auth_credentials WHERE connection_id = $1`, [deleteTarget.id]);
            assert.strictEqual(credsInDb.rows.length, 0, 'Auth credentials must be permanently deleted');

            const keysInDb = await pool.query(`SELECT * FROM whatsapp_auth_keys WHERE connection_id = $1`, [deleteTarget.id]);
            assert.strictEqual(keysInDb.rows.length, 0, 'Auth keys must be permanently deleted');

            // Verify audit trail survived
            const auditLogs = await auditLogRepo.listForTenant(tenantA.id, { limit: 10 });
            const deleteAudit = auditLogs.find((l) => l.action === 'CONNECTION_DELETED' && l.resource_id === deleteTarget.id);
            assert.ok(deleteAudit, 'Audit record for CONNECTION_DELETED must survive connection deletion');
        });
    });

    // =========================================================================
    // 6. Anti-Enumeration & Cross-Tenant Resource Isolation (Amendment 10)
    // =========================================================================
    describe('6. Anti-Enumeration & Cross-Tenant Resource Isolation', () => {
        let connB;

        before(async () => {
            connB = await connRepo.createForTenant(tenantB.id, { displayName: 'Tenant B Secret Conn' });
        });

        it('Tenant A member requesting Tenant B connection via Tenant A URL returns 404 RESOURCE_NOT_FOUND', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');
        });

        it('Tenant A member requesting Tenant B path directly returns 403 TENANT_ACCESS_DENIED', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantB.id}/connections/${connB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'TENANT_ACCESS_DENIED');
        });

        it('Cross-tenant probing logs UNAUTHORIZED_CONNECTION_ACCESS in audit_logs while returning 404', async () => {
            const probeConn = await connRepo.createForTenant(tenantB.id, { displayName: 'Tenant B Target' });

            // Tenant A owner requests Tenant B's connection via Tenant A URL
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${probeConn.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');

            // Verify audit log was recorded for security inspection
            const auditLogs = await auditLogRepo.listForTenant(tenantA.id, { limit: 10 });
            const probeLog = auditLogs.find((l) => l.action === 'UNAUTHORIZED_CONNECTION_ACCESS' && l.resource_id === probeConn.id);
            assert.ok(probeLog, 'UNAUTHORIZED_CONNECTION_ACCESS audit log must be recorded');
            assert.strictEqual(probeLog.actor_user_id, userOwnerA.id);
            assert.strictEqual(probeLog.metadata.actualTenantId, tenantB.id);
        });
    });

    // =========================================================================
    // 7. Ephemeral QR Code Security & Lifecycle (Amendment 2)
    // =========================================================================
    describe('7. Ephemeral QR Code Security & Lifecycle', () => {
        let testConn;

        before(async () => {
            testConn = await connRepo.createForTenant(tenantA.id, { displayName: 'QR Lifecycle Test' });
        });

        it('returns 404 QR_NOT_AVAILABLE when no QR is pending', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${testConn.id}/qr`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'QR_NOT_AVAILABLE');
        });

        it('returns active ephemeral QR payload and expiresAt timestamp when present', async () => {
            qrStore.set(tenantA.id, testConn.id, '2@testQrCodePayload==,12345', 60);

            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${testConn.id}/qr`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.qr, '2@testQrCodePayload==,12345');
            assert.ok(res.body.data.expiresAt);
        });

        it('cross-tenant QR request is blocked with 404 RESOURCE_NOT_FOUND', async () => {
            qrStore.set(tenantA.id, testConn.id, 'secret-qr', 60);

            // Tenant B owner attempts to fetch Tenant A connection QR via Tenant B path
            const res = await request('GET', `/api/v1/tenants/${tenantB.id}/connections/${testConn.id}/qr`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');
        });

        it('expired QR is automatically purged and returns 404 QR_NOT_AVAILABLE', async () => {
            // Set with 0s TTL (immediately expired)
            qrStore.set(tenantA.id, testConn.id, 'expired-qr', 0);

            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${testConn.id}/qr`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'QR_NOT_AVAILABLE');
        });

        it('Section 10 Scenario: QR generation fencing rejects stale generation QR after handoff', async () => {
            const qrConn = await connRepo.createForTenant(tenantA.id, { displayName: 'QR Fencing Conn' });

            // Acquire at epoch 2
            const acq1 = await connRepo.acquireLease({ connectionId: qrConn.id, tenantId: tenantA.id, workerId: 'worker-1' });
            assert.strictEqual(acq1.leaseEpoch, 2);

            // Store QR for epoch 2
            qrStore.set(tenantA.id, qrConn.id, 'qr-epoch-2-payload', 60, 2);

            // Valid fetch at epoch 2
            const qrEpoch2 = qrStore.get(tenantA.id, qrConn.id, 2);
            assert.ok(qrEpoch2);
            assert.strictEqual(qrEpoch2.qr, 'qr-epoch-2-payload');

            // Lease expires and Worker 2 acquires at epoch 3
            await pool.query(`UPDATE whatsapp_connections SET lease_expires_at = NOW() - interval '1 second' WHERE id = $1`, [qrConn.id]);
            const acq2 = await connRepo.acquireLease({ connectionId: qrConn.id, tenantId: tenantA.id, workerId: 'worker-2' });
            assert.strictEqual(acq2.leaseEpoch, 3);

            // Requesting QR at epoch 3 rejects the epoch 2 QR payload
            const qrEpoch3 = qrStore.get(tenantA.id, qrConn.id, 3);
            assert.strictEqual(qrEpoch3, null, 'QR from epoch 2 must not be exposed when current epoch is 3');

            // REST GET /qr at epoch 3 returns 404 QR_NOT_AVAILABLE
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${qrConn.id}/qr`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'QR_NOT_AVAILABLE');
        });
    });

    // =========================================================================
    // 8. Server-Sent Events (SSE) Realtime Stream & Tenant Isolation (Amendment 13, 14, 15)
    // =========================================================================
    describe('8. Server-Sent Events (SSE) Realtime Stream & Tenant Isolation', () => {
        it('streams events to authorized tenant clients and strictly excludes other tenants', async () => {
            const receivedEventsTenantA = [];
            const receivedEventsTenantB = [];

            let resolveConnA, resolveConnB;
            const connectedA = new Promise((resolve) => { resolveConnA = resolve; });
            const connectedB = new Promise((resolve) => { resolveConnB = resolve; });

            let resolveEventA;
            const eventPromiseA = new Promise((resolve) => { resolveEventA = resolve; });

            // Connect SSE client for Tenant A
            const reqA = http.request(new URL(`/api/v1/tenants/${tenantA.id}/events`, baseUrl), {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            }, (res) => {
                assert.strictEqual(res.statusCode, 200);
                assert.strictEqual(res.headers['content-type'], 'text/event-stream');
                res.on('data', (chunk) => {
                    const str = chunk.toString();
                    receivedEventsTenantA.push(str);
                    if (str.includes(':connected')) resolveConnA();
                    if (str.includes('connection.status.changed')) resolveEventA();
                });
            });
            reqA.end();

            // Connect SSE client for Tenant B
            const reqB = http.request(new URL(`/api/v1/tenants/${tenantB.id}/events`, baseUrl), {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
            }, (res) => {
                assert.strictEqual(res.statusCode, 200);
                res.on('data', (chunk) => {
                    const str = chunk.toString();
                    receivedEventsTenantB.push(str);
                    if (str.includes(':connected')) resolveConnB();
                });
            });
            reqB.end();

            // Await both clients fully connected
            await Promise.all([connectedA, connectedB]);

            // Publish an event for Tenant A
            await eventPublisher.publish({
                tenantId: tenantA.id,
                eventType: 'connection.status.changed',
                data: { connectionId: 'conn-a-1', actualState: 'ACTIVE', status: 'CONNECTED' },
            });

            // Await event delivery to Tenant A
            await eventPromiseA;
            await new Promise((resolve) => setTimeout(resolve, 50));

            // Assert Tenant A received the event
            const rawA = receivedEventsTenantA.join('');
            assert.ok(rawA.includes('connection.status.changed'), 'Tenant A must receive its own events');
            assert.ok(rawA.includes('conn-a-1'));

            // Assert Tenant B NEVER received Tenant A event
            const rawB = receivedEventsTenantB.join('');
            assert.strictEqual(rawB.includes('conn-a-1'), false, 'Tenant B must NEVER receive Tenant A events');

            // Clean up clients
            reqA.destroy();
            reqB.destroy();
        });

        it('rejects unauthenticated SSE connection with 401', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/events`);
            assert.strictEqual(res.status, 401);
        });

        it('rejects cross-tenant SSE connection with 403 TENANT_ACCESS_DENIED', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/events`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'TENANT_ACCESS_DENIED');
        });
    });
});
