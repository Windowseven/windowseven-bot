class ModerationService {
    /**
     * @param {object} params
     * @param {import('../../gateways/WhatsAppModerationGateway')} params.gateway
     * @param {import('../../repositories/ScheduledModerationTaskRepository')} [params.taskRepo]
     * @param {import('pg').Pool} [params.pool]
     * @param {import('../../repositories/ConnectionCommandRepository')} [params.commandRepo]
     * @param {object} [params.commandGateway]
     */
    constructor({ gateway, taskRepo = null, pool = null, commandRepo = null, commandGateway = null }) {
        if (!gateway) throw new Error('[ModerationService] gateway is required');
        this.gateway = gateway;
        this.taskRepo = taskRepo;
        this.pool = pool;
        this.commandRepo = commandRepo;
        this.commandGateway = commandGateway;
        this.activeMuteTimers = new Map(); // groupJid -> timerId or tracking entry
    }

    /**
     * Mutes a group by enabling announcement mode.
     * Enters the authoritative durable connection_commands control plane when commandRepo is available.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {number} [durationInMinutes]
     * @returns {Promise<{ success: boolean, commandId?: string, error?: string }>}
     */
    async muteGroup(appCtx, durationInMinutes) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false, error: 'Group is not managed' };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false, error: 'Bot must be an admin to mute the group' };
        }
        if (!appCtx.actor.isSenderAdmin) {
            return { success: false, error: 'Only group admins can mute the group' };
        }

        // 1. Authoritative Durable Path: Submit MUTE_GROUP command into connection_commands
        if (this.commandRepo && appCtx.tenantId && appCtx.connectionId && appCtx.group?.id) {
            const command = await this.commandRepo.createCommand(null, {
                tenantId: appCtx.tenantId,
                connectionId: appCtx.connectionId,
                groupId: appCtx.group.id,
                commandType: 'MUTE_GROUP',
                payload: durationInMinutes ? { durationMinutes: durationInMinutes } : {},
            });

            if (this.commandGateway) {
                this.commandGateway.sendCommand({
                    command: 'MUTE_GROUP',
                    tenantId: appCtx.tenantId,
                    connectionId: appCtx.connectionId,
                    payload: { commandId: command.id, durationMinutes },
                }).catch(() => {});
            }

            return { success: true, commandId: command.id };
        }

        // 2. Fallback for standalone unit test mocks (where commandRepo/database are omitted)
        const success = await this.gateway.muteGroup(appCtx.group.whatsappJid);
        if (!success) {
            return { success: false, error: 'Failed to update group setting' };
        }

        const groupJid = appCtx.group.whatsappJid;

        // Cancel any existing pending mute timer for this group
        if (this.activeMuteTimers.has(groupJid)) {
            const entry = this.activeMuteTimers.get(groupJid);
            if (entry && !entry.durable) {
                clearTimeout(entry);
            }
            this.activeMuteTimers.delete(groupJid);
        }

        if (typeof durationInMinutes === 'number' && durationInMinutes > 0) {
            const timerId = setTimeout(async () => {
                this.activeMuteTimers.delete(groupJid);
                try {
                    await this.gateway.unmuteGroup(groupJid);
                    await this.gateway.sendTextMessage(
                        groupJid,
                        '*_The group has been unmuted._*'
                    );
                } catch (err) {
                    console.error('[ModerationService] Error in scheduled unmute:', err.message);
                }
            }, durationInMinutes * 60 * 1000);

            if (typeof timerId.unref === 'function') {
                timerId.unref();
            }

            this.activeMuteTimers.set(groupJid, timerId);
        }

        return { success: true };
    }

    /**
     * Unmutes a group by disabling announcement mode.
     * Enters the authoritative durable connection_commands control plane when commandRepo is available.
     * @param {import('../context/ApplicationContext')} appCtx
     * @returns {Promise<{ success: boolean, commandId?: string, error?: string }>}
     */
    async unmuteGroup(appCtx) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false, error: 'Group is not managed' };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false, error: 'Bot must be an admin to unmute the group' };
        }
        if (!appCtx.actor.isSenderAdmin) {
            return { success: false, error: 'Only group admins can unmute the group' };
        }

        // 1. Authoritative Durable Path: Submit UNMUTE_GROUP command into connection_commands
        if (this.commandRepo && appCtx.tenantId && appCtx.connectionId && appCtx.group?.id) {
            if (this.taskRepo) {
                await this.taskRepo.cancelTasksForGroup(null, {
                    tenantId: appCtx.tenantId,
                    groupId: appCtx.group.id,
                    action: 'UNMUTE_GROUP',
                }).catch(() => {});
            }

            const command = await this.commandRepo.createCommand(null, {
                tenantId: appCtx.tenantId,
                connectionId: appCtx.connectionId,
                groupId: appCtx.group.id,
                commandType: 'UNMUTE_GROUP',
                payload: {},
            });

            if (this.commandGateway) {
                this.commandGateway.sendCommand({
                    command: 'UNMUTE_GROUP',
                    tenantId: appCtx.tenantId,
                    connectionId: appCtx.connectionId,
                    payload: { commandId: command.id },
                }).catch(() => {});
            }

            return { success: true, commandId: command.id };
        }

        // 2. Fallback for standalone unit test mocks
        const success = await this.gateway.unmuteGroup(appCtx.group.whatsappJid);
        if (!success) {
            return { success: false, error: 'Failed to update group setting' };
        }

        const groupJid = appCtx.group.whatsappJid;
        if (this.taskRepo && appCtx.tenantId && appCtx.group?.id) {
            await this.taskRepo.cancelTasksForGroup(null, {
                tenantId: appCtx.tenantId,
                groupId: appCtx.group.id,
                action: 'UNMUTE_GROUP',
            }).catch(() => {});
        }

        if (this.activeMuteTimers.has(groupJid)) {
            const entry = this.activeMuteTimers.get(groupJid);
            if (entry && !entry.durable) {
                clearTimeout(entry);
            }
            this.activeMuteTimers.delete(groupJid);
        }

        return { success: true };
    }

    /**
     * Checks if an in-memory mute timer is pending for a group.
     * @param {string} groupJid
     * @returns {boolean}
     */
    hasPendingMuteTimer(groupJid) {
        return this.activeMuteTimers.has(groupJid);
    }

    /**
     * Clears all active in-memory mute timers.
     */
    clearAllMuteTimers() {
        for (const timer of this.activeMuteTimers.values()) {
            if (timer && !timer.durable) {
                clearTimeout(timer);
            }
        }
        this.activeMuteTimers.clear();
    }

    /**
     * Kicks a participant from the group.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {string} targetJid
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async kickParticipant(appCtx, targetJid) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false, error: 'Group is not managed' };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false, error: 'Bot must be an admin to kick participants' };
        }
        if (!targetJid) {
            return { success: false, error: 'Target JID is required' };
        }

        const success = await this.gateway.kickParticipant(appCtx.group.whatsappJid, targetJid);
        return { success };
    }

    /**
     * Promotes a participant to group admin.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {string} targetJid
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async promoteParticipant(appCtx, targetJid) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false, error: 'Group is not managed' };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false, error: 'Bot must be an admin to promote participants' };
        }
        if (!appCtx.actor.isSenderAdmin) {
            return { success: false, error: 'Only group admins can promote members' };
        }
        if (!targetJid) {
            return { success: false, error: 'Target JID is required' };
        }

        const success = await this.gateway.promoteParticipant(appCtx.group.whatsappJid, targetJid);
        return { success };
    }

    /**
     * Demotes a participant from group admin.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {string} targetJid
     * @returns {Promise<{ success: boolean, error?: string }>}
     */
    async demoteParticipant(appCtx, targetJid) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false, error: 'Group is not managed' };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false, error: 'Bot must be an admin to demote participants' };
        }
        if (!appCtx.actor.isSenderAdmin) {
            return { success: false, error: 'Only group admins can demote members' };
        }
        if (!targetJid) {
            return { success: false, error: 'Target JID is required' };
        }

        const success = await this.gateway.demoteParticipant(appCtx.group.whatsappJid, targetJid);
        return { success };
    }

    /**
     * Deletes a message.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {object} messageKey
     * @returns {Promise<{ success: boolean }>}
     */
    async deleteMessage(appCtx, messageKey) {
        if (!appCtx.group || appCtx.group.status !== 'MANAGED') {
            return { success: false };
        }
        if (!appCtx.actor.isBotAdmin) {
            return { success: false };
        }
        const success = await this.gateway.deleteMessage(appCtx.group.whatsappJid, messageKey);
        return { success };
    }

    /**
     * Sends a plain text message to the group.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {string} text
     * @param {Array<string>} [mentions]
     * @returns {Promise<object|null>}
     */
    async sendMessage(appCtx, text, mentions = []) {
        if (!appCtx.group) return null;
        return this.gateway.sendTextMessage(appCtx.group.whatsappJid, text, { mentions });
    }
}

module.exports = ModerationService;
