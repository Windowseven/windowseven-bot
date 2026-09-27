const crypto = require('node:crypto');
const AuthError = require('../errors/AuthError');

/**
 * Windowseven MD Authentication Service
 * Implements user registration, login, token rotation, reuse detection, logout, and identity queries.
 */
class AuthService {
    /**
     * @param {object} params
     * @param {import('../../repositories/UserRepository')} params.userRepo
     * @param {import('../../repositories/RefreshTokenRepository')} params.refreshTokenRepo
     * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
     * @param {import('./PasswordService')} params.passwordService
     * @param {import('./TokenService')} params.tokenService
     * @param {import('pg').Pool} params.pool
     * @param {import('../../repositories/TenantRepository')} [params.tenantRepo]
     * @param {import('../../repositories/TenantMembershipRepository')} [params.tenantMembershipRepo]
     * @param {import('../../repositories/PlatformRoleRepository')} [params.platformRoleRepo]
     */
    constructor({
        userRepo,
        refreshTokenRepo,
        auditLogRepo = null,
        passwordService,
        tokenService,
        pool,
        tenantRepo = null,
        tenantMembershipRepo = null,
        platformRoleRepo = null,
    }) {
        if (!userRepo || !refreshTokenRepo || !passwordService || !tokenService || !pool) {
            throw new Error('[AuthService] userRepo, refreshTokenRepo, passwordService, tokenService, and pool are required');
        }

        this.userRepo = userRepo;
        this.refreshTokenRepo = refreshTokenRepo;
        this.auditLogRepo = auditLogRepo;
        this.passwordService = passwordService;
        this.tokenService = tokenService;
        this.pool = pool;
        this.tenantRepo = tenantRepo;
        this.tenantMembershipRepo = tenantMembershipRepo;
        this.platformRoleRepo = platformRoleRepo;
    }

    /**
     * Tanzanian phone number validation & normalization.
     * Expected form: +255XXXXXXXXX (E.164 Tanzanian mobile).
     * Accepts:
     *   +2557XXXXXXXX, +2556XXXXXXXX (13 chars)
     *   2557XXXXXXXX, 2556XXXXXXXX   (12 digits) -> +255...
     *   07XXXXXXXX, 06XXXXXXXX       (10 digits) -> +255...
     * Rejects arbitrary invalid strings.
     *
     * @param {string} phone
     * @returns {string|null} Normalized E.164 phone or null if invalid
     */
    static normalizePhoneNumber(phone) {
        if (!phone || typeof phone !== 'string') return null;
        const cleaned = phone.trim().replace(/[\s\-()]/g, '');
        if (/^\+255[67]\d{8}$/.test(cleaned)) {
            return cleaned;
        }
        if (/^255[67]\d{8}$/.test(cleaned)) {
            return `+${cleaned}`;
        }
        if (/^0[67]\d{8}$/.test(cleaned)) {
            return `+255${cleaned.slice(1)}`;
        }
        return null;
    }

    /**
     * Helper to validate email syntax.
     */
    static isValidEmail(email) {
        if (!email || typeof email !== 'string') return false;
        const trimmed = email.trim();
        if (trimmed.length < 5 || trimmed.length > 255) return false;
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        return emailRegex.test(trimmed);
    }

