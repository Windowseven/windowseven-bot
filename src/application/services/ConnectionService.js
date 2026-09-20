const ApiError = require('../errors/ApiError');
const { defaultQrStore } = require('../../whatsapp/control/EphemeralQrStore');
const { defaultCommandGateway } = require('../../whatsapp/control/ConnectionCommandGateway');

/**
 * Windowseven MD Connection Application Service
 * Orchestrates tenant-scoped WhatsApp connection lifecycle, state mutations, and worker commands.
 */
class ConnectionService {
    /**
     * @param {object} params
     * @param {import('pg').Pool} params.pool
     * @param {import('../../repositories/WhatsAppConnectionRepository')} params.connRepo
     * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
     * @param {import('../../whatsapp/control/ConnectionCommandGateway').ConnectionCommandGateway} [params.commandGateway]
     * @param {import('../../whatsapp/control/EphemeralQrStore').EphemeralQrStore} [params.qrStore]
     */
    constructor({
        pool,
        connRepo,
        auditLogRepo = null,
        commandGateway = defaultCommandGateway,
        qrStore = defaultQrStore,
    }) {
        if (!pool || !connRepo) {
            throw new Error('pool and connRepo are required for ConnectionService');
        }
        this.pool = pool;
        this.connRepo = connRepo;
        this.auditLogRepo = auditLogRepo;
        this.commandGateway = commandGateway;
        this.qrStore = qrStore;
    }

