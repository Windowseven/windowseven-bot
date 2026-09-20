const ApiError = require('../errors/ApiError');
const PolicyValidator = require('../policies/PolicyValidator');

class PolicyService {
    constructor({
        pool,
        groupRepo,
        policyRepo,
        auditLogRepo = null,
        eventPublisher = null,
    }) {
        if (!pool || !groupRepo || !policyRepo) {
            throw new Error('[PolicyService] pool, groupRepo, and policyRepo are required');
        }
        this.pool = pool;
        this.groupRepo = groupRepo;
        this.policyRepo = policyRepo;
        this.auditLogRepo = auditLogRepo;
        this.eventPublisher = eventPublisher;
    }

    /**
     * Retrieves policy configuration for a group.
     */
    async getPolicy(tenantId, groupId) {
        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group) {
            throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
        }

        const policy = await this.policyRepo.findByGroupIdForTenant(groupId, tenantId);
        if (!policy) {
            // Return default policy structure
            return {
                tenant_id: tenantId,
                group_id: groupId,
                antilink_enabled: false,
                antilink_action: 'delete',
                antibadword_enabled: false,
                antibadword_action: 'delete',
                max_warnings: 3,
                warning_action: 'kick',
                welcome_enabled: false,
                welcome_message: null,
                goodbye_enabled: false,
                goodbye_message: null,
                chatbot_enabled: false,
                settings: {},
                is_default: true,
            };
        }

        return policy;
    }

    /**
     * Upserts policy configuration for a managed group.
     */
    async updatePolicy(tenantId, groupId, rawPayload, actorContext = {}) {
        const group = await this.groupRepo.findByIdForTenant(groupId, tenantId);
        if (!group) {
            throw ApiError.notFound('Group not found', 'RESOURCE_NOT_FOUND');
        }

        // Managed Group Gate
        if (group.status !== 'MANAGED') {
            throw ApiError.badRequest(
                `Cannot configure policies on group "${group.name || groupId}": group is ${group.status}. Status must be MANAGED.`,
                'GROUP_NOT_MANAGED'
            );
        }

        // Strict validation: rejects unknown keys with 422
        const validated = PolicyValidator.validate(rawPayload);

        // Atomic upsert
        const policy = await this.policyRepo.upsertForTenant(tenantId, groupId, validated);

        // Audit log
        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                tenantId,
                actorUserId: actorContext.actorUserId || null,
                action: 'GROUP_POLICY_UPDATED',
                resourceType: 'group_policy',
                resourceId: policy.id,
                metadata: {
                    groupId,
                    antilinkEnabled: policy.antilink_enabled,
                    antilinkAction: policy.antilink_action,
                    antibadwordEnabled: policy.antibadword_enabled,
                    maxWarnings: policy.max_warnings,
                },
                ipAddress: actorContext.ipAddress || null,
                userAgent: actorContext.userAgent || null,
            }).catch(() => {});
        }

        // Realtime SSE broadcast
        if (this.eventPublisher) {
            this.eventPublisher.publish(tenantId, 'group.policy_updated', {
                groupId,
                policyId: policy.id,
                antilinkEnabled: policy.antilink_enabled,
                antilinkAction: policy.antilink_action,
            });
        }

        return policy;
    }
}

module.exports = PolicyService;
