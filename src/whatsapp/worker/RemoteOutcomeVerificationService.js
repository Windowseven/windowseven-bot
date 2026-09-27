const WhatsAppModerationGateway = require('../../gateways/WhatsAppModerationGateway');
const { defaultMetricsRegistry } = require('../../application/metrics/MetricsRegistry');

/**
 * Classifies remote WhatsApp errors into permanent vs transient categories.
 *
 * @param {Error|any} err
 * @returns {{ isPermanent: boolean, code: string, message: string }}
 */
function classifyRemoteError(err) {
    if (!err) return { isPermanent: false, code: 'UNKNOWN_ERROR', message: 'Unknown error' };
    const msg = (err.message || '').toLowerCase();
    const status = err.output?.statusCode || err.status || err.data;

    // Permanent errors: bot removed, group destroyed, invalid JID, 404, 401, 403, 400
    if (
        status === 404 ||
        status === 401 ||
        status === 403 ||
        status === 400 ||
        msg.includes('item-not-found') ||
        msg.includes('not-authorized') ||
        msg.includes('forbidden') ||
        msg.includes('group not found') ||
        msg.includes('bad request') ||
        msg.includes('invalid jid')
    ) {
        return { isPermanent: true, code: 'PERMANENT_REMOTE_UNAVAILABLE', message: err.message };
    }

    // Transient errors: rate-limit, timeout, socket disconnect, 503, etc.
    return { isPermanent: false, code: 'TRANSIENT_QUERY_FAILURE', message: err.message };
}

// Maximum duration an entity may remain in automated UNKNOWN verification sweeps before terminal failure (60 seconds)
const MAX_VERIFICATION_WINDOW_MS = 60 * 1000;

/**
 * Dedicated operation-aware Remote Outcome Verification Service.
 *
 * Enforces:
 * - Executes only from a worker holding valid connection ownership
 * - Uses existing ConnectionManager socket instance (never creates raw Baileys sockets)
 * - Verifies using read-only WhatsApp queries (groupMetadata)
 * - Applies operation-specific recovery decisions for MUTE_GROUP, UNMUTE_GROUP, and KICK_PARTICIPANT
 * - Guarantees exactly-once durable UNMUTE task insertion via atomic PostgreSQL transaction gate
 */
class RemoteOutcomeVerificationService {
    constructor({
        pool,
        commandRepo,
        taskRepo,
        groupRepo,
        connectionManager,
        leaseManager,
        auditLogRepo = null,
        eventPublisher = null,
        metricsRegistry = null,
        workerId,
    }) {
        if (!pool || !commandRepo || !taskRepo || !groupRepo || !connectionManager || !leaseManager || !workerId) {
            throw new Error('[RemoteOutcomeVerificationService] Required dependencies missing');
        }
        this.pool = pool;
        this.commandRepo = commandRepo;
        this.taskRepo = taskRepo;
        this.groupRepo = groupRepo;
        this.connectionManager = connectionManager;
        this.leaseManager = leaseManager;
        this.auditLogRepo = auditLogRepo;
        this.eventPublisher = eventPublisher;
        this.metricsRegistry = metricsRegistry || defaultMetricsRegistry;
        this.workerId = workerId;
    }