    /**
     * Creates a new connection for a tenant in STOPPED / UNASSIGNED state.
     */
    async createConnection({
        tenantId,
        phoneNumber = null,
        displayName = null,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        if (!tenantId) {
            throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');
        }

        const connection = await this.connRepo.createForTenant(tenantId, {
            phoneNumber,
            displayName,
            status: 'CREATED',
            desiredState: 'STOPPED',
            actualState: 'UNASSIGNED',
        });

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'CONNECTION_CREATED',
                resourceType: 'WhatsAppConnection',
                resourceId: connection.id,
                metadata: {
                    displayName,
                    phoneNumber,
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        return connection;
    }

    /**
     * Retrieves connection details with anti-enumeration protection.
     */
    async getConnection(tenantId, connectionId, context = {}) {
        if (!tenantId || !connectionId) {
            throw ApiError.badRequest('tenantId and connectionId are required', 'VALIDATION_ERROR');
        }

        const connection = await this.connRepo.findByIdForTenant(connectionId, tenantId);
        if (!connection) {
            // Anti-enumeration: check if connection belongs to another tenant to audit probe
            if (this.auditLogRepo) {
                const crossTenantConn = await this.connRepo.findById(connectionId).catch(() => null);
                if (crossTenantConn && crossTenantConn.tenantId !== tenantId) {
                    await this.auditLogRepo.create({
                        tenantId,
                        actorUserId: context.actorUserId || null,
                        action: 'UNAUTHORIZED_CONNECTION_ACCESS',
                        resourceType: 'WhatsAppConnection',
                        resourceId: connectionId,
                        metadata: {
                            requestedTenantId: tenantId,
                            actualTenantId: crossTenantConn.tenantId,
                        },
                        ipAddress: context.ipAddress || null,
                        userAgent: context.userAgent || null,
                    }).catch(() => {});
                }
            }

            // Anti-enumeration: returns generic 404
            throw ApiError.notFound('Connection not found', 'RESOURCE_NOT_FOUND');
        }

        // Attach ephemeral QR status (boolean flag only, never raw QR; fenced with leaseEpoch)
        const qrInfo = this.qrStore.get(tenantId, connectionId, connection.leaseEpoch);
        return {
            ...connection,
            hasActiveQr: Boolean(qrInfo),
            qrExpiresAt: qrInfo?.expiresAt || null,
        };
    }

    /**
     * Lists all connections belonging to a tenant.
     */
    async listConnections(tenantId) {
        if (!tenantId) return [];
        const connections = await this.connRepo.listForTenant(tenantId);
        return connections.map((conn) => {
            const qrInfo = this.qrStore.get(tenantId, conn.id);
            return {
                ...conn,
                hasActiveQr: Boolean(qrInfo),
                qrExpiresAt: qrInfo?.expiresAt || null,
            };
        });
    }

    /**
     * Requests connection start (desired_state -> RUNNING).
     */
    async startConnection({
        tenantId,
        connectionId,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        const connection = await this.getConnection(tenantId, connectionId);

        // Update desired state in PostgreSQL
        const updated = await this.connRepo.updateDesiredStateForTenant(connectionId, tenantId, 'RUNNING');

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'CONNECTION_START_REQUESTED',
                resourceType: 'WhatsAppConnection',
                resourceId: connectionId,
                metadata: {
                    previousDesiredState: connection.desiredState,
                    newDesiredState: 'RUNNING',
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        // Send wake-up signal to worker control plane
        await this.commandGateway.sendCommand({
            command: 'START_CONNECTION',
            tenantId,
            connectionId,
        });

        return updated;
    }

    /**
     * Requests connection stop (desired_state -> STOPPED).
     */
    async stopConnection({
        tenantId,
        connectionId,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        const connection = await this.getConnection(tenantId, connectionId);

        // Update desired state in PostgreSQL
        const updated = await this.connRepo.updateDesiredStateForTenant(connectionId, tenantId, 'STOPPED');

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'CONNECTION_STOP_REQUESTED',
                resourceType: 'WhatsAppConnection',
                resourceId: connectionId,
                metadata: {
                    previousDesiredState: connection.desiredState,
                    newDesiredState: 'STOPPED',
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        // Send wake-up signal to worker control plane
        await this.commandGateway.sendCommand({
            command: 'STOP_CONNECTION',
            tenantId,
            connectionId,
        });

        return updated;
    }

    /**
     * Operational reconnect command (preserves desired_state = RUNNING).
     */
    async reconnectConnection({
        tenantId,
        connectionId,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        const connection = await this.getConnection(tenantId, connectionId);

        // Ensure desired state is RUNNING
        const updated = await this.connRepo.updateDesiredStateForTenant(connectionId, tenantId, 'RUNNING');

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'CONNECTION_RECONNECT_REQUESTED',
                resourceType: 'WhatsAppConnection',
                resourceId: connectionId,
                metadata: {
                    desiredState: 'RUNNING',
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        // Send wake-up command
        await this.commandGateway.sendCommand({
            command: 'RECONNECT_CONNECTION',
            tenantId,
            connectionId,
        });

        return updated;
    }

    /**
     * Decommission / delete connection (Requires OWNER role).
     */
    async deleteConnection({
        tenantId,
        connectionId,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        const connection = await this.getConnection(tenantId, connectionId);

        // 1. Signal worker to stop active socket if running
        await this.commandGateway.sendCommand({
            command: 'STOP_CONNECTION',
            tenantId,
            connectionId,
        }).catch(() => {});

        // 2. Clear ephemeral QR
        this.qrStore.delete(tenantId, connectionId);

        // 3. Delete connection record from PostgreSQL
        // Foreign key constraints ON DELETE CASCADE will safely clean up auth credentials and keys
        await this.connRepo.deleteForTenant(connectionId, tenantId);

        // 4. Record audit log
        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'CONNECTION_DELETED',
                resourceType: 'WhatsAppConnection',
                resourceId: connectionId,
                metadata: {
                    deletedConnectionId: connectionId,
                    displayName: connection.displayName,
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        return { success: true, deletedConnectionId: connectionId };
    }

    /**
     * Retrieves current ephemeral QR code for a connection.
     * Enforces anti-enumeration and generation leaseEpoch fencing.
     */
    async getQrCode(tenantId, connectionId, context = {}) {
        // Enforce anti-enumeration: verify connection belongs to tenant
        const connection = await this.getConnection(tenantId, connectionId, context);

        // Generation fencing: Only retrieve QR if matching authoritative generation leaseEpoch
        const qrEntry = this.qrStore.get(tenantId, connectionId, connection.leaseEpoch);
        if (!qrEntry) {
            throw ApiError.notFound(
                'QR code is not currently available or has expired. Connect or reconnect the session to generate a fresh QR.',
                'QR_NOT_AVAILABLE'
            );
        }

        return qrEntry;
    }
}

module.exports = ConnectionService;
