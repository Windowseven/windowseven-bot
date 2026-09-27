const ApiError = require('../errors/ApiError');
const { defaultQrStore } = require('../../whatsapp/control/EphemeralQrStore');
const { defaultPairingCodeStore } = require('../../whatsapp/control/EphemeralPairingCodeStore');
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
     * @param {import('../../whatsapp/control/EphemeralPairingCodeStore').EphemeralPairingCodeStore} [params.pairingStore]
     */
    constructor({
        pool,
        connRepo,
        auditLogRepo = null,
        commandGateway = defaultCommandGateway,
        qrStore = defaultQrStore,
        pairingStore = defaultPairingCodeStore,
    }) {
        if (!pool || !connRepo) {
            throw new Error('pool and connRepo are required for ConnectionService');
        }
        this.pool = pool;
        this.connRepo = connRepo;
        this.auditLogRepo = auditLogRepo;
        this.commandGateway = commandGateway;
        this.qrStore = qrStore;
        this.pairingStore = pairingStore;
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
    }, client = null) {
        if (!tenantId) {
            throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');
        }

        const connection = await this.connRepo.createForTenant(tenantId, {
            phoneNumber,
            displayName,
            status: 'CREATED',
            desiredState: 'STOPPED',
            actualState: 'UNASSIGNED',
        }, client);

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
            }, client).catch(() => {});
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

    /**
     * Customer-scoped: Retrieves the customer's single WhatsApp connection.
     * Enforces anti-enumeration and returns null if no connection is provisioned.
     *
     * @param {string} tenantId
     * @returns {Promise<object|null>}
     */
    async getCustomerConnection(tenantId) {
        if (!tenantId) throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');

        const connection = await this.connRepo.findByTenantId(tenantId);
        if (!connection) {
            return null;
        }

        const qrInfo = this.qrStore.get(tenantId, connection.id, connection.leaseEpoch);
        const pairingInfo = this.pairingStore.get(tenantId, connection.id, connection.leaseEpoch);

        return {
            id: connection.id,
            tenantId: connection.tenantId,
            phoneNumber: connection.phoneNumber,
            displayName: connection.displayName,
            status: connection.status,
            desiredState: connection.desiredState,
            actualState: connection.actualState,
            assignedWorkerId: connection.assignedWorkerId,
            leaseEpoch: connection.leaseEpoch,
            hasActiveQr: Boolean(qrInfo),
            qrExpiresAt: qrInfo?.expiresAt || null,
            hasActivePairingCode: Boolean(pairingInfo),
            pairingExpiresAt: pairingInfo?.expiresAt || null,
            createdAt: connection.createdAt,
            updatedAt: connection.updatedAt,
        };
    }

    /**
     * Customer-scoped: Gets or creates the customer's single connection and sets desired_state to RUNNING.
     * Invariant: One connection per customer tenant.
     *
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} [params.phoneNumber]
     * @param {string} [params.displayName]
     * @param {string} [params.actorUserId]
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<object>}
     */
    async getOrCreateCustomerConnection({
        tenantId,
        phoneNumber = null,
        displayName = null,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        if (!tenantId) throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');

        // Check if connection already exists for tenant
        let connection = await this.connRepo.findByTenantId(tenantId);

        if (!connection) {
            try {
                connection = await this.connRepo.createForTenant(tenantId, {
                    phoneNumber,
                    displayName: displayName || 'Customer Bot',
                    status: 'CREATED',
                    desiredState: 'RUNNING',
                    actualState: 'UNASSIGNED',
                });

                if (this.auditLogRepo) {
                    await this.auditLogRepo.create({
                        tenantId,
                        actorUserId,
                        action: 'CUSTOMER_CONNECTION_PROVISIONED',
                        resourceType: 'WhatsAppConnection',
                        resourceId: connection.id,
                        metadata: { displayName: connection.displayName, phoneNumber },
                        ipAddress,
                        userAgent,
                    }).catch(() => {});
                }
            } catch (err) {
                // If concurrent insert occurred, handle unique constraint race
                if (err.code === '23505' || err.message.includes('unique')) {
                    connection = await this.connRepo.findByTenantId(tenantId);
                } else {
                    throw err;
                }
            }
        }

        // If connection exists and desiredState is not RUNNING, transition to RUNNING
        if (connection.desiredState !== 'RUNNING') {
            connection = await this.connRepo.updateDesiredStateForTenant(connection.id, tenantId, 'RUNNING');

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId,
                    actorUserId,
                    action: 'CUSTOMER_CONNECTION_STARTED',
                    resourceType: 'WhatsAppConnection',
                    resourceId: connection.id,
                    metadata: { previousDesiredState: 'STOPPED', newDesiredState: 'RUNNING' },
                    ipAddress,
                    userAgent,
                }).catch(() => {});
            }
        }

        // Wake up worker control plane to reconcile/acquire
        await this.commandGateway.sendCommand({
            command: 'START_CONNECTION',
            tenantId,
            connectionId: connection.id,
        }).catch(() => {});

        return this.getCustomerConnection(tenantId);
    }

    /**
     * Customer-scoped: Requests an ephemeral pairing code for the customer's active connection.
     *
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.phoneNumber
     * @param {string} [params.actorUserId]
     * @returns {Promise<{ code: string, expiresAt: string }>}
     */
    async requestCustomerPairingCode({
        tenantId,
        phoneNumber,
        actorUserId = null,
        ipAddress = null,
        userAgent = null,
    }) {
        if (!tenantId) throw ApiError.badRequest('tenantId is required', 'VALIDATION_ERROR');
        if (!phoneNumber) throw ApiError.badRequest('phoneNumber is required', 'VALIDATION_ERROR');

        const connection = await this.connRepo.findByTenantId(tenantId);
        if (!connection) {
            throw ApiError.notFound('Connection not found for customer account', 'CONNECTION_NOT_FOUND');
        }

        // Must have assigned worker and active lease
        if (!connection.assignedWorkerId || !connection.leaseEpoch) {
            throw ApiError.badRequest(
                'WhatsApp connection is not currently active on a worker. Please start the connection first.',
                'CONNECTION_NOT_ACTIVE'
            );
        }

        const workerNode = this.commandGateway.getWorkerNode ? this.commandGateway.getWorkerNode(connection.assignedWorkerId) : null;
        if (!workerNode) {
            throw ApiError.badRequest(
                'The worker handling this connection is currently offline or unreachable. Please try again shortly.',
                'WORKER_UNAVAILABLE'
            );
        }

        let code;
        try {
            code = await workerNode.requestPairingCode(connection.id, phoneNumber);
        } catch (err) {
            if (err.code === 'CONNECTION_NOT_LEASED_BY_WORKER' || err.code === 'STALE_LEASE_EPOCH') {
                throw ApiError.conflict('Worker lease expired or generation changed. Please retry.', 'STALE_LEASE');
            }
            if (err.code === 'SOCKET_UNAVAILABLE') {
                throw ApiError.badRequest('WhatsApp socket is not connected or ready for pairing code.', 'SOCKET_UNAVAILABLE');
            }
            if (err.code === 'INVALID_PHONE_NUMBER') {
                throw ApiError.badRequest('Invalid phone number format for pairing code.', 'INVALID_PHONE_NUMBER');
            }
            throw ApiError.internal(`Failed requesting pairing code: ${err.message}`);
        }

        // Store pairing code ephemerally with 120s TTL and current leaseEpoch
        this.pairingStore.set(tenantId, connection.id, code, 120, connection.leaseEpoch);

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId,
                action: 'PAIRING_CODE_REQUESTED',
                resourceType: 'WhatsAppConnection',
                resourceId: connection.id,
                metadata: {
                    phoneNumber: String(phoneNumber).replace(/.(?=.{4})/g, '*'), // Masked phone for privacy
                    leaseEpoch: connection.leaseEpoch,
                },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        return {
            code,
            expiresAt: new Date(Date.now() + 120 * 1000).toISOString(),
        };
    }
}

module.exports = ConnectionService;
