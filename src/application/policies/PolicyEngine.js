const PolicyDecision = require('../../domain/models/PolicyDecision');
const AntiLinkPolicy = require('./AntiLinkPolicy');
const AntiBadwordPolicy = require('./AntiBadwordPolicy');

class PolicyEngine {
    constructor(policies = null) {
        this.policies = policies || [
            new AntiBadwordPolicy(),
            new AntiLinkPolicy(),
        ];

        this.severityMap = {
            KICK: 4,
            DELETE: 3,
            WARN: 2,
            NO_ACTION: 1,
            ALLOW: 0,
        };
    }

    /**
     * Evaluates all registered policies against a message and resolves decisions by deterministic precedence.
     *
     * @param {object} params
     * @param {import('../../domain/models/NormalizedMessage')} params.message
     * @param {object|null} params.groupPolicy
     * @param {object} params.actor - { isSenderAdmin }
     * @returns {PolicyDecision}
     */
    evaluate({ message, groupPolicy, actor }) {
        if (!groupPolicy) {
            return PolicyDecision.allow('PolicyEngine:NoPolicy');
        }

        let highestDecision = PolicyDecision.allow('PolicyEngine:Default');
        let highestSeverity = -1;

        for (const policy of this.policies) {
            try {
                const decision = policy.evaluate({ message, groupPolicy, actor });
                const severity = this.severityMap[decision.action] ?? 0;

                if (severity > highestSeverity) {
                    highestSeverity = severity;
                    highestDecision = decision;
                }
            } catch (err) {
                console.error(`[PolicyEngine] Error in ${policy.constructor.name}:`, err.message);
            }
        }

        return highestDecision;
    }
}

module.exports = PolicyEngine;