    /**
     * Verifies all REMOTE_OUTCOME_UNKNOWN commands and scheduled tasks for a leased connection.
     *
     * @param {string} connectionId
     * @returns {Promise<{ verifiedCommands: number, verifiedTasks: number }>}
     */
    async verifyUnknownForConnection(connectionId) {
        if (!this.leaseManager.hasLease(connectionId)) {
            return { verifiedCommands: 0, verifiedTasks: 0 };
        }

        const lease = this.leaseManager.getLease(connectionId);
        if (!lease) return { verifiedCommands: 0, verifiedTasks: 0 };
        const claimEpoch = lease.leaseEpoch;

        let sock = null;
        if (this.connectionManager && typeof this.connectionManager.getSocket === 'function') {
            sock = this.connectionManager.getSocket(connectionId);
        } else if (this.connectionManager?.connections && typeof this.connectionManager.connections.get === 'function') {
            const conn = this.connectionManager.connections.get(connectionId);
            sock = conn ? (conn.socket || conn.sock || null) : null;
        }
        if (!sock) {
            // Cannot verify without an active socket; remain UNKNOWN until connection is active
            return { verifiedCommands: 0, verifiedTasks: 0 };
        }

        let verifiedCommands = 0;
        let verifiedTasks = 0;

        // 1. Verify unknown durable commands
        const unknownCommands = await this.commandRepo.findUnknownCommandsForConnection(null, connectionId);
        for (const cmd of unknownCommands) {
            // Re-verify lease before each operation
            if (!this.leaseManager.hasLease(connectionId)) break;
            try {
                const res = await this.verifyCommand(cmd, { sock, claimEpoch });
                if (res) verifiedCommands++;
            } catch (err) {
                console.error(`[RemoteOutcomeVerificationService ${this.workerId}] Error verifying command ${cmd.id}:`, err.message);
            }
        }

        // 2. Verify unknown scheduled moderation tasks
        const unknownTasks = await this.taskRepo.findUnknownTasksForConnection(null, connectionId);
        for (const task of unknownTasks) {
            // Re-verify lease before each operation
            if (!this.leaseManager.hasLease(connectionId)) break;
            try {
                const res = await this.verifyTask(task, { sock, claimEpoch });
                if (res) verifiedTasks++;
            } catch (err) {
                console.error(`[RemoteOutcomeVerificationService ${this.workerId}] Error verifying task ${task.id}:`, err.message);
            }
        }

        return { verifiedCommands, verifiedTasks };
    }

