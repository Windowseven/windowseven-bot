const ApiError = require('../errors/ApiError');
const { validateString, validateEmail, validateEnum } = require('../http/validation');

/**
 * Windowseven MD Tenant Service
 * Manages tenant creation, membership lifecycle, role hierarchy, and sole owner protection.
 */
class TenantService {
    /**
     * @param {object} params
     * @param {import('pg').Pool} params.pool
     * @param {import('../../repositories/TenantRepository')} params.tenantRepo
     * @param {import('../../repositories/TenantMembershipRepository')} params.tenantMembershipRepo
     * @param {import('../../repositories/UserRepository')} params.userRepo
     * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
     */
    constructor({ pool, tenantRepo, tenantMembershipRepo, userRepo, auditLogRepo = null }) {
        if (!pool || !tenantRepo || !tenantMembershipRepo || !userRepo) {
            throw new Error('[TenantService] pool, tenantRepo, tenantMembershipRepo, and userRepo are required');
        }
        this.pool = pool;
        this.tenantRepo = tenantRepo;
        this.tenantMembershipRepo = tenantMembershipRepo;
        this.userRepo = userRepo;
        this.auditLogRepo = auditLogRepo;
    }

    /**
     * Creates a new tenant and assigns the creating user as OWNER atomically.
     */
    async createTenant({ name, userId, ipAddress = null, userAgent = null }) {
        const validatedName = validateString(name, 'Tenant name', { min: 2, max: 255 });
        if (!userId) {
            throw ApiError.unauthorized('Authenticated user required to create a tenant', 'AUTH_REQUIRED');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Create tenant entity
            const tenant = await this.tenantRepo.create({ name: validatedName }, client);

            // 2. Assign creator as OWNER
            const membership = await this.tenantMembershipRepo.create({
                tenantId: tenant.id,
                userId,
                role: 'OWNER',
            }, client);

            // 3. Audit log
            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId: tenant.id,
                    actorUserId: userId,
                    action: 'TENANT_CREATED',
                    resourceType: 'TENANT',
                    resourceId: tenant.id,
                    metadata: { name: validatedName, role: 'OWNER' },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return {
                tenant: {
                    id: tenant.id,
                    name: tenant.name,
                    createdAt: tenant.created_at,
                    updatedAt: tenant.updated_at,
                },
                membership: {
                    id: membership.id,
                    role: membership.role,
                    createdAt: membership.created_at,
                },
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Retrieves details for a specific tenant.
     */
    async getTenant(tenantId) {
        const tenant = await this.tenantRepo.findById(tenantId);
        if (!tenant) {
            throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
        }
        return {
            id: tenant.id,
            name: tenant.name,
            createdAt: tenant.created_at,
            updatedAt: tenant.updated_at,
        };
    }

    /**
     * Lists all tenants that a user is a member of.
     */
    async listTenantsForUser(userId) {
        if (!userId) return [];
        const memberships = await this.tenantMembershipRepo.listTenantsForUser(userId);
        return memberships.map((m) => ({
            id: m.tenant_id,
            name: m.tenant_name,
            role: m.role,
            joinedAt: m.created_at,
        }));
    }

    /**
     * Lists all members of a tenant.
     */
    async listMembers(tenantId) {
        const members = await this.tenantMembershipRepo.listUsersForTenant(tenantId);
        return members.map((m) => ({
            id: m.id,
            userId: m.user_id,
            email: m.email,
            role: m.role,
            joinedAt: m.created_at,
            updatedAt: m.updated_at,
        }));
    }

    /**
     * Adds a new member to the tenant by email address.
     */
    async addMember({ tenantId, targetEmail, role = 'MEMBER', actorUserId, actorRole, ipAddress = null, userAgent = null }) {
        const normalizedEmail = validateEmail(targetEmail, 'email');
        const validatedRole = validateEnum(role, 'role', ['OWNER', 'ADMIN', 'MEMBER']);

        // Only an OWNER can assign the OWNER role
        if (validatedRole === 'OWNER' && actorRole !== 'OWNER') {
            throw ApiError.forbidden('Only tenant owners can assign the OWNER role', 'FORBIDDEN');
        }

        // Verify target user exists in system
        const targetUser = await this.userRepo.findByEmail(normalizedEmail);
        if (!targetUser) {
            throw ApiError.notFound(
                `User with email '${normalizedEmail}' does not exist`,
                'USER_NOT_FOUND'
            );
        }

        // Verify target user is not already a member
        const existingMembership = await this.tenantMembershipRepo.findByTenantAndUser(tenantId, targetUser.id);
        if (existingMembership) {
            throw ApiError.conflict(
                'User is already a member of this tenant',
                'MEMBERSHIP_ALREADY_EXISTS'
            );
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const membership = await this.tenantMembershipRepo.create({
                tenantId,
                userId: targetUser.id,
                role: validatedRole,
            }, client);

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId,
                    actorUserId,
                    action: 'MEMBER_ADDED',
                    resourceType: 'TENANT_MEMBERSHIP',
                    resourceId: membership.id,
                    metadata: { targetUserId: targetUser.id, email: normalizedEmail, role: validatedRole },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return {
                id: membership.id,
                tenantId: membership.tenant_id,
                userId: membership.user_id,
                email: targetUser.email,
                role: membership.role,
                createdAt: membership.created_at,
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            // Catch unique constraint violation race condition
            if (err.code === '23505') {
                throw ApiError.conflict('User is already a member of this tenant', 'MEMBERSHIP_ALREADY_EXISTS');
            }
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Updates a member's role with serialized row-level sole owner protection.
     */
    async updateMemberRole({ tenantId, targetUserId, newRole, actorUserId, actorRole, ipAddress = null, userAgent = null }) {
        const validatedRole = validateEnum(newRole, 'newRole', ['OWNER', 'ADMIN', 'MEMBER']);

        if (actorRole !== 'OWNER') {
            throw ApiError.forbidden('Only tenant owners can modify member roles', 'FORBIDDEN');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Serialize role updates across the tenant by locking parent tenant row
            const lockCheck = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE;', [tenantId]);
            if (lockCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
            }

            const targetMembership = await this.tenantMembershipRepo.findByTenantAndUser(tenantId, targetUserId, client);
            if (!targetMembership) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Member not found in this tenant', 'MEMBER_NOT_FOUND');
            }

            // Invariant: If target is currently an OWNER and being demoted, ensure at least one other OWNER exists
            if (targetMembership.role === 'OWNER' && validatedRole !== 'OWNER') {
                const ownerCount = await this.tenantMembershipRepo.countOwnersForTenant(tenantId, client);
                if (ownerCount <= 1) {
                    await client.query('ROLLBACK');
                    throw ApiError.badRequest(
                        'Cannot demote the sole OWNER of a tenant. Promote another member to OWNER first.',
                        'SOLE_OWNER_REQUIRED'
                    );
                }
            }

            const updated = await this.tenantMembershipRepo.updateRole(tenantId, targetUserId, validatedRole, client);

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId,
                    actorUserId,
                    action: 'MEMBER_ROLE_UPDATED',
                    resourceType: 'TENANT_MEMBERSHIP',
                    resourceId: updated.id,
                    metadata: { targetUserId, oldRole: targetMembership.role, newRole: validatedRole },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return {
                id: updated.id,
                tenantId: updated.tenant_id,
                userId: updated.user_id,
                role: updated.role,
                updatedAt: updated.updated_at,
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Removes a member from the tenant with serialized row-level sole owner protection.
     */
    async removeMember({ tenantId, targetUserId, actorUserId, actorRole, ipAddress = null, userAgent = null }) {
        // Members may remove themselves (leave), otherwise only OWNER can remove members
        if (actorRole !== 'OWNER' && actorUserId !== targetUserId) {
            throw ApiError.forbidden('Only tenant owners can remove other members', 'FORBIDDEN');
        }

        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // Lock parent tenant row to serialize membership deletions
            const lockCheck = await client.query('SELECT id FROM tenants WHERE id = $1 FOR UPDATE;', [tenantId]);
            if (lockCheck.rows.length === 0) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Tenant not found', 'TENANT_NOT_FOUND');
            }

            const targetMembership = await this.tenantMembershipRepo.findByTenantAndUser(tenantId, targetUserId, client);
            if (!targetMembership) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Member not found in this tenant', 'MEMBER_NOT_FOUND');
            }

            // Invariant: Cannot remove the sole OWNER
            if (targetMembership.role === 'OWNER') {
                const ownerCount = await this.tenantMembershipRepo.countOwnersForTenant(tenantId, client);
                if (ownerCount <= 1) {
                    await client.query('ROLLBACK');
                    throw ApiError.badRequest(
                        'Cannot remove the sole OWNER of a tenant. Transfer ownership or assign another OWNER before leaving.',
                        'SOLE_OWNER_REQUIRED'
                    );
                }
            }

            await this.tenantMembershipRepo.delete(tenantId, targetUserId, client);

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId,
                    actorUserId,
                    action: 'MEMBER_REMOVED',
                    resourceType: 'TENANT_MEMBERSHIP',
                    resourceId: targetMembership.id,
                    metadata: { targetUserId, role: targetMembership.role },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return { success: true, message: 'Member removed successfully' };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }
}

module.exports = TenantService;
