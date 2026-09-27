const os = require('node:os');
const crypto = require('node:crypto');
const WorkerLeaseManager = require('./WorkerLeaseManager');
const { defaultQrStore } = require('../control/EphemeralQrStore');
const { defaultEventPublisher } = require('../../application/realtime/EventPublisher');
const { defaultCommandGateway } = require('../control/ConnectionCommandGateway');
const { defaultMetricsRegistry } = require('../../application/metrics/MetricsRegistry');

/**
 * Windowseven MD Distributed Worker Node
 * Executes and monitors WhatsApp connections under atomic generation fencing.
 *
 * Invariants:
 * 1. Solitary socket ownership enforced via PostgreSQL lease_epoch fencing.
 * 2. Commands/signals are treated as ephemeral wake-up triggers; state is ALWAYS reconciled from PostgreSQL.
 * 3. Never persists or logs raw QR payloads; utilizes EphemeralQrStore with 60s TTL.
 * 4. Stale generations are aborted immediately and cannot resurrect via reconnects.
 */
class WorkerNode {
    /**
     * @param {object} params
     * @param {string} [params.workerId]
     * @param {import('../ConnectionManager')} params.connectionManager
     * @param {import('../../repositories/WhatsAppConnectionRepository')} params.connRepo
     * @param {import('../../repositories/WorkerRepository')} [params.workerRepo]
     * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
     * @param {import('../control/ConnectionCommandGateway').ConnectionCommandGateway} [params.commandGateway]
     * @param {import('../../application/realtime/EventPublisher').IEventPublisher} [params.eventPublisher]
     * @param {import('../control/EphemeralQrStore').EphemeralQrStore} [params.qrStore]
     * @param {number} [params.capacity=50] - Operational scheduling hint, NOT platform ceiling
     * @param {number} [params.reconcileIntervalMs=5000]
     */
    constructor({
        workerId = null,
        connectionManager,
        connRepo,
        workerRepo = null,
        auditLogRepo = null,
        commandGateway = defaultCommandGateway,
        eventPublisher = defaultEventPublisher,
        qrStore = defaultQrStore,
        capacity = 50,
        reconcileIntervalMs = 5000,
        pool = null,
        commandRepo = null,
        taskRepo = null,
        groupRepo = null,
        idempotencyRepo = null,
        drainGraceMs = 10000,
        leaseManager = null,
        metricsRegistry = null,
    }) {
        if (!connectionManager || !connRepo) {
            throw new Error('connectionManager and connRepo are required for WorkerNode');
        }

        this.workerId = workerId || `worker-${os.hostname()}-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
        this.connectionManager = connectionManager;
        this.connRepo = connRepo;
        this.workerRepo = workerRepo;
        this.auditLogRepo = auditLogRepo;
        this.commandGateway = commandGateway;
        this.eventPublisher = eventPublisher;
        this.qrStore = qrStore;
        this.capacity = capacity;
        this.reconcileIntervalMs = reconcileIntervalMs;
        this.pool = pool;
        this.commandRepo = commandRepo;
        this.taskRepo = taskRepo;
        this.groupRepo = groupRepo;
        this.idempotencyRepo = idempotencyRepo;
        this.drainGraceMs = drainGraceMs;
        this.metricsRegistry = metricsRegistry || defaultMetricsRegistry;
        this.inFlight = new Set();

        this.leaseManager = leaseManager || new WorkerLeaseManager({
            workerId: this.workerId,
            connRepo: this.connRepo,
            connectionManager: this.connectionManager,
            auditLogRepo: this.auditLogRepo,
        });

        // Initialize Durable Moderation Scheduler if taskRepo and pool are provided
        this.scheduler = null;
        if (this.taskRepo && this.pool && this.groupRepo) {
            const DurableModerationScheduler = require('./DurableModerationScheduler');
            this.scheduler = new DurableModerationScheduler({
                pool: this.pool,
                taskRepo: this.taskRepo,
                leaseManager: this.leaseManager,
                connectionManager: this.connectionManager,
                groupRepo: this.groupRepo,
                auditLogRepo: this.auditLogRepo,
                eventPublisher: this.eventPublisher,
                metricsRegistry: this.metricsRegistry,
                workerId: this.workerId,
                pollIntervalMs: 5000,
            });
        }

        // Initialize Remote Outcome Verification Service if dependencies are provided
        this.verificationService = null;
        if (this.commandRepo && this.taskRepo && this.pool && this.groupRepo) {
            const RemoteOutcomeVerificationService = require('./RemoteOutcomeVerificationService');
            this.verificationService = new RemoteOutcomeVerificationService({
                pool: this.pool,
                commandRepo: this.commandRepo,
                taskRepo: this.taskRepo,
                groupRepo: this.groupRepo,
                connectionManager: this.connectionManager,
                leaseManager: this.leaseManager,
                auditLogRepo: this.auditLogRepo,
                eventPublisher: this.eventPublisher,
                metricsRegistry: this.metricsRegistry,
                workerId: this.workerId,
            });
        }

        this.status = 'STARTING';
        this.reconcileTimer = null;
        this.workerHeartbeatTimer = null;
        this.isStopped = false;
        this.isReconciling = false;
        this._unsubscribeCommand = null;
    }

    /**
     * Initializes and starts the worker node.
     */
    async start() {
        if (this.status === 'READY') return;
        this.isStopped = false;

        // 1. Register in workers registry table if workerRepo is available
        if (this.workerRepo) {
            try {
                await this.workerRepo.registerWorker({
                    id: this.workerId,
                    hostname: os.hostname(),
                    capacity: this.capacity,
                    status: 'READY',
                    metadata: {
                        pid: process.pid,
                        nodeVersion: process.version,
                    },
                });
            } catch (err) {
                this.status = 'FAILED';
                console.error(`[WorkerNode] Worker registration failed for ${this.workerId}:`, err.message);
                if (this.auditLogRepo) {
                    this.auditLogRepo.create({
                        action: 'WORKER_REGISTRATION_FAILED',
                        resourceType: 'worker_node',
                        resourceId: this.workerId,
                        metadata: { error: err.message, hostname: os.hostname() },
                    }).catch(() => {});
                }
                throw err;
            }
        }

        this.status = 'READY';

        // 2. Start proactive lease heartbeats
        this.leaseManager.start();

        // Start durable moderation scheduler if configured
        if (this.scheduler) {
            this.scheduler.start();
        }

        // 3. Start worker registry heartbeat loop (every 10s)
        if (this.workerRepo) {
            this.workerHeartbeatTimer = setInterval(async () => {
                if (this.isStopped) return;
                await this.workerRepo.heartbeat({
                    id: this.workerId,
                    activeConnections: this.leaseManager.leases.size,
                }).catch(() => {});
            }, 10000);

            if (typeof this.workerHeartbeatTimer.unref === 'function') {
                this.workerHeartbeatTimer.unref();
            }
        }

        // 4. Subscribe to control-plane wake-up commands
        if (this.commandGateway) {
            if (typeof this.commandGateway.registerWorkerNode === 'function') {
                this.commandGateway.registerWorkerNode(this);
            }
            this._unsubscribeCommand = this.commandGateway.onCommand(async (cmd) => {
                if (cmd?.command === 'DRAIN_WORKER' && cmd?.workerId === this.workerId) {
                    await this.drain({ graceMs: cmd.graceMs || this.drainGraceMs }).catch((err) => {
                        console.error(`[WorkerNode] Error draining worker ${this.workerId}:`, err.message);
                    });
                } else if (cmd?.command === 'RECONNECT_CONNECTION' && cmd?.connectionId && this.leaseManager.hasLease(cmd.connectionId)) {
                    await this._handleReconnectCommand(cmd.connectionId).catch((err) => {
                        console.error(`[WorkerNode] Error handling reconnect command for ${cmd.connectionId}:`, err.message);
                    });
                } else {
                    // Signals are treated as immediate wake-up triggers; state is read from DB
                    await this.reconcile().catch((err) => {
                        console.error(`[WorkerNode] Reconciliation error on command:`, err.message);
                    });
                }
            });
        }

        // 5. Periodic reconciliation loop (Amendment 7: guarantees convergence even if NOTIFY dropped)
        this.reconcileTimer = setInterval(async () => {
            if (this.isStopped) return;
            await this.reconcile().catch((err) => {
                console.error(`[WorkerNode] Periodic reconciliation error:`, err.message);
            });
        }, this.reconcileIntervalMs);

        if (typeof this.reconcileTimer.unref === 'function') {
            this.reconcileTimer.unref();
        }

        // Run initial reconciliation immediately
        await this.reconcile();
    }

    /**
     * Authoritative State Reconciliation Loop.
     * Reads PostgreSQL to discover desired vs actual connection state and converges safely.
     */
    async reconcile() {
        if (this.isStopped || this.isReconciling || this.status === 'FAILED' || this.status === 'DRAINING' || this.status === 'OFFLINE') {
            return;
        }

        this.isReconciling = true;
        try {
            // 1. Recover expired processing work (Class A & B boundaries)
            if (this.commandRepo) {
                await this.commandRepo.reapStaleCommands(null).catch((err) => {
                    console.error(`[WorkerNode ${this.workerId}] Error reaping stale commands:`, err.message);
                });
            }
            if (this.taskRepo) {
                await this.taskRepo.reapStaleTasks(null).catch((err) => {
                    console.error(`[WorkerNode ${this.workerId}] Error reaping stale tasks:`, err.message);
                });
            }

            const candidates = await this.connRepo.findReconciliationCandidates({
                workerId: this.workerId,
                limit: 25,
            });

            for (const conn of candidates) {
                // Action A: Desired RUNNING, but not currently active
                if (conn.desiredState === 'RUNNING') {
                    await this._reconcileRunningConnection(conn);
                }
                // Action B: Desired STOPPED, but still running or assigned to this worker
                else if (conn.desiredState === 'STOPPED') {
                    await this._reconcileStoppedConnection(conn);
                }
            }

            // 2. Perform remote outcome verification for all actively leased connections
            if (this.verificationService) {
                const leasedConnIds = Array.from(this.leaseManager.leases.keys());
                for (const connId of leasedConnIds) {
                    await this.verificationService.verifyUnknownForConnection(connId).catch((err) => {
                        console.error(`[WorkerNode ${this.workerId}] Error verifying unknown work for ${connId}:`, err.message);
                    });
                }
            }

            // 3. Process durable commands for actively owned connections
            await this._processPendingCommands();
        } finally {
            this.isReconciling = false;
        }
    }

    /**
     * Converges a connection whose desired state is RUNNING.
     */
    async _reconcileRunningConnection(conn) {
        // If already actively running under this worker's lease, nothing to do
        if (this.leaseManager.hasLease(conn.id) && this.connectionManager.hasConnection(conn.id)) {
            return;
        }

        // Attempt atomic lease acquisition in PostgreSQL (increments lease_epoch)
        const acquired = await this.connRepo.acquireLease({
            connectionId: conn.id,
            tenantId: conn.tenantId,
            workerId: this.workerId,
        });

        if (!acquired) {
            // Another worker acquired the lease or row is locked; move to next
            return;
        }

        // Register with lease manager
        this.leaseManager.registerLease({
            connectionId: acquired.id,
            tenantId: acquired.tenantId,
            leaseEpoch: acquired.leaseEpoch,
        });

        // Record audit log
        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId: acquired.tenantId,
                actorUserId: null,
                action: 'WORKER_LEASE_ACQUIRED',
                resourceType: 'WhatsAppConnection',
                resourceId: acquired.id,
                metadata: {
                    workerId: this.workerId,
                    leaseEpoch: acquired.leaseEpoch,
                },
            }).catch(() => {});
        }

        // Transition actual_state -> SOCKET_STARTING
        await this.connRepo.updateActualState({
            connectionId: acquired.id,
            workerId: this.workerId,
            leaseEpoch: acquired.leaseEpoch,
            actualState: 'SOCKET_STARTING',
        });

        // Publish realtime event
        await this.eventPublisher.publish({
            tenantId: acquired.tenantId,
            eventType: 'connection.status.changed',
            data: {
                connectionId: acquired.id,
                actualState: 'SOCKET_STARTING',
                status: 'CONNECTING',
                leaseEpoch: acquired.leaseEpoch,
            },
        });

        // Start socket via ConnectionManager with lifecycle event hooks
        try {
            await this.connectionManager.createConnection(acquired.tenantId, acquired.id, {
                workerId: this.workerId,
                leaseEpoch: acquired.leaseEpoch,
                onQR: async (qr) => {
                    // Store ephemeral QR in-memory with 60s TTL and current leaseEpoch (Never written to DB or logged)
                    this.qrStore.set(acquired.tenantId, acquired.id, qr, 60, acquired.leaseEpoch);

                    // Update actual_state to QR_PENDING (fenced with current epoch)
                    await this.connRepo.updateActualState({
                        connectionId: acquired.id,
                        workerId: this.workerId,
                        leaseEpoch: acquired.leaseEpoch,
                        actualState: 'QR_PENDING',
                        status: 'CONNECTING',
                    }).catch(() => {});

                    // Publish sanitized QR event
                    await this.eventPublisher.publish({
                        tenantId: acquired.tenantId,
                        eventType: 'connection.qr.updated',
                        data: {
                            connectionId: acquired.id,
                            qr,
                            expiresInSeconds: 60,
                        },
                    });
                },
                onConnect: async () => {
                    // QR consumed upon successful connect
                    this.qrStore.delete(acquired.tenantId, acquired.id);

                    // Update actual_state to ACTIVE (fenced with current epoch)
                    await this.connRepo.updateActualState({
                        connectionId: acquired.id,
                        workerId: this.workerId,
                        leaseEpoch: acquired.leaseEpoch,
                        actualState: 'ACTIVE',
                        status: 'CONNECTED',
                    }).catch(() => {});

                    // Publish ACTIVE event
                    await this.eventPublisher.publish({
                        tenantId: acquired.tenantId,
                        eventType: 'connection.status.changed',
                        data: {
                            connectionId: acquired.id,
                            actualState: 'ACTIVE',
                            status: 'CONNECTED',
                            leaseEpoch: acquired.leaseEpoch,
                        },
                    });
                },
            });
        } catch (err) {
            console.error(`[WorkerNode] Socket startup error for ${acquired.id}:`, err.message);
            await this.connRepo.updateActualState({
                connectionId: acquired.id,
                workerId: this.workerId,
                leaseEpoch: acquired.leaseEpoch,
                actualState: 'FAILED',
                status: 'DISCONNECTED',
                lastErrorCode: 'SOCKET_START_ERROR',
            }).catch(() => {});

            this.leaseManager.unregisterLease(acquired.id);
        }
    }

    /**
     * Converges a connection whose desired state is STOPPED.
     */
    async _reconcileStoppedConnection(conn) {
        const lease = this.leaseManager.getLease(conn.id);
        if (!lease) return;

        // Transition actual_state -> SOCKET_STOPPING
        await this.connRepo.updateActualState({
            connectionId: conn.id,
            workerId: this.workerId,
            leaseEpoch: lease.leaseEpoch,
            actualState: 'SOCKET_STOPPING',
            status: 'DISCONNECTED',
        }).catch(() => {});

        // Gracefully disconnect socket
        await this.connectionManager.disconnectConnection(conn.id, 'desired_state_stopped').catch(() => {});

        // Release DB lease
        await this.connRepo.releaseLease({
            connectionId: conn.id,
            workerId: this.workerId,
            leaseEpoch: lease.leaseEpoch,
        }).catch(() => {});

        // Clear local lease and QR
        this.leaseManager.unregisterLease(conn.id);
        this.qrStore.delete(conn.tenantId, conn.id);

        // Publish event
        await this.eventPublisher.publish({
            tenantId: conn.tenantId,
            eventType: 'connection.status.changed',
            data: {
                connectionId: conn.id,
                actualState: 'UNASSIGNED',
                status: 'DISCONNECTED',
            },
        });
    }

    /**
     * Handles operational reconnect command for an actively leased connection.
     * Performs a controlled restart of the socket while preserving desired_state = RUNNING.
     */
    async _handleReconnectCommand(connectionId) {
        const lease = this.leaseManager.getLease(connectionId);
        if (!lease) {
            return this.reconcile();
        }

        // 1. Controlled disconnect of current socket
        await this.connectionManager.disconnectConnection(connectionId, 'manual_reconnect').catch(() => {});

        // 2. Fetch authoritative state from DB
        const conn = await this.connRepo.findById(connectionId);
        if (conn && conn.desiredState === 'RUNNING') {
            await this._reconcileRunningConnection(conn);
        }
    }

    /**
     * Sweeps and claims eligible durable commands for actively leased connections.
     */
    async _processPendingCommands() {
        if (this.status === 'DRAINING' || !this.commandRepo || !this.pool) return;
        const connectionIds = Array.from(this.leaseManager.leases.keys());
        if (connectionIds.length === 0) return;

        for (const connectionId of connectionIds) {
            const lease = this.leaseManager.getLease(connectionId);
            if (!lease) continue;
            const claimEpoch = lease.leaseEpoch;

            const client = await this.pool.connect();
            try {
                const cmd = await this.commandRepo.claimCommandForConnection(client, {
                    connectionId,
                    workerId: this.workerId,
                    claimEpoch,
                });

                if (cmd) {
                    await this._executeCommand(cmd, claimEpoch);
                }
            } catch (err) {
                console.error(`[WorkerNode ${this.workerId}] Error claiming command for ${connectionId}:`, err.message);
            } finally {
                client.release();
            }
        }
    }

    /**
     * Executes a claimed command under strict generation fencing and dual authorization.
     */
    async _executeCommand(cmd, claimEpoch) {
        const { id, tenant_id: tenantId, connection_id: connectionId, group_id: groupId, command_type: commandType, payload } = cmd;
        let remoteOperationStarted = false;
        this.inFlight.add(id);

        // 1. Generation check: verify worker still holds lease
        if (!this.leaseManager.hasLease(connectionId)) {
            console.warn(`[WorkerNode ${this.workerId}] Lost lease for ${connectionId} before command execution. Requeueing ${id}`);
            await this.commandRepo.requeueStaleCommand(null, { id, workerId: this.workerId, claimEpoch });
            if (this.auditLogRepo) {
                this.auditLogRepo.create({
                    tenantId,
                    action: 'STALE_GENERATION_REJECTED',
                    resourceType: 'connection_command',
                    resourceId: id,
                    metadata: { commandType, claimEpoch, reason: 'lost_connection_lease' },
                }).catch(() => {});
            }
            return;
        }

        const currentEpoch = this.leaseManager.getLease(connectionId)?.leaseEpoch;
        if (Number(currentEpoch) !== Number(claimEpoch)) {
            console.warn(`[WorkerNode ${this.workerId}] Epoch mismatch (${currentEpoch} !== ${claimEpoch}) on command ${id}. Requeueing.`);
            await this.commandRepo.requeueStaleCommand(null, { id, workerId: this.workerId, claimEpoch });
            return;
        }

        // 2. Socket check
        const sock = this.connectionManager.getSocket(connectionId);
        if (!sock) {
            await this.commandRepo.failCommand(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'SOCKET_UNAVAILABLE',
                isTerminal: false,
                backoffSeconds: 5,
            });
            return;
        }

        // 3. Command dispatch
        try {
            if (commandType === 'SYNC_GROUPS') {
                const GroupSynchronizer = require('../GroupSynchronizer');
                const synchronizer = new GroupSynchronizer(this.pool, {
                    leaseManager: this.leaseManager,
                    auditLogRepo: this.auditLogRepo,
                });
                const ctx = {
                    tenantId,
                    connectionId,
                    workerId: this.workerId,
                    leaseEpoch: claimEpoch,
                    sock,
                };
                const syncRes = await synchronizer.syncAllParticipatingGroups(ctx, { expectedEpoch: claimEpoch });
                if (!syncRes.success) {
                    if (syncRes.error === 'stale_generation') {
                        await this.commandRepo.requeueStaleCommand(null, { id, workerId: this.workerId, claimEpoch });
                        return;
                    }
                    throw new Error(syncRes.error || 'SYNC_FAILED');
                }

                const completed = await this.commandRepo.completeCommand(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                    result: { syncedCount: syncRes.syncedCount },
                });

                if (completed) {
                    this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'SYNC_GROUPS', status: 'COMPLETED' });
                    if (this.auditLogRepo) {
                        this.auditLogRepo.create({
                            tenantId,
                            action: 'GROUPS_SYNCHRONIZED',
                            resourceType: 'whatsapp_connection',
                            resourceId: connectionId,
                            metadata: { commandId: id, syncedCount: syncRes.syncedCount },
                        }).catch(() => {});
                    }
                    if (this.eventPublisher) {
                        this.eventPublisher.publish(tenantId, 'groups.synchronized', {
                            connectionId,
                            syncedCount: syncRes.syncedCount,
                            commandId: id,
                        });
                    }
                }
            } else if (commandType === 'MUTE_GROUP' || commandType === 'UNMUTE_GROUP' || commandType === 'KICK_PARTICIPANT') {
                if (!groupId || !this.groupRepo) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'GROUP_REQUIRED',
                        isTerminal: true,
                    });
                    if (failed) {
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
                    }
                    return;
                }

                const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
                if (!group || group.connection_id !== connectionId || group.status !== 'MANAGED') {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'GROUP_NOT_MANAGED_OR_MISMATCHED',
                        isTerminal: true,
                    });
                    if (failed) {
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
                    }
                    return;
                }

                const WhatsAppModerationGateway = require('../../gateways/WhatsAppModerationGateway');
                const gateway = new WhatsAppModerationGateway(sock);
                const botJid = sock.user?.id;
                const adminStatus = await gateway.checkAdminStatus(group.whatsapp_jid, botJid);
                if (!adminStatus.isBotAdmin) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'BOT_NOT_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) {
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
                    }
                    return;
                }

                if (commandType === 'MUTE_GROUP') {
                    if (!await this.commandRepo.markRemoteStarted(null, { id, workerId: this.workerId, claimEpoch })) return;
                    remoteOperationStarted = true;
                    const muted = await gateway.muteGroup(group.whatsapp_jid);
                    if (!muted) {
                        throw new Error('REMOTE_MUTE_FAILED');
                    }

                    // Critical Requirements A & B + Correction 1: Atomic completion + scheduled unmute activation
                    const txClient = await this.pool.connect();
                    try {
                        await txClient.query('BEGIN');

                        const compSql = `
                            UPDATE connection_commands
                            SET status = 'COMPLETED', executed_at = NOW(), updated_at = NOW()
                            WHERE id = $1 AND status = 'PROCESSING'
                              AND claimed_by_worker_id = $2 AND claim_epoch = $3
                              AND EXISTS (SELECT 1 FROM whatsapp_connections c
                                WHERE c.id = connection_commands.connection_id
                                  AND c.assigned_worker_id = $2 AND c.lease_epoch = $3
                                  AND c.lease_expires_at > NOW())
                            RETURNING id, executed_at;
                        `;
                        const compRes = await txClient.query(compSql, [id, this.workerId, claimEpoch]);
                        if (compRes.rows.length === 0) {
                            await txClient.query('ROLLBACK');
                            console.warn(`[WorkerNode ${this.workerId}] Lost authority completing mute command ${id}`);
                            return;
                        }

                        const successfulMuteTime = compRes.rows[0].executed_at;
                        const durationMinutes = payload?.durationMinutes;

                        // Replacement semantics: cancel previous pending unmutes for this group
                        await txClient.query(`
                            UPDATE scheduled_moderation_tasks
                            SET status = 'CANCELLED', updated_at = NOW()
                            WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';
                        `, [tenantId, groupId]);

                        // Activate new scheduled unmute starting from successful mute completion timestamp
                        if (durationMinutes && Number(durationMinutes) > 0) {
                            await txClient.query(`
                                INSERT INTO scheduled_moderation_tasks (
                                    tenant_id, group_id, connection_id, action, payload, run_at, status, next_attempt_at
                                ) VALUES (
                                    $1, $2, $3, 'UNMUTE_GROUP', $4,
                                    $5::timestamptz + ($6 || ' minutes')::interval,
                                    'PENDING', NOW()
                                );
                            `, [
                                tenantId,
                                groupId,
                                connectionId,
                                JSON.stringify({ durationMinutes }),
                                successfulMuteTime,
                                Number(durationMinutes),
                            ]);
                        }

                        await txClient.query('COMMIT');
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'MUTE_GROUP', status: 'COMPLETED' });

                        if (this.auditLogRepo) {
                            this.auditLogRepo.create({
                                tenantId,
                                action: 'GROUP_MUTED',
                                resourceType: 'group',
                                resourceId: groupId,
                                metadata: { commandId: id, durationMinutes, connectionId },
                            }).catch(() => {});
                        }

                        if (this.eventPublisher) {
                            this.eventPublisher.publish(tenantId, 'command.completed', {
                                commandId: id,
                                action: 'MUTE_GROUP',
                                status: 'COMPLETED',
                            });
                            this.eventPublisher.publish(tenantId, 'group.muted', {
                                groupId,
                                connectionId,
                                durationMinutes,
                            });
                        }
                    } catch (txErr) {
                        await txClient.query('ROLLBACK');
                        throw txErr;
                    } finally {
                        txClient.release();
                    }
                } else if (commandType === 'UNMUTE_GROUP') {
                    if (!await this.commandRepo.markRemoteStarted(null, { id, workerId: this.workerId, claimEpoch })) return;
                    remoteOperationStarted = true;
                    const unmuted = await gateway.unmuteGroup(group.whatsapp_jid);
                    if (!unmuted) {
                        throw new Error('REMOTE_UNMUTE_FAILED');
                    }

                    // Cancel any pending or processing scheduled unmutes for this group
                    if (this.taskRepo) {
                        await this.taskRepo.cancelTasksForGroup(null, {
                            tenantId,
                            groupId,
                            action: 'UNMUTE_GROUP',
                            includeProcessing: true,
                        });
                    }

                    const completed = await this.commandRepo.completeCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        result: { success: true },
                    });

                    if (completed) {
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'UNMUTE_GROUP', status: 'COMPLETED' });
                        if (this.auditLogRepo) {
                            this.auditLogRepo.create({
                                tenantId,
                                action: 'GROUP_UNMUTED',
                                resourceType: 'group',
                                resourceId: groupId,
                                metadata: { commandId: id, connectionId },
                            }).catch(() => {});
                        }
                        if (this.eventPublisher) {
                            this.eventPublisher.publish(tenantId, 'command.completed', {
                                commandId: id,
                                action: 'UNMUTE_GROUP',
                                status: 'COMPLETED',
                            });
                            this.eventPublisher.publish(tenantId, 'group.unmuted', {
                                groupId,
                                connectionId,
                            });
                        }
                    }
                } else if (commandType === 'KICK_PARTICIPANT') {
                    const targetJid = payload?.participantJid;
                    if (!targetJid) {
                        const failed = await this.commandRepo.failCommand(null, {
                            id,
                            workerId: this.workerId,
                            claimEpoch,
                            error: 'TARGET_PARTICIPANT_REQUIRED',
                            isTerminal: true,
                        });
                        if (failed) {
                            this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                        }
                        return;
                    }

                    // Check target is not admin and not bot
                    const targetAdminCheck = await gateway.checkAdminStatus(group.whatsapp_jid, targetJid);
                    if (targetAdminCheck.isSenderAdmin) {
                        const failed = await this.commandRepo.failCommand(null, {
                            id,
                            workerId: this.workerId,
                            claimEpoch,
                            error: 'TARGET_IS_ADMIN',
                            isTerminal: true,
                        });
                        if (failed) {
                            this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                        }
                        return;
                    }

                    if (!await this.commandRepo.markRemoteStarted(null, { id, workerId: this.workerId, claimEpoch })) return;
                    remoteOperationStarted = true;
                    const kicked = await gateway.kickParticipant(group.whatsapp_jid, targetJid);
                    const completed = await this.commandRepo.completeCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        result: { success: kicked, targetJid },
                    });

                    if (completed) {
                        this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'COMPLETED' });
                        if (this.auditLogRepo) {
                            this.auditLogRepo.create({
                                tenantId,
                                action: 'PARTICIPANT_KICKED',
                                resourceType: 'group',
                                resourceId: groupId,
                                metadata: { commandId: id, targetJid, connectionId },
                            }).catch(() => {});
                        }
                        if (this.eventPublisher) {
                            this.eventPublisher.publish(tenantId, 'command.completed', {
                                commandId: id,
                                action: 'KICK_PARTICIPANT',
                                status: 'COMPLETED',
                            });
                            this.eventPublisher.publish(tenantId, 'group.participant_kicked', {
                                groupId,
                                participantJid: targetJid,
                            });
                        }
                    }
                }
            }
        } catch (err) {
            console.error(`[WorkerNode ${this.workerId}] Error executing command ${id}:`, err.message);
            if (remoteOperationStarted) {
                // Do NOT increment terminal metrics on REMOTE_OUTCOME_UNKNOWN!
                // REMOTE_OUTCOME_UNKNOWN is an in-flight intermediate state.
                // The authoritative terminal metric will be recorded when resolved (COMPLETED/FAILED)
                // by RemoteOutcomeVerificationService or PlatformService.forceFailCommand.
                await this.commandRepo.markRemoteOutcomeUnknown(null, { id, workerId: this.workerId, claimEpoch, error: 'REMOTE_OUTCOME_UNKNOWN' });
                return;
            }
            const failRes = await this.commandRepo.failCommand(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: err.message,
                isTerminal: false,
                backoffSeconds: 5,
            });
            if (failRes === 'FAILED') {
                this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
            }
        } finally {
            this.inFlight.delete(id);
        }
    }

    drain({ graceMs = this.drainGraceMs } = {}) {
        if (this._drainPromise) return this._drainPromise;
        this._drainPromise = (async () => {
            this.status = 'DRAINING';
            if (this.workerRepo) {
                await this.workerRepo.updateStatus(this.workerId, 'DRAINING').catch(() => {});
            }

            // Snapshot active leases before stopping lease manager
            const activeLeases = Array.from(this.leaseManager.leases.values()).map((l) => ({ ...l }));

            // Immediately stop lease heartbeats so leases can expire or transfer (Test 4)
            this.leaseManager.stop();

            // Clear periodic reconcile timer immediately
            if (this.reconcileTimer) {
                clearInterval(this.reconcileTimer);
                this.reconcileTimer = null;
            }

            // No new durable work may be claimed after DRAINING is visible locally (Test 3)
            if (this.scheduler) this.scheduler.stop();

            // Existing work is allowed a bounded chance to finish. A timeout does
            // not infer remote failure: only durable remote-started work is marked unknown.
            const deadline = Date.now() + Math.max(0, graceMs);
            while (this.inFlight.size > 0 && Date.now() < deadline) {
                await new Promise((resolve) => setTimeout(resolve, Math.min(25, deadline - Date.now())));
            }
            if (this.inFlight.size > 0 && this.commandRepo) {
                await this.commandRepo.markRemoteStartedUnknownForWorker(null, { workerId: this.workerId }).catch(() => {});
            }
            if (this.inFlight.size > 0 && this.taskRepo) {
                await this.taskRepo.markRemoteStartedUnknownForWorker(null, { workerId: this.workerId }).catch(() => {});
            }

            for (const lease of activeLeases) {
                const connId = lease.connectionId;
                await this.connRepo.updateActualState({ connectionId: connId, workerId: this.workerId, leaseEpoch: lease.leaseEpoch, actualState: 'SOCKET_STOPPING', status: 'DISCONNECTED' }).catch(() => {});
                // This is runtime teardown initiation, not proof of physical liveness.
                await this.connectionManager.disconnectConnection(connId, 'worker_draining').catch(() => {});
                await this.connRepo.releaseLease({
                    connectionId: connId,
                    workerId: this.workerId,
                    leaseEpoch: lease.leaseEpoch,
                }).catch(() => {});
            }
            this.status = 'OFFLINE';
            if (this.workerRepo) await this.workerRepo.updateStatus(this.workerId, 'OFFLINE').catch(() => {});
        })();
        return this._drainPromise;
    }

    /**
     * Shuts down worker completely.
     */
    async shutdown() {
        if (this.isStopped) return;
        this.isStopped = true;
        this.status = 'OFFLINE';

        if (this.scheduler) {
            this.scheduler.stop();
        }

        if (this._unsubscribeCommand) {
            this._unsubscribeCommand();
        }
        if (this.reconcileTimer) {
            clearInterval(this.reconcileTimer);
            this.reconcileTimer = null;
        }
        if (this.workerHeartbeatTimer) {
            clearInterval(this.workerHeartbeatTimer);
            this.workerHeartbeatTimer = null;
        }

        this.leaseManager.stop();

        if (this.commandGateway && typeof this.commandGateway.unregisterWorkerNode === 'function') {
            this.commandGateway.unregisterWorkerNode(this.workerId);
        }

        if (this.workerRepo) {
            await this.workerRepo.updateStatus(this.workerId, 'OFFLINE').catch(() => {});
        }
    }

    async stop() {
        return this.shutdown();
    }

    /**
     * Executes a read-only remote probe for a command on this worker's active leased socket.
     * Guaranteed read-only: no database mutations, no downstream obligations.
     *
     * @param {string} commandId
     * @returns {Promise<object>} Sanitized remote state summary
     */
    async probeCommand(commandId) {
        if (!this.commandRepo) throw new Error('commandRepo is required for probe');
        const cmd = await this.commandRepo.findById(commandId);
        if (!cmd) return null;

        if (!this.leaseManager.hasLease(cmd.connection_id)) {
            const err = new Error('Connection is not leased by this worker');
            err.code = 'CONNECTION_NOT_LEASED_BY_WORKER';
            throw err;
        }

        const sock = this.connectionManager.getSocket(cmd.connection_id);
        if (!sock) {
            const err = new Error('WhatsApp socket is not connected for this connection');
            err.code = 'SOCKET_UNAVAILABLE';
            throw err;
        }

        const group = await this.groupRepo.findByIdForTenant(cmd.group_id, cmd.tenant_id);
        if (!group || !group.whatsapp_jid) {
            const err = new Error('Group not found or missing whatsapp_jid');
            err.code = 'GROUP_NOT_FOUND';
            throw err;
        }

        const metadata = await sock.groupMetadata(group.whatsapp_jid);
        const targetJid = cmd.payload?.participantJid;

        return {
            commandId: cmd.id,
            connectionId: cmd.connection_id,
            groupId: group.id,
            groupJid: group.whatsapp_jid,
            subject: metadata?.subject || null,
            announce: Boolean(metadata?.announce),
            restrict: Boolean(metadata?.restrict),
            participantCount: Array.isArray(metadata?.participants) ? metadata.participants.length : 0,
            targetParticipantPresent: targetJid && Array.isArray(metadata?.participants)
                ? metadata.participants.some((p) => p.id === targetJid)
                : null,
        };
    }

    /**
     * Executes a read-only remote probe for a scheduled task on this worker's active leased socket.
     * Guaranteed read-only: no database mutations.
     *
     * @param {string} taskId
     * @returns {Promise<object>} Sanitized remote state summary
     */
    async probeTask(taskId) {
        if (!this.taskRepo) throw new Error('taskRepo is required for probe');
        const task = await this.taskRepo.findById(taskId);
        if (!task) return null;

        if (!this.leaseManager.hasLease(task.connection_id)) {
            const err = new Error('Connection is not leased by this worker');
            err.code = 'CONNECTION_NOT_LEASED_BY_WORKER';
            throw err;
        }

        const sock = this.connectionManager.getSocket(task.connection_id);
        if (!sock) {
            const err = new Error('WhatsApp socket is not connected for this connection');
            err.code = 'SOCKET_UNAVAILABLE';
            throw err;
        }

        const group = await this.groupRepo.findByIdForTenant(task.group_id, task.tenant_id);
        if (!group || !group.whatsapp_jid) {
            const err = new Error('Group not found or missing whatsapp_jid');
            err.code = 'GROUP_NOT_FOUND';
            throw err;
        }

        const metadata = await sock.groupMetadata(group.whatsapp_jid);

        return {
            taskId: task.id,
            connectionId: task.connection_id,
            groupId: group.id,
            groupJid: group.whatsapp_jid,
            subject: metadata?.subject || null,
            announce: Boolean(metadata?.announce),
            restrict: Boolean(metadata?.restrict),
            participantCount: Array.isArray(metadata?.participants) ? metadata.participants.length : 0,
        };
    }

    /**
     * Executes fenced outcome resolution for a command in REMOTE_OUTCOME_UNKNOWN.
     * Uses the exact same verification logic and fencing as background verification.
     *
     * @param {string} commandId
     * @returns {Promise<object>} Authoritative command state
     */
    async resolveCommand(commandId) {
        if (!this.commandRepo) throw new Error('commandRepo is required for resolution');
        const cmd = await this.commandRepo.findById(commandId);
        if (!cmd) return null;

        // If already resolved by background sweeper or another operator, return current authoritative state
        if (cmd.status === 'COMPLETED' || cmd.status === 'FAILED') {
            return cmd;
        }

        const lease = this.leaseManager.getLease(cmd.connection_id);
        if (!lease) {
            const err = new Error('Connection is not leased by this worker');
            err.code = 'CONNECTION_NOT_LEASED_BY_WORKER';
            throw err;
        }

        const sock = this.connectionManager.getSocket(cmd.connection_id);
        if (!sock) {
            const err = new Error('WhatsApp socket is not connected for this connection');
            err.code = 'SOCKET_UNAVAILABLE';
            throw err;
        }

        if (this.verificationService) {
            await this.verificationService.verifyCommand(cmd, { sock, claimEpoch: lease.leaseEpoch });
        }

        return this.commandRepo.findById(commandId);
    }

    /**
     * Executes fenced outcome resolution for a scheduled task in REMOTE_OUTCOME_UNKNOWN.
     * Uses the exact same verification logic and fencing as background verification.
     *
     * @param {string} taskId
     * @returns {Promise<object>} Authoritative task state
     */
    async resolveTask(taskId) {
        if (!this.taskRepo) throw new Error('taskRepo is required for resolution');
        const task = await this.taskRepo.findById(taskId);
        if (!task) return null;

        if (task.status === 'COMPLETED' || task.status === 'FAILED') {
            return task;
        }

        const lease = this.leaseManager.getLease(task.connection_id);
        if (!lease) {
            const err = new Error('Connection is not leased by this worker');
            err.code = 'CONNECTION_NOT_LEASED_BY_WORKER';
            throw err;
        }

        const sock = this.connectionManager.getSocket(task.connection_id);
        if (!sock) {
            const err = new Error('WhatsApp socket is not connected for this connection');
            err.code = 'SOCKET_UNAVAILABLE';
            throw err;
        }

        if (this.verificationService) {
            await this.verificationService.verifyTask(task, { sock, claimEpoch: lease.leaseEpoch });
        }

        return this.taskRepo.findById(taskId);
    }

    /**
     * Requests an ephemeral pairing code from the leased connection's active socket.
     * Enforces worker lease ownership and generation fencing.
     *
     * @param {string} connectionId
     * @param {string} phoneNumber
     * @returns {Promise<string>} Formatted pairing code
     */
    async requestPairingCode(connectionId, phoneNumber) {
        if (!connectionId) throw new Error('connectionId is required');
        if (!phoneNumber) throw new Error('phoneNumber is required');

        const lease = this.leaseManager.getLease(connectionId);
        if (!lease) {
            const err = new Error('Connection is not leased by this worker');
            err.code = 'CONNECTION_NOT_LEASED_BY_WORKER';
            throw err;
        }

        const code = await this.connectionManager.requestPairingCode(connectionId, phoneNumber, {
            leaseEpoch: lease.leaseEpoch,
        });

        return code;
    }
}

module.exports = WorkerNode;
