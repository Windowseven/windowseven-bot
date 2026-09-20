const CommandHandler = require('../CommandHandler');

class WarningsCommand extends CommandHandler {
    constructor() {
        super({
            name: 'warnings',
            aliases: ['warns', 'checkwarn'],
            description: 'Checks warning count for a user in the group',
            category: 'READ',
            requireGroup: true,
            requireSenderAdmin: false,
            requireBotAdmin: false,
        });
    }

    async execute(appCtx, { warningService, moderationService }) {
        const { message, actor, group, tenantId } = appCtx;

        const explicitTarget = message.mentionedJids[0] || message.quotedSender;
        const targetJid = explicitTarget || actor.senderJid;

        // Regular members can check their own warnings.
        // Inspecting another member's warnings requires sender admin privileges.
        const isSelf = !explicitTarget || targetJid === actor.senderJid;
        if (!isSelf && !actor.isSenderAdmin) {
            await moderationService.sendMessage(
                appCtx,
                '❌ Error: Only group admins can check warnings for other members!'
            );
            return { success: false, error: 'Unauthorized: Admin required to inspect other members' };
        }

        const res = await warningService.getWarnings({
            tenantId,
            groupId: group.id,
            subjectJid: targetJid,
        });

        const targetUserNum = targetJid.split('@')[0];
        const text = `User @${targetUserNum} has ${res.count} warning(s).`;
        await moderationService.sendMessage(appCtx, text, [targetJid]);

        return { success: true, count: res.count };
    }
}

module.exports = WarningsCommand;
