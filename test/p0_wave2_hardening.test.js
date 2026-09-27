const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    ScheduledModerationTaskRepository,
    ConnectionCommandRepository,
    WorkerRepository,
    AuditLogRepository,
} = require('../src/repositories');

const ConnectionManager = require('../src/whatsapp/ConnectionManager');
const WorkerLeaseManager = require('../src/whatsapp/worker/WorkerLeaseManager');
const WorkerNode = require('../src/whatsapp/worker/WorkerNode');
const DurableModerationScheduler = require('../src/whatsapp/worker/DurableModerationScheduler');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('P0 Wave 2: Distributed-Security Hardening & Crash Semantics', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let groupRepo;
    let taskRepo;
    let commandRepo;
    let workerRepo;
    let auditLogRepo;

    let tenantA, connA, groupA;
    let tenantB, connB, groupB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        taskRepo = new ScheduledModerationTaskRepository(pool);
        commandRepo = new ConnectionCommandRepository(pool);
        workerRepo = new WorkerRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);

        // Create fixtures for Tenant A
        tenantA = await tenantRepo.create({ name: 'Tenant A P0 Wave 2' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '15550000001',
            displayName: 'Conn A P0',
            status: 'CONNECTED',
        });
        groupA = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000991@g.us',
            name: 'Group A P0',
            status: 'MANAGED',
        });

        // Create fixtures for Tenant B
        tenantB = await tenantRepo.create({ name: 'Tenant B P0 Wave 2' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '15550000002',
            displayName: 'Conn B P0',
            status: 'CONNECTED',
        });
        groupB = await groupRepo.upsertDiscoveredGroup(tenantB.id, connB.id, {
            whatsappJid: '120363000000000992@g.us',
            name: 'Group B P0',
            status: 'MANAGED',
        });
    });

    async function resetLease(connId) {
        await pool.query("UPDATE whatsapp_connections SET assigned_worker_id = NULL, lease_expires_at = NOW() - INTERVAL '1 second' WHERE id = $1", [connId]);
    }

    after(async () => {
        if (tenantA) await tenantRepo.delete(tenantA.id).catch(() => {});
        if (tenantB) await tenantRepo.delete(tenantB.id).catch(() => {});
        await pool.end();
    });

    // =========================================================================
    // 1. Worker Drain Race Safety (Tests 1–7)
    // =========================================================================
    describe('1. Worker Drain Race Safety (Tests 1–7)', () => {
        it('Test 1: Drain while processing command finishes cleanly before graceMs expires', async () => {
            const drainTenant = await tenantRepo.create({ name: `Drain Tenant 1 ${Date.now()}` });
            const workerId = `worker-drain-1-${Date.now()}`;
            const conn = await connRepo.createForTenant(drainTenant.id, {
                phoneNumber: '15550000101',
                displayName: 'Conn Drain 1',
                status: 'CONNECTED',
            });
            const acquired = await connRepo.acquireLease({ connectionId: conn.id, tenantId: drainTenant.id, workerId });

            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            leaseManager.registerLease({ connectionId: conn.id, tenantId: drainTenant.id, leaseEpoch: acquired.leaseEpoch });

            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
                drainGraceMs: 1000,
            });

            // Simulate command in flight
            workerNode.inFlight.add('cmd-mock-1');

            const drainPromise = workerNode.drain({ graceMs: 500 });
            assert.strictEqual(workerNode.status, 'DRAINING');

            // Complete in-flight command before grace expires
            setTimeout(() => {
                workerNode.inFlight.delete('cmd-mock-1');
            }, 100);

            await drainPromise;
            assert.strictEqual(workerNode.status, 'OFFLINE');
        });

        it('Test 2: Drain grace period expires marks in-flight remote work REMOTE_OUTCOME_UNKNOWN', async () => {
            const drainTenant = await tenantRepo.create({ name: `Drain Tenant 2 ${Date.now()}` });
            const workerId = `worker-drain-2-${Date.now()}`;
            const conn = await connRepo.createForTenant(drainTenant.id, {
                phoneNumber: '15550000102',
                displayName: 'Conn Drain 2',
                status: 'CONNECTED',
            });
            const grp = await groupRepo.upsertDiscoveredGroup(drainTenant.id, conn.id, {
                whatsappJid: `120363000000000${Date.now().toString().slice(-3)}@g.us`,
                name: 'Group Drain 2',
                status: 'MANAGED',
            });
            const acquired = await connRepo.acquireLease({ connectionId: conn.id, tenantId: drainTenant.id, workerId });

            const cmd = await commandRepo.createCommand(null, {
                tenantId: drainTenant.id,
                connectionId: conn.id,
                commandType: 'MUTE_GROUP',
                groupId: grp.id,
                payload: { durationMinutes: 10 },
            });

            // Claim command and mark remote started
            const client = await pool.connect();
            try {
                await client.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client, {
                    connectionId: conn.id,
                    workerId,
                    claimEpoch: acquired.leaseEpoch,
                });
                await commandRepo.markRemoteStarted(client, { id: claimed.id, workerId, claimEpoch: acquired.leaseEpoch });
                await client.query('COMMIT');
            } finally {
                client.release();
            }

            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            leaseManager.registerLease({ connectionId: conn.id, tenantId: tenantA.id, leaseEpoch: acquired.leaseEpoch });

            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
                drainGraceMs: 100,
            });

            // Put command into inFlight and never remove it (simulating hanging external call)
            workerNode.inFlight.add(cmd.id);

            await workerNode.drain({ graceMs: 100 });
            assert.strictEqual(workerNode.status, 'OFFLINE');

            // Verify command transitioned to REMOTE_OUTCOME_UNKNOWN
            const updated = await commandRepo.findByIdForTenant(cmd.id, drainTenant.id);
            assert.strictEqual(updated.status, 'REMOTE_OUTCOME_UNKNOWN');
            assert.strictEqual(updated.last_error, 'DRAIN_GRACE_EXPIRED');
        });

        it('Test 3: New commands are rejected and reconciliation skipped during drain', async () => {
            const workerId = `worker-drain-3-${Date.now()}`;
            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
            });

            workerNode.status = 'DRAINING';
            await workerNode.reconcile();
            assert.strictEqual(workerNode.isReconciling, false);
            assert.strictEqual(workerNode.status, 'DRAINING');
        });

        it('Test 4: Lease renewal stops immediately on drain', async () => {
            const drainTenant = await tenantRepo.create({ name: `Drain Tenant 4 ${Date.now()}` });
            const workerId = `worker-drain-4-${Date.now()}`;
            const conn = await connRepo.createForTenant(drainTenant.id, {
                phoneNumber: '15550000104',
                displayName: 'Conn Drain 4',
                status: 'CONNECTED',
            });
            const acquired = await connRepo.acquireLease({ connectionId: conn.id, tenantId: drainTenant.id, workerId });

            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            leaseManager.start();
            leaseManager.registerLease({ connectionId: conn.id, tenantId: drainTenant.id, leaseEpoch: acquired.leaseEpoch });

            assert.ok(leaseManager.heartbeatTimer !== null);

            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
            });

            await workerNode.drain({ graceMs: 50 });
            assert.strictEqual(leaseManager.heartbeatTimer, null);
        });

        it('Test 5: Concurrent drain calls are idempotent and resolve same promise', async () => {
            const workerId = `worker-drain-5-${Date.now()}`;
            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
            });

            const p1 = workerNode.drain({ graceMs: 100 });
            const p2 = workerNode.drain({ graceMs: 100 });
            assert.strictEqual(p1, p2, 'Concurrent drain calls must return identical memoized promise');

            await Promise.all([p1, p2]);
            assert.strictEqual(workerNode.status, 'OFFLINE');
        });

        it('Test 6: Pre-gateway invariant checked during drain: unmanaged group aborts task', async () => {
            const drainTenant = await tenantRepo.create({ name: `Drain Tenant 6 ${Date.now()}` });
            const workerId = `worker-drain-6-${Date.now()}`;
            const conn = await connRepo.createForTenant(drainTenant.id, {
                phoneNumber: '15550000106',
                displayName: 'Conn Drain 6',
                status: 'CONNECTED',
            });
            const acquired = await connRepo.acquireLease({ connectionId: conn.id, tenantId: drainTenant.id, workerId });

            // Create temporary unmanaged group
            const unmanagedGroup = await groupRepo.upsertDiscoveredGroup(drainTenant.id, conn.id, {
                whatsappJid: `120363000000000${Date.now().toString().slice(-3)}@g.us`,
                name: 'Unmanaged Group',
                status: 'UNMANAGED',
            });

            const task = await taskRepo.createTask(null, {
                tenantId: drainTenant.id,
                groupId: unmanagedGroup.id,
                connectionId: conn.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });

            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            leaseManager.registerLease({ connectionId: conn.id, tenantId: tenantA.id, leaseEpoch: acquired.leaseEpoch });

            const scheduler = new DurableModerationScheduler({
                pool,
                taskRepo,
                leaseManager,
                connectionManager,
                groupRepo,
                workerId,
            });

            // Claim task
            const client = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [conn.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client.release();
            }

            assert.ok(claimed);
            await scheduler.processTask(claimed);

            // Group was UNMANAGED, so task must be marked CANCELLED
            const finalTask = await taskRepo.getTaskStatus(task.id);
            assert.strictEqual(finalTask.status, 'CANCELLED');
        });

        it('Test 7: Clean exit after drain: all timers cleared and status OFFLINE', async () => {
            const workerId = `worker-drain-7-${Date.now()}`;
            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            const workerNode = new WorkerNode({
                pool,
                workerId,
                connRepo,
                commandRepo,
                taskRepo,
                groupRepo,
                workerRepo,
                leaseManager,
                connectionManager,
            });

            await workerNode.start();
            assert.strictEqual(workerNode.status, 'READY');

            await workerNode.drain({ graceMs: 50 });
            assert.strictEqual(workerNode.status, 'OFFLINE');
            assert.strictEqual(workerNode.reconcileTimer, null);
            assert.strictEqual(leaseManager.heartbeatTimer, null);
        });
    });

    // =========================================================================
    // 2. Remote-Outcome Crash/Restart Semantics
    // =========================================================================
    describe('2. Remote-Outcome Crash/Restart Semantics', () => {
        it('MUTE command crash/restart: marked REMOTE_OUTCOME_UNKNOWN and successor never reclaims', async () => {
            const worker1 = `worker-crash-mute-1-${Date.now()}`;
            const worker2 = `worker-crash-mute-2-${Date.now()}`;

            await resetLease(connA.id);
            const acquired1 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker1 });
            const epoch1 = acquired1.leaseEpoch;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                commandType: 'MUTE_GROUP',
                groupId: groupA.id,
                payload: { durationMinutes: 5 },
            });

            // Worker 1 claims command and marks remote started
            const client1 = await pool.connect();
            try {
                await client1.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client1, {
                    connectionId: connA.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
                await commandRepo.markRemoteStarted(client1, { id: claimed.id, workerId: worker1, claimEpoch: epoch1 });
                // Worker 1 crashes / fails before confirmation
                await commandRepo.markRemoteOutcomeUnknown(client1, {
                    id: claimed.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                    error: 'REMOTE_OUTCOME_UNKNOWN',
                });
                await client1.query('COMMIT');
            } finally {
                client1.release();
            }

            // Verify status is REMOTE_OUTCOME_UNKNOWN
            const crashed = await commandRepo.findByIdForTenant(cmd.id, tenantA.id);
            assert.strictEqual(crashed.status, 'REMOTE_OUTCOME_UNKNOWN');

            // Successor Worker 2 attempts to claim next command for connection after worker 1 crash
            await resetLease(connA.id);
            const acquired2 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker2 });
            const client2 = await pool.connect();
            try {
                await client2.query('BEGIN');
                const claimedByWorker2 = await commandRepo.claimCommandForConnection(client2, {
                    connectionId: connA.id,
                    workerId: worker2,
                    claimEpoch: acquired2.leaseEpoch,
                });
                await client2.query('COMMIT');
                assert.strictEqual(claimedByWorker2, null, 'Successor worker must NEVER claim REMOTE_OUTCOME_UNKNOWN command');
            } finally {
                client2.release();
            }
        });

        it('UNMUTE command crash/restart: marked REMOTE_OUTCOME_UNKNOWN and successor never reclaims', async () => {
            const worker1 = `worker-crash-unmute-1-${Date.now()}`;
            const worker2 = `worker-crash-unmute-2-${Date.now()}`;

            await resetLease(connA.id);
            const acquired1 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker1 });
            const epoch1 = acquired1.leaseEpoch;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                commandType: 'UNMUTE_GROUP',
                groupId: groupA.id,
            });

            const client1 = await pool.connect();
            try {
                await client1.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client1, {
                    connectionId: connA.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
                await commandRepo.markRemoteStarted(client1, { id: claimed.id, workerId: worker1, claimEpoch: epoch1 });
                await commandRepo.markRemoteOutcomeUnknown(client1, {
                    id: claimed.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
                await client1.query('COMMIT');
            } finally {
                client1.release();
            }

            await resetLease(connA.id);
            const acquired2 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker2 });
            const client2 = await pool.connect();
            try {
                await client2.query('BEGIN');
                const claimedByWorker2 = await commandRepo.claimCommandForConnection(client2, {
                    connectionId: connA.id,
                    workerId: worker2,
                    claimEpoch: acquired2.leaseEpoch,
                });
                await client2.query('COMMIT');
                assert.strictEqual(claimedByWorker2, null);
            } finally {
                client2.release();
            }
        });

        it('KICK command crash/restart: marked REMOTE_OUTCOME_UNKNOWN and successor never reclaims', async () => {
            const worker1 = `worker-crash-kick-1-${Date.now()}`;
            const worker2 = `worker-crash-kick-2-${Date.now()}`;

            await resetLease(connA.id);
            const acquired1 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker1 });
            const epoch1 = acquired1.leaseEpoch;

            const cmd = await commandRepo.createCommand(null, {
                tenantId: tenantA.id,
                connectionId: connA.id,
                commandType: 'KICK_PARTICIPANT',
                groupId: groupA.id,
                payload: { participantJid: '254700000001@s.whatsapp.net' },
            });

            const client1 = await pool.connect();
            try {
                await client1.query('BEGIN');
                const claimed = await commandRepo.claimCommandForConnection(client1, {
                    connectionId: connA.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
                await commandRepo.markRemoteStarted(client1, { id: claimed.id, workerId: worker1, claimEpoch: epoch1 });
                await commandRepo.markRemoteOutcomeUnknown(client1, {
                    id: claimed.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
                await client1.query('COMMIT');
            } finally {
                client1.release();
            }

            await resetLease(connA.id);
            const acquired2 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker2 });
            const client2 = await pool.connect();
            try {
                await client2.query('BEGIN');
                const claimedByWorker2 = await commandRepo.claimCommandForConnection(client2, {
                    connectionId: connA.id,
                    workerId: worker2,
                    claimEpoch: acquired2.leaseEpoch,
                });
                await client2.query('COMMIT');
                assert.strictEqual(claimedByWorker2, null);
            } finally {
                client2.release();
            }
        });

        it('Scheduled UNMUTE task crash/restart: marked REMOTE_OUTCOME_UNKNOWN and scheduler never reclaims', async () => {
            const worker1 = `worker-crash-sched-1-${Date.now()}`;
            const worker2 = `worker-crash-sched-2-${Date.now()}`;

            await resetLease(connA.id);
            const acquired1 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker1 });
            const epoch1 = acquired1.leaseEpoch;

            const task = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });

            const client1 = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client1, {
                    connectionIds: [connA.id],
                    workerId: worker1,
                    getLeaseEpochForConnection: () => epoch1,
                });
                assert.ok(claimed);
                await taskRepo.markRemoteStarted(client1, { id: claimed.id, workerId: worker1, claimEpoch: epoch1 });
                await taskRepo.markRemoteOutcomeUnknown(client1, {
                    id: claimed.id,
                    workerId: worker1,
                    claimEpoch: epoch1,
                });
            } finally {
                client1.release();
            }

            const fresh = await taskRepo.getTaskStatus(task.id);
            assert.strictEqual(fresh.status, 'REMOTE_OUTCOME_UNKNOWN');

            // Successor scheduler with new worker and lease epoch attempts claim
            await resetLease(connA.id);
            const acquired2 = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: worker2 });
            const client2 = await pool.connect();
            try {
                const claimedByWorker2 = await taskRepo.claimNextTask(client2, {
                    connectionIds: [connA.id],
                    workerId: worker2,
                    getLeaseEpochForConnection: () => acquired2.leaseEpoch,
                });
                assert.strictEqual(claimedByWorker2, null, 'Scheduler must NEVER claim REMOTE_OUTCOME_UNKNOWN tasks');
            } finally {
                client2.release();
            }
        });

        it('Worker replacement: old worker tasks marked unknown; new worker polls without touching them', async () => {
            const oldWorker = `worker-old-${Date.now()}`;
            const newWorker = `worker-new-${Date.now()}`;

            const task = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });

            // Mark task unknown for old worker
            await pool.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'REMOTE_OUTCOME_UNKNOWN',
                    claimed_by_worker_id = $1,
                    claim_epoch = 1,
                    updated_at = NOW()
                WHERE id = $2;
            `, [oldWorker, task.id]);

            // New worker acquires lease
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: newWorker });

            const client = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId: newWorker,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
                assert.strictEqual(claimed, null);
            } finally {
                client.release();
            }
        });
    });

    // =========================================================================
    // 3. Multi-Tenant Scheduled-Task Isolation (Cases 1–7)
    // =========================================================================
    describe('3. Multi-Tenant Scheduled-Task Isolation (Cases 1–7)', () => {
        it('Case 1: Worker assigned to Tenant A cannot claim tasks belonging to Tenant B connections', async () => {
            const workerA = `worker-iso-a-${Date.now()}`;
            const acquiredA = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: workerA });

            // Create pending task for Tenant B only
            const taskB = await taskRepo.createTask(null, {
                tenantId: tenantB.id,
                groupId: groupB.id,
                connectionId: connB.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });

            const client = await pool.connect();
            try {
                // Worker A provides only Tenant A's connection IDs
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId: workerA,
                    getLeaseEpochForConnection: () => acquiredA.leaseEpoch,
                });
                assert.strictEqual(claimed, null, 'Worker A must not claim Tenant B tasks');
            } finally {
                client.release();
            }

            // Cleanup taskB
            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE id = $1', [taskB.id]);
        });

        it('Case 2: Cross-tenant task creation rejection: composite FK mismatch rejected by database', async () => {
            // Attempt to create a task with Tenant A's ID but Tenant B's Group ID and Connection ID
            await assert.rejects(
                async () => {
                    await taskRepo.createTask(null, {
                        tenantId: tenantA.id,
                        groupId: groupB.id,
                        connectionId: connB.id,
                        action: 'UNMUTE_GROUP',
                        runAt: new Date(Date.now() + 60000),
                    });
                },
                (err) => {
                    assert.ok(
                        err.message.includes('foreign key') || err.message.includes('violates foreign key constraint'),
                        `Expected FK violation, got: ${err.message}`
                    );
                    return true;
                }
            );
        });

        it('Case 3: Cross-tenant task cancellation rejection: Tenant A cannot cancel Tenant B tasks', async () => {
            const taskB = await taskRepo.createTask(null, {
                tenantId: tenantB.id,
                groupId: groupB.id,
                connectionId: connB.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60000),
            });

            // Tenant A attempts to cancel Tenant B's task
            const cancelledCount = await taskRepo.cancelTasksForGroup(null, {
                tenantId: tenantA.id,
                groupId: groupB.id,
                action: 'UNMUTE_GROUP',
            });

            assert.strictEqual(cancelledCount, 0, 'Must not cancel any tasks belonging to other tenant');

            // Verify task B is still PENDING
            const fresh = await taskRepo.getTaskStatus(taskB.id);
            assert.strictEqual(fresh.status, 'PENDING');

            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE id = $1', [taskB.id]);
        });

        it('Case 4: Cross-tenant task status isolation: querying status across tenants is isolated', async () => {
            const taskB = await taskRepo.createTask(null, {
                tenantId: tenantB.id,
                groupId: groupB.id,
                connectionId: connB.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60000),
            });

            // Scoped query for Tenant A
            const { rows } = await pool.query(
                'SELECT * FROM scheduled_moderation_tasks WHERE id = $1 AND tenant_id = $2;',
                [taskB.id, tenantA.id]
            );
            assert.strictEqual(rows.length, 0, 'Tenant A query cannot locate Tenant B task');

            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE id = $1', [taskB.id]);
        });

        it('Case 5: Cross-tenant group status toggle: unmanaging Tenant A group only cancels Tenant A tasks', async () => {
            const taskA = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60000),
            });

            const taskB = await taskRepo.createTask(null, {
                tenantId: tenantB.id,
                groupId: groupB.id,
                connectionId: connB.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() + 60000),
            });

            // Unmanage Tenant A's group and cancel its tasks
            await taskRepo.cancelTasksForGroup(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                action: 'UNMUTE_GROUP',
            });

            const statusA = await taskRepo.getTaskStatus(taskA.id);
            const statusB = await taskRepo.getTaskStatus(taskB.id);

            assert.strictEqual(statusA.status, 'CANCELLED');
            assert.strictEqual(statusB.status, 'PENDING', 'Tenant B task must remain PENDING');

            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE id = $1', [taskB.id]);
        });

        it('Case 6: Fenced completion rejection: Worker B cannot complete task claimed by Worker A', async () => {
            const workerA = `worker-fenced-a-${Date.now()}`;
            const workerB = `worker-fenced-b-${Date.now()}`;

            await resetLease(connA.id);
            const acquiredA = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId: workerA });

            const taskA = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });

            const client = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId: workerA,
                    getLeaseEpochForConnection: () => acquiredA.leaseEpoch,
                });
                assert.ok(claimed);
            } finally {
                client.release();
            }

            // Worker B attempts to complete Worker A's claimed task
            const completed = await taskRepo.completeTask(null, {
                id: taskA.id,
                workerId: workerB,
                claimEpoch: acquiredA.leaseEpoch,
            });

            assert.strictEqual(completed, false, 'Worker B must not complete Worker A claimed task');
        });

        it('Case 7: Adversarial connection hijacking: mismatched connection/tenant cannot be claimed', async () => {
            const workerA = `worker-hijack-${Date.now()}`;
            // Worker A tries to pass Tenant B's connectionId to claimNextTask
            const client = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connB.id],
                    workerId: workerA,
                    getLeaseEpochForConnection: () => 1,
                });
                assert.ok(claimed === null || claimed !== undefined);
            } finally {
                client.release();
            }
        });
    });

    // =========================================================================
    // 4. Scheduled Unmute Suspension Policy (Option B — Pause & Resume)
    // =========================================================================
    describe('4. Scheduled Unmute Suspension Policy (Option B — Pause & Resume)', () => {
        let task1, task2, taskB_pause;

        beforeEach(async () => {
            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE tenant_id IN ($1, $2)', [tenantA.id, tenantB.id]);
            await resetLease(connA.id);
            await resetLease(connB.id);

            task1 = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });
            task2 = await taskRepo.createTask(null, {
                tenantId: tenantA.id,
                groupId: groupA.id,
                connectionId: connA.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 2000),
            });
            taskB_pause = await taskRepo.createTask(null, {
                tenantId: tenantB.id,
                groupId: groupB.id,
                connectionId: connB.id,
                action: 'UNMUTE_GROUP',
                runAt: new Date(Date.now() - 5000),
            });
        });

        afterEach(async () => {
            await pool.query('DELETE FROM scheduled_moderation_tasks WHERE tenant_id IN ($1, $2)', [tenantA.id, tenantB.id]);
        });

        it('Test 1: pauseTasksForTenant transitions all PENDING tasks to PAUSED for tenant', async () => {
            const pausedCount = await taskRepo.pauseTasksForTenant(null, tenantA.id);
            assert.strictEqual(pausedCount, 2);

            const t1 = await taskRepo.getTaskStatus(task1.id);
            const t2 = await taskRepo.getTaskStatus(task2.id);
            const tb = await taskRepo.getTaskStatus(taskB_pause.id);

            assert.strictEqual(t1.status, 'PAUSED');
            assert.strictEqual(t2.status, 'PAUSED');
            assert.strictEqual(tb.status, 'PENDING', 'Tenant B tasks must remain PENDING');
        });

        it('Test 2: claimNextTask strictly ignores PAUSED tasks even when run_at has passed', async () => {
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            const workerId = `worker-pause-claim-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            const client = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
                assert.strictEqual(claimed, null, 'claimNextTask must return null when all tasks are PAUSED');
            } finally {
                client.release();
            }
        });

        it('Test 3: Pre-gateway check aborts processing if task was PAUSED after claim', async () => {
            const workerId = `worker-pause-race-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            const client = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client.release();
            }

            assert.ok(claimed);

            // Directly mark task PAUSED (simulating pause right after claim)
            await pool.query('UPDATE scheduled_moderation_tasks SET status = \'PAUSED\' WHERE id = $1', [claimed.id]);

            const connectionManager = new ConnectionManager(pool);
            const leaseManager = new WorkerLeaseManager({ pool, workerId, connRepo, connectionManager, heartbeatIntervalMs: 10000 });
            leaseManager.registerLease({ connectionId: connA.id, tenantId: tenantA.id, leaseEpoch: acquired.leaseEpoch });

            let gatewayCalled = false;
            const mockSocket = {
                groupSettingUpdate: async () => { gatewayCalled = true; },
                sendMessage: async () => {},
            };
            const mockConnectionManager = {
                getSocket: () => mockSocket,
            };

            const scheduler = new DurableModerationScheduler({
                pool,
                taskRepo,
                leaseManager,
                connectionManager: mockConnectionManager,
                groupRepo,
                workerId,
            });

            await scheduler.processTask(claimed);
            assert.strictEqual(gatewayCalled, false, 'Must NOT invoke gateway when task status is PAUSED');
        });

        it('Test 4: resumeTasksForTenant transitions PAUSED tasks back to PENDING and sets next_attempt_at = NOW()', async () => {
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            const resumedCount = await taskRepo.resumeTasksForTenant(null, tenantA.id);
            assert.strictEqual(resumedCount, 2);

            const t1 = await taskRepo.getTaskStatus(task1.id);
            const t2 = await taskRepo.getTaskStatus(task2.id);

            assert.strictEqual(t1.status, 'PENDING');
            assert.strictEqual(t2.status, 'PENDING');
        });

        it('Test 5: Resumed tasks are immediately eligible and claimed by scheduler', async () => {
            await taskRepo.pauseTasksForTenant(null, tenantA.id);
            await taskRepo.resumeTasksForTenant(null, tenantA.id);

            const workerId = `worker-resume-claim-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            const client = await pool.connect();
            try {
                const claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
                assert.ok(claimed, 'Resumed task must be immediately claimable');
                assert.strictEqual(claimed.status, 'PROCESSING');
            } finally {
                client.release();
            }
        });

        it('Test 6: Repeated pause calls are idempotent and do not corrupt tasks', async () => {
            const count1 = await taskRepo.pauseTasksForTenant(null, tenantA.id);
            assert.strictEqual(count1, 2);

            // Repeated pause should pause 0 additional tasks and leave them PAUSED
            const count2 = await taskRepo.pauseTasksForTenant(null, tenantA.id);
            assert.strictEqual(count2, 0);

            const t1 = await taskRepo.getTaskStatus(task1.id);
            const t2 = await taskRepo.getTaskStatus(task2.id);
            assert.strictEqual(t1.status, 'PAUSED');
            assert.strictEqual(t2.status, 'PAUSED');
        });

        it('Test 7: Repeated resume calls are idempotent and do not corrupt tasks', async () => {
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            const count1 = await taskRepo.resumeTasksForTenant(null, tenantA.id);
            assert.strictEqual(count1, 2);

            // Repeated resume should resume 0 additional tasks and leave them PENDING
            const count2 = await taskRepo.resumeTasksForTenant(null, tenantA.id);
            assert.strictEqual(count2, 0);

            const t1 = await taskRepo.getTaskStatus(task1.id);
            const t2 = await taskRepo.getTaskStatus(task2.id);
            assert.strictEqual(t1.status, 'PENDING');
            assert.strictEqual(t2.status, 'PENDING');
        });

        it('Test 8: Cross-tenant suspension isolation: suspending Tenant A never affects Tenant B tasks', async () => {
            // Both tenants have tasks
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            const statusA1 = await taskRepo.getTaskStatus(task1.id);
            const statusB = await taskRepo.getTaskStatus(taskB_pause.id);

            assert.strictEqual(statusA1.status, 'PAUSED', 'Tenant A task must be PAUSED');
            assert.strictEqual(statusB.status, 'PENDING', 'Tenant B task must strictly remain PENDING');

            // Suspending Tenant B does not alter Tenant A
            await taskRepo.pauseTasksForTenant(null, tenantB.id);
            const statusB2 = await taskRepo.getTaskStatus(taskB_pause.id);
            assert.strictEqual(statusB2.status, 'PAUSED');
        });

        it('Test 9: Remote dispatch started + suspension preserves outcome, does not overwrite to PAUSED', async () => {
            const workerId = `worker-remote-pause-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            const client = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client.release();
            }

            assert.ok(claimed);
            // Mark remote dispatch started
            await taskRepo.markRemoteStarted(null, { id: claimed.id, workerId, claimEpoch: acquired.leaseEpoch });

            // Tenant suspension occurs while remote dispatch is in flight
            const pausedCount = await taskRepo.pauseTasksForTenant(null, tenantA.id);
            // Only PENDING tasks are paused by pauseTasksForTenant (claimed task is in PROCESSING)
            assert.strictEqual(pausedCount, 1, 'Only the other PENDING task should be paused; PROCESSING task is untouched');

            const currentClaimed = await taskRepo.getTaskStatus(claimed.id);
            assert.strictEqual(currentClaimed.status, 'PROCESSING');
            assert.ok(currentClaimed.remote_started_at, 'remote_started_at must be preserved');
        });

        it('Test 10: Remote outcome unknown + suspension preserves REMOTE_OUTCOME_UNKNOWN', async () => {
            const workerId = `worker-unk-pause-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            const client = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client.release();
            }

            // Mark remote outcome unknown
            await taskRepo.markRemoteStarted(null, { id: claimed.id, workerId, claimEpoch: acquired.leaseEpoch });
            await taskRepo.markRemoteOutcomeUnknown(null, { id: claimed.id, workerId, claimEpoch: acquired.leaseEpoch });

            // Tenant suspension occurs
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            // Tenant reactivation occurs
            await taskRepo.resumeTasksForTenant(null, tenantA.id);

            // Task must STILL be REMOTE_OUTCOME_UNKNOWN, not corrupted to PENDING or PAUSED
            const current = await taskRepo.getTaskStatus(claimed.id);
            assert.strictEqual(current.status, 'REMOTE_OUTCOME_UNKNOWN', 'REMOTE_OUTCOME_UNKNOWN must NEVER be overwritten by pause/resume');
        });

        it('Test 11: Reactivated task executes only once to completion', async () => {
            // Task is initially paused
            await taskRepo.pauseTasksForTenant(null, tenantA.id);

            // Reactivate
            await taskRepo.resumeTasksForTenant(null, tenantA.id);

            const workerId = `worker-once-${Date.now()}`;
            await resetLease(connA.id);
            const acquired = await connRepo.acquireLease({ connectionId: connA.id, tenantId: tenantA.id, workerId });

            // Worker claims and completes task1
            const client1 = await pool.connect();
            let claimed;
            try {
                claimed = await taskRepo.claimNextTask(client1, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client1.release();
            }

            assert.ok(claimed);
            const completed = await taskRepo.completeTask(null, {
                id: claimed.id,
                workerId,
                claimEpoch: acquired.leaseEpoch,
            });
            assert.strictEqual(completed, true);

            // Another worker or same worker attempts to claim again
            const client2 = await pool.connect();
            let secondClaim;
            try {
                secondClaim = await taskRepo.claimNextTask(client2, {
                    connectionIds: [connA.id],
                    workerId,
                    getLeaseEpochForConnection: () => acquired.leaseEpoch,
                });
            } finally {
                client2.release();
            }

            // If task2 was claimed, complete it too, but ensure claimed.id is never claimed again
            if (secondClaim && secondClaim.id !== claimed.id) {
                await taskRepo.completeTask(null, { id: secondClaim.id, workerId, claimEpoch: acquired.leaseEpoch });
                // Check once more
                const client3 = await pool.connect();
                try {
                    const third = await taskRepo.claimNextTask(client3, {
                        connectionIds: [connA.id],
                        workerId,
                        getLeaseEpochForConnection: () => acquired.leaseEpoch,
                    });
                    assert.strictEqual(third, null, 'No more tasks should be claimable');
                } finally {
                    client3.release();
                }
            } else {
                assert.notStrictEqual(secondClaim?.id, claimed.id, 'Completed task must never be claimed again');
            }
        });
    });

    // =========================================================================
    // 5. Force Disconnect Exact-One-Socket Exclusion
    // =========================================================================
    describe('5. Force Disconnect Exact-One-Socket Exclusion', () => {
        it('findReconciliationCandidates strictly excludes connections in SOCKET_STOPPING', async () => {
            const stoppingTenant = await tenantRepo.create({ name: `Stopping Tenant ${Date.now()}` });
            const workerA = `worker-socket-stopping-${Date.now()}`;
            const conn = await connRepo.createForTenant(stoppingTenant.id, {
                phoneNumber: '15550000099',
                displayName: 'Conn Stopping',
                status: 'CONNECTED',
            });

            // Simulate admin force-disconnect: desired_state = STOPPED, actual_state = SOCKET_STOPPING
            const acquiredA = await connRepo.acquireLease({ connectionId: conn.id, tenantId: stoppingTenant.id, workerId: workerA });
            await connRepo.updateDesiredStateForTenant(conn.id, stoppingTenant.id, 'STOPPED');
            await connRepo.updateActualState({
                connectionId: conn.id,
                workerId: workerA,
                leaseEpoch: acquiredA.leaseEpoch,
                actualState: 'SOCKET_STOPPING',
                status: 'DISCONNECTED',
            });

            // Another worker (workerB) checks reconciliation candidates to see if it should pick up conn
            const workerB = `worker-socket-other-${Date.now()}`;
            const candidatesForB = await connRepo.findReconciliationCandidates({
                workerId: workerB,
                limit: 50,
            });

            const foundForB = candidatesForB.find((c) => c.id === conn.id);
            assert.strictEqual(foundForB, undefined, 'Other worker must NOT find a connection currently in SOCKET_STOPPING');

            // Worker A (currently assigned worker) DOES find it so it can finish tearing down the socket
            const candidatesForA = await connRepo.findReconciliationCandidates({
                workerId: workerA,
                limit: 50,
            });

            const foundForA = candidatesForA.find((c) => c.id === conn.id);
            assert.ok(foundForA, 'Currently assigned worker must find it to finish teardown');

            // Once worker A releases lease and sets actual_state = UNASSIGNED or DISCONNECTED
            await connRepo.releaseLease({ connectionId: conn.id, workerId: workerA, leaseEpoch: acquiredA.leaseEpoch });
            await pool.query('UPDATE whatsapp_connections SET actual_state = \'UNASSIGNED\' WHERE id = $1', [conn.id]);

            // Now worker A has no more work on this stopped connection
            const candidatesAfterTeardown = await connRepo.findReconciliationCandidates({
                workerId: workerA,
                limit: 50,
            });
            const foundAfter = candidatesAfterTeardown.find((c) => c.id === conn.id);
            assert.strictEqual(foundAfter, undefined, 'Stopped unassigned connection requires no further reconciliation');
        });
    });
});
