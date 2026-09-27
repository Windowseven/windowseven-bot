const WhatsAppModerationGateway = require('../../gateways/WhatsAppModerationGateway');
const { defaultMetricsRegistry } = require('../../application/metrics/MetricsRegistry');

class DurableModerationScheduler {
    constructor({
        pool,
        taskRepo,
        leaseManager,
        connectionManager,
        groupRepo,
        auditLogRepo = null,
        eventPublisher = null,
        metricsRegistry = null,
        workerId,
        pollIntervalMs = 5000,
    }) {
        if (!pool || !taskRepo || !leaseManager || !connectionManager || !groupRepo || !workerId) {
            throw new Error('[DurableModerationScheduler] pool, taskRepo, leaseManager, connectionManager, groupRepo, and workerId are required');
        }
        this.pool = pool;
        this.taskRepo = taskRepo;
        this.leaseManager = leaseManager;
        this.connectionManager = connectionManager;
        this.groupRepo = groupRepo;
        this.auditLogRepo = auditLogRepo;
        this.eventPublisher = eventPublisher;
        this.metricsRegistry = metricsRegistry || defaultMetricsRegistry;
        this.workerId = workerId;
        this.pollIntervalMs = pollIntervalMs;
        this.timer = null;
        this.isProcessing = false;
        this.isStopped = false;
    }

    start() {
        if (this.timer) return;
        this.isStopped = false;
        this.timer = setInterval(async () => {
            if (this.isStopped || this.isProcessing) return;
            this.isProcessing = true;
            try {
                await this.sweepAndExecute();
            } catch (err) {
                console.error(`[DurableModerationScheduler ${this.workerId}] Error in sweep:`, err.message);
            } finally {
                this.isProcessing = false;
            }
        }, this.pollIntervalMs);

        if (typeof this.timer.unref === 'function') {
            this.timer.unref();
        }
    }

    stop() {
        this.isStopped = true;
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }

    async sweepAndExecute() {
        if (this.isStopped) return;
        // Collect currently active leased connection IDs
        const connectionIds = Array.from(this.leaseManager.leases.keys());
        if (connectionIds.length === 0) return;

        const client = await this.pool.connect();
        try {
            const task = await this.taskRepo.claimNextTask(client, {
                connectionIds,
                workerId: this.workerId,
                getLeaseEpochForConnection: (connId) => {
                    const l = this.leaseManager.leases.get(connId);
                    return l ? l.leaseEpoch : 1;
                },
            });

            if (!task) return;

            await this.processTask(task);
        } finally {
            client.release();
        }
    }

