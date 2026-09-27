const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const fs = require('node:fs');
const path = require('node:path');

const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    ScheduledModerationTaskRepository,
    ConnectionCommandRepository,
    WorkerRepository,
    AuditLogRepository,
} = require('../src/repositories');
const { IdempotencyRepository } = require('../src/repositories/IdempotencyRepository');

const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerLeaseManager = require('../src/whatsapp/worker/WorkerLeaseManager');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const DurableModerationScheduler = require('../src/whatsapp/worker/DurableModerationScheduler');
const RemoteOutcomeVerificationService = require('../src/whatsapp/worker/RemoteOutcomeVerificationService');
const ModerationService = require('../src/application/services/ModerationService');
const MuteCommand = require('../src/application/commands/moderation/MuteCommand');
const UnmuteCommand = require('../src/application/commands/moderation/UnmuteCommand');
const WhatsAppModerationGateway = require('../src/gateways/WhatsAppModerationGateway');
const { createPipeline } = require('../src/application/createPipeline');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Phase 5A: Production Reliability, Recovery & Failure Semantics', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let groupRepo;
    let taskRepo;
    let commandRepo;
    let workerRepo;
    let auditLogRepo;
    let idempotencyRepo;

    let tenant;
    let conn;
    let group;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        taskRepo = new ScheduledModerationTaskRepository(pool);
        commandRepo = new ConnectionCommandRepository(pool);
        workerRepo = new WorkerRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        idempotencyRepo = new IdempotencyRepository(pool);

        tenant = await tenantRepo.create({ name: 'Phase 5A Reliability Tenant' });
        conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '15555000001',
            displayName: 'Phase 5A Connection',
            status: 'CONNECTED',
        });
        group = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363555555555555@g.us',
            name: 'Phase 5A Reliability Group',
            status: 'MANAGED',
        });
    });

    after(async () => {
        if (pool) {
            await pool.query('DELETE FROM connection_commands WHERE tenant_id = $1;', [tenant.id]).catch(() => {});
            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE tenant_id = $1;', [tenant.id]).catch(() => {});
            await pool.query('DELETE FROM api_idempotency_keys WHERE tenant_id = $1;', [tenant.id]).catch(() => {});
            await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id = $1;', [tenant.id]).catch(() => {});
            await pool.query('DELETE FROM tenants WHERE id = $1;', [tenant.id]).catch(() => {});
            await pool.end();
        }
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM connection_commands WHERE tenant_id = $1;', [tenant.id]);
        await pool.query('DELETE FROM scheduled_moderation_tasks WHERE tenant_id = $1;', [tenant.id]);
        await pool.query('DELETE FROM api_idempotency_keys WHERE tenant_id = $1;', [tenant.id]);
        await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = NULL, lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1;", [conn.id]);
    });

    // =========================================================================
    // 1. WORKER REGISTRATION FAIL-CLOSED
    // =========================================================================
    describe('1. Worker Startup Fail-Closed', () => {
        it('1.1 registration succeeds -> worker transitions to READY and can reconcile', async () => {
            const workerId = `w-test-success-${Date.now()}`;
            const cm = new ConnectionManager();
            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
            });

            await node.start();
            assert.strictEqual(node.status, 'READY');

            const dbWorker = await workerRepo.findById(workerId);
            assert.ok(dbWorker);
            assert.strictEqual(dbWorker.status, 'READY');

            await node.shutdown();
        });

        it('1.2 registration fails -> start() rejects and status is FAILED', async () => {
            const workerId = `w-test-fail-${Date.now()}`;
            const cm = new ConnectionManager();
            const failingWorkerRepo = {
                registerWorker: async () => {
                    throw new Error('Database connection refused');
                },
                heartbeat: async () => {},
                updateStatus: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo: failingWorkerRepo,
                pool,
            });

            await assert.rejects(
                async () => { await node.start(); },
                /Database connection refused/
            );

            assert.strictEqual(node.status, 'FAILED');
            assert.strictEqual(node.reconcileTimer, null);
            assert.strictEqual(node.workerHeartbeatTimer, null);
        });

        it('1.3 failed registration cannot claim leases or run reconciliation', async () => {
            const workerId = `w-test-nolease-${Date.now()}`;
            const cm = new ConnectionManager();
            const failingWorkerRepo = {
                registerWorker: async () => {
                    throw new Error('Registration DB down');
                },
                updateStatus: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo: failingWorkerRepo,
                pool,
            });

            await assert.rejects(async () => { await node.start(); });

            // Ensure desiredState = RUNNING on connection
            await pool.query("UPDATE whatsapp_connections SET desired_state = 'RUNNING', assigned_worker_id = NULL, lease_expires_at = NOW() - INTERVAL '1s' WHERE id = $1;", [conn.id]);

            // Attempt manual reconciliation call
            await node.reconcile();

            // Verify connection was NOT acquired by this failed worker
            const freshConn = await connRepo.findById(conn.id);
            assert.notStrictEqual(freshConn.assigned_worker_id, workerId);
        });
    });

    // =========================================================================
    // 2. DURABLE CONNECTION-COMMAND RECOVERY (CLASS A & B)
    // =========================================================================
    describe('2. Durable Connection-Command Recovery', () => {
        it('2.1 Class A: Expired PROCESSING with no remote start safely resets to PENDING', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });

            // Simulate worker crash: status=PROCESSING, claim expired, remote_started_at IS NULL
            await pool.query(`
                UPDATE connection_commands
                SET status = 'PROCESSING',
                    claim_expires_at = NOW() - INTERVAL '10 seconds',
                    remote_started_at = NULL,
                    attempt_count = 1
                WHERE id = $1;
            `, [cmd.id]);

            const res = await commandRepo.reapStaleCommands(null, { connectionIds: [conn.id] });
            assert.strictEqual(res.classARequeued, 1);
            assert.strictEqual(res.classBUnknown, 0);

            const recovered = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(recovered.status, 'PENDING');
            assert.strictEqual(recovered.attempt_count, 1, 'Attempt count must not decrement');
            assert.strictEqual(recovered.claimed_by_worker_id, null);
        });

        it('2.2 Class B: Expired PROCESSING with remote start transitions to REMOTE_OUTCOME_UNKNOWN', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });

            // Simulate worker crash after remote start
            await pool.query(`
                UPDATE connection_commands
                SET status = 'PROCESSING',
                    claim_expires_at = NOW() - INTERVAL '10 seconds',
                    remote_started_at = NOW() - INTERVAL '15 seconds',
                    attempt_count = 1
                WHERE id = $1;
            `, [cmd.id]);

            const res = await commandRepo.reapStaleCommands(null, { connectionIds: [conn.id] });
            assert.strictEqual(res.classBUnknown, 1);
            assert.strictEqual(res.classARequeued, 0);

            const recovered = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(recovered.status, 'REMOTE_OUTCOME_UNKNOWN');
            assert.strictEqual(recovered.last_error, 'CLAIM_EXPIRED_REMOTE_OUTCOME_UNKNOWN');
        });

        it('2.3 claimCommandForConnection never blindly claims REMOTE_OUTCOME_UNKNOWN', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });

            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN' WHERE id = $1;", [cmd.id]);

            const client = await pool.connect();
            try {
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: conn.id,
                    workerId: 'w-blind-test',
                    claimEpoch: 1,
                });
                assert.strictEqual(claimed, null, 'UNKNOWN commands must never be claimed by standard queue loop');
            } finally {
                client.release();
            }
        });

        it('2.4 Monotonic attempt_count and max_attempts terminal failure for Class A', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });

            // Set attempt_count = 3 (max_attempts = 3) with no remote start
            await pool.query(`
                UPDATE connection_commands
                SET status = 'PROCESSING',
                    claim_expires_at = NOW() - INTERVAL '5 seconds',
                    remote_started_at = NULL,
                    attempt_count = 3,
                    max_attempts = 3
                WHERE id = $1;
            `, [cmd.id]);

            const res = await commandRepo.reapStaleCommands(null, { connectionIds: [conn.id] });
            assert.strictEqual(res.classAFailed, 1);

            const failed = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(failed.status, 'FAILED');
            assert.strictEqual(failed.last_error, 'EXCEEDED_MAX_ATTEMPTS');
        });
    });

    // =========================================================================
    // 3. DURABLE SCHEDULED-TASK RECOVERY
    // =========================================================================
    describe('3. Durable Scheduled-Task Recovery', () => {
        it('3.1 Class A: Expired PROCESSING scheduled task with no remote start resets to PENDING', async () => {
            const task = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 60000),
            });

            await pool.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'PROCESSING',
                    claim_expires_at = NOW() - INTERVAL '5 seconds',
                    remote_started_at = NULL,
                    attempt_count = 1
                WHERE id = $1;
            `, [task.id]);

            const res = await taskRepo.reapStaleTasks(null, { connectionIds: [conn.id] });
            assert.strictEqual(res.classARequeued, 1);

            const recovered = await taskRepo.getTaskStatus(task.id);
            assert.strictEqual(recovered.status, 'PENDING');
        });

        it('3.2 Class B: Expired PROCESSING scheduled task with remote start becomes REMOTE_OUTCOME_UNKNOWN', async () => {
            const task = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 60000),
            });

            await pool.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'PROCESSING',
                    claim_expires_at = NOW() - INTERVAL '5 seconds',
                    remote_started_at = NOW() - INTERVAL '10 seconds',
                    attempt_count = 1
                WHERE id = $1;
            `, [task.id]);

            const res = await taskRepo.reapStaleTasks(null, { connectionIds: [conn.id] });
            assert.strictEqual(res.classBUnknown, 1);

            const recovered = await taskRepo.getTaskStatus(task.id);
            assert.strictEqual(recovered.status, 'REMOTE_OUTCOME_UNKNOWN');
        });
    });

    // =========================================================================
    // 4. REMOTE OUTCOME VERIFICATION (MUTE, UNMUTE, KICK)
    // =========================================================================
    describe('4. Remote Outcome Verification Service', () => {
        let cm;
        let lm;
        let verifier;

        beforeEach(async () => {
            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = 'w-verifier-test',
                    lease_epoch = 1,
                    lease_expires_at = NOW() + INTERVAL '60 seconds'
                WHERE id = $1;
            `, [conn.id]);

            cm = new ConnectionManager();
            lm = new WorkerLeaseManager({
                workerId: 'w-verifier-test',
                connRepo,
                connectionManager: cm,
            });
            lm.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            verifier = new RemoteOutcomeVerificationService({
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                connectionManager: cm,
                leaseManager: lm,
                auditLogRepo,
                workerId: 'w-verifier-test',
            });
        });

        it('4.1 MUTE_GROUP + announce=true -> COMPLETED and creates exactly one UNMUTE task', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 15 },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() WHERE id = $1;", [cmd.id]);

            // Mock socket returning announce: true
            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({ announce: true }),
            };
            cm.connections.set(conn.id, { sock: mockSocket });

            const verified = await verifier.verifyCommand(cmd, { sock: mockSocket, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');

            // Assert exactly one scheduled unmute task was created
            const tasksRes = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND action = \'UNMUTE_GROUP\';', [group.id]);
            assert.strictEqual(tasksRes.rows.length, 1);
            assert.strictEqual(tasksRes.rows[0].status, 'PENDING');
            assert.strictEqual(tasksRes.rows[0].payload.durationMinutes, 15);
        });

        it('4.2 MUTE_GROUP + announce=false + expired window -> FAILED (no blind re-muting)', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 15 },
            });
            // 70s ago: window expired (>60s)
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', remote_started_at = NOW() - INTERVAL '70 seconds', claimed_by_worker_id = 'w-verifier-test', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSocket, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'REMOTE_MUTE_NOT_OBSERVED_TIMED_OUT');
        });

        it('4.3 UNMUTE_GROUP + announce=false -> COMPLETED', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'UNMUTE_GROUP',
                payload: {},
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-verifier-test', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSocket = {
                groupMetadata: async () => ({ announce: false }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSocket, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');
        });

        it('4.4 KICK_PARTICIPANT + target absent -> COMPLETED', async () => {
            const targetJid = 'badactor@s.whatsapp.net';
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'KICK_PARTICIPANT',
                payload: { participantJid: targetJid },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-verifier-test', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSocket = {
                groupMetadata: async () => ({
                    participants: [{ id: 'innocent@s.whatsapp.net' }],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSocket, claimEpoch: 1 });
            assert.strictEqual(verified, true);

            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');
            assert.strictEqual(finalCmd.result.verifiedAbsent, true);
        });

        it('4.5 KICK_PARTICIPANT + target still present -> FAILED without spam retry', async () => {
            const targetJid = 'persistent@s.whatsapp.net';
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'KICK_PARTICIPANT',
                payload: { participantJid: targetJid },
            });
            await pool.query("UPDATE connection_commands SET status = 'REMOTE_OUTCOME_UNKNOWN', claimed_by_worker_id = 'w-verifier-test', claim_epoch = 1 WHERE id = $1;", [cmd.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: targetJid, admin: null },
                    ],
                }),
            };

            const verified = await verifier.verifyCommand(cmd, { sock: mockSocket, claimEpoch: 1 });
            assert.strictEqual(verified, false);

            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'FAILED');
            assert.strictEqual(finalCmd.last_error, 'PARTICIPANT_REMAINS_PRESENT_AFTER_KICK');
        });
    });

    // =========================================================================
    // 5. DURABLE TIMED MUTE UNIFICATION & EXECUTION SEMANTICS (TESTS A - G)
    // =========================================================================
    describe('5. Durable Timed-Mute Unification & Execution Semantics', () => {
        it('5.1 Test A: Chat MUTE success (.mute 10 -> durable command -> worker processes -> exactly 1 UNMUTE task)', async () => {
            const workerId = `w-mute-a-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            let groupSettingCalledWith = null;
            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async (jid, setting) => {
                    groupSettingCalledWith = setting;
                    return true;
                },
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            const appCtx = {
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['10'] },
            };

            // In-band chat execution
            const res = await muteCmd.execute(appCtx, { moderationService: modService });
            assert.strictEqual(res.success, true);

            // Command was durably created in connection_commands
            const pendingCmds = await pool.query("SELECT * FROM connection_commands WHERE connection_id = $1 AND command_type = 'MUTE_GROUP';", [conn.id]);
            assert.strictEqual(pendingCmds.rows.length, 1);
            assert.strictEqual(pendingCmds.rows[0].status, 'PENDING');
            assert.strictEqual(pendingCmds.rows[0].payload.durationMinutes, 10);

            // Invariant: NO scheduled unmute task exists prior to worker processing
            let tasksRes = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(tasksRes.rows.length, 0);

            // Worker claims and executes command
            await node._processPendingCommands();

            // Assert command COMPLETED and remote setting updated
            const completedCmd = await commandRepo.findByIdForTenant(pendingCmds.rows[0].id, tenant.id);
            assert.strictEqual(completedCmd.status, 'COMPLETED');
            assert.strictEqual(groupSettingCalledWith, 'announcement');

            // Assert exactly 1 UNMUTE task in scheduled_moderation_tasks
            tasksRes = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(tasksRes.rows.length, 1);
            assert.strictEqual(tasksRes.rows[0].action, 'UNMUTE_GROUP');
            assert.strictEqual(tasksRes.rows[0].status, 'PENDING');
            assert.strictEqual(tasksRes.rows[0].payload.durationMinutes, 10);

            node.stop();
        });

        it('5.2 Test B: Chat MUTE remote failure (gateway throws -> command FAILED/retryable -> 0 UNMUTE tasks)', async () => {
            const workerId = `w-mute-b-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async () => {
                    throw new Error('Connection reset by peer');
                },
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            const appCtx = {
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['10'] },
            };

            await muteCmd.execute(appCtx, { moderationService: modService });
            const pendingCmds = await pool.query("SELECT * FROM connection_commands WHERE connection_id = $1 AND command_type = 'MUTE_GROUP';", [conn.id]);
            assert.strictEqual(pendingCmds.rows.length, 1);

            // Worker processes command and encounters gateway error
            await node._processPendingCommands();

            // Command must NOT be completed
            const nonCompletedCmd = await commandRepo.findByIdForTenant(pendingCmds.rows[0].id, tenant.id);
            assert.notStrictEqual(nonCompletedCmd.status, 'COMPLETED');

            // Authoritative invariant: ZERO scheduled unmute tasks created
            const tasksRes = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(tasksRes.rows.length, 0);

            node.stop();
        });

        it('5.3 Test C: Chat MUTE crash after remote side effect -> REMOTE_OUTCOME_UNKNOWN -> verified -> 1 UNMUTE task', async () => {
            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway({ user: { id: 'bot@s.whatsapp.net' } }),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            const appCtx = {
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['15'] },
            };

            await muteCmd.execute(appCtx, { moderationService: modService });
            const cmdRes = await pool.query("SELECT * FROM connection_commands WHERE connection_id = $1 AND command_type = 'MUTE_GROUP';", [conn.id]);
            const cmd = cmdRes.rows[0];

            // Simulate worker dispatched remote mute to WhatsApp, marked remote_started_at, and then crashed
            await pool.query(`
                UPDATE connection_commands
                SET status = 'PROCESSING',
                    claimed_by_worker_id = 'crashed-worker',
                    claim_epoch = 1,
                    claim_expires_at = NOW() - INTERVAL '5 seconds',
                    remote_started_at = NOW() - INTERVAL '10 seconds',
                    attempt_count = 1
                WHERE id = $1;
            `, [cmd.id]);

            // Zero unmute tasks exist during crash state
            let tasks = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(tasks.rows.length, 0);

            // Command reaper sweeps and transitions to REMOTE_OUTCOME_UNKNOWN
            const reapRes = await commandRepo.reapStaleCommands(null, { connectionIds: [conn.id] });
            assert.strictEqual(reapRes.classBUnknown, 1);

            const unknownCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(unknownCmd.status, 'REMOTE_OUTCOME_UNKNOWN');

            // Still 0 unmute tasks
            tasks = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(tasks.rows.length, 0);

            // Active worker runs RemoteOutcomeVerificationService
            const verifierWorker = 'w-verifier-c';
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 2, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [verifierWorker, conn.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: true, // WhatsApp was muted
                    participants: [{ id: 'bot@s.whatsapp.net', admin: 'admin' }],
                }),
            };

            const verifier = new RemoteOutcomeVerificationService({
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                connectionManager: { getSocket: () => mockSocket, hasSocket: () => true },
                leaseManager: { getLease: () => ({ leaseEpoch: 2 }) },
                workerId: verifierWorker,
            });

            const verified = await verifier.verifyCommand(unknownCmd, { sock: mockSocket, claimEpoch: 2 });
            assert.strictEqual(verified, true);

            // Command is COMPLETED
            const finalCmd = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(finalCmd.status, 'COMPLETED');

            // Exactly 1 UNMUTE task created
            tasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND action = 'UNMUTE_GROUP';", [group.id]);
            assert.strictEqual(tasks.rows.length, 1);
            assert.strictEqual(tasks.rows[0].status, 'PENDING');
            assert.strictEqual(tasks.rows[0].payload.durationMinutes, 15);
        });

        it('5.4 Test D: Concurrent REST + chat MUTE (no duplicate active obligations; atomic replacement leaves 1 pending)', async () => {
            const workerId = `w-mute-d-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async () => true,
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            // 1. REST command creates MUTE_GROUP
            await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'MUTE_GROUP',
                payload: { durationMinutes: 10 },
            });

            // 2. Chat .mute 20 creates MUTE_GROUP
            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            const appCtx = {
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['20'] },
            };
            await muteCmd.execute(appCtx, { moderationService: modService });

            // Worker processes both commands
            await node._processPendingCommands();
            await node._processPendingCommands();

            // Both commands are COMPLETED
            const allCmds = await pool.query("SELECT * FROM connection_commands WHERE connection_id = $1 AND command_type = 'MUTE_GROUP' ORDER BY id ASC;", [conn.id]);
            assert.strictEqual(allCmds.rows.length, 2);
            assert.strictEqual(allCmds.rows[0].status, 'COMPLETED');
            assert.strictEqual(allCmds.rows[1].status, 'COMPLETED');

            // Exact obligation count: exactly 1 PENDING task active
            const pendingTasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';", [group.id]);
            assert.strictEqual(pendingTasks.rows.length, 1);

            // Total tasks: 2 (1 CANCELLED by replacement semantics, 1 PENDING)
            const allTasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND action = 'UNMUTE_GROUP';", [group.id]);
            assert.strictEqual(allTasks.rows.length, 2);

            node.stop();
        });

        it('5.5 Test E: Remute replacement (.mute 10 followed by .mute 20 -> task 1 CANCELLED, task 2 PENDING at T+20)', async () => {
            const workerId = `w-mute-e-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async () => true,
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();

            // First mute: 10 minutes
            await muteCmd.execute({
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['10'] },
            }, { moderationService: modService });

            await node._processPendingCommands();

            const firstTaskRes = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND status = 'PENDING';", [group.id]);
            assert.strictEqual(firstTaskRes.rows.length, 1);
            const firstTaskId = firstTaskRes.rows[0].id;
            assert.strictEqual(firstTaskRes.rows[0].payload.durationMinutes, 10);

            // Second mute: 20 minutes (re-mute)
            await muteCmd.execute({
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['20'] },
            }, { moderationService: modService });

            await node._processPendingCommands();

            // Task 1 must now be CANCELLED
            const oldTask = await pool.query('SELECT * FROM scheduled_moderation_tasks WHERE id = $1;', [firstTaskId]);
            assert.strictEqual(oldTask.rows[0].status, 'CANCELLED');

            // Task 2 must be PENDING with duration 20
            const activeTask = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND status = 'PENDING';", [group.id]);
            assert.strictEqual(activeTask.rows.length, 1);
            assert.strictEqual(activeTask.rows[0].payload.durationMinutes, 20);

            node.stop();
        });

        it('5.6 Test F: Manual unmute (.mute 10 followed by .unmute -> pending UNMUTE task CANCELLED, 0 pending)', async () => {
            const workerId = `w-mute-f-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            let groupSettingCalledWith = [];
            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: true,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: 'admin' },
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async (jid, setting) => {
                    groupSettingCalledWith.push(setting);
                    return true;
                },
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            const unmuteCmd = new UnmuteCommand();

            // 1. Mute 10 minutes
            await muteCmd.execute({
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['10'] },
            }, { moderationService: modService });

            await node._processPendingCommands();

            // Verify 1 pending task exists
            let tasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND status = 'PENDING';", [group.id]);
            assert.strictEqual(tasks.rows.length, 1);

            // 2. Manual Unmute
            const unmuteRes = await unmuteCmd.execute({
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: [] },
            }, { moderationService: modService });
            assert.strictEqual(unmuteRes.success, true);

            // Invariant: unmuteGroup immediately cancels any pending UNMUTE_GROUP tasks in PostgreSQL
            tasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND status = 'PENDING';", [group.id]);
            assert.strictEqual(tasks.rows.length, 0);

            // Process UNMUTE_GROUP command via worker
            await node._processPendingCommands();

            // Verify groupSettingUpdate was called with 'not_announcement'
            assert.ok(groupSettingCalledWith.includes('not_announcement'));

            // Verify 0 pending tasks remain
            tasks = await pool.query("SELECT * FROM scheduled_moderation_tasks WHERE group_id = $1 AND status = 'PENDING';", [group.id]);
            assert.strictEqual(tasks.rows.length, 0);

            node.stop();
        });

        it('5.7 Test G: Failed MUTE never creates UNMUTE (bot not admin -> command FAILED -> COUNT(UNMUTE_GROUP) = 0)', async () => {
            const workerId = `w-mute-g-${Date.now()}`;
            await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = $1, lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '1 minute' WHERE id = $2;", [workerId, conn.id]);

            const mockSocket = {
                user: { id: 'bot@s.whatsapp.net' },
                groupMetadata: async () => ({
                    announce: false,
                    participants: [
                        { id: 'bot@s.whatsapp.net', admin: null }, // Bot is NOT an admin
                        { id: 'sender@s.whatsapp.net', admin: 'admin' },
                    ],
                }),
                groupSettingUpdate: async () => true,
                sendMessage: async () => ({ key: { id: 'msg-1' } }),
            };

            const cm = {
                getSocket: () => mockSocket,
                hasSocket: () => true,
                abortConnection: async () => {},
            };

            const node = new WorkerNode({
                workerId,
                connectionManager: cm,
                connRepo,
                workerRepo,
                pool,
                commandRepo,
                taskRepo,
                groupRepo,
                heartbeatIntervalMs: 60000,
                watchdogTimeoutMs: 60000,
            });
            node.leaseManager.registerLease({ connectionId: conn.id, tenantId: tenant.id, leaseEpoch: 1 });

            const modService = new ModerationService({
                gateway: new WhatsAppModerationGateway(mockSocket),
                taskRepo,
                commandRepo,
                pool,
            });
            const muteCmd = new MuteCommand();
            await muteCmd.execute({
                tenantId: tenant.id,
                connectionId: conn.id,
                group: { id: group.id, whatsappJid: group.whatsapp_jid, status: 'MANAGED' },
                actor: { isBotAdmin: true, isSenderAdmin: true },
                message: { args: ['10'] },
            }, { moderationService: modService });

            const pendingCmds = await pool.query("SELECT * FROM connection_commands WHERE connection_id = $1 AND command_type = 'MUTE_GROUP';", [conn.id]);
            assert.strictEqual(pendingCmds.rows.length, 1);

            // Worker executes command: adminStatus.isBotAdmin check fails
            await node._processPendingCommands();

            const failedCmd = await commandRepo.findByIdForTenant(pendingCmds.rows[0].id, tenant.id);
            assert.strictEqual(failedCmd.status, 'FAILED');
            assert.strictEqual(failedCmd.last_error, 'BOT_NOT_ADMIN');

            // Authoritative invariant: ZERO UNMUTE tasks created
            const tasksCount = await pool.query('SELECT COUNT(*) FROM scheduled_moderation_tasks WHERE group_id = $1;', [group.id]);
            assert.strictEqual(parseInt(tasksCount.rows[0].count, 10), 0);

            node.stop();
        });
    });

    // =========================================================================
    // 6. PHASE 4F OPTION B TENANT SUSPENSION
    // =========================================================================
    describe('6. Phase 4F Option B Tenant Suspension & Reactivation', () => {
        it('6.1 Suspension pauses PENDING tasks but preserves UNKNOWN and PROCESSING', async () => {
            // Task 1: PENDING
            const taskPending = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60000),
            });

            // Task 2: PROCESSING (remote_started_at IS NULL)
            const taskProcessing = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 10000),
            });
            await pool.query("UPDATE scheduled_moderation_tasks SET status = 'PROCESSING', claim_expires_at = NOW() + INTERVAL '30s' WHERE id = $1;", [taskProcessing.id]);

            // Task 3: REMOTE_OUTCOME_UNKNOWN
            const taskUnknown = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 30000),
            });
            await pool.query("UPDATE scheduled_moderation_tasks SET status = 'REMOTE_OUTCOME_UNKNOWN' WHERE id = $1;", [taskUnknown.id]);

            // Suspend tenant tasks
            const pausedCount = await taskRepo.pauseTasksForTenant(null, tenant.id);
            assert.strictEqual(pausedCount, 1, 'Only PENDING task must be paused');

            const s1 = await taskRepo.getTaskStatus(taskPending.id);
            assert.strictEqual(s1.status, 'PAUSED');

            const s2 = await taskRepo.getTaskStatus(taskProcessing.id);
            assert.strictEqual(s2.status, 'PROCESSING', 'PROCESSING task must NOT be paused');

            const s3 = await taskRepo.getTaskStatus(taskUnknown.id);
            assert.strictEqual(s3.status, 'REMOTE_OUTCOME_UNKNOWN', 'UNKNOWN task must NOT be overwritten');

            // Reactivate tenant tasks
            const resumedCount = await taskRepo.resumeTasksForTenant(null, tenant.id);
            assert.strictEqual(resumedCount, 1);

            const r1 = await taskRepo.getTaskStatus(taskPending.id);
            assert.strictEqual(r1.status, 'PENDING');
        });
    });

    // =========================================================================
    // 7. FENCING SEMANTICS
    // =========================================================================
    describe('7. Fenced Command and Task Finalization', () => {
        it('7.1 Stale worker cannot finalize command after lease epoch advances', async () => {
            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenant.id,
                connectionId: conn.id,
                groupId: group.id,
                commandType: 'UNMUTE_GROUP',
                payload: {},
            });

            // Worker A claims command under epoch 1
            await pool.query(`
                UPDATE connection_commands
                SET status = 'PROCESSING', claimed_by_worker_id = 'w-worker-A', claim_epoch = 1, claim_expires_at = NOW() + INTERVAL '30s'
                WHERE id = $1;
            `, [cmd.id]);

            // Meanwhile, lease for connection advances to Worker B at epoch 2
            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = 'w-worker-B', lease_epoch = 2, lease_expires_at = NOW() + INTERVAL '30s'
                WHERE id = $1;
            `, [conn.id]);

            // Worker A tries to complete the command
            const completedByA = await commandRepo.completeCommand(null, {
                id: cmd.id,
                workerId: 'w-worker-A',
                claimEpoch: 1,
            });
            assert.strictEqual(completedByA, false, 'Stale worker A must be fenced out from command completion');

            // Verify command is still PROCESSING
            const fresh = await commandRepo.findByIdForTenant(cmd.id, tenant.id);
            assert.strictEqual(fresh.status, 'PROCESSING');
        });

        it('7.2 Stale worker cannot finalize scheduled task after lease epoch advances', async () => {
            const task = await taskRepo.createTask(null, {
                tenantId: tenant.id,
                groupId: group.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 10000),
            });

            // Worker A claims task at epoch 1
            await pool.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'PROCESSING', claimed_by_worker_id = 'w-worker-A', claim_epoch = 1, claim_expires_at = NOW() + INTERVAL '30s'
                WHERE id = $1;
            `, [task.id]);

            // Connection lease epoch advances to 2 for Worker B
            await pool.query(`
                UPDATE whatsapp_connections
                SET assigned_worker_id = 'w-worker-B', lease_epoch = 2, lease_expires_at = NOW() + INTERVAL '30s'
                WHERE id = $1;
            `, [conn.id]);

            const completedByA = await taskRepo.completeTask(null, {
                id: task.id,
                workerId: 'w-worker-A',
                claimEpoch: 1,
            });
            assert.strictEqual(completedByA, false, 'Stale worker A must be fenced out from task completion');
        });
    });

    // =========================================================================
    // 8. SCHEMA INTEGRITY
    // =========================================================================
    describe('8. Database Migration Terminal Baseline', () => {
        it('8.1 Migrations 001-010 exist and migration 011 is strictly prohibited', async () => {
            const migrationsDir = path.join(__dirname, '../src/database/migrations');
            const files = fs.readdirSync(migrationsDir);

            // Confirm 001 through 010 up files exist
            for (let i = 1; i <= 10; i++) {
                const prefix = String(i).padStart(3, '0');
                const hasUp = files.some((f) => f.startsWith(prefix) && f.endsWith('.up.sql'));
                assert.strictEqual(hasUp, true, `Migration ${prefix} up file must exist`);
            }

            // Confirm no migration 011 or higher exists
            const has011 = files.some((f) => f.startsWith('011'));
            assert.strictEqual(has011, false, 'Migration 011 must NOT exist in the codebase');
        });
    });
});
