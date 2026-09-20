const NormalizedMessage = require('../../domain/models/NormalizedMessage');
const ApplicationContext = require('../context/ApplicationContext');

class ApplicationPipeline {
    /**
     * @param {object} params
     * @param {import('../../repositories/GroupRepository')} params.groupRepo
     * @param {import('../../repositories/GroupPolicyRepository')} params.policyRepo
     * @param {import('../../repositories/GroupWarningRepository')} params.warningRepo
     * @param {import('../services/WarningService')} params.warningService
     * @param {import('../services/ModerationService')} params.moderationService
     * @param {import('../policies/PolicyEngine')} params.policyEngine
     * @param {import('../commands/CommandRegistry')} params.commandRegistry
     * @param {import('../../gateways/WhatsAppModerationGateway')} params.gateway
     */
    constructor({
        groupRepo,
        policyRepo,
        warningRepo,
        warningService,
        moderationService,
        policyEngine,
        commandRegistry,
        gateway,
    }) {
        if (!groupRepo || !policyRepo || !warningService || !moderationService || !policyEngine || !commandRegistry || !gateway) {
            throw new Error('[ApplicationPipeline] All repositories, services, and gateways are required');
        }

        this.groupRepo = groupRepo;
        this.policyRepo = policyRepo;
        this.warningRepo = warningRepo;
        this.warningService = warningService;
        this.moderationService = moderationService;
        this.policyEngine = policyEngine;
        this.commandRegistry = commandRegistry;
        this.gateway = gateway;

        // Bundle services for command execution
        this.services = {
            groupRepo: this.groupRepo,
            policyRepo: this.policyRepo,
            warningRepo: this.warningRepo,
            warningService: this.warningService,
            moderationService: this.moderationService,
        };
    }

    /**
     * Main message ingestion entry point.
     * Evaluates context, gates, policies, and commands with strict failure isolation.
     *
     * @param {object} event - Normalized message.received event from EventAdapter
     * @returns {Promise<{ handled: boolean, reason?: string, result?: any, error?: string }>}
     */
    async processMessage(event) {
        try {
            // 1. Event Validation
            if (!event || !event.message || !event.ctx) {
                return { handled: false, reason: 'invalid_event' };
            }

            const { tenantId, connectionId, sock } = event.ctx;
            const { message, raw } = event;

            // Only group messages are subject to group policies and group moderation
            if (!message.isGroup || !message.remoteJid) {
                return { handled: false, reason: 'not_group' };
            }

            // 2. Tenant + Connection Scoped Group Resolution
            const group = await this.groupRepo.findByJidForTenant(message.remoteJid, tenantId);
            if (!group || group.connection_id !== connectionId) {
                return { handled: false, reason: 'unresolved_or_mismatched_group' };
            }

            // 3. Managed Group Gate (Mandatory: Only MANAGED groups run policies/moderation)
            if (group.status !== 'MANAGED') {
                return { handled: false, reason: 'group_not_managed' };
            }

            // 4. Actor Resolution (WhatsApp group privileges)
            const { isSenderAdmin, isBotAdmin } = await this.gateway.checkAdminStatus(
                message.remoteJid,
                message.sender
            );

            // 5. Build NormalizedMessage & ApplicationContext
            const normalizedMsg = new NormalizedMessage({
                messageId: message.id,
                tenantId,
                connectionId,
                chatJid: message.remoteJid,
                senderJid: message.sender,
                botJid: sock?.user?.id || this.gateway?.socket?.user?.id || null,
                text: message.text || '',
                isGroup: true,
                fromMe: Boolean(message.fromMe),
                timestamp: message.timestamp,
                mentionedJids: raw?.message?.extendedTextMessage?.contextInfo?.mentionedJid || [],
                quotedSender: raw?.message?.extendedTextMessage?.contextInfo?.participant || null,
                rawMessage: raw,
            });

            const appCtx = new ApplicationContext({
                tenantId,
                connectionId,
                group,
                actor: {
                    senderJid: message.sender,
                    isSenderAdmin,
                    isBotAdmin,
                },
                message: normalizedMsg,
            });

            // 6. Command Processing
            if (normalizedMsg.messageKind === 'COMMAND') {
                const handler = this.commandRegistry.find(normalizedMsg.command);
                if (handler) {
                    // Authorization Gate
                    if (handler.requireSenderAdmin && !appCtx.actor.isSenderAdmin) {
                        await this.moderationService.sendMessage(
                            appCtx,
                            '❌ Error: Only group admins can use this command!'
                        );
                        return { handled: true, reason: 'forbidden_sender' };
                    }

                    if (handler.requireBotAdmin && !appCtx.actor.isBotAdmin) {
                        await this.moderationService.sendMessage(
                            appCtx,
                            '❌ Error: Please make the bot an admin first to use this command!'
                        );
                        return { handled: true, reason: 'forbidden_bot' };
                    }

                    // Execute migrated command
                    const cmdResult = await handler.execute(appCtx, this.services);
                    return { handled: true, result: cmdResult };
                }

                // If command is not migrated (e.g. .ping, .alive), do not run automatic policies on it
                return { handled: false, reason: 'unmigrated_command' };
            }

            // Ignore system messages from policy evaluation
            if (normalizedMsg.messageKind === 'SYSTEM') {
                return { handled: false, reason: 'system_message' };
            }

            // 7. Automatic Policy Evaluation (for non-command messages: TEXT, MEDIA)
            const groupPolicy = await this.policyRepo.findByGroupIdForTenant(group.id, tenantId);
            if (!groupPolicy) {
                return { handled: false, reason: 'no_group_policy' };
            }

            const decision = this.policyEngine.evaluate({
                message: normalizedMsg,
                groupPolicy,
                actor: appCtx.actor,
            });

            if (decision.action === 'ALLOW' || decision.action === 'NO_ACTION') {
                return { handled: false, reason: 'policy_allow' };
            }

            // Execute policy decision
            await this._executePolicyDecision(appCtx, decision, raw);
            return { handled: true, decision };

        } catch (err) {
            console.error('[ApplicationPipeline] Failure isolating error in processMessage:', err);
            return { handled: false, error: err.message };
        }
    }

