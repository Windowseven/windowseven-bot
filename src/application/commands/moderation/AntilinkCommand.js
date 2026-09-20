const CommandHandler = require('../CommandHandler');

class AntilinkCommand extends CommandHandler {
    constructor() {
        super({
            name: 'antilink',
            aliases: [],
            description: 'Configures group anti-link protection',
            category: 'CONFIGURE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: false,
        });
    }

    async execute(appCtx, { policyRepo, moderationService }) {
        const { message, group, tenantId } = appCtx;
        const args = message.args;
        const action = args[0] ? args[0].toLowerCase() : '';

        if (!action) {
            const usage = '```ANTILINK SETUP\n\n.antilink on\n.antilink set delete | kick | warn\n.antilink off\n.antilink get```';
            await moderationService.sendMessage(appCtx, usage);
            return { success: true };
        }

        const existingPolicy = await policyRepo.findByGroupIdForTenant(group.id, tenantId) || {};

        switch (action) {
            case 'on': {
                if (existingPolicy.antilink_enabled) {
                    await moderationService.sendMessage(appCtx, '*_Antilink is already ON_*');
                    return { success: true };
                }
                await policyRepo.upsertForTenant(tenantId, group.id, {
                    ...existingPolicy,
                    antilinkEnabled: true,
                    antilinkAction: existingPolicy.antilink_action || 'delete',
                });
                await moderationService.sendMessage(appCtx, '*_Antilink has been turned ON_*');
                return { success: true };
            }

            case 'off': {
                await policyRepo.upsertForTenant(tenantId, group.id, {
                    ...existingPolicy,
                    antilinkEnabled: false,
                });
                await moderationService.sendMessage(appCtx, '*_Antilink has been turned OFF_*');
                return { success: true };
            }

            case 'set': {
                const newAction = args[1] ? args[1].toLowerCase() : '';
                if (!['delete', 'kick', 'warn'].includes(newAction)) {
                    await moderationService.sendMessage(
                        appCtx,
                        '*_Invalid action. Choose: delete, kick, or warn._*'
                    );
                    return { success: false, error: 'Invalid action' };
                }
                await policyRepo.upsertForTenant(tenantId, group.id, {
                    ...existingPolicy,
                    antilinkAction: newAction,
                });
                await moderationService.sendMessage(appCtx, `*_Antilink action set to ${newAction}_*`);
                return { success: true };
            }

            case 'get': {
                const isEnabled = Boolean(existingPolicy.antilink_enabled);
                const currentAction = existingPolicy.antilink_action || 'delete';
                const statusText = `*_Antilink Configuration:_*\nStatus: ${isEnabled ? 'ON' : 'OFF'}\nAction: ${currentAction}`;
                await moderationService.sendMessage(appCtx, statusText);
                return { success: true };
            }

            default:
                await moderationService.sendMessage(appCtx, '*_Use .antilink for usage._*');
                return { success: false, error: 'Unknown subcommand' };
        }
    }
}

module.exports = AntilinkCommand;
