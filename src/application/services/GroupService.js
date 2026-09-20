const ApiError = require('../errors/ApiError');

class GroupService {
    constructor({
        pool,
        groupRepo,
        policyRepo,
        connRepo,
        commandRepo = null,
        taskRepo = null,
        auditLogRepo = null,
        commandGateway = null,
        eventPublisher = null,
    }) {
        if (!pool || !groupRepo || !connRepo) {
            throw new Error('[GroupService] pool, groupRepo, and connRepo are required');
        }
        this.pool = pool;
        this.groupRepo = groupRepo;
        this.policyRepo = policyRepo;
        this.connRepo = connRepo;
        this.commandRepo = commandRepo;
        this.taskRepo = taskRepo;
        this.auditLogRepo = auditLogRepo;
        this.commandGateway = commandGateway;
        this.eventPublisher = eventPublisher;
    }

    /**
     * Lists groups for a specific connection belonging to the tenant.
     */
    async listGroupsForConnection(tenantId, connectionId, filter = {}) {
        const conn = await this.connRepo.findByIdForTenant(connectionId, tenantId);
        if (!conn) {
            throw ApiError.notFound('WhatsApp connection not found', 'RESOURCE_NOT_FOUND');
        }

        const groups = await this.groupRepo.listByConnectionForTenant(connectionId, tenantId);
        let filtered = groups;

        if (filter.status) {
            filtered = filtered.filter((g) => g.status === filter.status);
        }

        const offset = Math.max(0, parseInt(filter.offset, 10) || 0);
        const limit = Math.min(100, Math.max(1, parseInt(filter.limit, 10) || 50));
        const paginated = filtered.slice(offset, offset + limit);

        return {
            items: paginated,
            total: filtered.length,
            limit,
            offset,
        };
    }

    /**
     * Retrieves a single group by ID with policy summary.
     */
    async getGroup(tenantId, groupId) {
        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group) {
            throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
        }

        let policy = null;
        if (this.policyRepo) {
            policy = await this.policyRepo.findByGroupIdForTenant(groupId, tenantId);
        }

        return {
            ...group,
            policy: policy || null,
        };
    }

    /**
     * Updates group status (e.g. DISCOVERED -> MANAGED, or MANAGED -> UNMANAGED).
     */
    async updateGroupStatus(tenantId, groupId, status, actorContext = {}) {
        const validStatuses = ['MANAGED', 'UNMANAGED'];
        if (!validStatuses.includes(status)) {
            throw ApiError.badRequest(`Invalid status: ${status}. Allowed: ${validStatuses.join(', ')}`, 'VALIDATION_ERROR');
        }

        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group) {
            throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
        }

        const updated = await this.groupRepo.updateStatusForTenant(groupId, tenantId, status);

        // If unmanaged, cancel any pending or processing scheduled unmutes for this group
        if (status === 'UNMANAGED' && this.taskRepo) {
            await this.taskRepo.cancelTasksForGroup(null, {
                tenantId,
                groupId,
                action: 'UNMUTE_GROUP',
                includeProcessing: true,
            });
        }

        // Audit log
        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId: actorContext.actorUserId || null,
                action: 'GROUP_STATUS_UPDATED',
                resourceType: 'group',
                resourceId: groupId,
                metadata: {
                    oldStatus: group.status,
                    newStatus: status,
                    whatsappJid: group.whatsapp_jid,
                    connectionId: group.connection_id,
                },
                ipAddress: actorContext.ipAddress || null,
                userAgent: actorContext.userAgent || null,
            }).catch(() => {});
        }

        // Realtime SSE broadcast
        if (this.eventPublisher) {
            this.eventPublisher.publish(tenantId, 'group.status_changed', {
                groupId,
                status,
                connectionId: group.connection_id,
                whatsappJid: group.whatsapp_jid,
            });
        }

        return updated;
    }

    /**
     * Requests on-demand group synchronization from WhatsApp.
     */
    async requestGroupSync(tenantId, connectionId, actorContext = {}) {
        const conn = await this.connRepo.findByIdForTenant(connectionId, tenantId);
        if (!conn) {
            throw ApiError.notFound('WhatsApp connection not found', 'RESOURCE_NOT_FOUND');
        }

        if (conn.actual_state !== 'ACTIVE') {
            throw ApiError.conflict(
                `Cannot synchronize groups: connection is in state "${conn.actual_state}". Connection must be ACTIVE.`,
                'CONNECTION_NOT_ACTIVE'
            );
        }

        if (!this.commandRepo) {
            throw ApiError.internal('Command repository not configured');
        }

        // Create durable command in PostgreSQL
        const command = await this.commandRepo.createCommand(null, {
            tenantId,
            connectionId,
            groupId: null,
            commandType: 'SYNC_GROUPS',
            payload: {},
            requestedByUserId: actorContext.actorUserId || null,
        });

        // Audit log
        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId: actorContext.actorUserId || null,
                action: 'GROUPS_SYNC_REQUESTED',
                resourceType: 'whatsapp_connection',
                resourceId: connectionId,
                metadata: { commandId: command.id },
                ipAddress: actorContext.ipAddress || null,
                userAgent: actorContext.userAgent || null,
            }).catch(() => {});
        }

        // Wake up worker plane
        if (this.commandGateway) {
            this.commandGateway.sendCommand({
                command: 'SYNC_GROUPS',
                tenantId,
                connectionId,
                payload: { commandId: command.id },
            }).catch(() => {});
        }

        return {
            commandId: command.id,
            status: command.status,
            action: 'SYNC_GROUPS',
            createdAt: command.created_at,
        };
    }
}

module.exports = GroupService;
