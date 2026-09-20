const ApiError = require('../errors/ApiError');
const { validateUuid } = require('./validation');
const { computeRequestHash } = require('../../repositories/IdempotencyRepository');

/**
 * Executes a moderation command with idempotency support.
 */
async function handleIdempotentCommand({
    pool,
    idempotencyRepo,
    commandRepo,
    commandGateway,
    tenantId,
    userId,
    connectionId,
    groupId,
    commandType,
    payload,
    req,
}) {
    const rawKey = req.headers['idempotency-key'];
    const idempotencyKey = rawKey && typeof rawKey === 'string' ? rawKey.trim() : null;

    if (idempotencyKey) {
        if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) {
            throw ApiError.badRequest('Invalid Idempotency-Key header format', 'INVALID_IDEMPOTENCY_KEY');
        }
    }

    const normRoute = (req.url || '').split('?')[0].trim().toLowerCase();
    const requestHash = idempotencyKey ? computeRequestHash(req.method, normRoute, payload) : null;

    if (idempotencyKey && idempotencyRepo) {
        const client = await pool.connect();
        let shouldRollback = true;
        try {
            await client.query('BEGIN');

            const { isNew, record } = await idempotencyRepo.reserveKey(client, {
                tenantId,
                userId,
                idempotencyKey,
                requestHash,
            });

            if (!isNew) {
                await client.query('ROLLBACK');
                shouldRollback = false;

                if (record.request_hash !== requestHash) {
                    throw ApiError.unprocessableEntity(
                        'Idempotency-Key has already been used with a different request payload or route',
                        'IDEMPOTENCY_KEY_MISMATCH'
                    );
                }

                if (record.status === 'PENDING') {
                    throw ApiError.conflict(
                        'A request with this idempotency key is currently processing',
                        'IDEMPOTENCY_CONFLICT'
                    );
                }

                if (record.status === 'COMPLETED') {
                    return {
                        statusCode: record.response_status_code || 202,
                        body: record.response_body,
                        isReplay: true,
                    };
                }

                throw ApiError.conflict('Idempotency key collision in invalid state', 'IDEMPOTENCY_CONFLICT');
            }

            // We are the owner of the idempotency key: create command inside SAME transaction
            const command = await commandRepo.createCommand(client, {
                tenantId,
                connectionId,
                groupId,
                commandType,
                payload,
                requestedByUserId: userId,
            });

            const responseData = {
                commandId: command.id,
                status: command.status,
                action: commandType,
                createdAt: command.created_at,
            };

            await idempotencyRepo.completeKey(client, {
                id: record.id,
                statusCode: 202,
                responseBody: responseData,
            });

            await client.query('COMMIT');
            shouldRollback = false;

            // Signal worker plane outside transaction
            if (commandGateway) {
                commandGateway.sendCommand({
                    command: commandType,
                    tenantId,
                    connectionId,
                    payload: { commandId: command.id, ...payload },
                }).catch(() => {});
            }

            return {
                statusCode: 202,
                body: responseData,
            };
        } catch (err) {
            if (shouldRollback) {
                try { await client.query('ROLLBACK'); } catch (_) {}
            }
            throw err;
        } finally {
            client.release();
        }
    }

    // No idempotency key provided: standard command creation
    const command = await commandRepo.createCommand(null, {
        tenantId,
        connectionId,
        groupId,
        commandType,
        payload,
        requestedByUserId: userId,
    });

    const responseData = {
        commandId: command.id,
        status: command.status,
        action: commandType,
        createdAt: command.created_at,
    };

    if (commandGateway) {
        commandGateway.sendCommand({
            command: commandType,
            tenantId,
            connectionId,
            payload: { commandId: command.id, ...payload },
        }).catch(() => {});
    }

    return {
        statusCode: 202,
        body: responseData,
    };
}

