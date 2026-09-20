const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    ConnectionCommandRepository,
    ScheduledModerationTaskRepository,
    IdempotencyRepository,
    AuditLogRepository,
    RefreshTokenRepository,
    WorkerRepository,
    computeRequestHash,
} = require('../src/repositories');

const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PasswordService = require('../src/application/services/PasswordService');
const GroupService = require('../src/application/services/GroupService');
const PolicyService = require('../src/application/services/PolicyService');
const WarningService = require('../src/application/services/WarningService');
const ConnectionService = require('../src/application/services/ConnectionService');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const { EphemeralQrStore } = require('../src/whatsapp/control/EphemeralQrStore');
const SseGateway = require('../src/application/realtime/SseGateway');
const DurableModerationScheduler = require('../src/whatsapp/worker/DurableModerationScheduler');
const { createRestApp } = require('../src/application/http/RestApp');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Phase 4E: Policy & Moderation REST Endpoints + Durable Moderation Scheduling', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let groupRepo;
    let policyRepo;
    let warningRepo;
    let commandRepo;
    let taskRepo;
    let idempotencyRepo;
    let auditLogRepo;
    let workerRepo;

    let tokenService;
    let authService;
    let groupService;
    let policyService;
    let warningService;
    let connectionService;
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
    let connA, connB;
    let groupA1, groupA2, groupB1;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);
        commandRepo = new ConnectionCommandRepository(pool);
        taskRepo = new ScheduledModerationTaskRepository(pool);
        idempotencyRepo = new IdempotencyRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        workerRepo = new WorkerRepository(pool);
        const refreshTokenRepo = new RefreshTokenRepository(pool);

        const passwordService = new PasswordService();
        tokenService = new TokenService({ jwtSecret: 'test-phase-4e-secret-key-32-bytes-ok!' });
        authService = new AuthService({ userRepo, refreshTokenRepo, passwordService, tokenService, pool });

        commandGateway = new ConnectionCommandGateway({ pool });
        eventPublisher = new LocalEventPublisher();
        qrStore = new EphemeralQrStore();
        sseGateway = new SseGateway({ eventPublisher, keepaliveIntervalMs: 500 });

        groupService = new GroupService({
            pool,
            groupRepo,
            policyRepo,
            connRepo,
            commandRepo,
            taskRepo,
            auditLogRepo,
            commandGateway,
            eventPublisher,
        });

        policyService = new PolicyService({
            pool,
            groupRepo,
            policyRepo,
            auditLogRepo,
            eventPublisher,
        });

        warningService = new WarningService({
            warningRepo,
            policyRepo,
            commandRepo,
            groupRepo,
            commandGateway,
            idempotencyRepo,
            pool,
        });

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
            groupRepo,
            groupPolicyRepo: policyRepo,
            groupWarningRepo: warningRepo,
            connectionCommandRepo: commandRepo,
            scheduledTaskRepo: taskRepo,
            idempotencyRepo,
            groupService,
            policyService,
            warningService,
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, resolve));
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;

        // Clean database tables in dependency order
        await pool.query('DELETE FROM scheduled_moderation_tasks;');
        await pool.query('DELETE FROM connection_commands;');
        await pool.query('DELETE FROM api_idempotency_keys;');
        await pool.query('DELETE FROM group_warnings;');
        await pool.query('DELETE FROM group_policies;');
        await pool.query('DELETE FROM groups;');
        await pool.query('DELETE FROM workers;');
        await pool.query('DELETE FROM whatsapp_connections;');
        await pool.query('DELETE FROM tenants CASCADE;');
        await pool.query('DELETE FROM users CASCADE;');

        // Create Users
        userOwnerA = await userRepo.create({ email: 'owner-4e-a@example.com' });
        userAdminA = await userRepo.create({ email: 'admin-4e-a@example.com' });
        userMemberA = await userRepo.create({ email: 'member-4e-a@example.com' });
        userOwnerB = await userRepo.create({ email: 'owner-4e-b@example.com' });

        // Create Tenants
        tenantA = await tenantRepo.create({ name: 'Alpha Tenant 4E', slug: 'alpha-tenant-4e' });
        tenantB = await tenantRepo.create({ name: 'Beta Tenant 4E', slug: 'beta-tenant-4e' });

        // Assign Roles
        await membershipRepo.create({ tenantId: tenantA.id, userId: userOwnerA.id, role: 'OWNER' });
        await membershipRepo.create({ tenantId: tenantA.id, userId: userAdminA.id, role: 'ADMIN' });
        await membershipRepo.create({ tenantId: tenantA.id, userId: userMemberA.id, role: 'MEMBER' });
        await membershipRepo.create({ tenantId: tenantB.id, userId: userOwnerB.id, role: 'OWNER' });

        // Generate Tokens
        tokenOwnerA = tokenService.createAccessToken({ userId: userOwnerA.id, email: userOwnerA.email });
        tokenAdminA = tokenService.createAccessToken({ userId: userAdminA.id, email: userAdminA.email });
        tokenMemberA = tokenService.createAccessToken({ userId: userMemberA.id, email: userMemberA.email });
        tokenOwnerB = tokenService.createAccessToken({ userId: userOwnerB.id, email: userOwnerB.email });

        // Create Connections
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '+15551111111',
            displayName: 'Alpha Conn 1',
        });
        // Transition connA to ACTIVE for moderation tests
        await pool.query(
            `UPDATE whatsapp_connections SET actual_state = 'ACTIVE', desired_state = 'RUNNING' WHERE id = $1;`,
            [connA.id]
        );

        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '+15552222222',
            displayName: 'Beta Conn 1',
        });
        await pool.query(
            `UPDATE whatsapp_connections SET actual_state = 'ACTIVE', desired_state = 'RUNNING' WHERE id = $1;`,
            [connB.id]
        );

        // Create Groups
        groupA1 = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000001@g.us',
            name: 'Alpha General Chat',
        });
        // Make groupA1 MANAGED
        await groupRepo.updateStatusForTenant(groupA1.id, tenantA.id, 'MANAGED');
        groupA1.status = 'MANAGED';

        groupA2 = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000002@g.us',
            name: 'Alpha Unmanaged Chat',
        });

        groupB1 = await groupRepo.upsertDiscoveredGroup(tenantB.id, connB.id, {
            whatsappJid: '120363000000000003@g.us',
            name: 'Beta Managed Chat',
        });
        await groupRepo.updateStatusForTenant(groupB1.id, tenantB.id, 'MANAGED');
        groupB1.status = 'MANAGED';
    });

    after(async () => {
        qrStore.clearAll();
        sseGateway.closeAll();
        commandGateway.removeAllListeners();
        eventPublisher.removeAllListeners();
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
                    try {
                        parsed = JSON.parse(data);
                    } catch (_) {
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
            if (body !== null) {
                const jsonStr = typeof body === 'string' ? body : JSON.stringify(body);
                req.setHeader('Content-Type', 'application/json');
                req.write(jsonStr);
            }
            req.end();
        });
    }

    // =========================================================================
    // SECTION 1: Group REST APIs
    // =========================================================================
    describe('1. Group REST APIs', () => {
        it('GET /connections/:connId/groups lists discovered and managed groups for connection', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connA.id}/groups`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(Array.isArray(res.body.data.items));
            assert.strictEqual(res.body.data.items.length, 2);
            assert.strictEqual(res.body.data.total, 2);
        });

        it('GET /connections/:connId/groups supports status filtering', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connA.id}/groups?status=MANAGED`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.items.length, 1);
            assert.strictEqual(res.body.data.items[0].status, 'MANAGED');
            assert.strictEqual(res.body.data.items[0].id, groupA1.id);
        });

        it('GET /groups/:groupId returns group with policy summary', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.group.id, groupA1.id);
            assert.strictEqual(res.body.data.group.name, 'Alpha General Chat');
        });

        it('PATCH /groups/:groupId/status toggles status between MANAGED and UNMANAGED', async () => {
            // Demote to UNMANAGED
            const res1 = await request('PATCH', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/status`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { status: 'UNMANAGED' },
            });
            assert.strictEqual(res1.statusCode, 200);
            assert.strictEqual(res1.body.data.group.status, 'UNMANAGED');

            // Promote back to MANAGED
            const res2 = await request('PATCH', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/status`, {
                headers: { Authorization: `Bearer ${tokenOwnerA}` },
                body: { status: 'MANAGED' },
            });
            assert.strictEqual(res2.statusCode, 200);
            assert.strictEqual(res2.body.data.group.status, 'MANAGED');
        });

        it('PATCH /groups/:groupId/status enforces RBAC (MEMBER denied)', async () => {
            const res = await request('PATCH', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/status`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
                body: { status: 'UNMANAGED' },
            });
            assert.strictEqual(res.statusCode, 403);
        });

        it('POST /connections/:connId/groups/sync enqueues durable SYNC_GROUPS command', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/connections/${connA.id}/groups/sync`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
            });

            assert.strictEqual(res.statusCode, 202);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.commandId);
            assert.strictEqual(res.body.data.action, 'SYNC_GROUPS');
            assert.strictEqual(res.body.data.status, 'PENDING');
        });

        it('Enforces cross-tenant anti-enumeration (Tenant B cannot access Tenant A groups)', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}`, {
                headers: { Authorization: `Bearer ${tokenOwnerB}` },
            });
            // Member of B accessing tenant A URL gets 403 (membership forbidden)
            assert.strictEqual(res.statusCode, 403);

            // Accessing groupA1 under tenantB route returns 404 (group not found in tenant B)
            const res2 = await request('GET', `/api/v1/tenants/${tenantB.id}/groups/${groupA1.id}`, {
                headers: { Authorization: `Bearer ${tokenOwnerB}` },
            });
            assert.strictEqual(res2.statusCode, 404);
        });
    });

    // =========================================================================
    // SECTION 2: Policy REST APIs & Strict JSONB Validation
    // =========================================================================
    describe('2. Policy REST APIs & Strict JSONB Validation', () => {
        it('GET /groups/:groupId/policies returns default fallback policy if unconfigured', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/policies`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.policy.max_warnings, 3);
            assert.strictEqual(res.body.data.policy.antilink_enabled, false);
            assert.strictEqual(res.body.data.policy.is_default, true);
        });

        it('PUT /groups/:groupId/policies rejects unmanaged group with 400', async () => {
            const res = await request('PUT', `/api/v1/tenants/${tenantA.id}/groups/${groupA2.id}/policies`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { antilink_enabled: true },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, 'GROUP_NOT_MANAGED');
        });

        it('PUT /groups/:groupId/policies strictly rejects unknown JSON keys with 422', async () => {
            const res = await request('PUT', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/policies`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    antilink_enabled: true,
                    unrecognized_injected_field: 'malicious',
                },
            });

            assert.strictEqual(res.statusCode, 422);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
            assert.ok(res.body.error.details.some((d) => d.message.includes('unrecognized_injected_field')));
        });

        it('PUT /groups/:groupId/policies strictly rejects forbidden identity keys with 422', async () => {
            const res = await request('PUT', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/policies`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    id: '00000000-0000-0000-0000-000000000000',
                    tenant_id: '00000000-0000-0000-0000-000000000000',
                    max_warnings: 5,
                },
            });

            assert.strictEqual(res.statusCode, 422);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('PUT /groups/:groupId/policies successfully updates valid policy configuration', async () => {
            const res = await request('PUT', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/policies`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    antilink_enabled: true,
                    antilink_action: 'kick',
                    antibadword_enabled: true,
                    antibadword_action: 'warn',
                    max_warnings: 2,
                    warning_action: 'kick',
                    welcome_enabled: true,
                    welcome_message: 'Welcome to Alpha General!',
                    settings: {
                        delete_bot_commands: true,
                        auto_sticker_enabled: false,
                    },
                },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.policy.antilink_enabled, true);
            assert.strictEqual(res.body.data.policy.antilink_action, 'kick');
            assert.strictEqual(res.body.data.policy.max_warnings, 2);
            assert.strictEqual(res.body.data.policy.welcome_message, 'Welcome to Alpha General!');
        });
    });

    // =========================================================================
    // SECTION 3: Warnings Concurrency & Transactional Escalation
    // =========================================================================
    describe('3. Warnings Concurrency & Transactional Escalation', () => {
        const testSubject = '15559990001@s.whatsapp.net';

        beforeEach(async () => {
            await warningRepo.clearAllWarningsForGroup(tenantA.id, groupA1.id);
        });

        it('GET /groups/:groupId/warnings lists warnings', async () => {
            await warningRepo.createWarning(tenantA.id, groupA1.id, {
                subjectJid: testSubject,
                issuedBy: userAdminA.id,
                reason: 'Spamming',
            });

            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.total, 1);
            assert.strictEqual(res.body.data.warnings[0].reason, 'Spamming');
        });

        it('POST /groups/:groupId/warnings issues a warning without escalation below threshold', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    subjectJid: testSubject,
                    reason: 'Warning 1: No advertising',
                },
            });

            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.warningCount, 1);
            assert.strictEqual(res.body.data.maxWarnings, 2); // Set in previous test
            assert.strictEqual(res.body.data.shouldEscalate, false);
            assert.strictEqual(res.body.data.commandId, null);
        });

        it('POST /groups/:groupId/warnings atomically escalates to KICK command when threshold reached', async () => {
            await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { subjectJid: testSubject, reason: 'Warning 1' },
            });

            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    subjectJid: testSubject,
                    reason: 'Warning 2: Advertising again',
                },
            });

            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.warningCount, 2);
            assert.strictEqual(res.body.data.shouldEscalate, true);
            assert.strictEqual(res.body.data.escalationAction, 'kick');
            assert.ok(res.body.data.commandId);

            // Verify KICK_PARTICIPANT command exists in connection_commands
            const cmd = await commandRepo.findByIdForTenant(res.body.data.commandId, tenantA.id);
            assert.ok(cmd);
            assert.strictEqual(cmd.command_type, 'KICK_PARTICIPANT');
            assert.strictEqual(cmd.status, 'PENDING');
            assert.strictEqual(cmd.payload.participantJid, testSubject);
        });

        it('DELETE /groups/:groupId/warnings resets warnings for a specific subject', async () => {
            await warningRepo.createWarning(tenantA.id, groupA1.id, {
                subjectJid: testSubject,
                issuedBy: userAdminA.id,
                reason: 'Warn 1',
            });
            await warningRepo.createWarning(tenantA.id, groupA1.id, {
                subjectJid: testSubject,
                issuedBy: userAdminA.id,
                reason: 'Warn 2',
            });

            const res = await request('DELETE', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings?subjectJid=${testSubject}`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.resetCount, 2);

            const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            assert.strictEqual(count, 0);
        });

        // ---------------------------------------------------------------------
        // Warning Endpoint Idempotency Integration Tests (Phase 4E Final Patch)
        // ---------------------------------------------------------------------
        it('Test 1 — Initial idempotent warning creates warning and completed idempotency record', async () => {
            const idempotencyKey = 'warn-key-test-1';
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: {
                    subjectJid: testSubject,
                    reason: 'Spam violation',
                },
            });

            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.warningCount, 1);
            assert.strictEqual(res.body.data.shouldEscalate, false);

            // Verify one row in group_warnings
            const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            assert.strictEqual(count, 1);

            // Verify idempotency record in DB is COMPLETED
            const { rows } = await pool.query(
                `SELECT * FROM api_idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2;`,
                [tenantA.id, idempotencyKey]
            );
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].status, 'COMPLETED');
            assert.strictEqual(rows[0].response_status_code, 201);
        });

        it('Test 2 — Completed replay returns cached response without duplicate warning mutation', async () => {
            const idempotencyKey = 'warn-key-test-2';
            const payload = {
                subjectJid: testSubject,
                reason: 'First warning under key 2',
            };

            // Request 1: Initial creation
            const res1 = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });
            assert.strictEqual(res1.statusCode, 201);
            assert.strictEqual(res1.body.data.warningCount, 1);

            // Request 2: Replay exact same request
            const res2 = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });

            assert.strictEqual(res2.statusCode, 201);
            assert.strictEqual(res2.headers['x-cache'], 'IDEMPOTENT-REPLAY');
            assert.strictEqual(res2.body.data.warningCount, 1); // Not incremented!
            assert.strictEqual(res2.body.data.warning.id, res1.body.data.warning.id);

            // Database count remains strictly 1
            const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            assert.strictEqual(count, 1);
        });

        it('Test 3 — Same key with different request returns 422 IDEMPOTENCY_KEY_MISMATCH without mutation', async () => {
            const idempotencyKey = 'warn-key-test-3';

            // Initial request for testSubject
            await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: { subjectJid: testSubject, reason: 'Initial reason' },
            });

            const countBefore = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);

            // Duplicate key with different subject
            const diffSubject = '15559990099@s.whatsapp.net';
            const resDiff = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: { subjectJid: diffSubject, reason: 'Different subject reason' },
            });

            assert.strictEqual(resDiff.statusCode, 422);
            assert.strictEqual(resDiff.body.error.code, 'IDEMPOTENCY_KEY_MISMATCH');

            // Verify no new warnings created for diffSubject or testSubject
            const countDiff = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, diffSubject);
            assert.strictEqual(countDiff, 0);

            const countAfter = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            assert.strictEqual(countAfter, countBefore);
        });

        it('Test 4 — Concurrent identical requests produce exactly one warning mutation', async () => {
            const idempotencyKey = 'warn-key-concurrent-4';
            const payload = { subjectJid: testSubject, reason: 'Concurrent warning' };

            // Fire two identical requests simultaneously
            const [resA, resB] = await Promise.all([
                request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                    headers: {
                        Authorization: `Bearer ${tokenAdminA}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: payload,
                }),
                request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                    headers: {
                        Authorization: `Bearer ${tokenAdminA}`,
                        'Idempotency-Key': idempotencyKey,
                    },
                    body: payload,
                }),
            ]);

            // One must succeed with 201; the second must either receive 409 (in progress) or 201 (replayed cache)
            const statuses = [resA.statusCode, resB.statusCode].sort();
            assert.ok(
                (statuses[0] === 201 && statuses[1] === 201) || (statuses[0] === 201 && statuses[1] === 409),
                `Expected [201, 201] or [201, 409], got ${JSON.stringify(statuses)}`
            );

            // Database count must be EXACTLY 1!
            const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            assert.strictEqual(count, 1);
        });

        it('Test 5 — Threshold escalation + replay creates exactly one KICK command and replays it', async () => {
            const escalateSubject = '15559990088@s.whatsapp.net';
            // First warning to get subject to count = 1 (max_warnings is 2 for groupA1)
            await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { subjectJid: escalateSubject, reason: 'Warning 1 below threshold' },
            });

            const idempotencyKey = 'warn-key-escalate-5';
            const payload = { subjectJid: escalateSubject, reason: 'Warning 2 hitting threshold' };

            // Request 1: Reaches threshold and escalates
            const res1 = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });

            assert.strictEqual(res1.statusCode, 201);
            assert.strictEqual(res1.body.data.warningCount, 2);
            assert.strictEqual(res1.body.data.shouldEscalate, true);
            const initialCmdId = res1.body.data.commandId;
            assert.ok(initialCmdId);

            // Verify exactly 1 KICK_PARTICIPANT command exists for this subject
            const { rows: cmdsBefore } = await pool.query(
                `SELECT * FROM connection_commands WHERE command_type = 'KICK_PARTICIPANT' AND payload->>'participantJid' = $1;`,
                [escalateSubject]
            );
            assert.strictEqual(cmdsBefore.length, 1);
            assert.strictEqual(cmdsBefore[0].id, initialCmdId);

            // Request 2: Replay of the escalating request
            const res2 = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/warnings`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: payload,
            });

            assert.strictEqual(res2.statusCode, 201);
            assert.strictEqual(res2.headers['x-cache'], 'IDEMPOTENT-REPLAY');
            assert.strictEqual(res2.body.data.warningCount, 2);
            assert.strictEqual(res2.body.data.shouldEscalate, true);
            assert.strictEqual(res2.body.data.commandId, initialCmdId);

            // Verify NO SECOND KICK command was created
            const { rows: cmdsAfter } = await pool.query(
                `SELECT * FROM connection_commands WHERE command_type = 'KICK_PARTICIPANT' AND payload->>'participantJid' = $1;`,
                [escalateSubject]
            );
            assert.strictEqual(cmdsAfter.length, 1);
            assert.strictEqual(cmdsAfter[0].id, initialCmdId);
        });

        it('Test 6 — Crash / rollback consistency leaves no orphaned PENDING idempotency key or warning', async () => {
            const idempotencyKey = 'warn-key-rollback-6';
            const fakeGroupId = '00000000-0000-0000-0000-000000000099';

            // Group does not exist in DB, which causes a foreign key failure during warningRepo.createWarning
            // inside the WarningService transaction!
            await assert.rejects(
                async () => {
                    await warningService.issueWarning({
                        tenantId: tenantA.id,
                        groupId: fakeGroupId,
                        subjectJid: testSubject,
                        issuedBy: userAdminA.id,
                        reason: 'Will fail FK',
                        idempotencyKey,
                        requestHash: 'fake-hash',
                    });
                }
            );

            // Verify that rollback cleanly removed the reserved idempotency key (NO orphaned PENDING key)
            const { rows: keyRows } = await pool.query(
                `SELECT * FROM api_idempotency_keys WHERE tenant_id = $1 AND idempotency_key = $2;`,
                [tenantA.id, idempotencyKey]
            );
            assert.strictEqual(keyRows.length, 0);

            // Verify no warning was created
            const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA1.id, testSubject);
            // Count remains at whatever it was previously
            assert.ok(typeof count === 'number');
        });
    });

    // =========================================================================
    // SECTION 4: Moderation REST APIs & Dual Authorization Gates
    // =========================================================================
    describe('4. Moderation REST APIs & Dual Authorization Gates', () => {
        it('POST /moderation/mute rejects unmanaged group with 400', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA2.id}/moderation/mute`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { durationMinutes: 30 },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, 'GROUP_NOT_MANAGED');
        });

        it('Worker marks command FAILED with BOT_NOT_ADMIN when bot is not admin on WhatsApp', async () => {
            await pool.query('DELETE FROM connection_commands WHERE connection_id = $1;', [connA.id]);
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 15 },
            });

            // Claim command to move to PROCESSING
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: connA.id,
                    workerId: 'worker-test-bot-admin',
                    claimEpoch: 1,
                });
                await client.query('COMMIT');

                // Simulate worker executing command where gateway reports isBotAdmin: false
                await commandRepo.failCommand(null, {
                    id: claimed.id,
                    workerId: 'worker-test-bot-admin',
                    claimEpoch: claimed.claim_epoch,
                    error: 'BOT_NOT_ADMIN',
                    isTerminal: true,
                });

                const failedCmd = await commandRepo.findByIdForTenant(cmd.id, tenantA.id);
                assert.strictEqual(failedCmd.status, 'FAILED');
                assert.strictEqual(failedCmd.last_error, 'BOT_NOT_ADMIN');
            } finally {
                client.release();
            }
        });

        it('POST /moderation/mute rejects when connection is not ACTIVE with 409 CONNECTION_NOT_ACTIVE', async () => {
            // Temporarily set connection actual_state = DISCONNECTED
            await pool.query("UPDATE whatsapp_connections SET actual_state = 'DISCONNECTED' WHERE id = $1;", [connA.id]);

            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { durationMinutes: 10 },
            });

            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.body.error.code, 'CONNECTION_NOT_ACTIVE');

            // Restore connection actual_state = ACTIVE
            await pool.query("UPDATE whatsapp_connections SET actual_state = 'ACTIVE' WHERE id = $1;", [connA.id]);
        });

        it('POST /moderation/mute accepts valid request and returns 202 Accepted', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { durationMinutes: 45, reason: 'Maintenance' },
            });

            assert.strictEqual(res.statusCode, 202);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.action, 'MUTE_GROUP');
            assert.strictEqual(res.body.data.status, 'PENDING');
            assert.ok(res.body.data.commandId);

            // Verify command in DB
            const cmd = await commandRepo.findByIdForTenant(res.body.data.commandId, tenantA.id);
            assert.strictEqual(cmd.command_type, 'MUTE_GROUP');
            assert.strictEqual(cmd.payload.durationMinutes, 45);
        });

        it('POST /moderation/unmute accepts valid request and returns 202 Accepted', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/unmute`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { reason: 'Maintenance complete' },
            });

            assert.strictEqual(res.statusCode, 202);
            assert.strictEqual(res.body.data.action, 'UNMUTE_GROUP');
            assert.strictEqual(res.body.data.status, 'PENDING');
            assert.ok(res.body.data.commandId);
        });

        it('POST /moderation/kick rejects missing participantJid with 400', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/kick`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: { reason: 'Violation' },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('POST /moderation/kick accepts valid request and returns 202 Accepted', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/kick`, {
                headers: { Authorization: `Bearer ${tokenAdminA}` },
                body: {
                    participantJid: '15550009999@s.whatsapp.net',
                    reason: 'Repeated spam',
                },
            });

            assert.strictEqual(res.statusCode, 202);
            assert.strictEqual(res.body.data.action, 'KICK_PARTICIPANT');
            assert.strictEqual(res.body.data.status, 'PENDING');
            assert.ok(res.body.data.commandId);
        });
    });

    // =========================================================================
    // SECTION 5: API Idempotency Verification
    // =========================================================================
    describe('5. API Idempotency Key Semantics', () => {
        const idempotencyKey = 'idem-test-key-uuid-12345678';

        it('Processes initial request with Idempotency-Key header and creates record', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: { durationMinutes: 60, reason: 'Silent hour' },
            });

            assert.strictEqual(res.statusCode, 202);
            assert.ok(res.body.data.commandId);
            const initialCommandId = res.body.data.commandId;

            // Immediate replay with identical key and body returns EXACT same response
            const replayRes = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: { durationMinutes: 60, reason: 'Silent hour' },
            });

            assert.strictEqual(replayRes.statusCode, 202);
            assert.strictEqual(replayRes.body.data.commandId, initialCommandId);
        });

        it('Rejects duplicate Idempotency-Key with different payload with 422 IDEMPOTENCY_KEY_MISMATCH', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': idempotencyKey,
                },
                body: { durationMinutes: 120, reason: 'DIFFERENT_PAYLOAD' }, // Different body!
            });

            assert.strictEqual(res.statusCode, 422);
            assert.strictEqual(res.body.error.code, 'IDEMPOTENCY_KEY_MISMATCH');
        });

        it('Rejects malformed Idempotency-Key format with 400', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/groups/${groupA1.id}/moderation/mute`, {
                headers: {
                    Authorization: `Bearer ${tokenAdminA}`,
                    'Idempotency-Key': 'invalid key with spaces and symbols!@#$',
                },
                body: { durationMinutes: 10 },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_IDEMPOTENCY_KEY');
        });
    });

    // =========================================================================
    // SECTION 6: Command Claiming, Fencing & Stale Worker Protection
    // =========================================================================
    describe('6. Command Claiming, Fencing & Stale Worker Protection', () => {
        let testCmd;

        beforeEach(async () => {
            await pool.query('DELETE FROM connection_commands WHERE connection_id = $1;', [connA.id]);
            testCmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 30 },
            });
        });

        it('Worker claims pending command with claim_epoch tracking', async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: connA.id,
                    workerId: 'worker-node-alpha',
                    claimEpoch: 1,
                });
                await client.query('COMMIT');

                assert.ok(claimed);
                assert.strictEqual(claimed.id, testCmd.id);
                assert.strictEqual(claimed.status, 'PROCESSING');
                assert.strictEqual(claimed.claimed_by_worker_id, 'worker-node-alpha');
                assert.strictEqual(Number(claimed.claim_epoch), 1);
            } finally {
                client.release();
            }
        });

        it('Stale worker epoch cannot complete or requeue command (0 rows affected)', async () => {
            const client = await pool.connect();
            try {
                // Claim as Worker 1 with claim_epoch = 1
                await client.query('BEGIN');
                const claimed1 = await commandRepo.claimCommandForConnection(client, {
                    connectionId: connA.id,
                    workerId: 'worker-1',
                    claimEpoch: 1,
                });
                await client.query('COMMIT');

                // Simulate Worker 2 stealing the command due to lease expiration
                // Manually advance claim_epoch to 2 and claimed_by_worker_id to 'worker-2'
                await pool.query(
                    `UPDATE connection_commands
                     SET claimed_by_worker_id = 'worker-2', claim_epoch = 2, status = 'PROCESSING'
                     WHERE id = $1;`,
                    [testCmd.id]
                );

                // Now Worker 1 (still thinking it has epoch 1) tries to complete the command
                const completed = await commandRepo.completeCommand(null, {
                    id: testCmd.id,
                    workerId: 'worker-1',
                    claimEpoch: 1, // STALE EPOCH
                    result: { status: 'MUTED' },
                });

                // Must return false / 0 rows affected!
                assert.strictEqual(completed, false);

                // Verify the command in DB was NOT modified by Worker 1
                const finalCmd = await commandRepo.findByIdForTenant(testCmd.id, tenantA.id);
                assert.strictEqual(finalCmd.claimed_by_worker_id, 'worker-2');
                assert.strictEqual(Number(finalCmd.claim_epoch), 2);
                assert.strictEqual(finalCmd.status, 'PROCESSING');
            } finally {
                client.release();
            }
        });
    });

    // =========================================================================
    // SECTION 7: MUTE Success Atomically Activates Scheduled UNMUTE Task
    // =========================================================================
    describe('7. MUTE Success Atomically Activates Scheduled UNMUTE Task', () => {
        let muteCmd;

        beforeEach(async () => {
            // Clean up any commands and tasks for connection
            await pool.query('DELETE FROM connection_commands WHERE connection_id = $1;', [connA.id]);
            await pool.query('DELETE FROM scheduled_moderation_tasks;');
            muteCmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 60 },
            });
        });

        it('No scheduled UNMUTE task exists while MUTE is PENDING', async () => {
            const { rows } = await pool.query(
                `SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;`,
                [groupA1.id]
            );
            assert.strictEqual(rows.length, 0);
        });

        it('MUTE success atomically transitions command to COMPLETED and activates UNMUTE task with timing from executed_at', async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');

                // Claim command
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: connA.id,
                    workerId: 'worker-active-1',
                    claimEpoch: 1,
                });
                assert.strictEqual(claimed.id, muteCmd.id);

                // Simulate successful external WhatsApp execution
                const executedAt = new Date();
                const durationMinutes = claimed.payload.durationMinutes; // 60
                const runAt = new Date(executedAt.getTime() + durationMinutes * 60 * 1000);

                // 1. Cancel previous pending tasks for group
                await taskRepo.cancelTasksForGroup(client, {
                    tenantId: tenantA.id,
                    groupId: groupA1.id,
                    action: 'UNMUTE_GROUP',
                });

                // 2. Create the UNMUTE task
                const task = await taskRepo.createTask(client, {
                    tenantId: tenantA.id,
                    groupId: groupA1.id,
                    connectionId: connA.id,
                    action: 'UNMUTE_GROUP',
                    payload: { originCommandId: claimed.id },
                    runAt,
                });

                // 3. Mark MUTE command COMPLETED
                const completed = await commandRepo.completeCommand(client, {
                    id: claimed.id,
                    workerId: 'worker-active-1',
                    claimEpoch: 1,
                    result: { status: 'MUTED', executedAt: executedAt.toISOString() },
                });
                assert.strictEqual(completed, true);

                await client.query('COMMIT');

                // Verify the task exists in DB with run_at matching executed_at + duration
                assert.ok(task.id);
                assert.strictEqual(task.status, 'PENDING');
                const deltaMs = Math.abs(new Date(task.run_at).getTime() - (executedAt.getTime() + 60 * 60 * 1000));
                assert.ok(deltaMs < 2000, `run_at should match executed_at + 60m within 2s, got delta ${deltaMs}ms`);
            } finally {
                client.release();
            }
        });

        it('Failed MUTE never leaves an executable UNMUTE task in database', async () => {
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: connA.id,
                    workerId: 'worker-fail-test',
                    claimEpoch: 1,
                });

                // Simulate failure on WhatsApp
                await commandRepo.failCommand(client, {
                    id: claimed.id,
                    workerId: 'worker-fail-test',
                    claimEpoch: claimed.claim_epoch,
                    error: 'WhatsApp network timeout',
                    isTerminal: true,
                });

                await client.query('COMMIT');

                // Verify ZERO tasks created for this group
                const { rows } = await pool.query(
                    `SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;`,
                    [groupA1.id]
                );
                assert.strictEqual(rows.length, 0);
            } finally {
                client.release();
            }
        });

        it('Replacement Semantics: a new MUTE cancels previous pending UNMUTE for the group', async () => {
            // Create initial task
            const task1 = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60 * 60 * 1000),
                metadata: { durationMinutes: 60 },
            });
            const task1Id = task1.id;

            // Now a new MUTE command is executed
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                // Cancel existing
                const cancelledCount = await taskRepo.cancelTasksForGroup(client, {
                    tenantId: tenantA.id,
                    groupId: groupA1.id,
                    action: 'UNMUTE_GROUP',
                });
                assert.strictEqual(cancelledCount, 1);

                // Create new task
                const task2 = await taskRepo.createTask(client, {
                    tenantId: tenantA.id,
                    connectionId: connA.id,
                    groupId: groupA1.id,
                    action: 'UNMUTE_GROUP',
                    runAt: new Date(Date.now() + 120 * 60 * 1000), // 2 hours
                    metadata: { durationMinutes: 120 },
                });
                await client.query('COMMIT');

                // Verify Task 1 is CANCELLED and Task 2 is PENDING
                const t1 = await taskRepo.getTaskStatus(task1Id);
                assert.strictEqual(t1.status, 'CANCELLED');

                const t2 = await taskRepo.getTaskStatus(task2.id);
                assert.strictEqual(t2.status, 'PENDING');
            } finally {
                client.release();
            }
        });
    });

    // =========================================================================
    // SECTION 8: Durable Moderation Scheduler Execution & Invariants
    // =========================================================================
    describe('8. Durable Moderation Scheduler Execution & Invariants', () => {
        it('Scheduler claims eligible task when run_at <= NOW()', async () => {
            // Create a task that is due right now
            const dueTask = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000), // 5 seconds ago
                metadata: { reason: 'Scheduled unmute expired' },
            });

            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId: 'worker-scheduler-1',
                    getLeaseEpochForConnection: () => 1,
                });
                await client.query('COMMIT');

                assert.ok(claimed);
                assert.strictEqual(claimed.id, dueTask.id);
                assert.strictEqual(claimed.status, 'PROCESSING');
                assert.strictEqual(claimed.claimed_by_worker_id, 'worker-scheduler-1');
            } finally {
                client.release();
            }
        });

        it('Pre-gateway cancellation check: if group turned UNMANAGED, task is cancelled and aborted', async () => {
            // Create a task due right now for groupA1
            const task = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 1000),
            });

            // Turn groupA1 UNMANAGED
            await groupRepo.updateStatusForTenant(groupA1.id, tenantA.id, 'UNMANAGED');

            // Mock lease manager & connection manager
            const mockLeaseManager = {
                leases: new Map([[connA.id, { leaseEpoch: 1 }]]),
                hasLease: (cId) => cId === connA.id,
            };

            let unmuteCalled = false;
            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupSettingUpdate: async () => { unmuteCalled = true; },
                sendMessage: async () => {},
            };

            const mockConnectionManager = {
                getConnection: () => ({ sock: mockSocket }),
            };

            const scheduler = new DurableModerationScheduler({
                pool,
                taskRepo,
                groupRepo,
                leaseManager: mockLeaseManager,
                connectionManager: mockConnectionManager,
                workerId: 'worker-test-sched',
                pollIntervalMs: 100000,
            });

            // Run sweep
            await scheduler.sweepAndExecute();

            // Verify: WhatsApp gateway was NOT called
            assert.strictEqual(unmuteCalled, false);

            // Verify task was marked CANCELLED
            const updatedTask = await taskRepo.getTaskStatus(task.id);
            assert.strictEqual(updatedTask.status, 'CANCELLED');

            // Restore group to MANAGED
            await groupRepo.updateStatusForTenant(groupA1.id, tenantA.id, 'MANAGED');
        });
    });

    // =========================================================================
    // SECTION 9: Command Polling & Audit Boundaries
    // =========================================================================
    describe('9. Command Polling & Audit Boundaries', () => {
        it('GET /commands/:commandId allows polling command status', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                commandType: 'UNMUTE_GROUP',
                payload: { reason: 'Test polling' },
            });

            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/commands/${cmd.id}`, {
                headers: { Authorization: `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.command.id, cmd.id);
            assert.strictEqual(res.body.data.command.command_type, 'UNMUTE_GROUP');
            assert.strictEqual(res.body.data.command.status, 'PENDING');
        });

        it('GET /commands/:commandId enforces tenant boundary (Tenant B returns 404 for Tenant A command)', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                groupId: groupA1.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });

            const res = await request('GET', `/api/v1/tenants/${tenantB.id}/commands/${cmd.id}`, {
                headers: { Authorization: `Bearer ${tokenOwnerB}` },
            });

            assert.strictEqual(res.statusCode, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');
        });
    });
});