    /**
     * Executes side-effects for a triggered policy decision.
     * @private
     */
    async _executePolicyDecision(appCtx, decision, raw) {
        const { group, message, actor } = appCtx;
        const senderNum = message.senderJid ? message.senderJid.split('@')[0] : 'user';

        // 1. Delete the offending message if bot is admin
        if (actor.isBotAdmin && raw?.key) {
            await this.gateway.deleteMessage(group.whatsappJid, raw.key);
        }

        // 2. Execute configured action
        switch (decision.action) {
            case 'DELETE': {
                await this.moderationService.sendMessage(
                    appCtx,
                    `⚠️ @${senderNum}, links or prohibited words are not allowed in this group.`,
                    [message.senderJid]
                );
                break;
            }

            case 'KICK': {
                if (actor.isBotAdmin) {
                    await this.moderationService.kickParticipant(appCtx, message.senderJid);
                    await this.moderationService.sendMessage(
                        appCtx,
                        `*『 REMOVED 』*\n\n@${senderNum} was removed for violating group policy (${decision.policyName}).`,
                        [message.senderJid]
                    );
                } else {
                    await this.moderationService.sendMessage(
                        appCtx,
                        `⚠️ @${senderNum} violated policy (${decision.policyName}), but bot needs admin privileges to kick.`,
                        [message.senderJid]
                    );
                }
                break;
            }

            case 'WARN': {
                const warnRes = await this.warningService.issueWarning({
                    tenantId: appCtx.tenantId,
                    groupId: group.id,
                    subjectJid: message.senderJid,
                    issuedBy: `policy:${decision.policyName.toLowerCase()}`,
                    reason: decision.reason || 'Group policy violation',
                });

                if (warnRes.shouldEscalate && warnRes.escalationAction === 'kick') {
                    if (actor.isBotAdmin) {
                        await this.moderationService.kickParticipant(appCtx, message.senderJid);
                        await this.moderationService.sendMessage(
                            appCtx,
                            `*『 AUTO-KICK 』*\n\n@${senderNum} has been removed after receiving ${warnRes.maxWarnings} warnings! ⚠️`,
                            [message.senderJid]
                        );
                    } else {
                        await this.moderationService.sendMessage(
                            appCtx,
                            `⚠️ @${senderNum} reached maximum warnings (${warnRes.maxWarnings}), but bot needs admin privileges to kick.`,
                            [message.senderJid]
                        );
                    }
                } else {
                    await this.moderationService.sendMessage(
                        appCtx,
                        `⚠️ *Warning (${warnRes.warningCount}/${warnRes.maxWarnings})*\n\n@${senderNum}, posting prohibited content is not allowed.`,
                        [message.senderJid]
                    );
                }
                break;
            }

            default:
                break;
        }
    }
}

module.exports = ApplicationPipeline;
