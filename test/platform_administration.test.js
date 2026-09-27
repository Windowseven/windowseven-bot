const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pool } = require('pg');
const { migrateUp, migrateDown } = require('../src/database/migrator');
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
    RefreshTokenRepository,
    computePlatformRequestHash,
} = require('../src/repositories');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PasswordService = require('../src/application/services/PasswordService');
const PlatformService = require('../src/application/services/PlatformService');
const { createRestApp } = require('../src/application/http/RestApp');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const AntiLinkPolicy = require('../src/application/policies/AntiLinkPolicy');
const AntiBadwordPolicy = require('../src/application/policies/AntiBadwordPolicy');
const NormalizedMessage = require('../src/domain/models/NormalizedMessage');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_test';

/**
 * Helper to make HTTP requests against the in-process test server.
 */
function makeRequest(server, { method, path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const options = {
            hostname: '127.0.0.1',
            port: addr.port,
            path,
            method,
            headers: {
                ...headers,
            },
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

describe('Phase 4F — Platform Administration & Operations', () => {
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
    let groupRepo;
    let policyRepo;
    let tokenService;
    let authService;
    let passwordService;
    let commandGateway;
    let eventPublisher;
    let platformService;
    let server;

    let superAdminUser;
    let superAdminToken;
    let platformAdminUser;
    let platformAdminToken;
    let tenantOwnerUser;
    let tenantOwnerToken;
    let testTenant;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });

        // Ensure database is migrated through 008
        await migrateUp(pool);

        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        workerRepo = new WorkerRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        platformIdempotencyRepo = new PlatformIdempotencyRepository(pool);
        taskRepo = new ScheduledModerationTaskRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        const refreshTokenRepo = new RefreshTokenRepository(pool);

        tokenService = new TokenService();
        passwordService = new PasswordService();
        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            tokenService,
            passwordService,
            pool,
        });

        commandGateway = new ConnectionCommandGateway();
        eventPublisher = new LocalEventPublisher();

        platformService = new PlatformService({
            pool,
            tenantRepo,
            connRepo,
            workerRepo,
            platformAuditRepo,
            platformRoleRepo,
            taskRepo,
            groupRepo,
            commandGateway,
            eventPublisher,
        });

        // Initialize REST application with Platform routes
        const app = createRestApp({
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
            scheduledTaskRepo: taskRepo,
            groupRepo,
            commandGateway,
            eventPublisher,
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

        // Seed users & platform roles
        const runSuffix = `${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
        superAdminUser = await userRepo.create({ email: `superadmin_${runSuffix}@windowseven.test` });
        await platformRoleRepo.assignRole({ userId: superAdminUser.id, role: 'SUPER_ADMIN' });
        superAdminToken = tokenService.createAccessToken({
            userId: superAdminUser.id,
            email: superAdminUser.email,
        });

        platformAdminUser = await userRepo.create({ email: `platformadmin_${runSuffix}@windowseven.test` });
        await platformRoleRepo.assignRole({ userId: platformAdminUser.id, role: 'PLATFORM_ADMIN' });
        platformAdminToken = tokenService.createAccessToken({
            userId: platformAdminUser.id,
            email: platformAdminUser.email,
        });

        tenantOwnerUser = await userRepo.create({ email: `tenantowner_${runSuffix}@customer.test` });
        tenantOwnerToken = tokenService.createAccessToken({
            userId: tenantOwnerUser.id,
            email: tenantOwnerUser.email,
        });

        testTenant = await tenantRepo.create({ name: 'Acme SaaS Customer' });
        await membershipRepo.create({
            tenantId: testTenant.id,
            userId: tenantOwnerUser.id,
            role: 'OWNER',
        });
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        if (pool) {
            await pool.query('TRUNCATE TABLE platform_audit_logs, platform_idempotency_keys, platform_user_roles CASCADE;').catch(() => {});
            await pool.end();
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Platform Authorization & Sub-Millisecond Revocation
    // ─────────────────────────────────────────────────────────────────────────
    describe('Platform Authorization & RBAC', () => {
        it('should reject unauthenticated requests with 401 AUTH_REQUIRED', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/tenants',
            });
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('should reject tenant customer (non-platform user) with 403 PLATFORM_ACCESS_DENIED', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/tenants',
                headers: { Authorization: `Bearer ${tenantOwnerToken}` },
            });
            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.body.error.code, 'PLATFORM_ACCESS_DENIED');
        });

        it('should allow verified PLATFORM_ADMIN access to /api/v1/platform/tenants', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/tenants',
                headers: { Authorization: `Bearer ${platformAdminToken}` },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(Array.isArray(res.body.data.tenants));
        });

        it('should immediately reject revoked platform admin even with valid unexpired JWT', async () => {
            // Create a temp platform user
            const tempUser = await userRepo.create({ email: `temp_admin_${Date.now()}@windowseven.test` });
            await platformRoleRepo.assignRole({ userId: tempUser.id, role: 'PLATFORM_ADMIN' });
            const tempToken = tokenService.createAccessToken({
                userId: tempUser.id,
                email: tempUser.email,
            });

            // Verify access succeeds initially
            const res1 = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/tenants',
                headers: { Authorization: `Bearer ${tempToken}` },
            });
            assert.strictEqual(res1.statusCode, 200);

            // Revoke role synchronously from platform_user_roles in PostgreSQL
            await platformRoleRepo.revokeAllRoles(tempUser.id);

            // Subsequent request with the SAME unexpired token MUST immediately return 403
            const res2 = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/tenants',
                headers: { Authorization: `Bearer ${tempToken}` },
            });
            assert.strictEqual(res2.statusCode, 403);
            assert.strictEqual(res2.body.error.code, 'PLATFORM_ACCESS_DENIED');
        });

        it('should reject PLATFORM_ADMIN attempting tenant deactivation with 403 INSUFFICIENT_PLATFORM_ROLE', async () => {
            const rbacTenant = await tenantRepo.create({ name: 'RBAC Deactivate Test Tenant' });

            // PLATFORM_ADMIN attempts deactivation -> MUST return 403 INSUFFICIENT_PLATFORM_ROLE
            const denyRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${rbacTenant.id}/deactivate`,
                headers: { Authorization: `Bearer ${platformAdminToken}` },
                body: { reason: 'Unauthorized deactivation attempt' },
            });
            assert.strictEqual(denyRes.statusCode, 403);
            assert.strictEqual(denyRes.body.error.code, 'INSUFFICIENT_PLATFORM_ROLE');

            // Tenant must remain ACTIVE in database
            const unchanged = await tenantRepo.findById(rbacTenant.id);
            assert.strictEqual(unchanged.status, 'ACTIVE');

            // SUPER_ADMIN attempts deactivation -> MUST succeed
            const allowRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${rbacTenant.id}/deactivate`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Authorized super admin deactivation' },
            });
            assert.strictEqual(allowRes.statusCode, 200);
            assert.strictEqual(allowRes.body.data.status, 'DEACTIVATED');

            const deactivated = await tenantRepo.findById(rbacTenant.id);
            assert.strictEqual(deactivated.status, 'DEACTIVATED');
        });

        it('should reject PLATFORM_ADMIN attempting worker drain with 403 INSUFFICIENT_PLATFORM_ROLE', async () => {
            const rbacWorker = await workerRepo.registerWorker({
                id: `worker-rbac-drain-${Date.now()}`,
                hostname: 'worker-rbac.internal',
                capacity: 25,
                status: 'READY',
            });

            // PLATFORM_ADMIN attempts worker drain -> MUST return 403 INSUFFICIENT_PLATFORM_ROLE
            const denyRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/workers/${rbacWorker.id}/drain`,
                headers: { Authorization: `Bearer ${platformAdminToken}` },
                body: { graceMs: 5000, reason: 'Unauthorized drain attempt', confirm: true },
            });
            assert.strictEqual(denyRes.statusCode, 403);
            assert.strictEqual(denyRes.body.error.code, 'INSUFFICIENT_PLATFORM_ROLE');

            // Worker must remain READY in database
            const unchanged = await workerRepo.findById(rbacWorker.id);
            assert.strictEqual(unchanged.status, 'READY');

            // SUPER_ADMIN attempts worker drain -> MUST succeed
            const allowRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/workers/${rbacWorker.id}/drain`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { graceMs: 5000, reason: 'Authorized super admin drain', confirm: true },
            });
            assert.strictEqual(allowRes.statusCode, 200);
            assert.strictEqual(allowRes.body.data.status, 'DRAINING');
            assert.strictEqual(allowRes.body.data.workerId, rbacWorker.id);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Platform Idempotency
    // ─────────────────────────────────────────────────────────────────────────
    describe('Platform Idempotency', () => {
        it('should support replay with X-Cache: IDEMPOTENT-REPLAY for identical request', async () => {
            const tenant = await tenantRepo.create({ name: 'Idempotent Tenant Test' });
            const key = `plat-idem-${Date.now()}`;

            // First request
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${tenant.id}/suspend`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { reason: 'Billing review required' },
            });
            assert.strictEqual(res1.statusCode, 200);
            assert.strictEqual(res1.body.data.status, 'SUSPENDED');

            // Replay with identical payload and key
            const res2 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${tenant.id}/suspend`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { reason: 'Billing review required' },
            });
            assert.strictEqual(res2.statusCode, 200);
            assert.strictEqual(res2.headers['x-cache'], 'IDEMPOTENT-REPLAY');
            assert.strictEqual(res2.body.data.status, 'SUSPENDED');
        });

        it('should reject replay with different payload as 422 IDEMPOTENCY_KEY_MISMATCH', async () => {
            const tenant = await tenantRepo.create({ name: 'Idempotent Mismatch Test' });
            const key = `plat-mismatch-${Date.now()}`;

            // First request
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${tenant.id}/suspend`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { reason: 'First reason' },
            });
            assert.strictEqual(res1.statusCode, 200);

            // Replay with DIFFERENT payload
            const res2 = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${tenant.id}/suspend`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { reason: 'Completely different reason payload' },
            });
            assert.strictEqual(res2.statusCode, 422);
            assert.strictEqual(res2.body.error.code, 'IDEMPOTENCY_KEY_MISMATCH');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Tenant Lifecycle & Suspension Matrix (Option B Pause / Resume)
    // ─────────────────────────────────────────────────────────────────────────
    describe('Tenant Lifecycle & Suspension Matrix', () => {
        let lifecycleTenant;
        let lifecycleOwner;
        let lifecycleToken;
        let conn;

        before(async () => {
            lifecycleTenant = await tenantRepo.create({ name: 'Matrix Lifecycle Tenant' });
            lifecycleOwner = await userRepo.create({ email: `lifecycle_owner_${Date.now()}@customer.test` });
            await membershipRepo.create({
                tenantId: lifecycleTenant.id,
                userId: lifecycleOwner.id,
                role: 'OWNER',
            });
            lifecycleToken = tokenService.createAccessToken({
                userId: lifecycleOwner.id,
                email: lifecycleOwner.email,
            });
        });

        it('should allow mutations while tenant is ACTIVE', async () => {
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${lifecycleTenant.id}/connections`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
                body: { displayName: 'Second Connection' },
            });
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.success, true);
            conn = res.body.data.connection || res.body.connection;

            // Create group and insert a PENDING scheduled task
            const grp = await groupRepo.upsertDiscoveredGroup(lifecycleTenant.id, conn.id, {
                whatsappJid: '12036301@g.us',
                name: 'Test Group',
            });

            await pool.query(`
                INSERT INTO scheduled_moderation_tasks (
                    tenant_id, connection_id, group_id, action, run_at, status
                ) VALUES ($1, $2, $3, 'UNMUTE_GROUP', NOW() + INTERVAL '1 hour', 'PENDING');
            `, [lifecycleTenant.id, conn.id, grp.id]);
        });

        it('should suspend tenant, apply Option B (pause tasks), and deny tenant mutations with 403 TENANT_SUSPENDED', async () => {
            // Platform Admin suspends tenant
            const suspendRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${lifecycleTenant.id}/suspend`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Terms of service investigation' },
            });
            assert.strictEqual(suspendRes.statusCode, 200);
            assert.strictEqual(suspendRes.body.data.status, 'SUSPENDED');

            // Option B verification: check scheduled tasks are now PAUSED
            const { rows: taskRows } = await pool.query(`
                SELECT status FROM scheduled_moderation_tasks WHERE tenant_id = $1;
            `, [lifecycleTenant.id]);
            assert.ok(taskRows.length > 0);
            assert.ok(taskRows.every((t) => t.status === 'PAUSED'), 'All pending tasks must be PAUSED');

            // Matrix Cell: REST Reads allowed
            const readRes = await makeRequest(server, {
                method: 'GET',
                path: `/api/v1/tenants/${lifecycleTenant.id}`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
            });
            assert.strictEqual(readRes.statusCode, 200);

            // Matrix Cell: REST Mutations denied with 403 TENANT_SUSPENDED
            const mutateRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${lifecycleTenant.id}/connections`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
                body: { displayName: 'Should Be Blocked' },
            });
            assert.strictEqual(mutateRes.statusCode, 403);
            assert.strictEqual(mutateRes.body.error.code, 'TENANT_SUSPENDED');
        });

        it('should reactivate tenant, apply Option B (resume tasks), and re-enable mutations', async () => {
            // Platform Admin reactivates tenant
            const reactivateRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${lifecycleTenant.id}/reactivate`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Investigation completed and cleared' },
            });
            assert.strictEqual(reactivateRes.statusCode, 200);
            assert.strictEqual(reactivateRes.body.data.status, 'ACTIVE');

            // Option B verification: check scheduled tasks resumed to PENDING
            const { rows: taskRows } = await pool.query(`
                SELECT status FROM scheduled_moderation_tasks WHERE tenant_id = $1;
            `, [lifecycleTenant.id]);
            assert.ok(taskRows.length > 0);
            assert.ok(taskRows.every((t) => t.status === 'PENDING'), 'All paused tasks must be resumed to PENDING');

            // Clean up previous connection so tenant can create a new one under unique constraint
            await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1', [lifecycleTenant.id]);

            // Mutations now allowed again
            const mutateRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${lifecycleTenant.id}/connections`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
                body: { displayName: 'Third Connection Resumed' },
            });
            assert.strictEqual(mutateRes.statusCode, 201);
        });

        it('should deactivate tenant and deny both reads and mutations with 403 TENANT_DEACTIVATED', async () => {
            // Platform Admin deactivates tenant
            const deactRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tenants/${lifecycleTenant.id}/deactivate`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Customer requested account termination' },
            });
            assert.strictEqual(deactRes.statusCode, 200);
            assert.strictEqual(deactRes.body.data.status, 'DEACTIVATED');

            // Reads denied
            const readRes = await makeRequest(server, {
                method: 'GET',
                path: `/api/v1/tenants/${lifecycleTenant.id}`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
            });
            assert.strictEqual(readRes.statusCode, 403);
            assert.strictEqual(readRes.body.error.code, 'TENANT_DEACTIVATED');

            // Mutations denied
            const mutateRes = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/tenants/${lifecycleTenant.id}/connections`,
                headers: { Authorization: `Bearer ${lifecycleToken}` },
                body: { displayName: 'Never Created' },
            });
            assert.strictEqual(mutateRes.statusCode, 403);
            assert.strictEqual(mutateRes.body.error.code, 'TENANT_DEACTIVATED');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Force Disconnect & Reconnect State Machine (Barrier Verification)
    // ─────────────────────────────────────────────────────────────────────────
    describe('Force Disconnect & Reconnect Protocol', () => {
        let conn;

        before(async () => {
            conn = await connRepo.createForTenant(testTenant.id, {
                displayName: 'Fenced Connection',
                status: 'CONNECTED',
                desiredState: 'RUNNING',
                actualState: 'ACTIVE',
            });
            // Assign to fake worker
            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = 'worker-test-alpha',
                    lease_epoch = 1,
                    lease_expires_at = NOW() + INTERVAL '30 seconds'
                WHERE id = $1;
            `, [conn.id]);
        });

        it('should transition connection to SOCKET_STOPPING under force disconnect', async () => {
            let gatewayCommand = null;
            commandGateway.onCommand((cmd) => {
                if (cmd.connectionId === conn.id) {
                    gatewayCommand = cmd;
                }
            });

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/connections/${conn.id}/disconnect`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Cluster emergency mitigation', confirm: true },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.actualState, 'SOCKET_STOPPING');
            assert.strictEqual(res.body.data.desiredState, 'STOPPED');

            // Verify database row
            const dbRow = await connRepo.findById(conn.id);
            assert.strictEqual(dbRow.actualState, 'SOCKET_STOPPING');
            assert.strictEqual(dbRow.desiredState, 'STOPPED');

            // Verify gateway signal was dispatched
            assert.ok(gatewayCommand);
            assert.strictEqual(gatewayCommand.command, 'STOP_CONNECTION');

            // Barrier verification: successor worker calling findReconciliationCandidates MUST NOT find this connection
            const candidates = await connRepo.findReconciliationCandidates({
                workerId: 'worker-successor',
                limit: 10,
            });
            const foundInCandidates = candidates.some((c) => c.id === conn.id);
            assert.strictEqual(foundInCandidates, false, 'SOCKET_STOPPING connection must be excluded from reconciliation');
        });

        it('should return 409 conflict when force disconnect is attempted while already in SOCKET_STOPPING', async () => {
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/connections/${conn.id}/disconnect`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Duplicate disconnect attempt' },
            });
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.body.error.code, 'OPERATION_ALREADY_IN_PROGRESS');
        });

        it('should preserve SOCKET_STOPPING barrier when reconnect is requested during teardown', async () => {
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/connections/${conn.id}/reconnect`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Reconnection requested by operator' },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.desiredState, 'RUNNING');
            assert.strictEqual(res.body.data.actualState, 'SOCKET_STOPPING');

            // Database row must have desired_state = RUNNING, but actual_state still SOCKET_STOPPING
            const dbRow = await connRepo.findById(conn.id);
            assert.strictEqual(dbRow.desiredState, 'RUNNING');
            assert.strictEqual(dbRow.actualState, 'SOCKET_STOPPING');

            // Successor workers still cannot acquire while actual_state = SOCKET_STOPPING
            const candidates = await connRepo.findReconciliationCandidates({
                workerId: 'worker-successor',
                limit: 10,
            });
            const found = candidates.some((c) => c.id === conn.id);
            assert.strictEqual(found, false, 'Teardown barrier must prevent reacquisition until clean release');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Worker Drain Protocol
    // ─────────────────────────────────────────────────────────────────────────
    describe('Worker Cluster Management & Drain', () => {
        let testWorker;

        before(async () => {
            testWorker = await workerRepo.registerWorker({
                id: 'worker-drain-target-1',
                hostname: 'worker-host-1',
                capacity: 50,
                status: 'READY',
            });
        });

        it('should list registered workers at GET /api/v1/platform/workers', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/workers',
                headers: { Authorization: `Bearer ${platformAdminToken}` },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.data.workers));
            assert.ok(res.body.data.workers.some((w) => w.id === testWorker.id));
        });

        it('should dispatch DRAIN_WORKER command and audit drain request', async () => {
            let receivedCommand = null;
            commandGateway.onCommand((cmd) => {
                if (cmd.workerId === testWorker.id) {
                    receivedCommand = cmd;
                }
            });

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/workers/${testWorker.id}/drain`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { graceMs: 5000, reason: 'Host maintenance update', confirm: true },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, 'DRAINING');
            assert.strictEqual(res.body.data.workerId, testWorker.id);

            // Verify gateway command received
            assert.ok(receivedCommand);
            assert.strictEqual(receivedCommand.command, 'DRAIN_WORKER');
            assert.strictEqual(receivedCommand.graceMs, 5000);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Platform Audit Immutability & Retention
    // ─────────────────────────────────────────────────────────────────────────
    describe('Platform Audit Immutability', () => {
        let auditEntry;

        before(async () => {
            auditEntry = await platformAuditRepo.record({
                actorUserId: superAdminUser.id,
                actorRole: 'SUPER_ADMIN',
                action: 'TEST_AUDIT_ACTION',
                targetType: 'Tenant',
                targetId: testTenant.id,
                reason: 'Immutability test record',
            });
        });

        it('should query platform audit logs via GET /api/v1/platform/audit', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: `/api/v1/platform/audit?action=TEST_AUDIT_ACTION`,
                headers: { Authorization: `Bearer ${platformAdminToken}` },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(res.body.data.auditLogs.length > 0);
            assert.strictEqual(res.body.data.auditLogs[0].action, 'TEST_AUDIT_ACTION');
        });

        it('should strictly reject UPDATE on platform_audit_logs via trigger', async () => {
            await assert.rejects(
                async () => {
                    await pool.query(`
                        UPDATE platform_audit_logs
                        SET reason = 'Tampered Reason'
                        WHERE id = $1;
                    `, [auditEntry.id]);
                },
                (err) => {
                    return err.message.includes('platform_audit_logs entries are strictly immutable');
                },
                'Database trigger must reject UPDATE on platform_audit_logs'
            );
        });

        it('should strictly reject DELETE on platform_audit_logs via trigger', async () => {
            await assert.rejects(
                async () => {
                    await pool.query(`
                        DELETE FROM platform_audit_logs
                        WHERE id = $1;
                    `, [auditEntry.id]);
                },
                (err) => {
                    return err.message.includes('platform_audit_logs entries are strictly immutable');
                },
                'Database trigger must reject DELETE on platform_audit_logs'
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Policy Exemption Decoupling
    // ─────────────────────────────────────────────────────────────────────────
    describe('Decoupling WhatsApp Admin Privileges from Policy Exemption', () => {
        const antiLinkPolicy = new AntiLinkPolicy();
        const antiBadwordPolicy = new AntiBadwordPolicy();

        it('should exempt admin by default when exempt_admins is true or omitted', () => {
            const message = new NormalizedMessage({
                id: 'msg-1',
                senderJid: 'admin@s.whatsapp.net',
                groupJid: '12036301@g.us',
                text: 'Check this link: https://evil.com',
                timestamp: Date.now(),
            });

            // Default policy (exempt_admins omitted)
            const policyDefault = {
                antilink_enabled: true,
                antilink_action: 'delete',
                settings: {},
            };
            const decision1 = antiLinkPolicy.evaluate({
                message,
                groupPolicy: policyDefault,
                actor: { isSenderAdmin: true },
            });
            assert.strictEqual(decision1.action, 'ALLOW');

            // Explicit exempt_admins: true
            const policyExemptTrue = {
                antilink_enabled: true,
                antilink_action: 'delete',
                settings: { exempt_admins: true },
            };
            const decision2 = antiLinkPolicy.evaluate({
                message,
                groupPolicy: policyExemptTrue,
                actor: { isSenderAdmin: true },
            });
            assert.strictEqual(decision2.action, 'ALLOW');
        });

        it('should penalize admin when exempt_admins is explicitly configured as false', () => {
            const message = new NormalizedMessage({
                id: 'msg-2',
                senderJid: 'admin@s.whatsapp.net',
                groupJid: '12036301@g.us',
                text: 'Check this link: https://prohibited.com',
                timestamp: Date.now(),
            });

            const policyStrict = {
                antilink_enabled: true,
                antilink_action: 'delete',
                settings: { exempt_admins: false },
            };

            const decision = antiLinkPolicy.evaluate({
                message,
                groupPolicy: policyStrict,
                actor: { isSenderAdmin: true },
            });

            assert.strictEqual(decision.action, 'DELETE', 'Admin should not be exempt when exempt_admins: false');
            assert.strictEqual(decision.policyName, 'AntiLinkPolicy');
        });

        it('should penalize admin for bad words when exempt_admins is explicitly configured as false', () => {
            const message = new NormalizedMessage({
                id: 'msg-3',
                senderJid: 'admin@s.whatsapp.net',
                groupJid: '12036301@g.us',
                text: 'You are an idiot and a fool',
                timestamp: Date.now(),
            });

            const policyStrict = {
                antibadword_enabled: true,
                antibadword_action: 'warn',
                settings: { exempt_admins: false },
            };

            const decision = antiBadwordPolicy.evaluate({
                message,
                groupPolicy: policyStrict,
                actor: { isSenderAdmin: true },
            });

            assert.strictEqual(decision.action, 'WARN', 'Admin should not be exempt from badwords when exempt_admins: false');
            assert.strictEqual(decision.policyName, 'AntiBadwordPolicy');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Platform Cluster Health & Events
    // ─────────────────────────────────────────────────────────────────────────
    describe('Platform Cluster Observability', () => {
        it('should return cluster health summary at GET /api/v1/platform/health', async () => {
            const res = await makeRequest(server, {
                method: 'GET',
                path: '/api/v1/platform/health',
                headers: { Authorization: `Bearer ${platformAdminToken}` },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, 'OK');
            assert.ok(res.body.data.workers);
            assert.ok(Array.isArray(res.body.data.connections));
            assert.ok(Array.isArray(res.body.data.tenants));
        });

        it('should connect to SSE stream and receive cluster events at GET /api/v1/platform/events', async () => {
            const addr = server.address();
            const receivedChunks = [];

            const req = http.request({
                hostname: '127.0.0.1',
                port: addr.port,
                path: '/api/v1/platform/events',
                method: 'GET',
                headers: { Authorization: `Bearer ${superAdminToken}` },
            });

            const streamPromise = new Promise((resolve, reject) => {
                req.on('response', (res) => {
                    assert.strictEqual(res.statusCode, 200);
                    assert.strictEqual(res.headers['content-type'], 'text/event-stream');

                    res.on('data', (chunk) => {
                        receivedChunks.push(chunk.toString());
                        if (receivedChunks.join('').includes('test.cluster.event')) {
                            req.destroy();
                            resolve();
                        }
                    });
                });
                req.on('error', (err) => {
                    if (err.code !== 'ECONNRESET') reject(err);
                    else resolve();
                });
            });

            req.end();

            // Wait a tick then publish test event
            await new Promise((r) => setTimeout(r, 50));
            await eventPublisher.publish({
                tenantId: 'platform',
                eventType: 'test.cluster.event',
                data: { clusterMetric: 42 },
            });

            await streamPromise;
            const fullOutput = receivedChunks.join('');
            assert.ok(fullOutput.includes(': connected'), 'SSE stream must start with connected preamble');
            assert.ok(fullOutput.includes('test.cluster.event'), 'SSE stream must deliver published event');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Offline Admin Provisioning CLI
    // ─────────────────────────────────────────────────────────────────────────
    describe('Platform Admin Provisioning CLI', () => {
        it('should execute scripts/create_platform_admin.js to provision platform user', async () => {
            const { spawnSync } = require('node:child_process');
            const cliEmail = `cli_superadmin_${Date.now()}@windowseven.test`;
            const cliPass = 'Str0ngP@ssw0rd!1234';

            const result = spawnSync('node', [
                'scripts/create_platform_admin.js',
                '--email', cliEmail,
                '--role', 'SUPER_ADMIN',
                '--password', cliPass,
            ], {
                env: { ...process.env, TEST_DATABASE_URL: TEST_DB_URL, DATABASE_URL: TEST_DB_URL },
                encoding: 'utf8',
            });

            assert.strictEqual(result.status, 0, `CLI failed: ${result.stderr}`);
            assert.ok(result.stdout.includes('Successfully assigned role SUPER_ADMIN'));

            // Verify in DB
            const user = await userRepo.findByEmail(cliEmail);
            assert.ok(user);
            const hasRole = await platformRoleRepo.hasRole(user.id, 'SUPER_ADMIN');
            assert.strictEqual(hasRole, true);
        });
    });
});
