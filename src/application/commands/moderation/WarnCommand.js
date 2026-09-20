const CommandHandler = require('../CommandHandler');

class WarnCommand extends CommandHandler {
    constructor() {
        super({
            name: 'warn',
            aliases: ['warning'],
            description: 'Issues a formal warning to a group member',
            category: 'MODERATE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: true,
        });
    }

    async execute(appCtx, { warningService, moderationService }) {
        const { message, actor, group, tenantId } = appCtx;

        // Resolve target user
        let targetJid = message.mentionedJids[0] || message.quotedSender;
        if (!targetJid) {
            await moderationService.sendMessage(
                appCtx,
                '❌ Error: Please mention the user or reply to their message to warn!'
            );
            return { success: false, error: 'No target specified' };
        }

        // Cannot warn the bot
        if (targetJid === message.botJid) {
            await moderationService.sendMessage(appCtx, '❌ Error: Cannot warn the bot!');
            return { success: false, error: 'Target is bot' };
        }

        // Extract optional reason
        const reason = message.rawArgs ? message.rawArgs.replace(/@\S+/g, '').trim() || null : null;

        // Issue warning through domain service
        const res = await warningService.issueWarning({
            tenantId,
            groupId: group.id,
            subjectJid: targetJid,
            issuedBy: actor.senderJid,
            reason,
        });

        const targetUserNum = targetJid.split('@')[0];
        const issuerNum = actor.senderJid.split('@')[0];

        if (res.shouldEscalate && res.escalationAction === 'kick') {
            // Auto-kick participant
            await moderationService.kickParticipant(appCtx, targetJid);
            const kickText = `*『 AUTO-KICK 』*\n\n@${targetUserNum} has been removed from the group after receiving ${res.maxWarnings} warnings! ⚠️`;
            await moderationService.sendMessage(appCtx, kickText, [targetJid]);
            return { success: true, message: 'User kicked on warning threshold' };
        }

        const warnText = `*『 WARNING ALERT 』*\n\n` +
            `👤 *Warned User:* @${targetUserNum}\n` +
            `⚠️ *Warning Count:* ${res.warningCount}/${res.maxWarnings}\n` +
            `👑 *Warned By:* @${issuerNum}\n` +
            (reason ? `📝 *Reason:* ${reason}\n` : '') +
            `📅 *Date:* ${new Date().toLocaleString()}`;

        await moderationService.sendMessage(appCtx, warnText, [targetJid, actor.senderJid]);
        return { success: true, message: 'Warning issued' };
    }
}

module.exports = WarnCommand;
