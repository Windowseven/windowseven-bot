const CommandHandler = require('../CommandHandler');

class MuteCommand extends CommandHandler {
    constructor() {
        super({
            name: 'mute',
            aliases: ['silence'],
            description: 'Mutes the group (announcement mode: only admins can message)',
            category: 'MODERATE',
            requireGroup: true,
            requireSenderAdmin: true,
            requireBotAdmin: true,
        });
    }

    async execute(appCtx, { moderationService }) {
        const { message } = appCtx;

        let duration = undefined;
        if (message.args.length > 0) {
            const rawArg = message.args[0];
            const parsed = parseInt(rawArg, 10);
            if (isNaN(parsed) || parsed <= 0) {
                await moderationService.sendMessage(
                    appCtx,
                    '❌ Error: Invalid duration. Please specify a positive number of minutes (e.g. .mute 10)'
                );
                return { success: false, error: 'Invalid duration' };
            }
            if (parsed > 10080) {
                await moderationService.sendMessage(
                    appCtx,
                    '❌ Error: Duration exceeds maximum limit of 10080 minutes (7 days).'
                );
                return { success: false, error: 'Duration exceeds maximum limit' };
            }
            duration = parsed;
        }

        const res = await moderationService.muteGroup(appCtx, duration);
        if (!res.success) {
            await moderationService.sendMessage(appCtx, `❌ Error: ${res.error || 'Failed to mute group'}`);
            return res;
        }

        if (duration) {
            await moderationService.sendMessage(
                appCtx,
                `*_The group has been muted for ${duration} minute(s)._*`
            );
        } else {
            await moderationService.sendMessage(appCtx, '*_The group has been muted._*');
        }

        return { success: true };
    }
}

module.exports = MuteCommand;