    /**
     * Customer User registration with atomic provisioning:
     * User (CUSTOMER) + Tenant (Customer <safeId>) + OWNER Membership.
     * Single transaction, full rollback on any failure.
     *
     * @param {object} params
     * @param {string} params.email
     * @param {string} params.password
     * @param {string} [params.phoneNumber]
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ user: object, tenant?: object }>}
     */
    async register({ email, password, phoneNumber = null, ipAddress = null, userAgent = null }) {
        let cleanPhone = null;
        if (phoneNumber) {
            cleanPhone = AuthService.normalizePhoneNumber(phoneNumber);
            if (!cleanPhone) {
                throw new AuthError('A valid Tanzanian phone number (+255XXXXXXXXX) is required', 'VALIDATION_ERROR', 400);
            }
        }

        if (!email || typeof email !== 'string' || !AuthService.isValidEmail(email)) {
            throw new AuthError('A valid email address is required', 'VALIDATION_ERROR', 400);
        }

        const normalizedEmail = email.trim().toLowerCase();

        // 1. Password policy verification
        if (!password || typeof password !== 'string') {
            throw new AuthError('Password is required', 'VALIDATION_ERROR', 400);
        }
        const policy = this.passwordService.validatePolicy(password);
        if (!policy.valid) {
            throw new AuthError(policy.error || 'Password does not meet security requirements', 'WEAK_PASSWORD', 400);
        }

        // 2. Check for duplicate phone or email (case-insensitive)
        if (cleanPhone) {
            const existingPhone = await this.userRepo.findByPhoneNumber(cleanPhone);
            if (existingPhone) {
                throw new AuthError('An account with this phone number already exists', 'PHONE_ALREADY_EXISTS', 409);
            }
        }
        const existingEmail = await this.userRepo.findByEmail(normalizedEmail);
        if (existingEmail) {
            throw new AuthError('An account with this email address already exists', 'EMAIL_ALREADY_EXISTS', 409);
        }

        // 3. Hash password using Argon2id
        const passwordHash = await this.passwordService.hash(password);

        // 4. Transactional persistence
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const user = await this.userRepo.create({
                email: normalizedEmail,
                passwordHash,
                phoneNumber: cleanPhone,
            }, client);

            let tenant = null;
            let membership = null;
            if (this.tenantRepo && this.tenantMembershipRepo) {
                const safeId = user.id.replace(/-/g, '').slice(0, 8).toUpperCase();
                const tenantName = `Customer ${safeId}`;
                tenant = await this.tenantRepo.create({
                    name: tenantName,
                    status: 'ACTIVE',
                }, client);

                membership = await this.tenantMembershipRepo.create({
                    tenantId: tenant.id,
                    userId: user.id,
                    role: 'OWNER',
                }, client);
            }

            if (this.platformRoleRepo) {
                await this.platformRoleRepo.assignRole({
                    userId: user.id,
                    role: 'CUSTOMER',
                }, client);
            }

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    tenantId: tenant ? tenant.id : null,
                    actorUserId: user.id,
                    action: tenant ? 'CUSTOMER_REGISTERED' : 'USER_REGISTERED',
                    resourceType: 'USER',
                    resourceId: user.id,
                    metadata: {
                        email: normalizedEmail,
                        phoneNumber: cleanPhone,
                        tenantId: tenant ? tenant.id : null,
                    },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    phoneNumber: user.phone_number,
                    role: 'CUSTOMER',
                    createdAt: user.created_at,
                },
                tenant: tenant ? {
                    id: tenant.id,
                    name: tenant.name,
                    status: tenant.status,
                } : null,
            };
        } catch (err) {
            await client.query('ROLLBACK');
            // Check for unique constraint violation race condition
            if (err.code === '23505') {
                if (err.detail && err.detail.includes('phone_number')) {
                    throw new AuthError('An account with this phone number already exists', 'PHONE_ALREADY_EXISTS', 409);
                }
                throw new AuthError('An account with this email address already exists', 'EMAIL_ALREADY_EXISTS', 409);
            }
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * User login with constant-time password check, JWT generation, and opaque refresh token issuance.
     * Strictly requires EMAIL and PASSWORD. Phone number login is PROHIBITED.
     *
     * @param {object} params
     * @param {string} [params.email]
     * @param {string} [params.phoneNumber]
     * @param {string} [params.identifier]
     * @param {string} params.password
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    async login({ email, phoneNumber, identifier, password, ipAddress = null, userAgent = null }) {
        // Enforce: Phone number is strictly prohibited as a login identifier
        if (!email && (identifier || phoneNumber)) {
            // Mitigate timing attack
            await this.passwordService.verify(
                '$argon2id$v=19$m=4096,t=1,p=1$dummySaltForTiming$dummyHashForConstantTimeVerification12345678',
                password || 'dummy'
            ).catch(() => {});

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    action: 'LOGIN_FAILED',
                    resourceType: 'USER',
                    metadata: { reason: 'phone_login_prohibited', identifier: identifier || phoneNumber },
                    ipAddress,
                    userAgent,
                }).catch(() => {});
            }

            throw new AuthError('Phone number login is not permitted. Please log in with your email address.', 'INVALID_CREDENTIALS', 401);
        }

        if (!email || typeof email !== 'string' || !password || typeof password !== 'string') {
            throw new AuthError('Email and password are required', 'INVALID_CREDENTIALS', 401);
        }

        const trimmedEmail = email.trim();
        if (!AuthService.isValidEmail(trimmedEmail)) {
            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
        }

        const normalizedEmail = trimmedEmail.toLowerCase();
        const user = await this.userRepo.findByEmail(normalizedEmail);

        if (!user || !user.password_hash) {
            // Mitigate timing attacks by performing a dummy verification
            await this.passwordService.verify(
                '$argon2id$v=19$m=4096,t=1,p=1$dummySaltForTiming$dummyHashForConstantTimeVerification12345678',
                password
            ).catch(() => {});

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    action: 'LOGIN_FAILED',
                    resourceType: 'USER',
                    metadata: { reason: 'unknown_account', email: normalizedEmail },
                    ipAddress,
                    userAgent,
                }).catch(() => {});
            }

            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
        }

        const isPasswordValid = await this.passwordService.verify(user.password_hash, password);
        if (!isPasswordValid) {
            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    actorUserId: user.id,
                    action: 'LOGIN_FAILED',
                    resourceType: 'USER',
                    resourceId: user.id,
                    metadata: { reason: 'invalid_password' },
                    ipAddress,
                    userAgent,
                }).catch(() => {});
            }

            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
        }

        // Resolve user's tenant and platform role
        let primaryTenantId = null;
        if (this.tenantMembershipRepo) {
            const memberships = await this.tenantMembershipRepo.listTenantsForUser(user.id);
            const ownerMembership = memberships.find((m) => m.role === 'OWNER');
            primaryTenantId = ownerMembership ? ownerMembership.tenant_id : (memberships[0]?.tenant_id || null);
        }

        let platformRoles = [];
        if (this.platformRoleRepo) {
            platformRoles = await this.platformRoleRepo.findRolesByUserId(user.id);
        }
        const effectiveRole = platformRoles.includes('ADMIN') ? 'ADMIN' : 'CUSTOMER';

        // 1. Create short-lived Access Token (15m JWT)
        const accessToken = this.tokenService.createAccessToken({
            userId: user.id,
            email: user.email,
            extraClaims: {
                tenantId: primaryTenantId,
                role: effectiveRole,
            },
        });

        // 2. Generate opaque Refresh Token (32 bytes) and persist SHA-256 hash
        const rawRefreshToken = this.tokenService.generateRefreshToken();
        const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
        const familyId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + this.tokenService.refreshTokenTtl * 1000);

        await this.refreshTokenRepo.create({
            userId: user.id,
            tokenHash,
            familyId,
            expiresAt,
        });

        if (this.auditLogRepo) {
            await this.auditLogRepo.create({
                actorUserId: user.id,
                tenantId: primaryTenantId,
                action: 'LOGIN_SUCCEEDED',
                resourceType: 'USER',
                resourceId: user.id,
                metadata: { familyId, role: effectiveRole, tenantId: primaryTenantId },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        return {
            user: {
                id: user.id,
                email: user.email,
                phoneNumber: user.phone_number,
                role: effectiveRole,
                tenantId: primaryTenantId,
                createdAt: user.created_at,
            },
            accessToken,
            refreshToken: rawRefreshToken,
        };
    }

    /**
     * Refresh access token with atomic rotation, reuse detection, and family invalidation.
     *
     * @param {object} params
     * @param {string} params.rawRefreshToken
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ accessToken: string, refreshToken: string }>}
     */
    async refresh({ rawRefreshToken, ipAddress = null, userAgent = null }) {
        if (!rawRefreshToken || typeof rawRefreshToken !== 'string') {
            throw new AuthError('Refresh token is required', 'INVALID_REFRESH_TOKEN', 400);
        }

        const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
        const client = await this.pool.connect();

        try {
            await client.query('BEGIN');

            // Lock the token row FOR UPDATE to serialize concurrent refresh attempts
            const tokenRecord = await this.refreshTokenRepo.findByHashForUpdate(client, tokenHash);

            if (!tokenRecord) {
                await client.query('ROLLBACK');
                throw new AuthError('Invalid or unrecognised refresh token', 'INVALID_REFRESH_TOKEN', 401);
            }

            // 1. REUSE DETECTION: If token has already been revoked, a replay attack is occurring!
            if (tokenRecord.revoked_at !== null) {
                // Invalidate the ENTIRE token family immediately
                await this.refreshTokenRepo.revokeFamily(tokenRecord.family_id, client);

                if (this.auditLogRepo) {
                    await this.auditLogRepo.create({
                        actorUserId: tokenRecord.user_id,
                        action: 'TOKEN_REUSE_DETECTED',
                        resourceType: 'REFRESH_TOKEN',
                        resourceId: tokenRecord.id,
                        metadata: { familyId: tokenRecord.family_id },
                        ipAddress,
                        userAgent,
                    }, client);
                }

                await client.query('COMMIT');
                throw new AuthError(
                    'Refresh token reuse detected. All active sessions have been invalidated.',
                    'REFRESH_TOKEN_REUSED',
                    401
                );
            }

            // 2. EXPIRATION CHECK
            const now = new Date();
            if (new Date(tokenRecord.expires_at) < now) {
                await client.query('ROLLBACK');
                throw new AuthError('Refresh token has expired', 'TOKEN_EXPIRED', 401);
            }

            // 3. VERIFY USER ACCOUNT
            const user = await this.userRepo.findById(tokenRecord.user_id, client);
            if (!user) {
                await client.query('ROLLBACK');
                throw new AuthError('User account not found', 'INVALID_CREDENTIALS', 401);
            }

            // 4. ATOMIC ROTATION
            const newRawRefreshToken = this.tokenService.generateRefreshToken();
            const newTokenHash = this.tokenService.hashRefreshToken(newRawRefreshToken);
            const newExpiresAt = new Date(Date.now() + this.tokenService.refreshTokenTtl * 1000);

            await this.refreshTokenRepo.rotate({
                client,
                oldTokenId: tokenRecord.id,
                newTokenHash,
                userId: user.id,
                familyId: tokenRecord.family_id,
                expiresAt: newExpiresAt,
            });

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    actorUserId: user.id,
                    action: 'TOKEN_REFRESHED',
                    resourceType: 'REFRESH_TOKEN',
                    resourceId: tokenRecord.id,
                    metadata: { familyId: tokenRecord.family_id },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            // 5. Issue new short-lived Access Token
            const accessToken = this.tokenService.createAccessToken({
                userId: user.id,
                email: user.email,
            });

            return {
                accessToken,
                refreshToken: newRawRefreshToken,
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * User logout: invalidates the refresh token family for this session.
     *
     * @param {object} params
     * @param {string} [params.rawRefreshToken]
     * @param {string} [params.userId]
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ success: boolean, message: string }>}
     */
    async logout({ rawRefreshToken = null, userId = null, ipAddress = null, userAgent = null }) {
        if (rawRefreshToken) {
            try {
                const tokenHash = this.tokenService.hashRefreshToken(rawRefreshToken);
                const tokenRecord = await this.refreshTokenRepo.findByHash(tokenHash);

                if (tokenRecord) {
                    // Revoking the entire family terminates all sessions associated with this refresh cycle
                    await this.refreshTokenRepo.revokeFamily(tokenRecord.family_id);

                    if (this.auditLogRepo) {
                        await this.auditLogRepo.create({
                            actorUserId: tokenRecord.user_id,
                            action: 'LOGOUT',
                            resourceType: 'REFRESH_TOKEN',
                            resourceId: tokenRecord.id,
                            metadata: { familyId: tokenRecord.family_id },
                            ipAddress,
                            userAgent,
                        }).catch(() => {});
                    }
                }
            } catch (err) {
                // Ignore lookup/hash errors during logout to allow client cookie clearance
            }
        } else if (userId) {
            await this.refreshTokenRepo.revokeAllForUser(userId).catch(() => {});
        }

        return { success: true, message: 'Logged out successfully' };
    }

    /**
     * Retrieves current user identity.
     *
     * @param {string} userId
     * @returns {Promise<object>} Safe user profile
     */
    async getMe(userId) {
        if (!userId) {
            throw new AuthError('User ID is required', 'AUTH_REQUIRED', 401);
        }

        const user = await this.userRepo.findById(userId);
        if (!user) {
            throw new AuthError('User account not found', 'USER_NOT_FOUND', 404);
        }

        let tenant = null;
        if (this.tenantMembershipRepo) {
            const memberships = await this.tenantMembershipRepo.listTenantsForUser(user.id);
            const ownerMembership = memberships.find((m) => m.role === 'OWNER');
            const primary = ownerMembership || memberships[0] || null;
            if (primary) {
                tenant = {
                    id: primary.tenant_id,
                    name: primary.tenant_name,
                    status: primary.tenant_status || 'ACTIVE',
                    role: primary.role,
                };
            }
        }

        let role = 'CUSTOMER';
        if (this.platformRoleRepo) {
            const roles = await this.platformRoleRepo.findRolesByUserId(user.id);
            role = roles.includes('ADMIN') ? 'ADMIN' : 'CUSTOMER';
        }

        return {
            id: user.id,
            email: user.email,
            phoneNumber: user.phone_number,
            role,
            tenant,
            user: {
                id: user.id,
                email: user.email,
                phoneNumber: user.phone_number,
                role,
            },
            createdAt: user.created_at,
            updatedAt: user.updated_at,
        };
    }
}

module.exports = AuthService;