    /**
     * Verifies a single command whose status is REMOTE_OUTCOME_UNKNOWN.
     */
    async verifyCommand(cmd, { sock, claimEpoch }) {
        const { id, tenant_id: tenantId, connection_id: connectionId, group_id: groupId, command_type: commandType, payload } = cmd;

        if (!groupId) {
            const failed = await this.commandRepo.failCommand(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'GROUP_REQUIRED',
                isTerminal: true,
            });
            if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
            return false;
        }

        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group || !group.whatsapp_jid) {
            const failed = await this.commandRepo.failCommand(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'GROUP_NOT_FOUND',
                isTerminal: true,
            });
            if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
            return false;
        }

        const gateway = new WhatsAppModerationGateway(sock);
        const botJid = sock.user?.id;
        const currentCmd = (this.commandRepo?.findById ? await this.commandRepo.findById(id) : null) || cmd;
        const effectiveRemoteStartedAt = currentCmd.remote_started_at || cmd.remote_started_at;
        const effectiveAttemptCount = currentCmd.attempt_count ?? cmd.attempt_count ?? 0;
        const maxVerificationAttempts = currentCmd.max_attempts || cmd.max_attempts || 5;
        const elapsedMs = effectiveRemoteStartedAt ? (Date.now() - new Date(effectiveRemoteStartedAt).getTime()) : 0;

        if (commandType === 'MUTE_GROUP') {
            let metadata = null;
            let queryError = null;
            try {
                metadata = await sock.groupMetadata(group.whatsapp_jid);
            } catch (err) {
                queryError = err;
            }

            if (!metadata) {
                const classification = classifyRemoteError(queryError);
                if (classification.isPermanent) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `PERMANENT_REMOTE_UNAVAILABLE: ${classification.message}`,
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: commandType, status: 'FAILED' });
                    return false;
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.commandRepo.recordUnknownVerificationAttempt === 'function') {
                    await this.commandRepo.recordUnknownVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `TRANSIENT_QUERY_FAILURE: ${classification.message}`,
                        backoffSeconds,
                    });
                }
                return false;
            }

            const isAnnounce = Boolean(metadata.announce);

            if (isAnnounce) {
                // CASE A: Desired state achieved!
                // Atomic finalization transaction gate
                const txClient = await this.pool.connect();
                try {
                    await txClient.query('BEGIN');

                    const compSql = `
                        UPDATE connection_commands
                        SET status = 'COMPLETED', executed_at = NOW(), updated_at = NOW()
                        WHERE id = $1 AND status IN ('PROCESSING', 'REMOTE_OUTCOME_UNKNOWN')
                          AND connection_id = $2
                        RETURNING id, executed_at;
                    `;
                    const compRes = await txClient.query(compSql, [id, connectionId]);
                    if (compRes.rows.length === 0) {
                        // Lost race or already completed by another thread
                        await txClient.query('ROLLBACK');
                        return false;
                    }

                    const successfulMuteTime = compRes.rows[0].executed_at;
                    const durationMinutes = payload?.durationMinutes;

                    // Replacement semantics: cancel any previous pending unmutes for this group
                    await txClient.query(`
                        UPDATE scheduled_moderation_tasks
                        SET status = 'CANCELLED', updated_at = NOW()
                        WHERE tenant_id = $1 AND group_id = $2 AND action = 'UNMUTE_GROUP' AND status = 'PENDING';
                    `, [tenantId, groupId]);

                    // Insert durable unmute task if duration was requested
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
                            action: 'COMMAND_REMOTE_VERIFIED',
                            resourceType: 'connection_command',
                            resourceId: id,
                            metadata: { commandType: 'MUTE_GROUP', outcome: 'ACHIEVED', announce: true },
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

                    return true;
                } catch (txErr) {
                    await txClient.query('ROLLBACK');
                    throw txErr;
                } finally {
                    txClient.release();
                }
            } else {
                // CASE B: Desired state NOT observed (announce === false)
                const adminStatus = await gateway.checkAdminStatus(group.whatsapp_jid, botJid);
                if (!adminStatus.isBotAdmin) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'BOT_NOT_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'MUTE_GROUP', status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    // Verification window expired: terminal failure without scheduling any UNMUTE task
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_MUTE_NOT_OBSERVED_TIMED_OUT',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'MUTE_GROUP', status: 'FAILED' });
                    return false;
                }

                // Deterministic bounded backoff retry in UNKNOWN state (never requeue to PENDING!)
                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.commandRepo.recordUnknownVerificationAttempt === 'function') {
                    await this.commandRepo.recordUnknownVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_MUTE_NOT_YET_OBSERVED',
                        backoffSeconds,
                    });
                }
                return false;
            }
        } else if (commandType === 'UNMUTE_GROUP') {
            let metadata = null;
            let queryError = null;
            try {
                metadata = await sock.groupMetadata(group.whatsapp_jid);
            } catch (err) {
                queryError = err;
            }

            if (!metadata) {
                const classification = classifyRemoteError(queryError);
                if (classification.isPermanent) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `PERMANENT_REMOTE_UNAVAILABLE: ${classification.message}`,
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'UNMUTE_GROUP', status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'UNMUTE_GROUP', status: 'FAILED' });
                    return false;
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.commandRepo.recordUnknownVerificationAttempt === 'function') {
                    await this.commandRepo.recordUnknownVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `TRANSIENT_QUERY_FAILURE: ${classification.message}`,
                        backoffSeconds,
                    });
                }
                return false;
            }

            const isAnnounce = Boolean(metadata.announce);

            if (!isAnnounce) {
                // CASE A: Desired state achieved (already unmuted)
                const completed = await this.commandRepo.completeCommand(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                    result: { verifiedUnmuted: true },
                });

                if (completed) {
                    this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'UNMUTE_GROUP', status: 'COMPLETED' });
                    if (this.auditLogRepo) {
                        this.auditLogRepo.create({
                            tenantId,
                            action: 'COMMAND_REMOTE_VERIFIED',
                            resourceType: 'connection_command',
                            resourceId: id,
                            metadata: { commandType: 'UNMUTE_GROUP', outcome: 'ACHIEVED', announce: false },
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
                return true;
            } else {
                // CASE B: Still announce (muted)
                const adminStatus = await gateway.checkAdminStatus(group.whatsapp_jid, botJid);
                if (!adminStatus.isBotAdmin) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'BOT_NOT_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'UNMUTE_GROUP', status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_UNMUTE_NOT_OBSERVED_TIMED_OUT',
                        isTerminal: true,
                    });
                    return false;
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.commandRepo.recordUnknownVerificationAttempt === 'function') {
                    await this.commandRepo.recordUnknownVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_UNMUTE_PENDING_RETRY',
                        backoffSeconds,
                    });
                }
                return false;
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
                if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                return false;
            }

            let metadata = null;
            let queryError = null;
            try {
                metadata = await sock.groupMetadata(group.whatsapp_jid);
            } catch (err) {
                queryError = err;
            }

            if (!metadata) {
                const classification = classifyRemoteError(queryError);
                if (classification.isPermanent) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `PERMANENT_REMOTE_UNAVAILABLE: ${classification.message}`,
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                    return false;
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.commandRepo.recordUnknownVerificationAttempt === 'function') {
                    await this.commandRepo.recordUnknownVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `TRANSIENT_QUERY_FAILURE: ${classification.message}`,
                        backoffSeconds,
                    });
                }
                return false;
            }

            const isPresent = Array.isArray(metadata.participants) && metadata.participants.some((p) => p.id === targetJid);

            if (!isPresent) {
                // CASE A: Target absent!
                const completed = await this.commandRepo.completeCommand(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                    result: { success: true, verifiedAbsent: true },
                });

                if (completed) {
                    this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'COMPLETED' });
                    if (this.auditLogRepo) {
                        this.auditLogRepo.create({
                            tenantId,
                            action: 'COMMAND_REMOTE_VERIFIED',
                            resourceType: 'connection_command',
                            resourceId: id,
                            metadata: { commandType: 'KICK_PARTICIPANT', outcome: 'ACHIEVED', targetJid },
                        }).catch(() => {});
                    }

                    if (this.eventPublisher) {
                        this.eventPublisher.publish(tenantId, 'command.completed', {
                            commandId: id,
                            action: 'KICK_PARTICIPANT',
                            status: 'COMPLETED',
                        });
                    }
                }
                return true;
            } else {
                // CASE B: Target still present!
                const botAdmin = await gateway.checkAdminStatus(group.whatsapp_jid, botJid);
                if (!botAdmin.isBotAdmin) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'BOT_NOT_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                    return false;
                }

                const targetAdmin = await gateway.checkAdminStatus(group.whatsapp_jid, targetJid);
                if (targetAdmin.isSenderAdmin) {
                    const failed = await this.commandRepo.failCommand(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'TARGET_IS_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                    return false;
                }

                // If groupMetadata succeeded, bot is admin, target is not admin, but target is still present:
                // The remote kick did not take effect. Fail terminal immediately without blind retries.
                const failed = await this.commandRepo.failCommand(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                    error: 'PARTICIPANT_REMAINS_PRESENT_AFTER_KICK',
                    isTerminal: true,
                });
                if (failed) this.metricsRegistry?.durableCommandsTotal?.inc({ command: 'KICK_PARTICIPANT', status: 'FAILED' });
                return false;
            }
        }

        return false;
    }

    /**
     * Verifies a single scheduled task whose status is REMOTE_OUTCOME_UNKNOWN.
     */
    async verifyTask(task, { sock, claimEpoch }) {
        const { id, tenant_id: tenantId, connection_id: connectionId, group_id: groupId, action } = task;

        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group || !group.whatsapp_jid) {
            const failed = await this.taskRepo.failTask(null, {
                id,
                workerId: this.workerId,
                claimEpoch,
                error: 'GROUP_NOT_FOUND',
                isTerminal: true,
            });
            if (failed) this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
            return false;
        }

        const gateway = new WhatsAppModerationGateway(sock);
        const botJid = sock.user?.id;
        const currentTask = (this.taskRepo?.findById ? await this.taskRepo.findById(id) : null) || task;
        const effectiveRemoteStartedAt = currentTask.remote_started_at || task.remote_started_at;
        const effectiveAttemptCount = currentTask.attempt_count ?? task.attempt_count ?? 0;
        const maxVerificationAttempts = currentTask.max_attempts || task.max_attempts || 5;
        const elapsedMs = effectiveRemoteStartedAt ? (Date.now() - new Date(effectiveRemoteStartedAt).getTime()) : 0;

        if (action === 'UNMUTE_GROUP') {
            let metadata = null;
            let queryError = null;
            try {
                metadata = await sock.groupMetadata(group.whatsapp_jid);
            } catch (err) {
                queryError = err;
            }

            if (!metadata) {
                const classification = classifyRemoteError(queryError);
                if (classification.isPermanent) {
                    const failed = await this.taskRepo.failTask(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `PERMANENT_REMOTE_UNAVAILABLE: ${classification.message}`,
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.taskRepo.failTask(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'VERIFICATION_WINDOW_EXPIRED_REMOTE_UNVERIFIABLE',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
                    return false;
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.taskRepo.recordUnknownTaskVerificationAttempt === 'function') {
                    await this.taskRepo.recordUnknownTaskVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: `TRANSIENT_QUERY_FAILURE: ${classification.message}`,
                        backoffSeconds,
                    });
                }
                return false;
            }

            const isAnnounce = Boolean(metadata.announce);

            if (!isAnnounce) {
                // CASE A: Desired state achieved! (Already unmuted)
                const completed = await this.taskRepo.completeTask(null, {
                    id,
                    workerId: this.workerId,
                    claimEpoch,
                });

                if (completed) {
                    this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'COMPLETED' });
                    if (this.auditLogRepo) {
                        this.auditLogRepo.create({
                            tenantId,
                            action: 'TASK_REMOTE_VERIFIED',
                            resourceType: 'scheduled_moderation_task',
                            resourceId: id,
                            metadata: { action: 'UNMUTE_GROUP', outcome: 'ACHIEVED', announce: false },
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
                return true;
            } else {
                // CASE B: Still announce (muted)
                const adminStatus = await gateway.checkAdminStatus(group.whatsapp_jid, botJid);
                if (!adminStatus.isBotAdmin) {
                    const failed = await this.taskRepo.failTask(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'BOT_NOT_ADMIN',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
                    return false;
                }

                const nextAttempts = effectiveAttemptCount + 1;
                if (nextAttempts >= maxVerificationAttempts || elapsedMs >= MAX_VERIFICATION_WINDOW_MS) {
                    const failed = await this.taskRepo.failTask(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_UNMUTE_NOT_OBSERVED_TIMED_OUT',
                        isTerminal: true,
                    });
                    if (failed) this.metricsRegistry?.scheduledTasksTotal?.inc({ type: action, status: 'FAILED' });
                }

                const backoffSeconds = Math.min(10 * Math.pow(2, effectiveAttemptCount), 60);
                if (typeof this.taskRepo.recordUnknownTaskVerificationAttempt === 'function') {
                    await this.taskRepo.recordUnknownTaskVerificationAttempt(null, {
                        id,
                        workerId: this.workerId,
                        claimEpoch,
                        error: 'REMOTE_UNMUTE_PENDING_RETRY',
                        backoffSeconds,
                    });
                }
                return false;
            }
        }

        return false;
    }
}

module.exports = RemoteOutcomeVerificationService;
module.exports.classifyRemoteError = classifyRemoteError;
module.exports.MAX_VERIFICATION_WINDOW_MS = MAX_VERIFICATION_WINDOW_MS;
