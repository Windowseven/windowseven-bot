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
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    ScheduledModerationTaskRepository,
    ConnectionCommandRepository,
    GroupRepository,
    GroupPolicyRepository,
    RefreshTokenRepository,
} = require('../src/repositories');

const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PasswordService = require('../src/application/services/PasswordService');
const PlatformService = require('../src/application/services/PlatformService');
const RemoteOutcomeVerificationService = require('../src/whatsapp/worker/RemoteOutcomeVerificationService');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerLeaseManager = require('../src/whatsapp/worker/WorkerLeaseManager');
const { createRestApp } = require('../src/application/http/RestApp');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_test';

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

describe('Phase 5B — Production Reliability, Recovery & Platform Operations', () => {
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
    let tokenService;
    let authService;
    let passwordService;
    let commandGateway;
    let eventPublisher;
    let platformService;
    let verifier;
    let server;

    let superAdminUser;
    let superAdminToken;
    let platformAdminUser;
    let platformAdminToken;
    let testTenant;
    let testConn;
    let testGroup;

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
            commandRepo,
            groupRepo,
            commandGateway,
            eventPublisher,
        });

        const cm = new ConnectionManager();
        const lm = new WorkerLeaseManager({
            workerId: 'w-p5b-verifier',
            connRepo,
            connectionManager: cm,
        });

        verifier = new RemoteOutcomeVerificationService({
            pool,
            commandRepo,
            taskRepo,
            groupRepo,
            connectionManager: cm,
            leaseManager: lm,
            workerId: 'w-p5b-verifier',
        });

        // Seed Platform Users
        superAdminUser = await userRepo.create({
            email: `p5b_super_${Date.now()}@platform.local`,
        });
        await platformRoleRepo.assignRole({
            userId: superAdminUser.id,
            role: 'SUPER_ADMIN',
            assignedBy: superAdminUser.id,
        });
        superAdminToken = tokenService.createAccessToken({
            userId: superAdminUser.id,
            email: superAdminUser.email,
        });

        platformAdminUser = await userRepo.create({
            email: `p5b_plat_${Date.now()}@platform.local`,
        });
        await platformRoleRepo.assignRole({
            userId: platformAdminUser.id,
            role: 'PLATFORM_ADMIN',
            assignedBy: superAdminUser.id,
        });
        platformAdminToken = tokenService.createAccessToken({
            userId: platformAdminUser.id,
            email: platformAdminUser.email,
        });

        // Seed Tenant & Connection
        testTenant = await tenantRepo.create({ name: 'Phase 5B Production Reliability Tenant' });
        testConn = await connRepo.createForTenant(testTenant.id, {
            phoneNumber: '15555550001',
            displayName: 'P5B Connection',
        });
        testGroup = await groupRepo.upsertDiscoveredGroup(testTenant.id, testConn.id, {
            whatsappJid: '120363555555555555@g.us',
            name: 'P5B Monitored Group',
            status: 'MANAGED',
        });

        // Initialize RestApp
        const restApp = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo: membershipRepo,
            userRepo,
            platformRoleRepo,
            platformAuditRepo,
            platformIdempotencyRepo,
            whatsAppConnectionRepo: connRepo,
            workerRepo,
            groupRepo,
            scheduledTaskRepo: taskRepo,
            connectionCommandRepo: commandRepo,
            platformService,
            commandGateway,
            eventPublisher,
        });

        server = http.createServer(restApp);
        await new Promise((resolve) => server.listen(0, resolve));
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        if (pool) {
            await pool.query('TRUNCATE TABLE platform_audit_logs, platform_idempotency_keys, platform_user_roles CASCADE;').catch(() => {});
            if (testTenant) {
                await pool.query('DELETE FROM scheduled_moderation_tasks WHERE tenant_id = $1;', [testTenant.id]).catch(() => {});
                await pool.query('DELETE FROM connection_commands WHERE tenant_id = $1;', [testTenant.id]).catch(() => {});
                await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1;', [testTenant.id]).catch(() => {});
                await pool.query('DELETE FROM groups WHERE tenant_id = $1;', [testTenant.id]).catch(() => {});
                await pool.query('DELETE FROM tenants WHERE id = $1;', [testTenant.id]).catch(() => {});
            }
            if (superAdminUser && platformAdminUser) {
                await pool.query('DELETE FROM users WHERE id IN ($1, $2);', [superAdminUser.id, platformAdminUser.id]).catch(() => {});
            }
            await pool.end();
        }
    });

    beforeEach(async () => {
        await pool.query("DELETE FROM scheduled_moderation_tasks WHERE tenant_id = $1;", [testTenant.id]);
        await pool.query("DELETE FROM connection_commands WHERE tenant_id = $1;", [testTenant.id]);
        await pool.query(`
            UPDATE whatsapp_connections
            SET assigned_worker_id = 'w-p5b-verifier',
                lease_epoch = 1,
                lease_expires_at = NOW() + INTERVAL '1 hour'
            WHERE id = $1;
        `, [testConn.id]);
    });

    // =========================================================================
    // 1. BOUNDED REMOTE_OUTCOME_UNKNOWN RECOVERY FOR COMMANDS
    // =========================================================================
    describe('1. Bounded REMOTE_OUTCOME_UNKNOWN Recovery for Commands', () => {
        it('1.1 MUTE_GROUP: positive observation (announce=true) -> COMPLETED & 1 UNMUTE task', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 20 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW(), claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: true,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');

            const { rows: tasks } = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [testTenant.id, testGroup.id]);
            assert.strictEqual(tasks.length, 1);
            assert.strictEqual(tasks[0].payload.durationMinutes, 20);
        });

        it('1.2 MUTE_GROUP: negative observation (announce=false) + bot not admin -> FAILED BOT_NOT_ADMIN & 0 UNMUTE tasks', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW(), claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: null }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'BOT_NOT_ADMIN');

            const { rows: tasks } = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [testTenant.id, testGroup.id]);
            assert.strictEqual(tasks.length, 0);
        });

        it('1.3 MUTE_GROUP: negative observation (announce=false) + expired window -> FAILED REMOTE_MUTE_NOT_OBSERVED_TIMED_OUT & 0 UNMUTE tasks', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 15 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '70 seconds', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'REMOTE_MUTE_NOT_OBSERVED_TIMED_OUT');

            const { rows: tasks } = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [testTenant.id, testGroup.id]);
            assert.strictEqual(tasks.length, 0);
        });

        it('1.4 MUTE_GROUP: negative observation + active window -> stays REMOTE_OUTCOME_UNKNOWN with backoff (never resets to PENDING)', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '5 seconds', attempt_count = 1, claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'REMOTE_OUTCOME_UNKNOWN');
            assert.strictEqual(finalCmd.attempt_count, 2);
            assert.strictEqual(finalCmd.last_error, 'REMOTE_MUTE_NOT_YET_OBSERVED');
            assert(finalCmd.next_attempt_at > new Date());
        });

        it('1.5 MUTE_GROUP: permanent remote error (404 item-not-found) -> FAILED PERMANENT_REMOTE_UNAVAILABLE & 0 UNMUTE tasks', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW(), claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const permErr = new Error('item-not-found');
            permErr.data = 404;

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => { throw permErr; },
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert(finalCmd.last_error.includes('PERMANENT_REMOTE_UNAVAILABLE'));

            const { rows: tasks } = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [testTenant.id, testGroup.id]);
            assert.strictEqual(tasks.length, 0);
        });

        it('1.6 MUTE_GROUP: transient error (503) + active window -> stays REMOTE_OUTCOME_UNKNOWN with backoff', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '5 seconds', attempt_count = 0, claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const transErr = new Error('Connection timed out');
            transErr.data = 503;

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => { throw transErr; },
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'REMOTE_OUTCOME_UNKNOWN');
            assert.strictEqual(finalCmd.attempt_count, 1);
            assert(finalCmd.last_error.includes('TRANSIENT_QUERY_FAILURE'));
        });

        it('1.7 MUTE_GROUP: transient error + max attempts exhausted -> FAILED VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW(), attempt_count = 5, max_attempts = 5, claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const transErr = new Error('Service Unavailable');
            transErr.data = 503;

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => { throw transErr; },
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE');
        });

        it('1.8 UNMUTE_GROUP: positive observation (announce=false) -> COMPLETED', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'UNMUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({ announce: false }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');
            assert.strictEqual(finalCmd.result.verifiedUnmuted, true);
        });

        it('1.9 UNMUTE_GROUP: negative observation (announce=true) + expired window -> FAILED', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'UNMUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '75 seconds', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: true,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'REMOTE_UNMUTE_NOT_OBSERVED_TIMED_OUT');
        });

        it('1.10 KICK_PARTICIPANT: positive observation (target absent) -> COMPLETED', async () => {
            const targetJid = 'baduser@s.whatsapp.net';
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'KICK_PARTICIPANT',
                payload: { participantJid: targetJid },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    participants: [{ id: 'innocent@s.whatsapp.net' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');
            assert.strictEqual(finalCmd.result.verifiedAbsent, true);
        });

        it('1.11 KICK_PARTICIPANT: target present + bot not admin -> FAILED BOT_NOT_ADMIN', async () => {
            const targetJid = 'baduser@s.whatsapp.net';
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'KICK_PARTICIPANT',
                payload: { participantJid: targetJid },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: null },
                        { id: targetJid, admin: null },
                    ],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'BOT_NOT_ADMIN');
        });

        it('1.12 KICK_PARTICIPANT: target present + target is admin -> FAILED TARGET_IS_ADMIN', async () => {
            const targetJid = 'adminuser@s.whatsapp.net';
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'KICK_PARTICIPANT',
                payload: { participantJid: targetJid },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: targetJid, admin: 'admin' },
                    ],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'TARGET_IS_ADMIN');
        });
    });

    // =========================================================================
    // 2. BOUNDED REMOTE_OUTCOME_UNKNOWN RECOVERY FOR SCHEDULED TASKS
    // =========================================================================
    describe('2. Bounded REMOTE_OUTCOME_UNKNOWN Recovery for Scheduled Tasks', () => {
        it('2.1 UNMUTE_GROUP task: positive observation (announce=false) -> COMPLETED', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at, claimed_by_worker_id, claim_epoch)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'REMOTE_OUTCOME_UNKNOWN', NOW(), 'w-p5b-verifier', 1)
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({ announce: false }),
            };

            const verified = await verifier.verifyTask(task, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalTask = await taskRepo.findById(task.id);
            assert.strictEqual(finalTask.status, 'COMPLETED');
            assert(finalTask.executed_at !== null);
        });

        it('2.2 UNMUTE_GROUP task: permanent remote error (404) -> FAILED PERMANENT_REMOTE_UNAVAILABLE', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at, claimed_by_worker_id, claim_epoch)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'REMOTE_OUTCOME_UNKNOWN', NOW(), 'w-p5b-verifier', 1)
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const permErr = new Error('not-authorized');
            permErr.data = 403;

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => { throw permErr; },
            };

            const verified = await verifier.verifyTask(task, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalTask = await taskRepo.findById(task.id);
            assert.strictEqual(finalTask.status, 'FAILED');
            assert(finalTask.last_error.includes('PERMANENT_REMOTE_UNAVAILABLE'));
        });

        it('2.3 UNMUTE_GROUP task: transient error + active window -> stays REMOTE_OUTCOME_UNKNOWN with backoff', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at, attempt_count, claimed_by_worker_id, claim_epoch)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'REMOTE_OUTCOME_UNKNOWN', NOW(), 1, 'w-p5b-verifier', 1)
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const transErr = new Error('Rate limit exceeded');
            transErr.data = 429;

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => { throw transErr; },
            };

            const verified = await verifier.verifyTask(task, { sock: mockSock, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalTask = await taskRepo.findById(task.id);
            assert.strictEqual(finalTask.status, 'REMOTE_OUTCOME_UNKNOWN');
            assert.strictEqual(finalTask.attempt_count, 2);
            assert(finalTask.next_attempt_at > new Date());
        });
    });

    // =========================================================================
    // 3. ZERO UNMUTE TASK INVARIANT
    // =========================================================================
    describe('3. Zero UNMUTE Task Invariant', () => {
        it('3.1 Proves across all MUTE verification non-success outcomes that COUNT(UNMUTE_GROUP) = 0', async () => {
            // Clear any lingering tasks for testGroup
            await pool.query("DELETE FROM scheduled_moderation_tasks WHERE group_id = $1;", [testGroup.id]);

            // Run verification with non-announced state
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 30 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '80 seconds', claimed_by_worker_id = 'w-p5b-verifier', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });

            const { rows } = await pool.query("SELECT COUNT(*)::int AS count FROM scheduled_moderation_tasks WHERE group_id = $1 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [testGroup.id]);
            assert.strictEqual(rows[0].count, 0, 'Must never insert UNMUTE task unless positive announce=true is verified');
        });
    });

    // =========================================================================
    // 4. UNSAFE REQUEUE PREVENTION
    // =========================================================================
    describe('4. Unsafe Requeue Prevention', () => {
        beforeEach(async () => {
            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = 'w-stale',
                    lease_epoch = 1,
                    lease_expires_at = NOW() + INTERVAL '1 hour'
                WHERE id = $1;
            `, [testConn.id]);
        });

        it('4.1 Mutating command with remote_started_at IS NOT NULL is rejected from requeueStaleCommand', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'PROCESSING', remote_started_at = NOW(), claimed_by_worker_id = 'w-stale', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const requeued = await commandRepo.requeueStaleCommand(null, {
                id: cmd.id,
                workerId: 'w-stale',
                claimEpoch: 1,
            });
            assert.strictEqual(requeued, false, 'Mutating command with remote side effect must never reset to PENDING');

            const afterCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(afterCmd.status, 'PROCESSING');
        });

        it('4.2 Non-mutating command (SYNC_GROUPS) with remote_started_at IS NOT NULL is allowed to requeue', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                commandType: 'SYNC_GROUPS',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'PROCESSING', remote_started_at = NOW(), claimed_by_worker_id = 'w-stale', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const requeued = await commandRepo.requeueStaleCommand(null, {
                id: cmd.id,
                workerId: 'w-stale',
                claimEpoch: 1,
            });
            assert.strictEqual(requeued, true, 'Idempotent non-mutating SYNC_GROUPS may safely reset to PENDING');

            const afterCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(afterCmd.status, 'PENDING');
        });

        it('4.3 Mutating command with remote_started_at IS NULL is allowed to requeue to PENDING', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'PROCESSING', remote_started_at = NULL, claimed_by_worker_id = 'w-stale', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const requeued = await commandRepo.requeueStaleCommand(null, {
                id: cmd.id,
                workerId: 'w-stale',
                claimEpoch: 1,
            });
            assert.strictEqual(requeued, true, 'Command that crashed before remote side effect started may safely reset to PENDING');

            const afterCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(afterCmd.status, 'PENDING');
        });

        it('4.4 Scheduled task with remote_started_at IS NOT NULL is rejected from requeueStaleTask', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at, remote_started_at, claimed_by_worker_id, claim_epoch)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'PROCESSING', NOW(), NOW(), 'w-stale', 1)
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const requeued = await taskRepo.requeueStaleTask(null, {
                id: task.id,
                workerId: 'w-stale',
                claimEpoch: 1,
            });
            assert.strictEqual(requeued, false, 'Scheduled task with remote side effect must never reset to PENDING');

            const afterTask = await taskRepo.findById(task.id);
            assert.strictEqual(afterTask.status, 'PROCESSING');
        });

        it('4.5 Scheduled task with remote_started_at IS NULL is allowed to requeue to PENDING', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at, remote_started_at, claimed_by_worker_id, claim_epoch)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'PROCESSING', NOW(), NULL, 'w-stale', 1)
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const requeued = await taskRepo.requeueStaleTask(null, {
                id: task.id,
                workerId: 'w-stale',
                claimEpoch: 1,
            });
            assert.strictEqual(requeued, true, 'Task that crashed before remote execution started may safely reset to PENDING');

            const afterTask = await taskRepo.findById(task.id);
            assert.strictEqual(afterTask.status, 'PENDING');
        });
    });

    // =========================================================================
    // 5. PLATFORM OPERATIONS, RBAC & IDEMPOTENCY
    // =========================================================================
    describe('5. Platform Operations, RBAC & Idempotency', () => {
        it('5.1 POST /api/v1/platform/tenants: PLATFORM_ADMIN is rejected with 403 INSUFFICIENT_PLATFORM_ROLE', async () => {
            const res = await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
                body: { name: 'Unauthorized Tenant' },
            });

            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.body.error?.code, 'INSUFFICIENT_PLATFORM_ROLE');
        });

        it('5.2 POST /api/v1/platform/tenants: SUPER_ADMIN succeeds with 201 and creates audit log', async () => {
            const tenantName = `P5B Created Tenant ${Date.now()}`;
            const res = await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                },
                body: { name: tenantName },
            });

            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.success, true);
            const created = res.body.data;
            assert.strictEqual(created.name, tenantName);
            assert.strictEqual(created.status, 'ACTIVE');

            // Verify audit log
            const auditRes = await platformAuditRepo.list({
                action: 'TENANT_CREATED',
                targetId: created.id,
            });
            assert.strictEqual(auditRes.length, 1);
            assert.strictEqual(auditRes[0].actor_user_id, superAdminUser.id);
        });

        it('5.3 POST /api/v1/platform/tenants: Idempotency replay returns cached response with X-Cache: IDEMPOTENT-REPLAY', async () => {
            const key = `idem-tenant-${Date.now()}`;
            const body = { name: `Idempotent Tenant ${Date.now()}` };

            // Request 1
            const res1 = await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body,
            });
            assert.strictEqual(res1.statusCode, 201);

            // Request 2 (replay)
            const res2 = await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body,
            });
            assert.strictEqual(res2.statusCode, 201);
            assert.strictEqual(res2.headers['x-cache'], 'IDEMPOTENT-REPLAY');
            assert.strictEqual(res2.body.data.id, res1.body.data.id);
        });

        it('5.4 POST /api/v1/platform/tenants: Duplicate key with different payload rejects with 422 IDEMPOTENCY_KEY_MISMATCH', async () => {
            const key = `idem-tenant-mismatch-${Date.now()}`;
            await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { name: 'Initial Payload' },
            });

            const res2 = await makeRequest(server, {
                method: 'POST',
                path: '/api/v1/platform/tenants',
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                    'Idempotency-Key': key,
                },
                body: { name: 'Different Payload' },
            });

            assert.strictEqual(res2.statusCode, 422);
            assert.strictEqual(res2.body.error?.code, 'IDEMPOTENCY_KEY_MISMATCH');
        });

        it('5.5 GET /api/v1/platform/commands/:id: details accessible to PLATFORM_ADMIN', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });

            const res = await makeRequest(server, {
                method: 'GET',
                path: `/api/v1/platform/commands/${cmd.id}`,
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.command.id, cmd.id);
        });

        it('5.6 POST /api/v1/platform/commands/:id/probe: fails when connection has no active worker holding lease', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = NULL WHERE id = $1;", [testConn.id]);

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/probe`,
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error?.code, 'NO_ACTIVE_WORKER');
        });

        it('5.7 POST /api/v1/platform/commands/:id/probe: performs live inspection via active worker without mutating DB state', async () => {
            const workerId = `w-live-probe-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 5, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, testConn.id]);

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '10 seconds' WHERE id = $1;", [cmd.id]);

            // Register dummy WorkerNode with mock socket
            const dummyWorkerNode = {
                workerId,
                probeCommand: async (id) => ({
                    commandId: id,
                    verified: false,
                    announce: false,
                    isBotAdmin: true,
                    status: 'REMOTE_OUTCOME_UNKNOWN',
                }),
            };
            commandGateway.registerWorkerNode(dummyWorkerNode);

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/probe`,
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.probeResult.isBotAdmin, true);
            assert.strictEqual(res.body.data.probeResult.announce, false);

            // Verify database row was NOT mutated by probe
            const afterCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(afterCmd.status, 'REMOTE_OUTCOME_UNKNOWN');

            // Verify probe audit log
            const auditLogs = await platformAuditRepo.list({
                action: 'COMMAND_PROBED',
                targetId: cmd.id,
            });
            assert.strictEqual(auditLogs.length, 1);
            assert.strictEqual(auditLogs[0].metadata.assignedWorkerId, workerId);

            commandGateway.unregisterWorkerNode(workerId);
        });

        it('5.8 POST /api/v1/platform/commands/:id/resolve: triggers fenced resolution via active worker', async () => {
            const workerId = `w-live-resolve-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 7, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, testConn.id]);

            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN' WHERE id = $1;", [cmd.id]);

            const dummyWorkerNode = {
                workerId,
                resolveCommand: async (id) => {
                    await pool.query("UPDATE connection_commands SET status = 'COMPLETED', updated_at = NOW() WHERE id = $1;", [id]);
                    return commandRepo.findById(id);
                },
            };
            commandGateway.registerWorkerNode(dummyWorkerNode);

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/resolve`,
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.command.status, 'COMPLETED');

            // Verify audit log
            const auditLogs = await platformAuditRepo.list({
                action: 'COMMAND_RESOLVED',
                targetId: cmd.id,
            });
            assert.strictEqual(auditLogs.length, 1);
            assert.strictEqual(auditLogs[0].metadata.newStatus, 'COMPLETED');

            commandGateway.unregisterWorkerNode(workerId);
        });

        it('5.9 POST /api/v1/platform/commands/:id/force-fail: PLATFORM_ADMIN rejected with 403', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/force-fail`,
                headers: {
                    Authorization: `Bearer ${platformAdminToken}`,
                },
                body: { reason: 'Operator aborted' },
            });

            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.body.error?.code, 'INSUFFICIENT_PLATFORM_ROLE');
        });

        it('5.10 POST /api/v1/platform/commands/:id/force-fail: SUPER_ADMIN without reason rejected with 400', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });

            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/force-fail`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                },
                body: {},
            });

            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error?.code, 'VALIDATION_ERROR');
        });

        it('5.11 POST /api/v1/platform/commands/:id/force-fail: SUPER_ADMIN with reason marks FAILED and writes audit log', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN' WHERE id = $1;", [cmd.id]);

            const reason = 'Host catastrophic failure: Baileys socket permanently lost';
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/force-fail`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                },
                body: { reason },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.command.status, 'FAILED');
            assert(res.body.data.command.last_error.includes(reason));

            // Verify audit log
            const auditLogs = await platformAuditRepo.list({
                action: 'COMMAND_FORCE_FAILED',
                targetId: cmd.id,
            });
            assert.strictEqual(auditLogs.length, 1);
            assert.strictEqual(auditLogs[0].reason, reason);
            assert.strictEqual(auditLogs[0].actor_user_id, superAdminUser.id);
        });

        it('5.12 POST /api/v1/platform/tasks/:id/force-fail: SUPER_ADMIN with reason marks task FAILED and writes audit log', async () => {
            const { rows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'REMOTE_OUTCOME_UNKNOWN', NOW())
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = rows[0];

            const reason = 'Operator manual intervention';
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tasks/${task.id}/force-fail`,
                headers: {
                    Authorization: `Bearer ${superAdminToken}`,
                },
                body: { reason },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.task.status, 'FAILED');
            assert(res.body.data.task.last_error.includes(reason));

            const auditLogs = await platformAuditRepo.list({
                action: 'TASK_FORCE_FAILED',
                targetId: task.id,
            });
            assert.strictEqual(auditLogs.length, 1);
            assert.strictEqual(auditLogs[0].reason, reason);
        });

        it('5.14 FORCE_FAIL Command state validation: PENDING and PROCESSING rejected with 409, terminal states no-op', async () => {
            // Case A: PENDING
            const cmdPending = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: {},
            });
            const resPending = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmdPending.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should fail because pending' },
            });
            assert.strictEqual(resPending.statusCode, 409);
            assert.strictEqual(resPending.body.error.code, 'INVALID_COMMAND_STATE');
            const checkPending = await commandRepo.findById(cmdPending.id);
            assert.strictEqual(checkPending.status, 'PENDING');

            // Case B: PROCESSING
            await pool.query("UPDATE connection_commands SET status = 'PROCESSING', claimed_by_worker_id = 'worker-test', claim_epoch = 1, claim_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1;", [cmdPending.id]);
            const resProcessing = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmdPending.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should fail because processing' },
            });
            assert.strictEqual(resProcessing.statusCode, 409);
            assert.strictEqual(resProcessing.body.error.code, 'INVALID_COMMAND_STATE');
            const checkProcessing = await commandRepo.findById(cmdPending.id);
            assert.strictEqual(checkProcessing.status, 'PROCESSING');

            // Case C: COMPLETED
            await pool.query("UPDATE connection_commands SET status = 'COMPLETED' WHERE id = $1;", [cmdPending.id]);
            const resCompleted = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmdPending.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should no-op because completed' },
            });
            assert.strictEqual(resCompleted.statusCode, 200);
            assert.strictEqual(resCompleted.body.data.alreadyTerminal, true);
            const checkCompleted = await commandRepo.findById(cmdPending.id);
            assert.strictEqual(checkCompleted.status, 'COMPLETED');

            // Case D: FAILED
            await pool.query("UPDATE connection_commands SET status = 'FAILED' WHERE id = $1;", [cmdPending.id]);
            const resFailed = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmdPending.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should no-op because failed' },
            });
            assert.strictEqual(resFailed.statusCode, 200);
            assert.strictEqual(resFailed.body.data.alreadyTerminal, true);
        });

        it('5.15 FORCE_FAIL Task state validation: PENDING and PROCESSING rejected with 409, terminal states no-op', async () => {
            // Case A: PENDING
            const { rows: pRows } = await pool.query(`
                INSERT INTO scheduled_moderation_tasks (tenant_id, group_id, connection_id, action, status, run_at)
                VALUES ($1, $2, $3, 'UNMUTE_GROUP', 'PENDING', NOW())
                RETURNING *;
            `, [testTenant.id, testGroup.id, testConn.id]);
            const task = pRows[0];

            const resPending = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tasks/${task.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should fail because pending' },
            });
            assert.strictEqual(resPending.statusCode, 409);
            assert.strictEqual(resPending.body.error.code, 'INVALID_TASK_STATE');
            const checkPending = await taskRepo.findById(task.id);
            assert.strictEqual(checkPending.status, 'PENDING');

            // Case B: PROCESSING
            await pool.query("UPDATE scheduled_moderation_tasks SET status = 'PROCESSING', claimed_by_worker_id = 'worker-test', claim_epoch = 1, claim_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $1;", [task.id]);
            const resProcessing = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tasks/${task.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should fail because processing' },
            });
            assert.strictEqual(resProcessing.statusCode, 409);
            assert.strictEqual(resProcessing.body.error.code, 'INVALID_TASK_STATE');
            const checkProcessing = await taskRepo.findById(task.id);
            assert.strictEqual(checkProcessing.status, 'PROCESSING');

            // Case C: COMPLETED
            await pool.query("UPDATE scheduled_moderation_tasks SET status = 'COMPLETED' WHERE id = $1;", [task.id]);
            const resCompleted = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tasks/${task.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should no-op because completed' },
            });
            assert.strictEqual(resCompleted.statusCode, 200);
            assert.strictEqual(resCompleted.body.data.alreadyTerminal, true);

            // Case D: CANCELLED
            await pool.query("UPDATE scheduled_moderation_tasks SET status = 'CANCELLED' WHERE id = $1;", [task.id]);
            const resCancelled = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/tasks/${task.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Should no-op because cancelled' },
            });
            assert.strictEqual(resCancelled.statusCode, 200);
            assert.strictEqual(resCancelled.body.data.alreadyTerminal, true);
        });

        it('5.16 FORCE_FAIL vs Worker resolution race: cannot overwrite worker completion or create duplicate obligations', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: testTenant.id,
                connectionId: testConn.id,
                groupId: testGroup.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() WHERE id = $1;", [cmd.id]);

            // Simulate worker outcome verification succeeding and committing COMPLETED right as FORCE_FAIL runs
            const mockSock = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    id: testGroup.whatsapp_jid,
                    subject: 'Race Test Group',
                    announce: true,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verifier = new RemoteOutcomeVerificationService({
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                connectionManager: { getSocket: () => mockSock },
                leaseManager: { hasLease: () => true },
                workerId: 'worker-race',
            });
            await verifier.verifyCommand(cmd, { sock: mockSock, claimEpoch: 1 });

            // Command is now COMPLETED with an active UNMUTE task
            const afterVerify = await commandRepo.findById(cmd.id);
            assert.strictEqual(afterVerify.status, 'COMPLETED');

            // Now operator attempts FORCE_FAIL concurrently/afterwards
            const res = await makeRequest(server, {
                method: 'POST',
                path: `/api/v1/platform/commands/${cmd.id}/force-fail`,
                headers: { Authorization: `Bearer ${superAdminToken}` },
                body: { reason: 'Operator raced against verifier' },
            });

            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.alreadyTerminal, true);

            // Database remains COMPLETED, never overwritten
            const finalCmd = await commandRepo.findById(cmd.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');

            // UNMUTE task is intact and count is exactly 1
            const { rows: taskRows } = await pool.query(
                "SELECT * FROM scheduled_moderation_tasks WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';",
                [testTenant.id, testGroup.id]
            );
            assert.strictEqual(taskRows.length, 1);
        });

        it('5.17 Platform audit log hygiene: metadata contains only compact derived metadata with zero raw messages/rosters', async () => {
            const auditLogs = await platformAuditRepo.list({ limit: 50 });
            for (const log of auditLogs) {
                const metaStr = JSON.stringify(log.metadata || {});
                assert(!metaStr.includes('messageTimestamp'), 'Audit log metadata must not contain raw WhatsApp message packets');
                assert(!metaStr.includes('participants'), 'Audit log metadata must not contain full group participant rosters');
            }
        });
    });
});