    async processTask(task) {
        const { id, tenant_id: tenantId, connection_id: connectionId, group_id: groupId, claim_epoch: claimEpoch, action } = task;

        // 1. Generation fencing check
        if (!this.leaseManager.hasLease(connectionId)) {
            console.warn(`[DurableModerationScheduler ${this.workerId}] Lost lease for ${connectionId}. Requeueing task ${id}`);
            const requeued = await this.taskRepo.requeueStaleTask(null, { id, workerId: this.workerId, claimEpoch });
            if (requeued && this.auditLogRepo) {
                this.auditLogRepo.create({
                    tenantId,
                    action: 'STALE_GENERATION_REJECTED',
                    resourceType: 'scheduled_moderation_task',
                    resourceId: id,
                    metadata: { operation: 'processTask', claimEpoch, reason: 'lost_connection_lease' },
                }).catch(() => {});
            }
            return;
        }

        const currentEpoch = this.leaseManager.leases.get(connectionId)?.leaseEpoch;
        if (Number(currentEpoch) !== Number(claimEpoch)) {
            console.warn(`[DurableModerationScheduler ${this.workerId}] Epoch mismatch (${currentEpoch} !== ${claimEpoch}) for task ${id}. Requeueing.`);
            await this.taskRepo.requeueStaleTask(null, { id, workerId: this.workerId, claimEpoch });
            return;
        }

        // 2. Pre-gateway cancellation check (Honest cancellation race handling)
        const fresh = await this.taskRepo.getTaskStatus(id);
        if (fresh?.status === 'CANCELLED') {
            console.log(`[DurableModerationScheduler ${this.workerId}] Task ${id} was cancelled before execution. Aborting.`);
            return;
        }
        if (fresh?.status === 'PAUSED') {
            console.log(`[DurableModerationScheduler ${this.workerId}] Task ${id} was paused before execution. Aborting.`);
            return;
        }

        // 3. Group and connection relational invariant & status check
        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group || group.connection_id !== connectionId || group.status !== 'MANAGED') {
            console.warn(`[DurableModerationScheduler ${this.workerId}] Task ${id} failed invariant check: group not found or unmanaged`);
            if (group && group.status !== 'MANAGED') {
                await this.taskRepo.cancelTask(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                });
                return;
            }
            const failed = await this.taskRepo.failTask(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'GROUP_NOT_MANAGED_OR_MISMATCHED',
                isTerminal: true,
            });
            if (failed) {
                this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
            }
            return;
        }

        // 4. Active socket check
        const sock = this.connectionManager.getSocket(connectionId);
        if (!sock) {
            console.warn(`[DurableModerationScheduler ${this.workerId}] Socket unavailable for ${connectionId}. Retrying task ${id}`);
            await this.taskRepo.failTask(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'SOCKET_UNAVAILABLE',
                isTerminal: false,
                backoffSeconds: 5,
            });
            return;
        }

        // 5. Execute side effect on WhatsApp (At-least-once delivery; repeat-safe)
        let remoteOperationStarted = false;
        try {
            if (action === 'UNMUTE_GROUP') {
                const gateway = new WhatsAppModerationGateway(sock);
                if (!await this.taskRepo.markRemoteStarted(null, { id, workerId: this.workerId, claimEpoch })) return;
                remoteOperationStarted = true;
                await gateway.unmuteGroup(group.whatsapp_jid);
                await gateway.sendTextMessage(group.whatsapp_jid, '*_The group has been unmuted._*');
            }

            // 6. Claim-fenced completion
            const completed = await this.taskRepo.completeTask(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
            });

            if (completed) {
                this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'COMPLETED' });
                if (this.auditLogRepo) {
                    await this.auditLogRepo.create({
                        tenantId,
                        action: 'SCHEDULED_UNMUTE_EXECUTED',
                        resourceType: 'group',
                        resourceId: groupId,
                        metadata: { taskId: id, connectionId, whatsappJid: group.whatsapp_jid },
                    }).catch(() => {});
                }

                if (this.eventPublisher) {
                    this.eventPublisher.publish(tenantId, 'group.unmuted', {
                        groupId,
                        connectionId,
                        whatsappJid: group.whatsapp_jid,
                        taskId: id,
                    });
                }
            }
        } catch (err) {
            console.error(`[DurableModerationScheduler ${this.workerId}] Error executing task ${id}:`, err.message);
            if (remoteOperationStarted) {
                // Do NOT increment terminal metrics on REMOTE_OUTCOME_UNKNOWN!
                // REMOTE_OUTCOME_UNKNOWN is an in-flight intermediate state.
                // The authoritative terminal metric will be recorded when resolved (COMPLETED/FAILED)
                // by RemoteOutcomeVerificationService or PlatformService.forceFailTask.
                await this.taskRepo.markRemoteOutcomeUnknown(null, { id, workerId: this.workerId, claimEpoch, error: 'REMOTE_OUTCOME_UNKNOWN' });
                return;
            }
            const failRes = await this.taskRepo.failTask(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: err.message,
                isTerminal: false,
                backoffSeconds: 10,
            });
            if (failRes === 'FAILED') {
                this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
            }
        }
    }
}

module.exports = DurableModerationScheduler;
