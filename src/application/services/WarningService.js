const ApiError = require('../errors/ApiError');

class WarningService {
    /**
     * @param {object} params
     * @param {import('../../repositories/GroupWarningRepository')} params.warningRepo
     * @param {import('../../repositories/GroupPolicyRepository')} [params.policyRepo]
     * @param {import('../../repositories/ConnectionCommandRepository')} [params.commandRepo]
     * @param {import('../../repositories/GroupRepository')} [params.groupRepo]
     * @param {object} [params.commandGateway]
     * @param {import('../../repositories/IdempotencyRepository').IdempotencyRepository} [params.idempotencyRepo]
     * @param {import('pg').Pool} [params.pool]
     */
    constructor({ warningRepo, policyRepo, commandRepo = null, groupRepo = null, commandGateway = null, idempotencyRepo = null, pool = null }) {
        if (!warningRepo) throw new Error('[WarningService] warningRepo is required');
        this.warningRepo = warningRepo;
        this.policyRepo = policyRepo;
        this.commandRepo = commandRepo;
        this.groupRepo = groupRepo;
        this.commandGateway = commandGateway;
        this.idempotencyRepo = idempotencyRepo;
        this.pool = pool || warningRepo.pool;
    }

    /**
     * Issues a warning to a participant and checks if the warning threshold is reached.
     * Transactionally atomic: idempotency reservation, warning insertion, threshold evaluation,
     * KICK_PARTICIPANT command creation, and idempotency completion all happen inside the SAME transaction!
     *
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.groupId
     * @param {string} params.subjectJid
     * @param {string} params.issuedBy
     * @param {string} [params.reason]
     * @param {string} [params.connectionId]
     * @param {string} [params.idempotencyKey]
     * @param {string} [params.requestHash]
     * @returns {Promise<{
     *   warning: object,
     *   warningCount: number,
     *   maxWarnings: number,
     *   shouldEscalate: boolean,
     *   escalationAction: string,
     *   commandId: string|null,
     *   statusCode?: number,
     *   isReplay?: boolean
     * }>}
     */
    async issueWarning({
        tenantId,
        groupId,
        subjectJid,
        issuedBy,
        reason = null,
        connectionId = null,
        idempotencyKey = null,
        requestHash = null,
    }) {
        if (!tenantId || !groupId || !subjectJid || !issuedBy) {
            throw new Error('[WarningService] tenantId, groupId, subjectJid, and issuedBy are required');
        }

        // If no pool available, fallback to repository-level non-transactional path (e.g. basic mock unit tests)
        if (!this.pool || typeof this.pool.connect !== 'function') {
            const warning = await this.warningRepo.createWarning(tenantId, groupId, {
                subjectJid,
                issuedBy,
                reason,
            });
            const warningCount = await this.warningRepo.countWarningsForSubject(tenantId, groupId, subjectJid);
            let maxWarnings = 3;
            let warningAction = 'kick';
            if (this.policyRepo) {
                const policy = await this.policyRepo.findByGroupIdForTenant(groupId, tenantId);
                if (policy && typeof policy.max_warnings === 'number' && policy.max_warnings > 0) {
                    maxWarnings = policy.max_warnings;
                    warningAction = policy.warning_action || 'kick';
                }
            }
            return {
                warning,
                warningCount,
                maxWarnings,
                shouldEscalate: warningCount >= maxWarnings,
                escalationAction: warningAction,
                commandId: null,
                statusCode: 201,
                isReplay: false,
            };
        }

        const client = await this.pool.connect();
        let shouldRollback = true;
        try {
            await client.query('BEGIN');

            let idempotencyRecord = null;
            if (idempotencyKey && this.idempotencyRepo) {
                // 1. Atomically reserve idempotency key inside the transaction
                const { isNew, record } = await this.idempotencyRepo.reserveKey(client, {
                    tenantId,
                    userId: issuedBy,
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
                            ...record.response_body,
                            statusCode: record.response_status_code || 201,
                            isReplay: true,
                        };
                    }

                    throw ApiError.conflict('Idempotency key collision in invalid state', 'IDEMPOTENCY_CONFLICT');
                }

                idempotencyRecord = record;
            }

            // 2. Subject-level advisory lock prevents concurrent warning race conditions
            const lockKey = `${tenantId}:${groupId}:${subjectJid.trim().toLowerCase()}`;
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1));', [lockKey]);

            // 3. Insert warning record inside transaction
            const warning = await this.warningRepo.createWarning(tenantId, groupId, {
                subjectJid,
                issuedBy,
                reason,
            }, client);

            // 4. Authoritative count inside transaction
            const countSql = `
                SELECT COUNT(*)::int AS count
                FROM group_warnings
                WHERE tenant_id = $1 AND group_id = $2 AND subject_jid = $3;
            `;
            const countRes = await client.query(countSql, [
                tenantId,
                groupId,
                this.warningRepo._normalizeJid(subjectJid),
            ]);
            const warningCount = countRes.rows[0]?.count || 1;

            // 5. Resolve threshold from policy
            let maxWarnings = 3;
            let warningAction = 'kick';
            const policySql = `
                SELECT max_warnings, warning_action
                FROM group_policies
                WHERE tenant_id = $1 AND group_id = $2;
            `;
            const policyRes = await client.query(policySql, [tenantId, groupId]);
            if (policyRes.rows.length > 0) {
                maxWarnings = policyRes.rows[0].max_warnings || 3;
                warningAction = policyRes.rows[0].warning_action || 'kick';
            }

            const shouldEscalate = warningCount >= maxWarnings;
            let commandId = null;

            // 6. If escalation threshold is reached, create KICK_PARTICIPANT command in the SAME transaction!
            if (shouldEscalate && this.commandRepo) {
                let resolvedConnId = connectionId;
                if (!resolvedConnId && this.groupRepo) {
                    const grp = await this.groupRepo.findByIdForTenant(groupId, tenantId);
                    resolvedConnId = grp?.connection_id || null;
                }

                if (resolvedConnId && warningAction === 'kick') {
                    const cmd = await this.commandRepo.createCommand(client, {
                        tenantId,
                        connectionId: resolvedConnId,
                        groupId,
                        commandType: 'KICK_PARTICIPANT',
                        payload: {
                            participantJid: this.warningRepo._normalizeJid(subjectJid),
                            reason: `Max warnings reached (${warningCount}/${maxWarnings})`,
                        },
                    });
                    commandId = cmd.id;
                }
            }

            const responseData = {
                warning,
                warningCount,
                maxWarnings,
                shouldEscalate,
                escalationAction: warningAction,
                commandId,
            };

            // 7. Complete idempotency key inside SAME transaction before commit!
            if (idempotencyRecord && this.idempotencyRepo) {
                await this.idempotencyRepo.completeKey(client, {
                    id: idempotencyRecord.id,
                    statusCode: 201,
                    responseBody: responseData,
                });
            }

            await client.query('COMMIT');
            shouldRollback = false;

            // 8. Best-effort wake-up signal emitted strictly AFTER commit
            if (commandId && this.commandGateway && connectionId) {
                this.commandGateway.sendCommand({
                    command: 'KICK_PARTICIPANT',
                    tenantId,
                    connectionId,
                    payload: { commandId },
                }).catch(() => {});
            }

            return {
                ...responseData,
                statusCode: 201,
                isReplay: false,
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

    /**
     * Retrieves warning summary and list for a subject.
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.groupId
     * @param {string} params.subjectJid
     * @returns {Promise<{ count: number, warnings: Array<object> }>}
     */
    async getWarnings({ tenantId, groupId, subjectJid }) {
        if (!tenantId || !groupId || !subjectJid) {
            return { count: 0, warnings: [] };
        }
        const count = await this.warningRepo.countWarningsForSubject(tenantId, groupId, subjectJid);
        const warnings = await this.warningRepo.listWarningsForSubject(tenantId, groupId, subjectJid);
        return { count, warnings };
    }

    /**
     * Resets warnings for a subject.
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.groupId
     * @param {string} params.subjectJid
     * @returns {Promise<{ clearedCount: number }>}
     */
    async resetWarnings({ tenantId, groupId, subjectJid }) {
        if (!tenantId || !groupId || !subjectJid) {
            return { clearedCount: 0 };
        }
        const clearedCount = await this.warningRepo.resetWarningsForSubject(tenantId, groupId, subjectJid);
        return { clearedCount };
    }
}

module.exports = WarningService;
