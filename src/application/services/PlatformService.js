const ApiError = require('../errors/ApiError');
const ConnectionCommandRepository = require('../../repositories/ConnectionCommandRepository');
const ScheduledModerationTaskRepository = require('../../repositories/ScheduledModerationTaskRepository');
const PlanRepository = require('../../repositories/PlanRepository');
const SubscriptionRepository = require('../../repositories/SubscriptionRepository');
const PaymentRepository = require('../../repositories/PaymentRepository');
const UserRepository = require('../../repositories/UserRepository');
const { defaultCommandGateway } = require('../../whatsapp/control/ConnectionCommandGateway');
const { defaultEventPublisher } = require('../realtime/EventPublisher');
const { defaultMetricsRegistry } = require('../metrics/MetricsRegistry');

/**
 * Windowseven MD Platform Administration Service
 * Governs cross-tenant operations, worker cluster coordination, tenant lifecycles, and audit trails.
 */
class PlatformService {
    /**
     * @param {object} params
     * @param {import('pg').Pool} params.pool
     * @param {import('../../repositories/TenantRepository')} params.tenantRepo
     * @param {import('../../repositories/WhatsAppConnectionRepository')} params.connRepo
     * @param {import('../../repositories/WorkerRepository')} params.workerRepo
     * @param {import('../../repositories/PlatformAuditRepository')} params.platformAuditRepo
     * @param {import('../../repositories/PlatformRoleRepository')} params.platformRoleRepo
     * @param {import('../../repositories/ScheduledModerationTaskRepository')} [params.taskRepo]
     * @param {import('../../repositories/GroupRepository')} [params.groupRepo]
     * @param {import('../../repositories/ConnectionCommandRepository')} [params.commandRepo]
     * @param {import('../../repositories/PlanRepository')} [params.planRepo]
     * @param {import('../../repositories/SubscriptionRepository')} [params.subscriptionRepo]
     * @param {import('../../repositories/PaymentRepository')} [params.paymentRepo]
     * @param {import('../../repositories/UserRepository')} [params.userRepo]
     * @param {import('../../whatsapp/control/ConnectionCommandGateway').ConnectionCommandGateway} [params.commandGateway]
     * @param {import('../realtime/EventPublisher').IEventPublisher} [params.eventPublisher]
     * @param {import('../metrics/MetricsRegistry').MetricsRegistry} [params.metricsRegistry]
     */
    constructor({
        pool,
        tenantRepo,
        connRepo,
        workerRepo,
        platformAuditRepo,
        platformRoleRepo,
        taskRepo = null,
        groupRepo = null,
        commandRepo = null,
        planRepo = null,
        subscriptionRepo = null,
        paymentRepo = null,
        userRepo = null,
        commandGateway = defaultCommandGateway,
        eventPublisher = defaultEventPublisher,
        metricsRegistry = null,
    }) {
        if (!pool || !tenantRepo || !connRepo || !workerRepo || !platformAuditRepo || !platformRoleRepo) {
            throw new Error('[PlatformService] Required repositories and pool must be provided');
        }
        this.pool = pool;
        this.tenantRepo = tenantRepo;
        this.connRepo = connRepo;
        this.workerRepo = workerRepo;
        this.platformAuditRepo = platformAuditRepo;
        this.platformRoleRepo = platformRoleRepo;
        this.taskRepo = taskRepo || (pool ? new ScheduledModerationTaskRepository(pool) : null);
        this.groupRepo = groupRepo;
        this.commandRepo = commandRepo || (pool ? new ConnectionCommandRepository(pool) : null);
        this.planRepo = planRepo || (pool ? new PlanRepository(pool) : null);
        this.subscriptionRepo = subscriptionRepo || (pool ? new SubscriptionRepository(pool) : null);
        this.paymentRepo = paymentRepo || (pool ? new PaymentRepository(pool) : null);
        this.userRepo = userRepo || (pool ? new UserRepository(pool) : null);
        this.commandGateway = commandGateway;
        this.eventPublisher = eventPublisher;
        this.metricsRegistry = metricsRegistry || defaultMetricsRegistry;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. TENANT LIFECYCLE MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Creates a new tenant (SUPER_ADMIN only).
     */
    async createTenant({ name }, { actorUserId = null, actorRole = 'SUPER_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw ApiError.badRequest('Tenant name is required', 'VALIDATION_ERROR');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const tenant = await this.tenantRepo.create({ name: name.trim() }, client);

            // Platform audit log
            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'TENANT_CREATED',
                targetType: 'TENANT',
                targetId: tenant.id,
                targetTenantId: tenant.id,
                reason: null,
                metadata: {
                    name: tenant.name,
                    status: tenant.status,
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');

            // Publish platform event
            await this.eventPublisher.publish({
                tenantId: tenant.id,
                eventType: 'platform.tenant.created',
                data: {
                    tenantId: tenant.id,
                    name: tenant.name,
                },
            }).catch(() => {});

            return tenant;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Lists tenants across the platform with pagination and aggregate counts.
     */
    async listTenants({ limit = 50, offset = 0, status = null } = {}) {
        return this.tenantRepo.listAllTenants({ limit, offset, status });
    }

    /**
     * Retrieves comprehensive operational state for a specific tenant.
     */
    async getTenantDetail(tenantId) {
        if (!tenantId) throw ApiError.badRequest('Tenant ID is required', 'VALIDATION_ERROR');

        const tenant = await this.tenantRepo.findById(tenantId);
        if (!tenant) throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');

        // Fetch connections for tenant
        const connections = await this.connRepo.listForTenant(tenantId);

        // Fetch group count if groupRepo is available
        let groupCount = 0;
        if (this.groupRepo) {
            const groups = await this.groupRepo.listForTenant(tenantId).catch(() => []);
            groupCount = groups.length;
        }

        return {
            tenant,
            connections,
            groupCount,
        };
    }

    /**
     * Suspends a tenant using Option B (Pauses all PENDING scheduled tasks).
     */
    async suspendTenant(tenantId, { reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!tenantId) throw ApiError.badRequest('Tenant ID is required', 'VALIDATION_ERROR');

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const tenant = await this.tenantRepo.findById(tenantId, client);
            if (!tenant) throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
            if (tenant.status === 'SUSPENDED') {
                await client.query('ROLLBACK');
                return tenant;
            }
            if (tenant.status === 'DEACTIVATED') {
                throw ApiError.badRequest('Cannot suspend a deactivated tenant', 'TENANT_DEACTIVATED');
            }

            // 1. Mutate tenant status
            const updated = await this.tenantRepo.updateStatus(tenantId, 'SUSPENDED', client);

            // 2. Option B: Pause PENDING scheduled moderation tasks
            let pausedTasksCount = 0;
            if (this.taskRepo) {
                pausedTasksCount = await this.taskRepo.pauseTasksForTenant(client, tenantId);
            }

            // 3. Platform audit log
            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'TENANT_SUSPENDED',
                targetType: 'TENANT',
                targetId: tenantId,
                targetTenantId: tenantId,
                reason,
                metadata: {
                    previousStatus: tenant.status,
                    newStatus: 'SUSPENDED',
                    pausedTasksCount,
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');

            // 4. Publish platform event
            await this.eventPublisher.publish({
                tenantId,
                eventType: 'platform.tenant.suspended',
                data: {
                    tenantId,
                    status: 'SUSPENDED',
                    reason,
                    pausedTasksCount,
                },
            }).catch(() => {});

            return updated;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Reactivates a suspended tenant using Option B (Resumes all PAUSED scheduled tasks).
     */
    async reactivateTenant(tenantId, { reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null, allowDeactivatedReactivation = false } = {}) {
        if (!tenantId) throw ApiError.badRequest('Tenant ID is required', 'VALIDATION_ERROR');

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const tenant = await this.tenantRepo.findById(tenantId, client);
            if (!tenant) throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
            if (tenant.status === 'ACTIVE') {
                await client.query('ROLLBACK');
                return tenant;
            }
            if (tenant.status === 'DEACTIVATED' && !allowDeactivatedReactivation) {
                throw ApiError.badRequest('Cannot reactivate a deactivated tenant', 'TENANT_DEACTIVATED');
            }

            // 1. Mutate tenant status
            const updated = await this.tenantRepo.updateStatus(tenantId, 'ACTIVE', client);

            // 2. Option B: Resume PAUSED scheduled moderation tasks
            let resumedTasksCount = 0;
            if (this.taskRepo) {
                resumedTasksCount = await this.taskRepo.resumeTasksForTenant(client, tenantId);
            }

            // 3. Platform audit log
            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'TENANT_REACTIVATED',
                targetType: 'TENANT',
                targetId: tenantId,
                targetTenantId: tenantId,
                reason,
                metadata: {
                    previousStatus: tenant.status,
                    newStatus: 'ACTIVE',
                    resumedTasksCount,
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');

            // 4. Publish platform event
            await this.eventPublisher.publish({
                tenantId,
                eventType: 'platform.tenant.reactivated',
                data: {
                    tenantId,
                    status: 'ACTIVE',
                    reason,
                    resumedTasksCount,
                },
            }).catch(() => {});

            return updated;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Deactivates a tenant (terminal state). Stops connections and cancels pending tasks.
     */
    async deactivateTenant(tenantId, { reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!tenantId) throw ApiError.badRequest('Tenant ID is required', 'VALIDATION_ERROR');

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const tenant = await this.tenantRepo.findById(tenantId, client);
            if (!tenant) throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
            if (tenant.status === 'DEACTIVATED') {
                await client.query('ROLLBACK');
                return tenant;
            }

            // 1. Set status to DEACTIVATED
            const updated = await this.tenantRepo.updateStatus(tenantId, 'DEACTIVATED', client);

            // 2. Cancel scheduled moderation tasks
            await client.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'CANCELLED', updated_at = NOW()
                WHERE tenant_id = $1 AND status IN ('PENDING', 'PAUSED');
            `, [tenantId]);

            // 3. Stop all connections for tenant
            await client.query(`
                UPDATE whatsapp_connections
                SET desired_state = 'STOPPED', updated_at = NOW()
                WHERE tenant_id = $1;
            `, [tenantId]);

            // 4. Record audit log
            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'TENANT_DEACTIVATED',
                targetType: 'TENANT',
                targetId: tenantId,
                targetTenantId: tenantId,
                reason,
                metadata: {
                    previousStatus: tenant.status,
                    newStatus: 'DEACTIVATED',
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');

            // 5. Signal workers to stop connections
            const connections = await this.connRepo.listForTenant(tenantId);
            for (const conn of connections) {
                await this.commandGateway.sendCommand({
                    command: 'STOP_CONNECTION',
                    tenantId,
                    connectionId: conn.id,
                }).catch(() => {});
            }

            // 6. Publish platform event
            await this.eventPublisher.publish({
                tenantId,
                eventType: 'platform.tenant.deactivated',
                data: { tenantId, status: 'DEACTIVATED', reason },
            }).catch(() => {});

            return updated;
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 2. CONNECTION GOVERNANCE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Lists connections across all tenants in the cluster.
     */
    async listConnections({ limit = 50, offset = 0, status = null, tenantId = null } = {}) {
        return this.connRepo.listAll({ limit, offset, status, tenantId });
    }

    /**
     * Retrieves connection diagnostic details by ID.
     */
    async getConnectionDetail(connectionId) {
        if (!connectionId) throw ApiError.badRequest('connectionId is required', 'VALIDATION_ERROR');

        const connection = await this.connRepo.findById(connectionId);
        if (!connection) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');

        return connection;
    }

    /**
     * Force-disconnects a connection using the SOCKET_STOPPING barrier protocol.
     */
    async forceDisconnectConnection(connectionId, { reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!connectionId) throw ApiError.badRequest('connectionId is required', 'VALIDATION_ERROR');

        const conn = await this.connRepo.findById(connectionId);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');

        // Optimistic concurrency: transition actual_state -> SOCKET_STOPPING atomically
        const updated = await this.connRepo.setSocketStopping(connectionId);
        if (!updated) {
            throw ApiError.conflict(
                'Operation already in progress: connection is already in SOCKET_STOPPING state.',
                'OPERATION_ALREADY_IN_PROGRESS'
            );
        }

        // Record platform audit log
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'CONNECTION_FORCE_DISCONNECT_REQUESTED',
            targetType: 'WhatsAppConnection',
            targetId: connectionId,
            targetTenantId: conn.tenantId,
            reason,
            metadata: {
                previousActualState: conn.actualState,
                previousDesiredState: conn.desiredState,
                assignedWorkerId: conn.assignedWorkerId,
                leaseEpoch: conn.leaseEpoch,
            },
            ipAddress,
            userAgent,
        });

        // Send control-plane command to owning worker
        await this.commandGateway.sendCommand({
            command: 'STOP_CONNECTION',
            tenantId: conn.tenantId,
            connectionId,
        });

        // Publish platform event
        await this.eventPublisher.publish({
            tenantId: conn.tenantId,
            eventType: 'platform.connection.stopping',
            data: {
                connectionId,
                actualState: 'SOCKET_STOPPING',
                desiredState: 'STOPPED',
                assignedWorkerId: conn.assignedWorkerId,
            },
        }).catch(() => {});

        return {
            accepted: true,
            connectionId,
            actualState: 'SOCKET_STOPPING',
            desiredState: 'STOPPED',
            assignedWorkerId: conn.assignedWorkerId,
            leaseEpoch: conn.leaseEpoch,
        };
    }

    /**
     * Requests connection reconnection while strictly respecting the SOCKET_STOPPING barrier.
     */
    async reconnectConnection(connectionId, { reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!connectionId) throw ApiError.badRequest('connectionId is required', 'VALIDATION_ERROR');

        const conn = await this.connRepo.findById(connectionId);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');

        // Set desired_state = 'RUNNING' in PostgreSQL
        await this.connRepo.updateDesiredStateForTenant(connectionId, conn.tenantId, 'RUNNING');

        // Record platform audit log
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'CONNECTION_RECONNECT_REQUESTED',
            targetType: 'WhatsAppConnection',
            targetId: connectionId,
            targetTenantId: conn.tenantId,
            reason,
            metadata: {
                actualState: conn.actualState,
                desiredState: 'RUNNING',
                assignedWorkerId: conn.assignedWorkerId,
            },
            ipAddress,
            userAgent,
        });

        // Send wake-up signal to control plane
        await this.commandGateway.sendCommand({
            command: 'RECONNECT_CONNECTION',
            tenantId: conn.tenantId,
            connectionId,
        });

        return {
            accepted: true,
            connectionId,
            desiredState: 'RUNNING',
            actualState: conn.actualState,
            message: conn.actualState === 'SOCKET_STOPPING'
                ? 'Reconnection requested; awaiting socket teardown barrier before reacquisition.'
                : 'Reconnection requested.',
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3. WORKER CLUSTER MANAGEMENT
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Lists all workers in the cluster registry.
     */
    async listWorkers({ limit = 50, offset = 0 } = {}) {
        return this.workerRepo.listAll({ limit, offset });
    }

    /**
     * Retrieves worker node details by ID.
     */
    async getWorkerDetail(workerId) {
        if (!workerId) throw ApiError.badRequest('workerId is required', 'VALIDATION_ERROR');

        const worker = await this.workerRepo.findById(workerId);
        if (!worker) throw ApiError.notFound('Worker not found', 'WORKER_NOT_FOUND');

        return worker;
    }

    /**
     * Initiates worker node drain protocol via the control gateway.
     */
    async drainWorker(workerId, { graceMs = 10000, reason = null, actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!workerId) throw ApiError.badRequest('workerId is required', 'VALIDATION_ERROR');

        const worker = await this.workerRepo.findById(workerId);
        if (!worker) throw ApiError.notFound('Worker not found', 'WORKER_NOT_FOUND');
        if (worker.status === 'OFFLINE') {
            throw ApiError.badRequest('Worker is already OFFLINE', 'WORKER_OFFLINE');
        }

        // Record platform audit log
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'WORKER_DRAIN_REQUESTED',
            targetType: 'Worker',
            targetId: workerId,
            targetTenantId: null,
            reason,
            metadata: {
                previousStatus: worker.status,
                graceMs,
            },
            ipAddress,
            userAgent,
        });

        // Dispatch DRAIN_WORKER command to cluster
        await this.commandGateway.sendCommand({
            command: 'DRAIN_WORKER',
            workerId,
            graceMs,
        });

        // Publish platform event
        await this.eventPublisher.publish({
            tenantId: 'platform',
            eventType: 'platform.worker.draining',
            data: { workerId, graceMs, reason },
        }).catch(() => {});

        return {
            accepted: true,
            workerId,
            status: 'DRAINING',
            graceMs,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 3B. RELIABILITY & RECOVERY OPERATIONS (Phase 5B)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Retrieves command detail for platform operators.
     */
    async getCommandDetail(commandId) {
        if (!commandId) throw ApiError.badRequest('Command ID is required', 'VALIDATION_ERROR');
        const command = await this.commandRepo.findById(commandId);
        if (!command) throw ApiError.notFound('Command not found', 'COMMAND_NOT_FOUND');
        return { command };
    }

    /**
     * Retrieves scheduled moderation task detail for platform operators.
     */
    async getTaskDetail(taskId) {
        if (!taskId) throw ApiError.badRequest('Task ID is required', 'VALIDATION_ERROR');
        const task = await this.taskRepo.findById(taskId);
        if (!task) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');
        return { task };
    }

    /**
     * Probes remote WhatsApp state for a command via the active leased worker node.
     * Purely read-only; never mutates database state.
     */
    async probeCommand(commandId, { actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!commandId) throw ApiError.badRequest('Command ID is required', 'VALIDATION_ERROR');
        const command = await this.commandRepo.findById(commandId);
        if (!command) throw ApiError.notFound('Command not found', 'COMMAND_NOT_FOUND');

        const conn = await this.connRepo.findById(command.connection_id);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');
        if (!conn.assigned_worker_id) {
            throw ApiError.badRequest('Connection has no assigned worker holding active lease', 'NO_ACTIVE_WORKER');
        }

        const workerNode = this.commandGateway.getWorkerNode ? this.commandGateway.getWorkerNode(conn.assigned_worker_id) : null;
        if (!workerNode) {
            throw ApiError.badRequest('Assigned worker node is not registered or unreachable', 'WORKER_UNAVAILABLE');
        }

        const probeResult = await workerNode.probeCommand(commandId);

        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'COMMAND_PROBED',
            targetType: 'COMMAND',
            targetId: commandId,
            targetTenantId: command.tenant_id,
            reason: null,
            metadata: {
                commandId,
                commandType: command.command_type,
                commandStatus: command.status,
                assignedWorkerId: conn.assigned_worker_id,
                probeResult,
            },
            ipAddress,
            userAgent,
        });

        return { command, probeResult };
    }

    /**
     * Probes remote WhatsApp state for a scheduled task via the active leased worker node.
     * Purely read-only; never mutates database state.
     */
    async probeTask(taskId, { actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!taskId) throw ApiError.badRequest('Task ID is required', 'VALIDATION_ERROR');
        const task = await this.taskRepo.findById(taskId);
        if (!task) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');

        const conn = await this.connRepo.findById(task.connection_id);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');
        if (!conn.assigned_worker_id) {
            throw ApiError.badRequest('Connection has no assigned worker holding active lease', 'NO_ACTIVE_WORKER');
        }

        const workerNode = this.commandGateway.getWorkerNode ? this.commandGateway.getWorkerNode(conn.assigned_worker_id) : null;
        if (!workerNode) {
            throw ApiError.badRequest('Assigned worker node is not registered or unreachable', 'WORKER_UNAVAILABLE');
        }

        const probeResult = await workerNode.probeTask(taskId);

        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'TASK_PROBED',
            targetType: 'TASK',
            targetId: taskId,
            targetTenantId: task.tenant_id,
            reason: null,
            metadata: {
                taskId,
                action: task.action,
                taskStatus: task.status,
                assignedWorkerId: conn.assigned_worker_id,
                probeResult,
            },
            ipAddress,
            userAgent,
        });

        return { task, probeResult };
    }

    /**
     * Fenced manual resolution for a command in REMOTE_OUTCOME_UNKNOWN via the leased worker.
     */
    async resolveCommand(commandId, { actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!commandId) throw ApiError.badRequest('Command ID is required', 'VALIDATION_ERROR');
        const command = await this.commandRepo.findById(commandId);
        if (!command) throw ApiError.notFound('Command not found', 'COMMAND_NOT_FOUND');

        const conn = await this.connRepo.findById(command.connection_id);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');
        if (!conn.assigned_worker_id) {
            throw ApiError.badRequest('Connection has no assigned worker holding active lease', 'NO_ACTIVE_WORKER');
        }

        const workerNode = this.commandGateway.getWorkerNode ? this.commandGateway.getWorkerNode(conn.assigned_worker_id) : null;
        if (!workerNode) {
            throw ApiError.badRequest('Assigned worker node is not registered or unreachable', 'WORKER_UNAVAILABLE');
        }

        const resolvedCommand = await workerNode.resolveCommand(commandId);

        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'COMMAND_RESOLVED',
            targetType: 'COMMAND',
            targetId: commandId,
            targetTenantId: command.tenant_id,
            reason: null,
            metadata: {
                commandId,
                commandType: command.command_type,
                previousStatus: command.status,
                newStatus: resolvedCommand?.status || command.status,
                assignedWorkerId: conn.assigned_worker_id,
            },
            ipAddress,
            userAgent,
        });

        return { command: resolvedCommand };
    }

    /**
     * Fenced manual resolution for a task in REMOTE_OUTCOME_UNKNOWN via the leased worker.
     */
    async resolveTask(taskId, { actorUserId = null, actorRole = 'PLATFORM_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!taskId) throw ApiError.badRequest('Task ID is required', 'VALIDATION_ERROR');
        const task = await this.taskRepo.findById(taskId);
        if (!task) throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');

        const conn = await this.connRepo.findById(task.connection_id);
        if (!conn) throw ApiError.notFound('Connection not found', 'CONNECTION_NOT_FOUND');
        if (!conn.assigned_worker_id) {
            throw ApiError.badRequest('Connection has no assigned worker holding active lease', 'NO_ACTIVE_WORKER');
        }

        const workerNode = this.commandGateway.getWorkerNode ? this.commandGateway.getWorkerNode(conn.assigned_worker_id) : null;
        if (!workerNode) {
            throw ApiError.badRequest('Assigned worker node is not registered or unreachable', 'WORKER_UNAVAILABLE');
        }

        const resolvedTask = await workerNode.resolveTask(taskId);

        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'TASK_RESOLVED',
            targetType: 'TASK',
            targetId: taskId,
            targetTenantId: task.tenant_id,
            reason: null,
            metadata: {
                taskId,
                action: task.action,
                previousStatus: task.status,
                newStatus: resolvedTask?.status || task.status,
                assignedWorkerId: conn.assigned_worker_id,
            },
            ipAddress,
            userAgent,
        });

        return { task: resolvedTask };
    }

    /**
     * Forces a stuck command to FAILED status (SUPER_ADMIN only).
     * Mandatory audit logging and reason requirement.
     */
    async forceFailCommand(commandId, { reason, actorUserId = null, actorRole = 'SUPER_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!commandId) throw ApiError.badRequest('Command ID is required', 'VALIDATION_ERROR');
        if (!reason || typeof reason !== 'string' || !reason.trim()) {
            throw ApiError.badRequest('Reason is required for force-fail', 'VALIDATION_ERROR');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`
                SELECT * FROM connection_commands WHERE id = $1 FOR UPDATE;
            `, [commandId]);
            if (rows.length === 0) {
                throw ApiError.notFound('Command not found', 'COMMAND_NOT_FOUND');
            }
            const command = rows[0];
            if (command.status === 'COMPLETED' || command.status === 'FAILED') {
                await client.query('ROLLBACK');
                return { command, alreadyTerminal: true };
            }
            if (command.status !== 'REMOTE_OUTCOME_UNKNOWN') {
                await client.query('ROLLBACK');
                throw ApiError.conflict(
                    `Only commands in REMOTE_OUTCOME_UNKNOWN status can be force-failed. Current status: ${command.status}`,
                    'INVALID_COMMAND_STATE'
                );
            }

            const formattedError = `[FORCE_FAIL by ${actorUserId || actorRole}]: ${reason.trim()}`;
            const { rows: updatedRows } = await client.query(`
                UPDATE connection_commands
                SET status = 'FAILED',
                    last_error = $1,
                    updated_at = NOW()
                WHERE id = $2
                  AND status = 'REMOTE_OUTCOME_UNKNOWN'
                RETURNING *;
            `, [formattedError, commandId]);
            if (updatedRows.length === 0) {
                await client.query('ROLLBACK');
                const latest = await this.commandRepo.findById(commandId);
                return { command: latest, alreadyTerminal: true };
            }
            const updatedCommand = updatedRows[0];

            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'COMMAND_FORCE_FAILED',
                targetType: 'COMMAND',
                targetId: commandId,
                targetTenantId: command.tenant_id,
                reason: reason.trim(),
                metadata: {
                    commandId,
                    commandType: command.command_type,
                    previousStatus: command.status,
                    newStatus: 'FAILED',
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');
            this.metricsRegistry?.durableCommandsTotal?.inc({ command: command.command_type, status: 'FAILED' });

            await this.eventPublisher.publish({
                tenantId: command.tenant_id,
                eventType: 'platform.command.force_failed',
                data: {
                    commandId,
                    reason: reason.trim(),
                },
            }).catch(() => {});

            return { command: updatedCommand };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Forces a stuck scheduled task to FAILED status (SUPER_ADMIN only).
     * Mandatory audit logging and reason requirement.
     */
    async forceFailTask(taskId, { reason, actorUserId = null, actorRole = 'SUPER_ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!taskId) throw ApiError.badRequest('Task ID is required', 'VALIDATION_ERROR');
        if (!reason || typeof reason !== 'string' || !reason.trim()) {
            throw ApiError.badRequest('Reason is required for force-fail', 'VALIDATION_ERROR');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');
            const { rows } = await client.query(`
                SELECT * FROM scheduled_moderation_tasks WHERE id = $1 FOR UPDATE;
            `, [taskId]);
            if (rows.length === 0) {
                throw ApiError.notFound('Task not found', 'TASK_NOT_FOUND');
            }
            const task = rows[0];
            if (task.status === 'COMPLETED' || task.status === 'FAILED' || task.status === 'CANCELLED') {
                await client.query('ROLLBACK');
                return { task, alreadyTerminal: true };
            }
            if (task.status !== 'REMOTE_OUTCOME_UNKNOWN') {
                await client.query('ROLLBACK');
                throw ApiError.conflict(
                    `Only tasks in REMOTE_OUTCOME_UNKNOWN status can be force-failed. Current status: ${task.status}`,
                    'INVALID_TASK_STATE'
                );
            }

            const formattedError = `[FORCE_FAIL by ${actorUserId || actorRole}]: ${reason.trim()}`;
            const { rows: updatedRows } = await client.query(`
                UPDATE scheduled_moderation_tasks
                SET status = 'FAILED',
                    last_error = $1,
                    updated_at = NOW()
                WHERE id = $2
                  AND status = 'REMOTE_OUTCOME_UNKNOWN'
                RETURNING *;
            `, [formattedError, taskId]);
            if (updatedRows.length === 0) {
                await client.query('ROLLBACK');
                const latest = await this.taskRepo.findById(taskId);
                return { task: latest, alreadyTerminal: true };
            }
            const updatedTask = updatedRows[0];

            await this.platformAuditRepo.record({
                actorUserId,
                actorRole,
                action: 'TASK_FORCE_FAILED',
                targetType: 'TASK',
                targetId: taskId,
                targetTenantId: task.tenant_id,
                reason: reason.trim(),
                metadata: {
                    taskId,
                    action: task.action,
                    previousStatus: task.status,
                    newStatus: 'FAILED',
                },
                ipAddress,
                userAgent,
            }, client);

            await client.query('COMMIT');
            this.metricsRegistry?.scheduledTasksTotal?.inc({ type: task.action, status: 'FAILED' });

            await this.eventPublisher.publish({
                tenantId: task.tenant_id,
                eventType: 'platform.task.force_failed',
                data: {
                    taskId,
                    reason: reason.trim(),
                },
            }).catch(() => {});

            return { task: updatedTask };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 4. PLATFORM AUDIT & OBSERVABILITY
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Queries immutable platform audit logs.
     */
    async queryAuditLogs(params = {}) {
        return this.platformAuditRepo.list(params);
    }

    /**
     * Summarizes cluster operational health.
     */
    async getClusterHealth() {
        // Query active workers
        const activeWorkers = await this.workerRepo.listActiveWorkers({ heartbeatTimeoutSeconds: 30 });

        // Query connection states summary
        const connStateSql = `
            SELECT actual_state, desired_state, COUNT(*)::int AS count
            FROM whatsapp_connections
            GROUP BY actual_state, desired_state;
        `;
        const { rows: connectionSummary } = await this.pool.query(connStateSql);

        // Query tenant statuses summary
        const tenantStateSql = `
            SELECT status, COUNT(*)::int AS count
            FROM tenants
            GROUP BY status;
        `;
        const { rows: tenantSummary } = await this.pool.query(tenantStateSql);

        return {
            status: 'OK',
            timestamp: new Date().toISOString(),
            workers: {
                activeCount: activeWorkers.length,
                nodes: activeWorkers.map((w) => ({
                    id: w.id,
                    hostname: w.hostname,
                    status: w.status,
                    activeConnections: w.activeConnections,
                    lastHeartbeatAt: w.lastHeartbeatAt,
                })),
            },
            connections: connectionSummary,
            tenants: tenantSummary,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 5. WINDOWSEVEN ADMIN BUSINESS OPERATIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Lists customers with search, status filtering, and aggregate counts.
     */
    async listCustomers({ search = null, status = null, limit = 50, offset = 0 } = {}) {
        return this.tenantRepo.listCustomers({ search, status, limit, offset });
    }

    /**
     * Retrieves unified customer operational detail.
     */
    async getCustomerOverview(customerId) {
        if (!customerId) throw ApiError.badRequest('Customer ID is required', 'VALIDATION_ERROR');

        // CustomerId can be tenantId or user.id
        let tenant = await this.tenantRepo.findById(customerId);
        if (!tenant && this.userRepo) {
            const user = await this.userRepo.findById(customerId);
            if (user) {
                const { rows } = await this.pool.query(
                    `SELECT tenant_id FROM tenant_memberships WHERE user_id = $1 AND role = 'OWNER' LIMIT 1;`,
                    [user.id]
                );
                if (rows.length > 0) {
                    tenant = await this.tenantRepo.findById(rows[0].tenant_id);
                }
            }
        }

        if (!tenant) {
            throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');
        }

        // Fetch owner user details
        const { rows: ownerRows } = await this.pool.query(
            `SELECT u.id, u.email, u.phone_number, u.created_at
             FROM users u
             JOIN tenant_memberships tm ON tm.user_id = u.id AND tm.role = 'OWNER'
             WHERE tm.tenant_id = $1
             LIMIT 1;`,
            [tenant.id]
        );
        const owner = ownerRows[0] || null;

        // Fetch active/latest subscription
        const activeSubscription = await this.subscriptionRepo.findActiveByTenantId(tenant.id);
        const latestSubscription = activeSubscription || await this.subscriptionRepo.findLatestByTenantId(tenant.id);

        // Fetch WhatsApp connection (0 or 1 connection per customer)
        const connections = await this.connRepo.listForTenant(tenant.id);
        const connection = connections[0] || null;

        // Fetch groups
        let groups = [];
        if (this.groupRepo) {
            groups = await this.groupRepo.listForTenant(tenant.id).catch(() => []);
        }

        // Fetch recent payments
        const recentPayments = await this.paymentRepo.findAll({ tenantId: tenant.id, limit: 10 });

        return {
            customer: {
                id: tenant.id,
                name: tenant.name,
                status: tenant.status,
                createdAt: tenant.created_at,
                owner,
            },
            subscription: {
                active: Boolean(activeSubscription),
                current: latestSubscription,
            },
            connection,
            groups: {
                totalCount: groups.length,
                items: groups.map((g) => ({
                    id: g.id,
                    jid: g.whatsapp_jid || g.jid,
                    name: g.name,
                    status: g.status,
                    joinedAt: g.created_at,
                })),
            },
            recentPayments,
        };
    }

    /**
     * Suspends a customer account with mandatory reason and audit trail.
     */
    async suspendCustomer(customerId, { reason, actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required for suspension', 'VALIDATION_ERROR');
        }
        return this.suspendTenant(customerId, { reason, actorUserId, actorRole, ipAddress, userAgent });
    }

    /**
     * Reactivates a customer account with mandatory reason and audit trail.
     */
    async reactivateCustomer(customerId, { reason, actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required for reactivation', 'VALIDATION_ERROR');
        }
        return this.reactivateTenant(customerId, { reason, actorUserId, actorRole, ipAddress, userAgent, allowDeactivatedReactivation: false });
    }

    /**
     * Deactivates a customer account with mandatory reason and audit trail.
     */
    async deactivateCustomer(customerId, { reason, actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required for deactivation', 'VALIDATION_ERROR');
        }
        return this.deactivateTenant(customerId, { reason, actorUserId, actorRole, ipAddress, userAgent });
    }

    /**
     * Disconnects a customer WhatsApp connection without cancelling subscription or deleting account.
     */
    async disconnectCustomerConnection(connectionId, { reason, actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        return this.forceDisconnectConnection(connectionId, { reason, actorUserId, actorRole, ipAddress, userAgent });
    }

    /**
     * Plans operations
     */
    async listPlans({ status = null } = {}) {
        return this.planRepo.findAll({ status });
    }

    async createPlan({ name, price, currency = 'TZS', durationDays, description = null, status = 'ACTIVE' }, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw ApiError.badRequest('Plan name is required', 'VALIDATION_ERROR');
        }
        if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0) {
            throw ApiError.badRequest('Valid non-negative price is required', 'VALIDATION_ERROR');
        }
        if (!durationDays || isNaN(Number(durationDays)) || Number(durationDays) <= 0) {
            throw ApiError.badRequest('Valid durationDays greater than 0 is required', 'VALIDATION_ERROR');
        }
        const plan = await this.planRepo.create({ name, price, currency, durationDays, description, status });
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'PLAN_CREATED',
            targetType: 'PLAN',
            targetId: plan.id,
            reason: null,
            metadata: { name: plan.name, price: plan.price, durationDays: plan.duration_days },
            ipAddress,
            userAgent,
        });
        return plan;
    }

    async updatePlan(planId, updates, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (updates.price !== undefined && (isNaN(Number(updates.price)) || Number(updates.price) < 0)) {
            throw ApiError.badRequest('Valid non-negative price is required', 'VALIDATION_ERROR');
        }
        if (updates.durationDays !== undefined && (isNaN(Number(updates.durationDays)) || Number(updates.durationDays) <= 0)) {
            throw ApiError.badRequest('Valid durationDays greater than 0 is required', 'VALIDATION_ERROR');
        }
        if (updates.status !== undefined && !['ACTIVE', 'INACTIVE'].includes(String(updates.status).toUpperCase())) {
            throw ApiError.badRequest('Invalid plan status (must be ACTIVE or INACTIVE)', 'VALIDATION_ERROR');
        }

        const plan = await this.planRepo.update(planId, updates);
        if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'PLAN_UPDATED',
            targetType: 'PLAN',
            targetId: plan.id,
            reason: null,
            metadata: { updates },
            ipAddress,
            userAgent,
        });
        return plan;
    }

    async setPlanStatus(planId, status, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        const normalized = String(status || '').toUpperCase();
        if (!['ACTIVE', 'INACTIVE'].includes(normalized)) {
            throw ApiError.badRequest('Invalid plan status (must be ACTIVE or INACTIVE)', 'VALIDATION_ERROR');
        }
        const plan = await this.planRepo.update(planId, { status: normalized });
        if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'PLAN_STATUS_CHANGED',
            targetType: 'PLAN',
            targetId: plan.id,
            reason: null,
            metadata: { newStatus: normalized },
            ipAddress,
            userAgent,
        });
        return plan;
    }

    async deletePlan(planId, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        const deleted = await this.planRepo.delete(planId);
        if (!deleted) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'PLAN_DELETED',
            targetType: 'PLAN',
            targetId: planId,
            reason: null,
            metadata: {},
            ipAddress,
            userAgent,
        });
        return deleted;
    }

    /**
     * Subscriptions operations
     */
    async listSubscriptions({ tenantId = null, customerUserId = null, status = null, limit = 50, offset = 0 } = {}) {
        return this.subscriptionRepo.findAll({ tenantId, customerUserId, status, limit, offset });
    }

    async extendSubscription(subscriptionId, { additionalDays, reason }, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required for manual extension', 'VALIDATION_ERROR');
        }
        const days = parseInt(additionalDays, 10);
        if (isNaN(days) || days <= 0) {
            throw ApiError.badRequest('additionalDays must be a positive integer', 'VALIDATION_ERROR');
        }

        const sub = await this.subscriptionRepo.findById(subscriptionId);
        if (!sub) throw ApiError.notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');

        const updated = await this.subscriptionRepo.extendSubscription(subscriptionId, days);
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'SUBSCRIPTION_EXTENDED',
            targetType: 'SUBSCRIPTION',
            targetId: subscriptionId,
            targetTenantId: sub.tenant_id,
            reason,
            metadata: {
                additionalDays: days,
                previousExpiresAt: sub.expires_at,
                newExpiresAt: updated.expires_at,
            },
            ipAddress,
            userAgent,
        });

        return updated;
    }

    async cancelSubscription(subscriptionId, { reason }, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required to cancel a subscription', 'VALIDATION_ERROR');
        }
        const sub = await this.subscriptionRepo.findById(subscriptionId);
        if (!sub) throw ApiError.notFound('Subscription not found', 'SUBSCRIPTION_NOT_FOUND');
        if (sub.status === 'CANCELLED') {
            return sub;
        }

        const updated = await this.subscriptionRepo.cancelSubscription(subscriptionId);
        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'SUBSCRIPTION_CANCELLED',
            targetType: 'SUBSCRIPTION',
            targetId: subscriptionId,
            targetTenantId: sub.tenant_id,
            reason,
            metadata: {
                previousStatus: sub.status,
                newStatus: 'CANCELLED',
                expiresAt: sub.expires_at,
            },
            ipAddress,
            userAgent,
        });

        // If the tenant has no other active subscription, stop active WhatsApp connections
        const remainingActive = await this.subscriptionRepo.findActiveByTenantId(sub.tenant_id);
        if (!remainingActive && this.commandGateway && this.connRepo) {
            const connections = await this.connRepo.listForTenant(sub.tenant_id).catch(() => []);
            for (const conn of connections) {
                await this.commandGateway.sendCommand({
                    command: 'STOP_CONNECTION',
                    tenantId: sub.tenant_id,
                    connectionId: conn.id,
                }).catch(() => {});
            }
        }

        return updated;
    }

    async grantSubscription({ customerId, planId, reason }, { actorUserId = null, actorRole = 'ADMIN', ipAddress = null, userAgent = null } = {}) {
        if (!planId) {
            throw ApiError.badRequest('planId is required for manual grant', 'VALIDATION_ERROR');
        }
        if (!reason || !reason.trim()) {
            throw ApiError.badRequest('A mandatory reason is required for manual grant', 'VALIDATION_ERROR');
        }
        const tenant = await this.tenantRepo.findById(customerId);
        if (!tenant) throw ApiError.notFound('Customer not found', 'CUSTOMER_NOT_FOUND');

        // Resolve customer owner user ID
        const { rows: ownerRows } = await this.pool.query(
            `SELECT user_id FROM tenant_memberships WHERE tenant_id = $1 AND role = 'OWNER' LIMIT 1;`,
            [tenant.id]
        );
        if (ownerRows.length === 0) {
            throw ApiError.badRequest('Customer does not have an owner user', 'CUSTOMER_OWNER_NOT_FOUND');
        }
        const customerUserId = ownerRows[0].user_id;

        const plan = await this.planRepo.findById(planId);
        if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');

        // Server-authoritative: duration_days and currency strictly come from plan
        const days = plan.duration_days;
        const currency = plan.currency;
        const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

        const sub = await this.subscriptionRepo.create({
            tenantId: tenant.id,
            customerUserId,
            planId: plan.id,
            pricePaid: 0.00,
            currency,
            durationDays: days,
            status: 'MANUALLY_GRANTED',
            expiresAt,
            metadata: {
                reason,
                grantedBy: actorUserId,
                planName: plan.name,
                authoritativePrice: plan.price,
                authoritativeDurationDays: plan.duration_days,
            },
        });

        await this.platformAuditRepo.record({
            actorUserId,
            actorRole,
            action: 'SUBSCRIPTION_GRANTED',
            targetType: 'SUBSCRIPTION',
            targetId: sub.id,
            targetTenantId: tenant.id,
            reason,
            metadata: {
                planId: plan.id,
                planName: plan.name,
                durationDays: days,
                expiresAt,
            },
            ipAddress,
            userAgent,
        });

        return sub;
    }

    /**
     * Payments operations
     */
    async listPayments({ tenantId = null, customerUserId = null, status = null, limit = 50, offset = 0 } = {}) {
        return this.paymentRepo.findAll({ tenantId, customerUserId, status, limit, offset });
    }

    /**
     * Groups operations across tenants (operational view, strictly no message data).
     */
    async listAdminGroups({ search = null, limit = 50, offset = 0 } = {}) {
        let sql = `
            SELECT g.id, g.whatsapp_jid AS jid, g.name, g.status, g.created_at, g.updated_at,
                   t.id AS tenant_id, t.name AS tenant_name, t.status AS tenant_status,
                   c.actual_state AS connection_state
            FROM groups g
            JOIN tenants t ON g.tenant_id = t.id
            LEFT JOIN whatsapp_connections c ON c.tenant_id = t.id
            WHERE 1=1
        `;
        const params = [];
        if (search) {
            params.push(search.trim());
            sql += ` AND (g.name ILIKE '%' || $1 || '%' OR g.whatsapp_jid ILIKE '%' || $1 || '%' OR t.name ILIKE '%' || $1 || '%')`;
        }
        sql += ` ORDER BY g.created_at DESC`;
        params.push(parseInt(limit, 10) || 50);
        sql += ` LIMIT $${params.length}`;
        params.push(parseInt(offset, 10) || 0);
        sql += ` OFFSET $${params.length};`;

        const { rows } = await this.pool.query(sql, params);
        return rows;
    }

    /**
     * Overview metrics for Admin Dashboard
     */
    async getAdminOverview() {
        const [
            { rows: customerStats },
            { rows: subStats },
            { rows: connStats },
            { rows: payStats },
        ] = await Promise.all([
            this.pool.query(`
                SELECT 
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status = 'ACTIVE')::int AS active,
                    COUNT(*) FILTER (WHERE status = 'SUSPENDED')::int AS suspended,
                    COUNT(*) FILTER (WHERE status = 'DEACTIVATED')::int AS deactivated
                FROM tenants;
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'MANUALLY_GRANTED') AND expires_at > NOW())::int AS active,
                    COUNT(*) FILTER (WHERE status IN ('ACTIVE', 'MANUALLY_GRANTED') AND expires_at > NOW() AND expires_at <= NOW() + INTERVAL '3 days')::int AS expiring_soon,
                    COUNT(*) FILTER (WHERE status = 'EXPIRED' OR expires_at <= NOW())::int AS expired
                FROM customer_subscriptions;
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*)::int AS total,
                    COUNT(*) FILTER (WHERE actual_state = 'CONNECTED')::int AS connected,
                    COUNT(*) FILTER (WHERE actual_state = 'CONNECTING')::int AS connecting,
                    COUNT(*) FILTER (WHERE actual_state = 'DISCONNECTED')::int AS disconnected
                FROM whatsapp_connections;
            `),
            this.pool.query(`
                SELECT 
                    COUNT(*)::int AS total_count,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS' AND created_at >= NOW() - INTERVAL '30 days'), 0)::numeric AS revenue_30d,
                    COALESCE(SUM(amount) FILTER (WHERE status = 'SUCCESS'), 0)::numeric AS total_revenue,
                    COUNT(*) FILTER (WHERE status = 'SUCCESS')::int AS success_count
                FROM payments;
            `),
        ]);

        return {
            customers: customerStats[0] || { total: 0, active: 0, suspended: 0, deactivated: 0 },
            subscriptions: subStats[0] || { total: 0, active: 0, expiring_soon: 0, expired: 0 },
            connections: connStats[0] || { total: 0, connected: 0, connecting: 0, disconnected: 0 },
            payments: {
                totalCount: payStats[0]?.total_count || 0,
                revenue30d: Number(payStats[0]?.revenue_30d || 0),
                totalRevenue: Number(payStats[0]?.total_revenue || 0),
                successCount: payStats[0]?.success_count || 0,
            },
            timestamp: new Date().toISOString(),
        };
    }

    /**
     * Creates a customer purchase intent / pending payment outside the admin scope.
     * Enforces server-authoritative plan configuration; client amounts are strictly ignored.
     */
    async createCustomerPurchase({ tenantId, customerUserId, planId, provider = 'M-PESA' }) {
        if (!tenantId) throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');
        if (!customerUserId) throw ApiError.badRequest('customerUserId is required', 'VALIDATION_ERROR');
        if (!planId) throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');

        const plan = await this.planRepo.findById(planId);
        if (!plan) throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        if (plan.status !== 'ACTIVE') throw ApiError.badRequest('Plan is not currently active', 'PLAN_NOT_ACTIVE');

        const transactionReference = `TX_${Date.now()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        const payment = await this.paymentRepo.create({
            tenantId,
            customerUserId,
            planId: plan.id,
            amount: plan.price,
            currency: plan.currency,
            provider,
            transactionReference,
            status: 'PENDING',
            metadata: {
                planName: plan.name,
                durationDays: plan.duration_days,
            },
        });

        return {
            payment,
            plan: {
                id: plan.id,
                name: plan.name,
                price: Number(plan.price),
                currency: plan.currency,
                durationDays: plan.duration_days,
            },
        };
    }

    /**
     * Activates a customer subscription upon successful payment completion.
     * Enforces database transaction boundaries, row-level locking (FOR UPDATE),
     * locked renewal rules (active vs expired), idempotency, and audit logging.
     */
    async activateSubscriptionFromPayment({ paymentId = null, transactionReference = null, status = 'SUCCESS', failureReason = null }) {
        if (!paymentId && !transactionReference) {
            throw ApiError.badRequest('paymentId or transactionReference is required', 'VALIDATION_ERROR');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Fetch payment with row-level lock (FOR UPDATE)
            let payment = null;
            if (paymentId) {
                const { rows } = await client.query('SELECT * FROM payments WHERE id = $1 FOR UPDATE;', [paymentId]);
                payment = rows[0] || null;
            } else if (transactionReference) {
                const { rows } = await client.query('SELECT * FROM payments WHERE transaction_reference = $1 FOR UPDATE;', [transactionReference]);
                payment = rows[0] || null;
            }

            if (!payment) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Payment not found', 'PAYMENT_NOT_FOUND');
            }

            // 2. Idempotency Check: if payment is already SUCCESS and has a subscriptionId, return existing activation
            if (payment.status === 'SUCCESS' && payment.subscription_id) {
                const existingSub = await this.subscriptionRepo.findById(payment.subscription_id, client);
                await client.query('COMMIT');
                return {
                    success: true,
                    payment,
                    subscription: existingSub,
                    alreadyActivated: true,
                };
            }

            // 3. Handle Failed Payment Confirmation
            if (status.toUpperCase() !== 'SUCCESS') {
                const updated = await this.paymentRepo.updateStatus(payment.id, {
                    status: 'FAILED',
                    failureReason: failureReason || 'Payment rejected by provider',
                }, client);
                await client.query('COMMIT');
                return { success: false, payment: updated, subscription: null };
            }

            // 4. Lock tenant record to strictly serialize multiple concurrent payments for the same tenant
            await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE;', [payment.tenant_id]);

            // 5. Authoritative Plan Verification
            const plan = await this.planRepo.findById(payment.plan_id, client);
            if (!plan) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Plan associated with payment not found', 'PLAN_NOT_FOUND');
            }

            // 6. Locked Renewal Rules:
            // Check if customer currently has an active entitlement (expires_at > NOW())
            const { rows: activeRows } = await client.query(`
                SELECT s.*
                FROM customer_subscriptions s
                WHERE s.tenant_id = $1
                  AND s.status IN ('ACTIVE', 'MANUALLY_GRANTED')
                  AND s.expires_at > NOW()
                ORDER BY s.expires_at DESC
                LIMIT 1
                FOR UPDATE;
            `, [payment.tenant_id]);
            const activeSub = activeRows[0] || null;

            const days = plan.duration_days;
            let baseTime;
            if (activeSub && new Date(activeSub.expires_at) > new Date()) {
                // Active entitlement: preserve remaining subscription time!
                baseTime = new Date(activeSub.expires_at);
            } else {
                // Expired or no prior subscription: begins from NOW()
                baseTime = new Date();
            }
            const expiresAt = new Date(baseTime.getTime() + days * 24 * 60 * 60 * 1000);

            // 7. Create Subscription with Historical Pricing Snapshot
            const subscription = await this.subscriptionRepo.create({
                tenantId: payment.tenant_id,
                customerUserId: payment.customer_user_id,
                planId: plan.id,
                pricePaid: payment.amount,
                currency: payment.currency,
                durationDays: days,
                status: 'ACTIVE',
                startedAt: new Date(),
                expiresAt,
                metadata: {
                    paymentId: payment.id,
                    transactionReference: payment.transaction_reference,
                    planName: plan.name,
                    previousExpiresAt: activeSub ? activeSub.expires_at : null,
                },
            }, client);

            // 8. Update Payment to SUCCESS linking subscriptionId
            const updatedPayment = await this.paymentRepo.updateStatus(payment.id, {
                status: 'SUCCESS',
                subscriptionId: subscription.id,
            }, client);

            // 9. Record Platform Audit Event
            if (this.platformAuditRepo) {
                await this.platformAuditRepo.record({
                    actorUserId: payment.customer_user_id,
                    actorRole: 'CUSTOMER',
                    action: 'SUBSCRIPTION_ACTIVATED',
                    targetType: 'SUBSCRIPTION',
                    targetId: subscription.id,
                    targetTenantId: payment.tenant_id,
                    reason: null,
                    metadata: {
                        paymentId: payment.id,
                        planId: plan.id,
                        planName: plan.name,
                        durationDays: days,
                        pricePaid: payment.amount,
                        currency: payment.currency,
                        previousExpiresAt: activeSub ? activeSub.expires_at : null,
                        expiresAt: expiresAt.toISOString(),
                    },
                }, client);
            }

            await client.query('COMMIT');

            return {
                success: true,
                payment: updatedPayment,
                subscription,
            };
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = PlatformService;
