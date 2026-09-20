const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const { GroupRepository } = require('../repositories');

class GroupSynchronizer {
    /**
     * @param {import('pg').Pool} pool
     * @param {object} [options]
     * @param {import('./worker/WorkerLeaseManager')} [options.leaseManager]
     * @param {import('../repositories/AuditLogRepository')} [options.auditLogRepo]
     */
    constructor(pool, { leaseManager = null, auditLogRepo = null } = {}) {
        this.pool = pool;
        this.groupRepo = new GroupRepository(pool);
        this.leaseManager = leaseManager;
        this.auditLogRepo = auditLogRepo;
    }

    /**
     * Synchronizes all currently participating WhatsApp groups for the connection into PostgreSQL.
     * Generation-fenced: If the worker loses its lease during synchronization, it immediately aborts
     * and discards in-flight updates to prevent stale generation mutations.
     * Failure-isolated: A network error logs the error and returns failure, never crashing the connection.
     *
     * @param {object} ctx - Immutable ExecutionContext
     * @param {object} [options]
     * @param {number} [options.expectedEpoch]
     * @returns {Promise<{ success: boolean, syncedCount: number, error?: string }>}
     */
    async syncAllParticipatingGroups(ctx, { expectedEpoch = null } = {}) {
        if (!ctx || !ctx.tenantId || !ctx.connectionId || !ctx.sock) {
            console.error('[GroupSynchronizer] Cannot sync groups: invalid ExecutionContext');
            return { success: false, syncedCount: 0, error: 'invalid_context' };
        }

        // 1. Initial lease fencing check
        if (this.leaseManager && !this.leaseManager.hasLease(ctx.connectionId)) {
            console.warn(`[GroupSynchronizer] Initial lease check failed for connection ${ctx.connectionId}`);
            return { success: false, syncedCount: 0, error: 'stale_generation' };
        }

        try {
            if (typeof ctx.sock.groupFetchAllParticipating !== 'function') {
                return { success: true, syncedCount: 0 };
            }

            const groupsMap = await ctx.sock.groupFetchAllParticipating();
            if (!groupsMap || typeof groupsMap !== 'object') {
                return { success: true, syncedCount: 0 };
            }

            let count = 0;
            for (const [jid, meta] of Object.entries(groupsMap)) {
                if (!jid || !jid.endsWith('@g.us')) continue;

                // Fencing check before every database mutation
                if (this.leaseManager && !this.leaseManager.hasLease(ctx.connectionId)) {
                    console.warn(`[GroupSynchronizer] Aborting group sync: lost lease for ${ctx.connectionId}`);
                    if (this.auditLogRepo) {
                        this.auditLogRepo.create({
                            tenantId: ctx.tenantId,
                            action: 'STALE_GENERATION_REJECTED',
                            resourceType: 'whatsapp_connection',
                            resourceId: ctx.connectionId,
                            metadata: {
                                operation: 'syncAllParticipatingGroups',
                                expectedEpoch,
                                reason: 'lease_lost_during_sync',
                            },
                        }).catch(() => {});
                    }
                    return { success: false, syncedCount: count, error: 'stale_generation' };
                }

                const name = meta?.subject || null;
                try {
                    await this.groupRepo.upsertDiscoveredGroup(ctx.tenantId, ctx.connectionId, {
                        whatsappJid: jid,
                        name,
                        status: 'DISCOVERED',
                    });
                    count++;
                } catch (dbErr) {
                    console.error(
                        `[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] Failed upserting group ${jid}:`,
                        dbErr.message
                    );
                }
            }

            console.log(`[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] Synchronized ${count} group(s) to PostgreSQL.`);
            return { success: true, syncedCount: count };
        } catch (err) {
            // Failure-isolated: record error but never crash connection
            console.error(
                `[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] Background group sync failed:`,
                err.message
            );
            return { success: false, syncedCount: 0, error: err.message };
        }
    }

    /**
     * Handles real-time group discovery events.
     */
    async handleGroupDiscovered(ctx, event) {
        try {
            const { jid, name } = event.group;
            if (!jid || !jid.endsWith('@g.us')) return;

            await this.groupRepo.upsertDiscoveredGroup(ctx.tenantId, ctx.connectionId, {
                whatsappJid: jid,
                name: name || null,
                status: 'DISCOVERED',
            });
        } catch (err) {
            console.error(`[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] handleGroupDiscovered error:`, err.message);
        }
    }

    /**
     * Handles real-time group metadata updates (e.g. subject changes).
     */
    async handleGroupUpdated(ctx, event) {
        try {
            const { jid, name } = event.group;
            if (!jid || !jid.endsWith('@g.us')) return;

            await this.groupRepo.upsertDiscoveredGroup(ctx.tenantId, ctx.connectionId, {
                whatsappJid: jid,
                name: name || null,
                status: 'DISCOVERED',
            });
        } catch (err) {
            console.error(`[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] handleGroupUpdated error:`, err.message);
        }
    }

    /**
     * Handles participant changes. Reliably detects if the bot account itself was removed
     * and transitions group status to UNMANAGED.
     */
    async handleGroupParticipantsChanged(ctx, event) {
        try {
            const { group, action, participants } = event;
            if (action !== 'remove' || !group?.jid) return;

            // Reliably resolve the connected account's own JID
            const botUserId = ctx.sock.user?.id;
            if (!botUserId) return;

            const botJid = jidNormalizedUser(botUserId);
            const botNumber = botJid.split('@')[0];

            // Verify if the bot account was among the removed participants
            const botWasRemoved = participants.some((p) => {
                if (!p.jid) return false;
                const normalized = jidNormalizedUser(p.jid);
                return normalized === botJid || normalized.startsWith(botNumber);
            });

            if (botWasRemoved) {
                console.log(`[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] Bot was removed from ${group.jid}. Marking UNMANAGED.`);
                const foundGroup = await this.groupRepo.findByJidForTenant(group.jid, ctx.tenantId);
                if (foundGroup) {
                    await this.groupRepo.updateStatusForTenant(foundGroup.id, ctx.tenantId, 'UNMANAGED');
                }
            }
        } catch (err) {
            console.error(`[GroupSynchronizer ${ctx.tenantId}:${ctx.connectionId}] handleGroupParticipantsChanged error:`, err.message);
        }
    }
}

module.exports = GroupSynchronizer;