/**
 * Registers moderation and warning routes.
 *
 * @param {object} params
 * @param {import('./HttpRouter')} params.router
 * @param {import('pg').Pool} params.pool
 * @param {import('../../repositories/GroupRepository')} params.groupRepo
 * @param {import('../../repositories/WhatsAppConnectionRepository')} params.connRepo
 * @param {import('../../repositories/ConnectionCommandRepository')} params.commandRepo
 * @param {import('../../repositories/GroupWarningRepository')} params.warningRepo
 * @param {import('../../repositories/IdempotencyRepository').IdempotencyRepository} params.idempotencyRepo
 * @param {import('../services/WarningService')} params.warningService
 * @param {object} [params.commandGateway]
 * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
 * @param {Function} params.authMiddleware
 * @param {Function} params.tenantMiddleware
 * @param {Function} params.requireTenantRole
 * @param {Function} params.sendJson
 * @param {Function} params.readJsonBody
 */
function registerModerationRoutes({
    router,
    pool,
    groupRepo,
    connRepo,
    commandRepo,
    warningRepo,
    idempotencyRepo,
    warningService,
    commandGateway = null,
    auditLogRepo = null,
    authMiddleware,
    tenantMiddleware,
    requireTenantRole,
    sendJson,
    readJsonBody,
}) {
    /**
     * Shared validator for group and connection pre-conditions.
     */
    async function assertGroupAndConnectionReady(tenantId, groupId) {
        const group = await groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group) {
            throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
        }

        if (group.status !== 'MANAGED') {
            throw ApiError.badRequest(
                `Cannot moderate group "${group.name || groupId}": group is ${group.status}. Status must be MANAGED.`,
                'GROUP_NOT_MANAGED'
            );
        }

        const conn = await connRepo.findByIdForTenant(group.connection_id, tenantId);
        if (!conn) {
            throw ApiError.notFound('WhatsApp connection not found', 'RESOURCE_NOT_FOUND');
        }

        if (conn.actual_state !== 'ACTIVE') {
            throw ApiError.conflict(
                `Cannot moderate group: connection is in state "${conn.actual_state}". Connection must be ACTIVE.`,
                'CONNECTION_NOT_ACTIVE'
            );
        }

        return { group, conn };
    }

    // -------------------------------------------------------------
    // MUTE GROUP
    // Route: POST /api/v1/tenants/:tenantId/groups/:groupId/moderation/mute
    // -------------------------------------------------------------
    router.post(
        '/api/v1/tenants/:tenantId/groups/:groupId/moderation/mute',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;
            const { group } = await assertGroupAndConnectionReady(tenantId, groupId);

            const body = await readJsonBody(req);
            let durationMinutes = null;
            if (body && body.durationMinutes !== undefined && body.durationMinutes !== null) {
                const parsed = parseInt(body.durationMinutes, 10);
                if (isNaN(parsed) || parsed <= 0 || parsed > 10080) {
                    throw ApiError.badRequest('durationMinutes must be a positive integer between 1 and 10080 (7 days)', 'VALIDATION_ERROR');
                }
                durationMinutes = parsed;
            }

            const result = await handleIdempotentCommand({
                pool,
                idempotencyRepo,
                commandRepo,
                commandGateway,
                tenantId,
                userId: req.user.id,
                connectionId: group.connection_id,
                groupId,
                commandType: 'MUTE_GROUP',
                payload: {
                    durationMinutes,
                    reason: body && body.reason ? String(body.reason).trim() : null,
                },
                req,
            });

            if (auditLogRepo) {
                auditLogRepo.create({
                    tenantId,
                    actorUserId: req.user.id,
                    action: 'GROUP_MUTE_REQUESTED',
                    resourceType: 'group',
                    resourceId: groupId,
                    metadata: { commandId: result.body.commandId, durationMinutes },
                    ipAddress: req.ip || null,
                    userAgent: req.headers['user-agent'] || null,
                }).catch(() => {});
            }

            return sendJson(res, result.statusCode, result.body);
        }
    );

    // -------------------------------------------------------------
    // UNMUTE GROUP
    // Route: POST /api/v1/tenants/:tenantId/groups/:groupId/moderation/unmute
    // -------------------------------------------------------------
    router.post(
        '/api/v1/tenants/:tenantId/groups/:groupId/moderation/unmute',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;
            const { group } = await assertGroupAndConnectionReady(tenantId, groupId);

            const body = await readJsonBody(req);

            const result = await handleIdempotentCommand({
                pool,
                idempotencyRepo,
                commandRepo,
                commandGateway,
                tenantId,
                userId: req.user.id,
                connectionId: group.connection_id,
                groupId,
                commandType: 'UNMUTE_GROUP',
                payload: {
                    reason: body && body.reason ? String(body.reason).trim() : null,
                },
                req,
            });

            if (auditLogRepo) {
                auditLogRepo.create({
                    tenantId,
                    actorUserId: req.user.id,
                    action: 'GROUP_UNMUTE_REQUESTED',
                    resourceType: 'group',
                    resourceId: groupId,
                    metadata: { commandId: result.body.commandId },
                    ipAddress: req.ip || null,
                    userAgent: req.headers['user-agent'] || null,
                }).catch(() => {});
            }

            return sendJson(res, result.statusCode, result.body);
        }
    );

    // -------------------------------------------------------------
    // KICK PARTICIPANT
    // Route: POST /api/v1/tenants/:tenantId/groups/:groupId/moderation/kick
    // -------------------------------------------------------------
    router.post(
        '/api/v1/tenants/:tenantId/groups/:groupId/moderation/kick',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;
            const { group } = await assertGroupAndConnectionReady(tenantId, groupId);

            const body = await readJsonBody(req);
            if (!body || !body.participantJid || typeof body.participantJid !== 'string' || !body.participantJid.trim()) {
                throw ApiError.badRequest('participantJid is required', 'VALIDATION_ERROR');
            }

            const participantJid = body.participantJid.trim();

            const result = await handleIdempotentCommand({
                pool,
                idempotencyRepo,
                commandRepo,
                commandGateway,
                tenantId,
                userId: req.user.id,
                connectionId: group.connection_id,
                groupId,
                commandType: 'KICK_PARTICIPANT',
                payload: {
                    participantJid,
                    reason: body.reason ? String(body.reason).trim() : null,
                },
                req,
            });

            if (auditLogRepo) {
                auditLogRepo.create({
                    tenantId,
                    actorUserId: req.user.id,
                    action: 'PARTICIPANT_KICK_REQUESTED',
                    resourceType: 'group',
                    resourceId: groupId,
                    metadata: { commandId: result.body.commandId, participantJid },
                    ipAddress: req.ip || null,
                    userAgent: req.headers['user-agent'] || null,
                }).catch(() => {});
            }

            return sendJson(res, result.statusCode, result.body);
        }
    );

    // -------------------------------------------------------------
    // GET WARNINGS
    // Route: GET /api/v1/tenants/:tenantId/groups/:groupId/warnings
    // -------------------------------------------------------------
    router.get(
        '/api/v1/tenants/:tenantId/groups/:groupId/warnings',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN', 'MEMBER']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;

            const group = await groupRepo.findByIdForTenant(groupId, tenantId);
            if (!group) {
                throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
            }

            const result = await warningRepo.listWarningsForGroup(tenantId, groupId, {
                subjectJid: req.query.subjectJid || null,
                limit: req.query.limit,
                offset: req.query.offset,
            });

            return sendJson(res, 200, {
                warnings: result.items,
                total: result.total,
                limit: result.limit,
                offset: result.offset,
            });
        }
    );

    // -------------------------------------------------------------
    // ISSUE WARNING
    // Route: POST /api/v1/tenants/:tenantId/groups/:groupId/warnings
    // -------------------------------------------------------------
    router.post(
        '/api/v1/tenants/:tenantId/groups/:groupId/warnings',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;

            const group = await groupRepo.findByIdForTenant(groupId, tenantId);
            if (!group) {
                throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
            }

            if (group.status !== 'MANAGED') {
                throw ApiError.badRequest(
                    `Cannot issue warning: group is ${group.status}. Status must be MANAGED.`,
                    'GROUP_NOT_MANAGED'
                );
            }

            const body = await readJsonBody(req);
            if (!body || !body.subjectJid || typeof body.subjectJid !== 'string' || !body.subjectJid.trim()) {
                throw ApiError.badRequest('subjectJid is required', 'VALIDATION_ERROR');
            }

            const rawKey = req.headers['idempotency-key'];
            const idempotencyKey = rawKey && typeof rawKey === 'string' ? rawKey.trim() : null;

            if (idempotencyKey) {
                if (!/^[a-zA-Z0-9_-]{1,128}$/.test(idempotencyKey)) {
                    throw ApiError.badRequest('Invalid Idempotency-Key header format', 'INVALID_IDEMPOTENCY_KEY');
                }
            }

            const normRoute = (req.url || '').split('?')[0].trim().toLowerCase();
            const requestHash = idempotencyKey ? computeRequestHash(req.method, normRoute, body) : null;

            const result = await warningService.issueWarning({
                tenantId,
                groupId,
                subjectJid: body.subjectJid.trim(),
                issuedBy: req.user.id,
                reason: body.reason ? String(body.reason).trim() : null,
                connectionId: group.connection_id,
                idempotencyKey,
                requestHash,
            });

            if (result.isReplay) {
                res.setHeader('X-Cache', 'IDEMPOTENT-REPLAY');
            } else {
                // If warning reached threshold and escalated to kick, notify worker
                if (result.shouldEscalate && result.commandId && commandGateway) {
                    commandGateway.sendCommand({
                        command: 'KICK_PARTICIPANT',
                        tenantId,
                        connectionId: group.connection_id,
                        payload: {
                            commandId: result.commandId,
                            participantJid: body.subjectJid.trim(),
                            reason: 'Warning threshold reached',
                        },
                    }).catch(() => {});
                }

                if (auditLogRepo) {
                    auditLogRepo.create({
                        tenantId,
                        actorUserId: req.user.id,
                        action: 'WARNING_ISSUED',
                        resourceType: 'group_warning',
                        resourceId: result.warning?.id || null,
                        metadata: {
                            groupId,
                            subjectJid: body.subjectJid.trim(),
                            warningCount: result.warningCount,
                            shouldEscalate: result.shouldEscalate,
                            escalationAction: result.escalationAction,
                        },
                        ipAddress: req.ip || null,
                        userAgent: req.headers['user-agent'] || null,
                    }).catch(() => {});
                }
            }

            const responsePayload = {
                warning: result.warning,
                warningCount: result.warningCount,
                maxWarnings: result.maxWarnings,
                shouldEscalate: result.shouldEscalate,
                escalationAction: result.escalationAction,
                commandId: result.commandId,
            };

            return sendJson(res, result.statusCode || 201, responsePayload);
        }
    );

    // -------------------------------------------------------------
    // RESET WARNINGS
    // Route: DELETE /api/v1/tenants/:tenantId/groups/:groupId/warnings
    // -------------------------------------------------------------
    router.delete(
        '/api/v1/tenants/:tenantId/groups/:groupId/warnings',
        authMiddleware,
        tenantMiddleware,
        requireTenantRole(['OWNER', 'ADMIN']),
        async (req, res) => {
            const groupId = validateUuid(req.params.groupId, 'groupId');
            const tenantId = req.tenantContext.tenantId;

            const group = await groupRepo.findByIdForTenant(groupId, tenantId);
            if (!group) {
                throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
            }

            let body = {};
            try { body = await readJsonBody(req); } catch (_) {}
            const subjectJid = req.query.subjectJid || body.subjectJid || null;

            let resetCount = 0;
            if (subjectJid && typeof subjectJid === 'string' && subjectJid.trim()) {
                resetCount = await warningRepo.resetWarningsForSubject(tenantId, groupId, subjectJid.trim());
            } else {
                resetCount = await warningRepo.clearAllWarningsForGroup(tenantId, groupId);
            }

            if (auditLogRepo) {
                auditLogRepo.create({
                    tenantId,
                    actorUserId: req.user.id,
                    action: 'WARNINGS_RESET',
                    resourceType: 'group',
                    resourceId: groupId,
                    metadata: { subjectJid, resetCount },
                    ipAddress: req.ip || null,
                    userAgent: req.headers['user-agent'] || null,
                }).catch(() => {});
            }

            return sendJson(res, 200, { resetCount });
        }
    );
}

module.exports = { registerModerationRoutes };
