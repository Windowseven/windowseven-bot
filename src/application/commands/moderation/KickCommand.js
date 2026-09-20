const CommandHandler = require('../CommandHandler');

class KickCommand extends CommandHandler {
    constructor() {
        super({
            name: 'kick',
            aliases: ['remove'],
            description: 'Removes a participant from the group',
            category: 'MODERATE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: true,
        });
    }

    async execute(appCtx, { moderationService }) {
        const { message } = appCtx;

        const targetJid = message.mentionedJids[0] || message.quotedSender;
        if (!targetJid) {
            await moderationService.sendMessage(
                appCtx,
                '❌ Please mention the user or reply to their message to kick!'
            );
            return { success: false, error: 'No target specified' };
        }

        if (targetJid === message.botJid) {
            await moderationService.sendMessage(appCtx, "I can't kick myself🤖");
            return { success: false, error: 'Target is bot' };
        }

        const res = await moderationService.kickParticipant(appCtx, targetJid);
        if (!res.success) {
            await moderationService.sendMessage(appCtx, `❌ Error: ${res.error || 'Failed to kick user!'}`);
            return res;
        }

        const targetNum = targetJid.split('@')[0];
        await moderationService.sendMessage(
            appCtx,
            `@${targetNum} has been kicked successfully!`,
            [targetJid]
        );

        return { success: true };
    }
}

module.exports = KickCommand;
