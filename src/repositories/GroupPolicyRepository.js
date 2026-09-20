class GroupPolicyRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async upsertForTenant(tenantId, groupId, policyData = {}) {
        if (!tenantId || !groupId) {
            throw new Error('tenantId and groupId are required');
        }

        const {
            antilinkEnabled = false,
            antilinkAction = 'delete',
            antibadwordEnabled = false,
            antibadwordAction = 'delete',
            maxWarnings = 3,
            warningAction = 'warn',
            welcomeEnabled = false,
            welcomeMessage = null,
            goodbyeEnabled = false,
            goodbyeMessage = null,
            chatbotEnabled = false,
            settings = {},
        } = policyData;

        const validActions = ['delete', 'warn', 'kick'];
        if (!validActions.includes(antilinkAction)) {
            throw new Error(`Invalid antilinkAction: ${antilinkAction}`);
        }
        if (!validActions.includes(antibadwordAction)) {
            throw new Error(`Invalid antibadwordAction: ${antibadwordAction}`);
        }
        const validWarningActions = ['warn', 'kick'];
        if (!validWarningActions.includes(warningAction)) {
            throw new Error(`Invalid warningAction: ${warningAction}`);
        }
        if (typeof maxWarnings !== 'number' || maxWarnings <= 0) {
            throw new Error('maxWarnings must be a positive integer');
        }

        const sql = `
            INSERT INTO group_policies (
                tenant_id, group_id,
                antilink_enabled, antilink_action,
                antibadword_enabled, antibadword_action,
                max_warnings, warning_action,
                welcome_enabled, welcome_message,
                goodbye_enabled, goodbye_message,
                chatbot_enabled, settings
            )
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
            ON CONFLICT (group_id)
            DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                antilink_enabled = EXCLUDED.antilink_enabled,
                antilink_action = EXCLUDED.antilink_action,
                antibadword_enabled = EXCLUDED.antibadword_enabled,
                antibadword_action = EXCLUDED.antibadword_action,
                max_warnings = EXCLUDED.max_warnings,
                warning_action = EXCLUDED.warning_action,
                welcome_enabled = EXCLUDED.welcome_enabled,
                welcome_message = EXCLUDED.welcome_message,
                goodbye_enabled = EXCLUDED.goodbye_enabled,
                goodbye_message = EXCLUDED.goodbye_message,
                chatbot_enabled = EXCLUDED.chatbot_enabled,
                settings = EXCLUDED.settings,
                updated_at = NOW()
            RETURNING
                id, tenant_id, group_id,
                antilink_enabled, antilink_action,
                antibadword_enabled, antibadword_action,
                max_warnings, warning_action,
                welcome_enabled, welcome_message,
                goodbye_enabled, goodbye_message,
                chatbot_enabled, settings,
                created_at, updated_at;
        `;

        const params = [
            tenantId,
            groupId,
            Boolean(antilinkEnabled),
            antilinkAction,
            Boolean(antibadwordEnabled),
            antibadwordAction,
            maxWarnings,
            warningAction,
            Boolean(welcomeEnabled),
            welcomeMessage,
            Boolean(goodbyeEnabled),
            goodbyeMessage,
            Boolean(chatbotEnabled),
            JSON.stringify(settings),
        ];

        const { rows } = await this.pool.query(sql, params);
        return rows[0];
    }

    async findByGroupIdForTenant(groupId, tenantId) {
        if (!groupId || !tenantId) return null;
        const sql = `
            SELECT
                id, tenant_id, group_id,
                antilink_enabled, antilink_action,
                antibadword_enabled, antibadword_action,
                max_warnings, warning_action,
                welcome_enabled, welcome_message,
                goodbye_enabled, goodbye_message,
                chatbot_enabled, settings,
                created_at, updated_at
            FROM group_policies
            WHERE group_id = $1 AND tenant_id = $2;
        `;
        const { rows } = await this.pool.query(sql, [groupId, tenantId]);
        return rows[0] || null;
    }

    async deleteForTenant(groupId, tenantId) {
        if (!groupId || !tenantId) return null;
        const sql = `
            DELETE FROM group_policies
            WHERE group_id = $1 AND tenant_id = $2
            RETURNING id;
        `;
        const { rows } = await this.pool.query(sql, [groupId, tenantId]);
        return rows[0] || null;
    }
}

module.exports = GroupPolicyRepository;
