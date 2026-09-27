const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    PlatformRoleRepository,
    RefreshTokenRepository,
    AuditLogRepository,
    WhatsAppConnectionRepository,
} = require('../src/repositories');
const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const { createRestApp } = require('../src/application/http/RestApp');
const { parseCookies } = require('../src/application/http/AuthHandler');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Slice 1: Customer Auth & Account Provisioning', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let refreshTokenRepo;
    let auditLogRepo;
    let whatsAppConnectionRepo;
    let passwordService;
    let tokenService;
    let authService;
    let appHandler;
    let server;
    let serverUrl;
    let adminUser;
    let rateLimiter;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        whatsAppConnectionRepo = new WhatsAppConnectionRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'slice1-test-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 900,
            refreshTokenTtlSeconds: 604800,
        });

        rateLimiter = createRateLimiter({
            windowMs: 60000,
            maxRequests: 1000,
        });

        authService = new AuthService({
            userRepo,
            tenantRepo,
            tenantMembershipRepo,
            platformRoleRepo,
            refreshTokenRepo,
            auditLogRepo,
            passwordService,
            tokenService,
            pool,
        });

        appHandler = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo,
            userRepo,
            auditLogRepo,
            whatsAppConnectionRepo,
            platformRoleRepo,
            rateLimiter,
            cookieOptions: { secure: false },
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;

        // Create an existing ADMIN user to test ADMIN login preservation
        const adminEmail = `admin_slice1_${Date.now()}@windowseven.test`;
        const adminPassword = 'AdminSecretPassword123!';
        const adminHash = await passwordService.hash(adminPassword);
        adminUser = await userRepo.create({
            email: adminEmail,
            passwordHash: adminHash,
            phoneNumber: '+255799999999',
        });
        await platformRoleRepo.assignRole({
            userId: adminUser.id,
            role: 'ADMIN',
        });
    });

    beforeEach(() => {
        if (rateLimiter) rateLimiter.reset();
    });

    after(async () => {
        if (rateLimiter) rateLimiter.destroy();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        // Clean up test data
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice1test.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice1test.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM tenants WHERE name LIKE 'Customer %';");
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice1test.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice1test.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@slice1test.com' OR email LIKE '%@windowseven.test';");
        await pool.end();
    });

    // HTTP Helper
    async function request(method, path, { headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const reqUrl = new URL(path, serverUrl);
            const req = http.request(reqUrl, {
                method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...headers,
                },
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: parsed,
                    });
                });
            });
            req.on('error', reject);
            if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Customer Registration & Atomic Account Provisioning
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Customer Registration & Atomic Account Provisioning', () => {
        const validPhone = '+255712345678';
        const validEmail = 'customer1@slice1test.com';
        const validPassword = 'SecureCustomerPass123!';
        let registeredCustomerId;
        let provisionedTenantId;

        it('1.1 should atomically register customer user, tenant, OWNER membership, and CUSTOMER role', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: validPhone,
                    email: validEmail,
                    password: validPassword,
                },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);

            // User verification
            const user = res.body.data.user;
            assert.ok(user.id, 'Must return generated UUID for user');
            assert.strictEqual(user.email, validEmail);
            assert.strictEqual(user.phoneNumber, validPhone);
            assert.strictEqual(user.role, 'CUSTOMER');
            assert.strictEqual(user.password, undefined);
            assert.strictEqual(user.password_hash, undefined);
            registeredCustomerId = user.id;

            // Tenant verification
            const tenant = res.body.data.tenant;
            assert.ok(tenant, 'Must return provisioned tenant');
            assert.ok(tenant.id, 'Must have tenant UUID');
            assert.strictEqual(tenant.status, 'ACTIVE');
            assert.ok(tenant.name.startsWith('Customer '), 'Tenant name must start with Customer prefix');
            assert.ok(!tenant.name.includes(validPhone), 'Tenant name must NOT expose raw unadorned phone number');
            provisionedTenantId = tenant.id;

            // Database entity verification: users
            const dbUser = await userRepo.findById(registeredCustomerId);
            assert.ok(dbUser, 'User must exist in database');
            assert.strictEqual(dbUser.email, validEmail);
            assert.strictEqual(dbUser.phone_number, validPhone);
            assert.ok(dbUser.password_hash.startsWith('$argon2id$'), 'Password must be hashed with Argon2id');

            // Database entity verification: tenants
            const dbTenant = await tenantRepo.findById(provisionedTenantId);
            assert.ok(dbTenant, 'Tenant must exist in database');
            assert.strictEqual(dbTenant.status, 'ACTIVE');

            // Database entity verification: tenant_memberships (OWNER)
            const dbMembership = await tenantMembershipRepo.findByTenantAndUser(provisionedTenantId, registeredCustomerId);
            assert.ok(dbMembership, 'Membership must link user to tenant');
            assert.strictEqual(dbMembership.role, 'OWNER');

            // Database entity verification: platform_user_roles (CUSTOMER)
            const roles = await platformRoleRepo.findRolesByUserId(registeredCustomerId);
            assert.deepStrictEqual(roles, ['CUSTOMER']);

            // Database entity verification: audit_logs
            const logs = await auditLogRepo.listForTenant(provisionedTenantId, { action: 'CUSTOMER_REGISTERED' });
            assert.ok(logs.length > 0, 'Audit log must be recorded for customer registration');
            assert.strictEqual(logs[0].actor_user_id, registeredCustomerId);
        });

        it('1.2 should strictly NOT create any subscription or payment records on registration', async () => {
            // Verify customer_subscriptions table has 0 rows for this new customer
            const subRes = await pool.query('SELECT * FROM customer_subscriptions WHERE customer_user_id = $1;', [registeredCustomerId]);
            assert.strictEqual(subRes.rows.length, 0, 'Must NOT create any subscription record on registration');

            // Verify payments table has 0 rows for this new customer
            const payRes = await pool.query('SELECT * FROM payments WHERE customer_user_id = $1;', [registeredCustomerId]);
            assert.strictEqual(payRes.rows.length, 0, 'Must NOT create any payment record on registration');
        });

        it('1.3 should reject registration with duplicate email (409 EMAIL_ALREADY_EXISTS)', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: '+255712999999', // distinct phone
                    email: validEmail.toUpperCase(), // duplicate email with different casing
                    password: 'AnotherPassword123!',
                },
            });

            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.error.code, 'EMAIL_ALREADY_EXISTS');
        });

        it('1.4 should reject registration with duplicate phone number (409 PHONE_ALREADY_EXISTS)', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: validPhone, // duplicate phone
                    email: 'distinct_email@slice1test.com',
                    password: 'AnotherPassword123!',
                },
            });

            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.error.code, 'PHONE_ALREADY_EXISTS');
        });

        it('1.5 should normalize phone format from 0XXXXXXXXX to +255XXXXXXXXX', async () => {
            const localPhone = '0713456789';
            const expectedE164 = '+255713456789';
            const email = 'normalizetest@slice1test.com';

            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: localPhone,
                    email,
                    password: 'ValidPassword123!',
                },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.data.user.phoneNumber, expectedE164);

            const dbUser = await userRepo.findById(res.body.data.user.id);
            assert.strictEqual(dbUser.phone_number, expectedE164);
        });

        it('1.6 should reject invalid phone numbers (non-Tanzanian, malformed, letters)', async () => {
            const invalidNumbers = [
                '+1234567890',     // non-Tanzanian country code
                '12345',           // too short
                '07123456789012',  // too long
                '0512345678',      // invalid mobile prefix (not 6 or 7)
                'not-a-number',    // letters
                '+255999999999',   // invalid prefix 9
            ];

            for (const badPhone of invalidNumbers) {
                const res = await request('POST', '/api/v1/auth/register', {
                    body: {
                        phoneNumber: badPhone,
                        email: `badphone_${Date.now()}@slice1test.com`,
                        password: 'ValidPassword123!',
                    },
                });

                assert.strictEqual(res.status, 400, `Expected 400 for bad phone: ${badPhone}`);
                assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
            }
        });

        it('1.7 should reject missing phone number (400 VALIDATION_ERROR)', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'missingphone@slice1test.com',
                    password: 'ValidPassword123!',
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('1.8 should reject invalid email format (400 VALIDATION_ERROR)', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: '+255714000001',
                    email: 'invalid-email-syntax',
                    password: 'ValidPassword123!',
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('1.9 should reject weak password failing security policy (400 WEAK_PASSWORD)', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: '+255714000002',
                    email: 'weakpass_slice1@slice1test.com',
                    password: 'short',
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'WEAK_PASSWORD');
        });

        it('1.10 should reject or neutralize client attempts to self-assign ADMIN role', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: '+255714000003',
                    email: 'attacker@slice1test.com',
                    password: 'AttackerPassword123!',
                    role: 'ADMIN', // malicious payload
                },
            });

            assert.strictEqual(res.status, 201);
            // Must strictly receive CUSTOMER role, never ADMIN
            assert.strictEqual(res.body.data.user.role, 'CUSTOMER');

            const roles = await platformRoleRepo.findRolesByUserId(res.body.data.user.id);
            assert.deepStrictEqual(roles, ['CUSTOMER'], 'Platform role in database must strictly be CUSTOMER');
        });

        it('1.11 should ignore client-supplied tenantId or tenantName during registration', async () => {
            const forgedTenantId = '00000000-0000-0000-0000-000000000099';
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    phoneNumber: '+255714000004',
                    email: 'tenanttamper@slice1test.com',
                    password: 'ValidPassword123!',
                    tenantId: forgedTenantId,
                    tenantName: 'Hacked Tenant',
                },
            });

            assert.strictEqual(res.status, 201);
            assert.notStrictEqual(res.body.data.tenant.id, forgedTenantId, 'Must not use client-supplied tenantId');
            assert.notStrictEqual(res.body.data.tenant.name, 'Hacked Tenant', 'Must not use client-supplied tenantName');
            assert.ok(res.body.data.tenant.name.startsWith('Customer '));
        });

        it('1.12 should roll back all provisioning atomically if an internal step fails', async () => {
            // Test transaction atomicity via AuthService directly with a failing mock pool client
            const failingEmail = 'atomic_fail@slice1test.com';
            const failingPhone = '+255714999999';

            // Simulate constraint violation on tenant creation
            const originalTenantCreate = tenantRepo.create;
            tenantRepo.create = async () => {
                throw new Error('Simulated database failure during tenant provisioning');
            };

            await assert.rejects(
                () => authService.register({
                    email: failingEmail,
                    phoneNumber: failingPhone,
                    password: 'ValidPassword123!',
                }),
                /Simulated database failure during tenant provisioning/
            );

            // Restore
            tenantRepo.create = originalTenantCreate;

            // Verify ZERO state was persisted in the database:
            // 1. User must NOT exist
            const orphanedUser = await userRepo.findByEmail(failingEmail);
            assert.strictEqual(orphanedUser, null, 'User row must be rolled back');

            const orphanedPhone = await userRepo.findByPhoneNumber(failingPhone);
            assert.strictEqual(orphanedPhone, null, 'Phone row must be rolled back');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Customer & Admin Login Behavior
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Customer & Admin Login Behavior', () => {
        const customerEmail = 'customer_login@slice1test.com';
        const customerPhone = '+255715555555';
        const customerPassword = 'CustomerLogin123!';
        let customerAccessToken;
        let customerRefreshToken;
        let customerTenantId;

        before(async () => {
            const reg = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: customerEmail,
                    phoneNumber: customerPhone,
                    password: customerPassword,
                },
            });
            assert.strictEqual(reg.status, 201);
            customerTenantId = reg.body.data.tenant.id;
        });

        it('2.1 should login customer successfully using email + password', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: customerEmail,
                    password: customerPassword,
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.accessToken);

            // User representation
            const user = res.body.data.user;
            assert.strictEqual(user.email, customerEmail);
            assert.strictEqual(user.phoneNumber, customerPhone);
            assert.strictEqual(user.role, 'CUSTOMER');
            assert.strictEqual(user.tenantId, customerTenantId);

            // Verify JWT claims
            const decoded = tokenService.verifyAccessToken(res.body.data.accessToken);
            assert.strictEqual(decoded.valid, true);
            assert.strictEqual(decoded.payload.email, customerEmail);
            assert.strictEqual(decoded.payload.role, 'CUSTOMER');
            assert.strictEqual(decoded.payload.tenantId, customerTenantId);

            // Verify HTTP-only cookie
            const setCookie = res.headers['set-cookie'];
            assert.ok(setCookie);
            const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
            assert.ok(cookieStr.includes('refreshToken='));
            assert.ok(cookieStr.includes('HttpOnly'));

            customerAccessToken = res.body.data.accessToken;
            const cookies = parseCookies(cookieStr);
            customerRefreshToken = cookies.refreshToken;
        });

        it('2.2 should strictly REJECT login with phone number as identifier', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    identifier: customerPhone,
                    password: customerPassword,
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
        });

        it('2.3 should strictly REJECT login when phoneNumber field is used without email', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    phoneNumber: customerPhone,
                    password: customerPassword,
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
        });

        it('2.4 should reject login with incorrect password (401 INVALID_CREDENTIALS)', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: customerEmail,
                    password: 'WrongPassword123!',
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
        });

        it('2.5 should reject login with non-existent email (401 INVALID_CREDENTIALS, timing-safe)', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: 'doesnotexist@slice1test.com',
                    password: customerPassword,
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
        });

        it('2.6 should verify existing ADMIN email + password login still works', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: adminUser.email,
                    password: 'AdminSecretPassword123!',
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.user.role, 'ADMIN');
            assert.strictEqual(res.body.data.user.email, adminUser.email);

            const decoded = tokenService.verifyAccessToken(res.body.data.accessToken);
            assert.strictEqual(decoded.valid, true);
            assert.strictEqual(decoded.payload.role, 'ADMIN');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. User Identity & Tenant Context Resolution (GET /api/v1/auth/me)
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. User Identity & Tenant Context (GET /api/v1/auth/me)', () => {
        let customerToken;
        let customerUser;
        let customerTenant;

        before(async () => {
            const email = 'me_context@slice1test.com';
            const phone = '+255716666666';
            const password = 'MePassword123!';

            const reg = await request('POST', '/api/v1/auth/register', {
                body: { email, phoneNumber: phone, password },
            });
            customerUser = reg.body.data.user;
            customerTenant = reg.body.data.tenant;

            const login = await request('POST', '/api/v1/auth/login', {
                body: { email, password },
            });
            customerToken = login.body.data.accessToken;
        });

        it('3.1 should return user identity with phone number, CUSTOMER role, and provisioned tenant', async () => {
            const res = await request('GET', '/api/v1/auth/me', {
                headers: {
                    'Authorization': `Bearer ${customerToken}`,
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);

            const data = res.body.data;
            assert.strictEqual(data.id, customerUser.id);
            assert.strictEqual(data.email, customerUser.email);
            assert.strictEqual(data.phoneNumber, customerUser.phoneNumber);
            assert.strictEqual(data.role, 'CUSTOMER');
            assert.ok(data.tenant, 'Must include primary tenant');
            assert.strictEqual(data.tenant.id, customerTenant.id);
            assert.strictEqual(data.tenant.name, customerTenant.name);
            assert.strictEqual(data.tenant.role, 'OWNER');

            // Passwords must never leak
            assert.strictEqual(data.password, undefined);
            assert.strictEqual(data.password_hash, undefined);
        });
    });
});
