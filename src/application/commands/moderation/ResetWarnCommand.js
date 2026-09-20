const CommandHandler = require('../CommandHandler');

class ResetWarnCommand extends CommandHandler {
    constructor() {
        super({
            name: 'resetwarn',
            aliases: ['clearwarn', 'resetwarns', 'clearwarns'],
            description: 'Clears warnings for a user in the group',
            category: 'MODERATE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: false,
        });
    }

    async execute(appCtx, { warningService, moderationService }) {
        const { message, group, tenantId } = appCtx;

        const targetJid = message.mentionedJids[0] || message.quotedSender;
        if (!targetJid) {
            await moderationService.sendMessage(
                appCtx,
                '❌ Please mention the user or reply to their message to reset warnings.'
            );
            return { success: false, error: 'No target specified' };
        }

        const res = await warningService.resetWarnings({
            tenantId,
            groupId: group.id,
            subjectJid: targetJid,
        });

        const targetUserNum = targetJid.split('@')[0];
        const text = `✅ Warnings reset for @${targetUserNum}. Cleared ${res.clearedCount} warning(s).`;
        await moderationService.sendMessage(appCtx, text, [targetJid]);

        return { success: true, clearedCount: res.clearedCount };
    }
}

module.exports = ResetWarnCommand;
