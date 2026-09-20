const PolicyDecision = require('../../domain/models/PolicyDecision');

class AntiBadwordPolicy {
    static DEFAULT_BADWORDS = new Set([
        'fuck', 'fucker', 'fucking', 'bitch', 'asshole', 'bastard', 'dick', 'cunt', 'pussy',
        'motherfucker', 'whore', 'slut', 'idiot', 'nigga', 'nigger', 'chutiya', 'madarchod',
        'bhosdike', 'behenchod', 'gandu', 'randi', 'lauda', 'lodu'
    ]);

    /**
     * Evaluates a message for bad words.
     * @param {object} params
     * @param {import('../../domain/models/NormalizedMessage')} params.message
     * @param {object|null} params.groupPolicy
     * @param {object} params.actor - { isSenderAdmin }
     * @returns {PolicyDecision}
     */
    evaluate({ message, groupPolicy, actor }) {
        if (!groupPolicy || !groupPolicy.antibadword_enabled) {
            return PolicyDecision.allow('AntiBadwordPolicy');
        }

        // WhatsApp group admins are exempt
        if (actor && actor.isSenderAdmin) {
            return PolicyDecision.allow('AntiBadwordPolicy');
        }

        const text = message.text || '';
        if (!text) {
            return PolicyDecision.allow('AntiBadwordPolicy');
        }

        const cleanMessage = text.toLowerCase()
            .replace(/[^\w\s]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        const words = cleanMessage.split(' ');
        const customList = Array.isArray(groupPolicy.settings?.badwords)
            ? new Set(groupPolicy.settings.badwords.map((w) => w.toLowerCase()))
            : null;

        let matchedWord = null;
        for (const word of words) {
            if (word.length < 2) continue;
            if (AntiBadwordPolicy.DEFAULT_BADWORDS.has(word) || (customList && customList.has(word))) {
                matchedWord = word;
                break;
            }
        }

        if (matchedWord) {
            const rawAction = (groupPolicy.antibadword_action || 'delete').toLowerCase();
            let action = 'DELETE';
            if (rawAction === 'kick') action = 'KICK';
            else if (rawAction === 'warn') action = 'WARN';

            return new PolicyDecision({
                action,
                policyName: 'AntiBadwordPolicy',
                reason: `Message contains prohibited word`,
                metadata: {
                    senderJid: message.senderJid,
                    matchedWord,
                    configuredAction: rawAction,
                },
            });
        }

        return PolicyDecision.allow('AntiBadwordPolicy');
    }
}

module.exports = AntiBadwordPolicy;
