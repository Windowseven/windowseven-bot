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
    PlanRepository,
    SubscriptionRepository,
} = require('../src/repositories');
const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const { createRestApp } = require('../src/application/http/RestApp');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Slice 2A: Customer Context + Plan & Subscription Read APIs', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let refreshTokenRepo;
    let auditLogRepo;
    let whatsAppConnectionRepo;
    let planRepo;
    let subscriptionRepo;

    let passwordService;
    let tokenService;
    let authService;
    let rateLimiter;
    let appHandler;
    let server;
    let serverUrl;

    // Test accounts
    let customerA;
    let customerAToken;
    let customerB;
    let customerBToken;
    let customerC;
    let customerCToken;
    let customerD;
    let customerDToken;
    let adminUser;
    let adminToken;

    // Test plans
    let activePlan1;
    let activePlan2;
    let inactivePlan;

    // Test subscriptions
    let subA;
    let subC;
    let subD;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        whatsAppConnectionRepo = new WhatsAppConnectionRepository(pool);
        planRepo = new PlanRepository(pool);
        subscriptionRepo = new SubscriptionRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'slice2a-test-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 900,
            refreshTokenTtlSeconds: 604800,
        });

        rateLimiter = createRateLimiter({
            windowMs: 60000,
            maxRequests: 5000,
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
            planRepo,
            subscriptionRepo,
            rateLimiter,
            cookieOptions: { secure: false },
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;

        // 1. Provision Plans
        activePlan1 = await planRepo.create({
            name: `Starter Pro ${Date.now()}`,
            price: 15000.00,
            currency: 'TZS',
            durationDays: 30,
            description: 'Monthly starter package for groups',
            status: 'ACTIVE',
        });

        activePlan2 = await planRepo.create({
            name: `Annual VIP ${Date.now()}`,
            price: 150000.00,
            currency: 'TZS',
            durationDays: 365,
            description: 'Annual VIP package',
            status: 'ACTIVE',
        });

        inactivePlan = await planRepo.create({
            name: `Archived Plan ${Date.now()}`,
            price: 5000.00,
            currency: 'TZS',
            durationDays: 7,
            description: 'Legacy inactive trial',
            status: 'INACTIVE',
        });

        // 2. Provision Customer A (has active subscription with historical pricing)
        customerA = await authService.register({
            email: `customera_${Date.now()}@slice2atest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: '+255711000001',
        });
        const loginA = await authService.login({
            email: customerA.user.email,
            password: 'CustomerPass123!@#',
        });
        customerAToken = loginA.accessToken;

        // Create active subscription with historical snapshot price of 12500 (discounted vs 15000 current plan price)
        const expiresA = new Date(Date.now() + 30 * 86400 * 1000);
        subA = await subscriptionRepo.create({
            tenantId: customerA.tenant.id,
            customerUserId: customerA.user.id,
            planId: activePlan1.id,
            pricePaid: 12500.00,
            currency: 'TZS',
            durationDays: 30,
            status: 'ACTIVE',
            expiresAt: expiresA,
        });

        // 3. Provision Customer B (Zero subscriptions)
        customerB = await authService.register({
            email: `customerb_${Date.now()}@slice2atest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: '+255711000002',
        });
        const loginB = await authService.login({
            email: customerB.user.email,
            password: 'CustomerPass123!@#',
        });
        customerBToken = loginB.accessToken;

        // 4. Provision Customer C (Expired subscription)
        customerC = await authService.register({
            email: `customerc_${Date.now()}@slice2atest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: '+255711000003',
        });
        const loginC = await authService.login({
            email: customerC.user.email,
            password: 'CustomerPass123!@#',
        });
        customerCToken = loginC.accessToken;

        const expiredDate = new Date(Date.now() - 5 * 86400 * 1000);
        subC = await subscriptionRepo.create({
            tenantId: customerC.tenant.id,
            customerUserId: customerC.user.id,
            planId: activePlan1.id,
            pricePaid: 15000.00,
            currency: 'TZS',
            durationDays: 30,
            status: 'EXPIRED',
            expiresAt: expiredDate,
        });

        // 5. Provision Customer D (MANUALLY_GRANTED subscription)
        customerD = await authService.register({
            email: `customerd_${Date.now()}@slice2atest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: '+255711000004',
        });
        const loginD = await authService.login({
            email: customerD.user.email,
            password: 'CustomerPass123!@#',
        });
        customerDToken = loginD.accessToken;

        const expiresD = new Date(Date.now() + 14 * 86400 * 1000);
        subD = await subscriptionRepo.create({
            tenantId: customerD.tenant.id,
            customerUserId: customerD.user.id,
            planId: activePlan1.id,
            pricePaid: 0.00,
            currency: 'TZS',
            durationDays: 14,
            status: 'MANUALLY_GRANTED',
            expiresAt: expiresD,
        });

        // 6. Provision Admin User
        const adminEmail = `admin_slice2a_${Date.now()}@windowseven.test`;
        const adminHash = await passwordService.hash('AdminSecretPassword123!');
        adminUser = await userRepo.create({
            email: adminEmail,
            passwordHash: adminHash,
            phoneNumber: '+255799999998',
        });
        await platformRoleRepo.assignRole({
            userId: adminUser.id,
            role: 'ADMIN',
        });
        const adminLogin = await authService.login({
            email: adminEmail,
            password: 'AdminSecretPassword123!',
        });
        adminToken = adminLogin.accessToken;
    });

    beforeEach(() => {
        if (rateLimiter) rateLimiter.reset();
    });

    after(async () => {
        if (rateLimiter) rateLimiter.destroy();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2atest.com');");
        await pool.query("DELETE FROM plans WHERE id IN ($1, $2, $3);", [activePlan1.id, activePlan2.id, inactivePlan.id]);
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2atest.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2atest.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM tenants WHERE id IN ($1, $2, $3, $4);", [
            customerA.tenant.id, customerB.tenant.id, customerC.tenant.id, customerD.tenant.id
        ]);
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2atest.com' OR email LIKE '%@windowseven.test');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@slice2atest.com' OR email LIKE '%@windowseven.test';");
        await pool.end();
    });

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
            if (body) req.write(JSON.stringify(body));
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Authentication & Customer Profile (GET /api/v1/me)
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Customer Profile (GET /api/v1/me)', () => {
        it('1.1 should reject unauthenticated GET /api/v1/me with 401 AUTH_REQUIRED', async () => {
            const res = await request('GET', '/api/v1/me');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('1.2 should reject invalid Bearer token with 401 TOKEN_INVALID', async () => {
            const res = await request('GET', '/api/v1/me', {
                headers: { Authorization: 'Bearer totally-invalid-token-string' },
            });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.error.code, 'TOKEN_INVALID');
        });

        it('1.3 should allow authenticated CUSTOMER to access /api/v1/me and receive user and tenant context', async () => {
            const res = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            const data = res.body.data;

            // Verified user profile
            assert.strictEqual(data.user.id, customerA.user.id);
            assert.strictEqual(data.user.email, customerA.user.email);
            assert.strictEqual(data.user.phoneNumber, '+255711000001');
            assert.strictEqual(data.user.role, 'CUSTOMER');

            // Verified tenant context
            assert.strictEqual(data.tenant.id, customerA.tenant.id);
            assert.strictEqual(data.tenant.name, customerA.tenant.name);
            assert.strictEqual(data.tenant.status, 'ACTIVE');
            assert.strictEqual(data.tenant.role, 'OWNER');

            // Sensitive secrets must never be exposed
            assert.strictEqual(data.user.password, undefined);
            assert.strictEqual(data.user.password_hash, undefined);
        });

        it('1.4 should allow authenticated ADMIN to access /api/v1/me following platform rules', async () => {
            const res = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.user.id, adminUser.id);
            assert.strictEqual(res.body.data.user.role, 'ADMIN');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Multi-Tenant Profile Isolation & IDOR Protection
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Multi-Tenant Profile Isolation & IDOR Protection', () => {
        it('2.1 Customer A cannot access Customer B profile using ?tenantId manipulation', async () => {
            const res = await request('GET', `/api/v1/me?tenantId=${customerB.tenant.id}`, {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            // Must return Customer A's data only, strictly ignoring tenantId param
            assert.strictEqual(res.body.data.user.id, customerA.user.id);
            assert.strictEqual(res.body.data.tenant.id, customerA.tenant.id);
            assert.notStrictEqual(res.body.data.tenant.id, customerB.tenant.id);
        });

        it('2.2 Customer A cannot access Customer B profile using ?userId manipulation', async () => {
            const res = await request('GET', `/api/v1/me?userId=${customerB.user.id}`, {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.user.id, customerA.user.id);
            assert.notStrictEqual(res.body.data.user.id, customerB.user.id);
        });

        it('2.3 Customer B retrieves their own tenant and user context, distinct from Customer A', async () => {
            const res = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.user.id, customerB.user.id);
            assert.strictEqual(res.body.data.tenant.id, customerB.tenant.id);
            assert.notStrictEqual(res.body.data.tenant.id, customerA.tenant.id);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Public Plan Catalog (GET /api/v1/plans)
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Public Plan Catalog (GET /api/v1/plans)', () => {
        it('3.1 should allow unauthenticated access to the active plans catalog', async () => {
            const res = await request('GET', '/api/v1/plans');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(Array.isArray(res.body.data.plans));
        });

        it('3.2 should return only ACTIVE customer-visible plans and exclude INACTIVE plans', async () => {
            const res = await request('GET', '/api/v1/plans');
            assert.strictEqual(res.status, 200);
            const plans = res.body.data.plans;

            // Active plans must be present
            const found1 = plans.find((p) => p.id === activePlan1.id);
            const found2 = plans.find((p) => p.id === activePlan2.id);
            assert.ok(found1, 'activePlan1 must be present');
            assert.ok(found2, 'activePlan2 must be present');

            // Inactive plan must be excluded
            const foundInactive = plans.find((p) => p.id === inactivePlan.id);
            assert.strictEqual(foundInactive, undefined, 'inactivePlan must be excluded');

            // All returned plans must have status ACTIVE
            for (const p of plans) {
                assert.strictEqual(p.status, 'ACTIVE');
            }
        });

        it('3.3 should enforce authoritative database pricing, duration, and currency (no client control)', async () => {
            const res = await request('GET', `/api/v1/plans?price=100&durationDays=999`);
            assert.strictEqual(res.status, 200);
            const plan = res.body.data.plans.find((p) => p.id === activePlan1.id);

            assert.ok(plan);
            assert.strictEqual(typeof plan.price, 'number');
            assert.strictEqual(plan.price, 15000);
            assert.strictEqual(plan.currency, 'TZS');
            assert.strictEqual(plan.durationDays, 30);
            assert.strictEqual(plan.description, 'Monthly starter package for groups');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Customer Subscription Read API (GET /api/v1/me/subscription)
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Customer Subscription Read API (GET /api/v1/me/subscription)', () => {
        it('4.1 should reject unauthenticated GET /api/v1/me/subscription with 401 AUTH_REQUIRED', async () => {
            const res = await request('GET', '/api/v1/me/subscription');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('4.2 should return established empty state for customer with no subscription (Customer B)', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.subscription, null);
            assert.strictEqual(res.body.data.status, 'NONE');
            assert.strictEqual(res.body.data.hasActiveSubscription, false);

            // Invariant: Verify zero subscription records in DB for Customer B
            const count = await pool.query('SELECT COUNT(*)::int AS cnt FROM customer_subscriptions WHERE customer_user_id = $1;', [customerB.user.id]);
            assert.strictEqual(count.rows[0].cnt, 0);
        });

        it('4.3 should return active subscription for Customer A with plan and expiry details', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            const sub = res.body.data.subscription;

            assert.ok(sub, 'Subscription data must exist');
            assert.strictEqual(sub.id, subA.id);
            assert.strictEqual(sub.planId, activePlan1.id);
            assert.strictEqual(sub.status, 'ACTIVE');
            assert.strictEqual(sub.isExpired, false);
            assert.strictEqual(res.body.data.hasActiveSubscription, true);
            assert.ok(sub.secondsRemaining > 0);
            assert.ok(sub.daysRemaining > 0);
            assert.ok(sub.startedAt);
            assert.ok(sub.expiresAt);
        });

        it('4.4 should expose historical snapshot pricing (pricePaid: 12500) rather than current plans row price (15000)', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            const sub = res.body.data.subscription;

            // Historical price paid was 12500, catalog plan price is 15000
            assert.strictEqual(sub.pricePaid, 12500);
            assert.strictEqual(sub.price_paid, 12500);
            assert.strictEqual(sub.currency, 'TZS');
            assert.strictEqual(sub.durationDays, 30);
        });

        it('4.5 altering catalog plan price in database must NOT alter historical subscription snapshot', async () => {
            // Admin increases catalog plan price from 15000 to 25000
            await pool.query('UPDATE plans SET price = 25000 WHERE id = $1;', [activePlan1.id]);

            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            const sub = res.body.data.subscription;

            // Subscription snapshot must preserve original 12500
            assert.strictEqual(sub.pricePaid, 12500);
            assert.strictEqual(sub.currency, 'TZS');

            // Revert plan price
            await pool.query('UPDATE plans SET price = 15000 WHERE id = $1;', [activePlan1.id]);
        });

        it('4.6 should return correctly represented EXPIRED status for Customer C', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerCToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            const sub = res.body.data.subscription;

            assert.ok(sub);
            assert.strictEqual(sub.status, 'EXPIRED');
            assert.strictEqual(sub.isExpired, true);
            assert.strictEqual(res.body.data.hasActiveSubscription, false);
            assert.strictEqual(sub.secondsRemaining, 0);
        });

        it('4.7 should correctly represent MANUALLY_GRANTED subscription for Customer D', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerDToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            const sub = res.body.data.subscription;

            assert.ok(sub);
            assert.strictEqual(sub.status, 'MANUALLY_GRANTED');
            assert.strictEqual(sub.pricePaid, 0);
            assert.strictEqual(sub.isExpired, false);
            assert.strictEqual(res.body.data.hasActiveSubscription, true);
            assert.ok(sub.secondsRemaining > 0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Multi-Tenant Subscription Isolation & IDOR Security
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Multi-Tenant Subscription Isolation & IDOR Security', () => {
        it('5.1 Customer B cannot read Customer A subscription via ?tenantId=<Tenant A ID>', async () => {
            const res = await request('GET', `/api/v1/me/subscription?tenantId=${customerA.tenant.id}`, {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(res.status, 200);
            // Must strictly return Customer B's empty state, not Customer A's active subscription
            assert.strictEqual(res.body.data.subscription, null);
            assert.strictEqual(res.body.data.status, 'NONE');
            assert.strictEqual(res.body.data.hasActiveSubscription, false);
        });

        it('5.2 Customer A cannot be tricked into reading Customer B state via ?tenantId=<Tenant B ID>', async () => {
            const res = await request('GET', `/api/v1/me/subscription?tenantId=${customerB.tenant.id}`, {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(res.status, 200);
            // Must strictly return Customer A's active subscription
            assert.strictEqual(res.body.data.subscription.id, subA.id);
            assert.strictEqual(res.body.data.hasActiveSubscription, true);
        });

        it('5.3 Custom header or body tampering with tenantId is completely ignored', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: {
                    Authorization: `Bearer ${customerBToken}`,
                    'X-Tenant-ID': customerA.tenant.id,
                    'x-customer-id': customerA.user.id,
                },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.subscription, null);
            assert.strictEqual(res.body.data.status, 'NONE');
        });
    });
});
