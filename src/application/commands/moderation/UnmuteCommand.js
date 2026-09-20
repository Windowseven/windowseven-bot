const CommandHandler = require('../CommandHandler');

class UnmuteCommand extends CommandHandler {
    constructor() {
        super({
            name: 'unmute',
            aliases: [],
            description: 'Unmutes the group (all members can message)',
            category: 'MODERATE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: true,
        });
    }

    async execute(appCtx, { moderationService }) {
        const res = await moderationService.unmuteGroup(appCtx);
        if (!res.success) {
            await moderationService.sendMessage(appCtx, `❌ Error: ${res.error || 'Failed to unmute group'}`);
            return res;
        }

        await moderationService.sendMessage(appCtx, '*_The group has been unmuted._*');
        return { success: true };
    }
}

module.exports = UnmuteCommand;
