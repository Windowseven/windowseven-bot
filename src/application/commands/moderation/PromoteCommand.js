const CommandHandler = require('../CommandHandler');

class PromoteCommand extends CommandHandler {
    constructor() {
        super({
            name: 'promote',
            aliases: ['admin'],
            description: 'Promotes a group member to admin',
            category: 'ADMIN_ACTION',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: true,
        });
    }

    async execute(appCtx, { moderationService }) {
        const { message, actor } = appCtx;

        const targetJid = message.mentionedJids[0] || message.quotedSender;
        if (!targetJid) {
            await moderationService.sendMessage(
                appCtx,
                '❌ Please mention the user or reply to their message to promote!'
            );
            return { success: false, error: 'No target specified' };
        }

        const res = await moderationService.promoteParticipant(appCtx, targetJid);
        if (!res.success) {
            await moderationService.sendMessage(appCtx, `❌ Error: ${res.error || 'Failed to promote user!'}`);
            return res;
        }

        const targetNum = targetJid.split('@')[0];
        const issuerNum = actor.senderJid.split('@')[0];

        const text = `*『 GROUP PROMOTION 』*\n\n` +
            `👥 *Promoted User:* @${targetNum}\n` +
            `👑 *Promoted By:* @${issuerNum}\n\n` +
            `📅 *Date:* ${new Date().toLocaleString()}`;

        await moderationService.sendMessage(appCtx, text, [targetJid, actor.senderJid]);
        return { success: true };
    }
}

module.exports = PromoteCommand;
