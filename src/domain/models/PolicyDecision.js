class PolicyDecision {
    /**
     * @param {object} params
     * @param {'ALLOW'|'DELETE'|'WARN'|'KICK'|'NO_ACTION'} params.action
     * @param {string} params.policyName
     * @param {string} [params.reason]
     * @param {object} [params.metadata]
     */
    constructor({
        action = 'ALLOW',
        policyName,
        reason = null,
        metadata = {},
    }) {
        const validActions = ['ALLOW', 'DELETE', 'WARN', 'KICK', 'NO_ACTION'];
        if (!validActions.includes(action)) {
            throw new Error(`Invalid PolicyDecision action: ${action}`);
        }
        this.action = action;
        this.policyName = policyName || 'UnknownPolicy';
        this.reason = reason;
        this.metadata = Object.freeze({ ...metadata });
        Object.freeze(this);
    }

    static allow(policyName = 'Default') {
        return new PolicyDecision({ action: 'ALLOW', policyName });
    }

    static delete(policyName, reason = null, metadata = {}) {
        return new PolicyDecision({ action: 'DELETE', policyName, reason, metadata });
    }

    static warn(policyName, reason = null, metadata = {}) {
        return new PolicyDecision({ action: 'WARN', policyName, reason, metadata });
    }

    static kick(policyName, reason = null, metadata = {}) {
        return new PolicyDecision({ action: 'KICK', policyName, reason, metadata });
    }

    static noAction(policyName, reason = null) {
        return new PolicyDecision({ action: 'NO_ACTION', policyName, reason });
    }
}

module.exports = PolicyDecision;
