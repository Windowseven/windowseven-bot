const PolicyDecision = require('../../domain/models/PolicyDecision');

class AntiLinkPolicy {
    /**
     * Regex matching HTTP/HTTPS URLs, www., and common domain patterns.
     */
    static URL_REGEX = /(https?:\/\/)?([a-z0-9-]+\.)+[a-z]{2,}(\/[^\s]*)?/i;

    /**
     * Evaluates a message for anti-link policy violation.
     * @param {object} params
     * @param {import('../../domain/models/NormalizedMessage')} params.message
     * @param {object|null} params.groupPolicy
     * @param {object} params.actor - { isSenderAdmin }
     * @returns {PolicyDecision}
     */
    evaluate({ message, groupPolicy, actor }) {
        if (!groupPolicy || !groupPolicy.antilink_enabled) {
            return PolicyDecision.allow('AntiLinkPolicy');
        }

        // WhatsApp group admins are exempt from anti-link penalties
        if (actor && actor.isSenderAdmin) {
            return PolicyDecision.allow('AntiLinkPolicy');
        }

        const text = message.text || '';
        if (!text) {
            return PolicyDecision.allow('AntiLinkPolicy');
        }

        if (AntiLinkPolicy.URL_REGEX.test(text)) {
            const rawAction = (groupPolicy.antilink_action || 'delete').toLowerCase();
            let action = 'DELETE';
            if (rawAction === 'kick') action = 'KICK';
            else if (rawAction === 'warn') action = 'WARN';

            return new PolicyDecision({
                action,
                policyName: 'AntiLinkPolicy',
                reason: 'Message contains prohibited link/URL',
                metadata: {
                    senderJid: message.senderJid,
                    configuredAction: rawAction,
                },
            });
        }

        return PolicyDecision.allow('AntiLinkPolicy');
    }
}

module.exports = AntiLinkPolicy;
