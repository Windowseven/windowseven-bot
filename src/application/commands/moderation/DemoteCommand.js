const CommandHandler = require('../CommandHandler');

class DemoteCommand extends CommandHandler {
    constructor() {
        super({
            name: 'demote',
            aliases: ['unadmin'],
            description: 'Demotes a group admin to regular member',
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
                '❌ Please mention the user or reply to their message to demote!'
            );
            return { success: false, error: 'No target specified' };
        }

        const res = await moderationService.demoteParticipant(appCtx, targetJid);
        if (!res.success) {
            await moderationService.sendMessage(appCtx, `❌ Error: ${res.error || 'Failed to demote user!'}`);
            return res;
        }

        const targetNum = targetJid.split('@')[0];
        const issuerNum = actor.senderJid.split('@')[0];

        const text = `*『 GROUP DEMOTION 』*\n\n` +
            `👥 *Demoted User:* @${targetNum}\n` +
            `👑 *Demoted By:* @${issuerNum}\n\n` +
            `📅 *Date:* ${new Date().toLocaleString()}`;

        await moderationService.sendMessage(appCtx, text, [targetJid, actor.senderJid]);
        return { success: true };
    }
}

module.exports = DemoteCommand;
