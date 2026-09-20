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
     */
    constructor({ userRepo, refreshTokenRepo, auditLogRepo = null, passwordService, tokenService, pool }) {
        if (!userRepo || !refreshTokenRepo || !passwordService || !tokenService || !pool) {
            throw new Error('[AuthService] userRepo, refreshTokenRepo, passwordService, tokenService, and pool are required');
        }

        this.userRepo = userRepo;
        this.refreshTokenRepo = refreshTokenRepo;
        this.auditLogRepo = auditLogRepo;
        this.passwordService = passwordService;
        this.tokenService = tokenService;
        this.pool = pool;
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
     * User registration with password policy check, Argon2id hashing, and transactional creation.
     *
     * @param {object} params
     * @param {string} params.email
     * @param {string} params.password
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ user: object }>} Safe user representation
     */
    async register({ email, password, ipAddress = null, userAgent = null }) {
        if (!AuthService.isValidEmail(email)) {
            throw new AuthError('A valid email address is required', 'VALIDATION_ERROR', 400);
        }

        const normalizedEmail = email.trim().toLowerCase();

        // 1. Password policy verification
        const policy = this.passwordService.validatePolicy(password);
        if (!policy.valid) {
            throw new AuthError(policy.error || 'Password does not meet security requirements', 'WEAK_PASSWORD', 400);
        }

        // 2. Check for duplicate email (case-insensitive)
        const existing = await this.userRepo.findByEmail(normalizedEmail);
        if (existing) {
            throw new AuthError('An account with this email address already exists', 'EMAIL_ALREADY_EXISTS', 409);
        }

        // 3. Hash password using Argon2id
        const passwordHash = await this.passwordService.hash(password);

        // 4. Transactional persistence
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            const user = await this.userRepo.create({ email: normalizedEmail, passwordHash }, client);

            if (this.auditLogRepo) {
                await this.auditLogRepo.create({
                    actorUserId: user.id,
                    action: 'USER_REGISTERED',
                    resourceType: 'USER',
                    resourceId: user.id,
                    metadata: { email: normalizedEmail },
                    ipAddress,
                    userAgent,
                }, client);
            }

            await client.query('COMMIT');

            return {
                user: {
                    id: user.id,
                    email: user.email,
                    createdAt: user.created_at,
                },
            };
        } catch (err) {
            await client.query('ROLLBACK');
            // Check for unique constraint violation race condition
            if (err.code === '23505') {
                throw new AuthError('An account with this email address already exists', 'EMAIL_ALREADY_EXISTS', 409);
            }
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * User login with constant-time password check, JWT generation, and opaque refresh token issuance.
     *
     * @param {object} params
     * @param {string} params.email
     * @param {string} params.password
     * @param {string} [params.ipAddress]
     * @param {string} [params.userAgent]
     * @returns {Promise<{ user: object, accessToken: string, refreshToken: string }>}
     */
    async login({ email, password, ipAddress = null, userAgent = null }) {
        if (!email || !password || typeof email !== 'string' || typeof password !== 'string') {
            throw new AuthError('Invalid email or password', 'INVALID_CREDENTIALS', 401);
        }

        const normalizedEmail = email.trim().toLowerCase();
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

        // 1. Create short-lived Access Token (15m JWT)
        const accessToken = this.tokenService.createAccessToken({
            userId: user.id,
            email: user.email,
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
                action: 'LOGIN_SUCCEEDED',
                resourceType: 'USER',
                resourceId: user.id,
                metadata: { familyId },
                ipAddress,
                userAgent,
            }).catch(() => {});
        }

        return {
            user: {
                id: user.id,
                email: user.email,
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

        return {
            id: user.id,
            email: user.email,
            createdAt: user.created_at,
            updatedAt: user.updated_at,
        };
    }
}

module.exports = AuthService;
