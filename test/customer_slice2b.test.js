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
    PlatformAuditRepository,
    WhatsAppConnectionRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
} = require('../src/repositories');
const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PlatformService = require('../src/application/services/PlatformService');
const CustomerPurchaseService = require('../src/application/services/CustomerPurchaseService');
const { createRestApp } = require('../src/application/http/RestApp');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Slice 2B: Subscription Purchase Domain + Renewal Rules', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let refreshTokenRepo;
    let auditLogRepo;
    let whatsAppConnectionRepo;
    let planRepo;
    let subscriptionRepo;
    let paymentRepo;

    let passwordService;
    let tokenService;
    let authService;
    let platformService;
    let customerPurchaseService;
    let rateLimiter;
    let appHandler;
    let server;
    let serverUrl;

    // Accounts
    let customerA;
    let customerAToken;
    let customerB;
    let customerBToken;

    // Plans
    let plan7Days;
    let plan30Days;
    let inactivePlan;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        whatsAppConnectionRepo = new WhatsAppConnectionRepository(pool);
        planRepo = new PlanRepository(pool);
        subscriptionRepo = new SubscriptionRepository(pool);
        paymentRepo = new PaymentRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'slice2b-test-kid',
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

        platformService = new PlatformService({
            pool,
            tenantRepo,
            connRepo: whatsAppConnectionRepo,
            workerRepo: {
                findById: async () => null,
                findAll: async () => [],
                countActiveWorkers: async () => 0,
            },
            platformAuditRepo,
            platformRoleRepo,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            userRepo,
        });

        customerPurchaseService = new CustomerPurchaseService({
            pool,
            planRepo,
            paymentRepo,
            subscriptionRepo,
            tenantMembershipRepo,
            platformService,
            platformAuditRepo,
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
            platformAuditRepo,
            platformService,
            customerPurchaseService,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            rateLimiter,
            cookieOptions: { secure: false },
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;

        // Clean up any leftover test data from prior interrupted runs
        await pool.query("DELETE FROM payments WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@slice2btest.com';");

        // Provision Plans
        plan7Days = await planRepo.create({
            name: `Weekly Plan ${Date.now()}`,
            price: 5000.00,
            currency: 'TZS',
            durationDays: 7,
            description: 'Weekly test plan',
            status: 'ACTIVE',
        });

        plan30Days = await planRepo.create({
            name: `Monthly Plan ${Date.now()}`,
            price: 15000.00,
            currency: 'TZS',
            durationDays: 30,
            description: 'Monthly test plan',
            status: 'ACTIVE',
        });

        inactivePlan = await planRepo.create({
            name: `Disabled Plan ${Date.now()}`,
            price: 2000.00,
            currency: 'TZS',
            durationDays: 3,
            description: 'Disabled plan',
            status: 'INACTIVE',
        });

        // Provision Customers with dynamic unique Tanzanian phone numbers (+2557XXXXXXXX)
        const randA = Math.floor(10000000 + Math.random() * 90000000);
        const randB = Math.floor(10000000 + Math.random() * 90000000);

        customerA = await authService.register({
            email: `custA_${Date.now()}@slice2btest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: `+2557${randA}`,
        });
        const loginA = await authService.login({
            email: customerA.user.email,
            password: 'CustomerPass123!@#',
        });
        customerAToken = loginA.accessToken;

        customerB = await authService.register({
            email: `custB_${Date.now()}@slice2btest.com`,
            password: 'CustomerPass123!@#',
            phoneNumber: `+2557${randB}`,
        });
        const loginB = await authService.login({
            email: customerB.user.email,
            password: 'CustomerPass123!@#',
        });
        customerBToken = loginB.accessToken;
    });

    beforeEach(() => {
        if (rateLimiter) rateLimiter.reset();
    });

    after(async () => {
        if (rateLimiter) rateLimiter.destroy();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        await pool.query("DELETE FROM payments WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM plans WHERE id IN ($1, $2, $3);", [plan7Days.id, plan30Days.id, inactivePlan.id]);
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM tenants WHERE id IN ($1, $2);", [customerA.tenant.id, customerB.tenant.id]);
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@slice2btest.com');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@slice2btest.com';");
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
    // 1. Purchase Intent Creation (POST /api/v1/me/subscriptions/purchase)
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Purchase Intent Creation (POST /api/v1/me/subscriptions/purchase)', () => {
        it('1.1 should reject unauthenticated request with 401 AUTH_REQUIRED', async () => {
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                body: { planId: plan30Days.id },
            });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('1.2 should reject missing planId with 400 VALIDATION_ERROR', async () => {
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${customerAToken}` },
                body: {},
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('1.3 should reject non-existent planId with 404 PLAN_NOT_FOUND', async () => {
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${customerAToken}` },
                body: { planId: '00000000-0000-0000-0000-000000000000' },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'PLAN_NOT_FOUND');
        });

        it('1.4 should reject inactive plan with 400 PLAN_NOT_ACTIVE', async () => {
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${customerAToken}` },
                body: { planId: inactivePlan.id },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'PLAN_NOT_ACTIVE');
        });

        it('1.5 should create a PENDING payment intent strictly taking price & currency from DB plan', async () => {
            // Attempt tamper attack: client sends manipulated price and duration
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${customerAToken}` },
                body: {
                    planId: plan30Days.id,
                    amount: 1.00,
                    currency: 'USD',
                    durationDays: 365,
                    tenantId: customerB.tenant.id, // IDOR attempt
                },
            });
            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);

            const { payment, plan } = res.body.data;
            assert.ok(payment.id);
            assert.ok(payment.transactionReference.startsWith('TX_CUST_'));
            assert.strictEqual(payment.status, 'PENDING');

            // Strictly matches database plan, ignoring client tamper values
            assert.strictEqual(payment.amount, 15000);
            assert.strictEqual(payment.currency, 'TZS');
            assert.strictEqual(plan.price, 15000);
            assert.strictEqual(plan.durationDays, 30);

            // DB Record verification: strictly assigned to Customer A's tenant, not Customer B's
            const dbPayment = await paymentRepo.findById(payment.id);
            assert.strictEqual(dbPayment.tenant_id, customerA.tenant.id);
            assert.strictEqual(dbPayment.customer_user_id, customerA.user.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
            assert.strictEqual(dbPayment.subscription_id, null);

            // Invariant: PENDING payment does NOT create any subscription
            const subCount = await pool.query('SELECT COUNT(*)::int AS cnt FROM customer_subscriptions WHERE tenant_id = $1;', [customerA.tenant.id]);
            assert.strictEqual(subCount.rows[0].cnt, 0);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Payment Confirmation & Subscription Activation Seam
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Payment Confirmation & Subscription Activation', () => {
        let pendingPayment;

        beforeEach(async () => {
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            pendingPayment = purchase.payment;
        });

        it('2.1 FAILED payment confirmation marks payment FAILED and does not activate subscription', async () => {
            const result = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: pendingPayment.id,
                status: 'FAILED',
                failureReason: 'Insufficient mobile money balance',
            });
            assert.strictEqual(result.success, false);
            assert.strictEqual(result.payment.status, 'FAILED');
            assert.strictEqual(result.payment.failure_reason, 'Insufficient mobile money balance');
            assert.strictEqual(result.subscription, null);

            const dbPayment = await paymentRepo.findById(pendingPayment.id);
            assert.strictEqual(dbPayment.status, 'FAILED');
            assert.strictEqual(dbPayment.subscription_id, null);

            const subs = await subscriptionRepo.findAll({ tenantId: customerA.tenant.id });
            assert.strictEqual(subs.length, 0);
        });

        it('2.2 SUCCESS payment confirmation activates subscription with plan snapshot', async () => {
            const result = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: pendingPayment.id,
                status: 'SUCCESS',
            });
            assert.strictEqual(result.success, true);
            assert.strictEqual(result.payment.status, 'SUCCESS');
            assert.ok(result.payment.subscription_id);

            const sub = result.subscription;
            assert.ok(sub);
            assert.strictEqual(sub.tenant_id, customerA.tenant.id);
            assert.strictEqual(sub.customer_user_id, customerA.user.id);
            assert.strictEqual(sub.plan_id, plan7Days.id);
            assert.strictEqual(Number(sub.price_paid), 5000);
            assert.strictEqual(sub.currency, 'TZS');
            assert.strictEqual(sub.duration_days, 7);
            assert.strictEqual(sub.status, 'ACTIVE');

            // Audit record logged
            const auditRows = await pool.query("SELECT * FROM platform_audit_logs WHERE action = 'SUBSCRIPTION_ACTIVATED' AND target_id = $1;", [sub.id]);
            assert.strictEqual(auditRows.rows.length, 1);
            assert.strictEqual(auditRows.rows[0].target_tenant_id, customerA.tenant.id);
        });

        it('2.3 Customer B cannot activate Customer A payment (Ownership verification)', async () => {
            await assert.rejects(
                async () => {
                    await customerPurchaseService.activateSubscriptionFromPayment({
                        paymentId: pendingPayment.id,
                        status: 'SUCCESS',
                        customerUserId: customerB.user.id, // Attacker trying to activate Customer A's payment
                    });
                },
                (err) => err.code === 'FORBIDDEN' || err.statusCode === 403
            );
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Locked Renewal Rules: Active vs Expired Entitlements
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Locked Renewal Rules: Active vs Expired Entitlements', () => {
        it('3.1 Expired previous subscription renews starting from NOW + duration (does not preserve expired time)', async () => {
            // Customer B has a subscription that expired 10 days ago
            const pastExpiry = new Date(Date.now() - 10 * 86400 * 1000);
            await subscriptionRepo.create({
                tenantId: customerB.tenant.id,
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
                pricePaid: 5000.00,
                currency: 'TZS',
                durationDays: 7,
                status: 'EXPIRED',
                expiresAt: pastExpiry,
            });

            // Customer B purchases a 7-day plan
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
            });

            const beforeActivation = Date.now();
            const activation = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: purchase.payment.id,
                status: 'SUCCESS',
            });
            const afterActivation = Date.now();

            const sub = activation.subscription;
            const subExpiry = new Date(sub.expires_at).getTime();

            // Expected: NOW + 7 days
            const minExpected = beforeActivation + 7 * 86400 * 1000;
            const maxExpected = afterActivation + 7 * 86400 * 1000;

            assert.ok(subExpiry >= minExpected - 1000, `subExpiry ${subExpiry} must be >= ${minExpected}`);
            assert.ok(subExpiry <= maxExpected + 1000, `subExpiry ${subExpiry} must be <= ${maxExpected}`);
        });

        it('3.2 Active entitlement renews by extending existing expires_at + duration (preserves remaining time!)', async () => {
            // Customer B now has an active subscription expiring in 7 days
            const activeSub = await subscriptionRepo.findActiveByTenantId(customerB.tenant.id);
            assert.ok(activeSub, 'Must have active subscription');
            const priorExpiry = new Date(activeSub.expires_at).getTime();

            // Customer B purchases a second 30-day plan while still having ~7 days active
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan30Days.id,
            });

            const activation = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: purchase.payment.id,
                status: 'SUCCESS',
            });

            const newSub = activation.subscription;
            const newExpiry = new Date(newSub.expires_at).getTime();

            // Expected: exactly priorExpiry + 30 days
            const expectedExpiry = priorExpiry + 30 * 86400 * 1000;
            const diffMs = Math.abs(newExpiry - expectedExpiry);
            assert.ok(diffMs < 2000, `New expiry (${newExpiry}) must extend prior expiry (${priorExpiry}) by 30 days. Diff: ${diffMs}ms`);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Historical Pricing Snapshot Immutability
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Historical Pricing Snapshot Immutability', () => {
        it('4.1 changing plan price in catalog does NOT affect historical subscription snapshot', async () => {
            // Customer A purchases plan7Days (5000 TZS)
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            const activation = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: purchase.payment.id,
                status: 'SUCCESS',
            });

            const sub = activation.subscription;
            assert.strictEqual(Number(sub.price_paid), 5000);

            // Admin updates plan price to 12000 TZS in database
            await planRepo.update(plan7Days.id, { price: 12000.00 });

            // Verify subscription snapshot in DB still retains 5000 TZS
            const freshSub = await subscriptionRepo.findById(sub.id);
            assert.strictEqual(Number(freshSub.price_paid), 5000);
            assert.strictEqual(freshSub.currency, 'TZS');

            // Revert plan price
            await planRepo.update(plan7Days.id, { price: 5000.00 });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Idempotency & Concurrency Guarantees
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Idempotency & Concurrency Guarantees', () => {
        it('5.1 Idempotency: duplicate payment confirmation is a no-op and does not double-extend', async () => {
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });

            // 1st confirmation
            const firstResult = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: purchase.payment.id,
                status: 'SUCCESS',
            });
            assert.strictEqual(firstResult.success, true);
            const firstSub = firstResult.subscription;

            // 2nd confirmation with exact same payment
            const secondResult = await customerPurchaseService.activateSubscriptionFromPayment({
                paymentId: purchase.payment.id,
                status: 'SUCCESS',
            });
            assert.strictEqual(secondResult.success, true);
            assert.strictEqual(secondResult.alreadyActivated, true);
            assert.strictEqual(secondResult.subscription.id, firstSub.id);

            // Verify expiry was NOT extended a second time
            assert.strictEqual(
                new Date(secondResult.subscription.expires_at).toISOString(),
                new Date(firstSub.expires_at).toISOString()
            );
        });

        it('5.2 Concurrency: two workers activating the same payment simultaneously results in exactly one activation', async () => {
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });

            // Run two simultaneous activations of the same payment
            const [res1, res2] = await Promise.all([
                customerPurchaseService.activateSubscriptionFromPayment({ paymentId: purchase.payment.id, status: 'SUCCESS' }),
                customerPurchaseService.activateSubscriptionFromPayment({ paymentId: purchase.payment.id, status: 'SUCCESS' }),
            ]);

            assert.strictEqual(res1.success, true);
            assert.strictEqual(res2.success, true);

            // Exactly one subscription was linked to the payment
            const dbPayment = await paymentRepo.findById(purchase.payment.id);
            assert.ok(dbPayment.subscription_id);
            assert.strictEqual(res1.subscription.id, dbPayment.subscription_id);
            assert.strictEqual(res2.subscription.id, dbPayment.subscription_id);

            // One was first, one was alreadyActivated
            const alreadyActivatedCount = (res1.alreadyActivated ? 1 : 0) + (res2.alreadyActivated ? 1 : 0);
            assert.strictEqual(alreadyActivatedCount, 1);
        });

        it('5.3 Concurrency: two legitimate distinct purchases for same customer activated in parallel stack consecutively', async () => {
            // Create two distinct purchases: Purchase 1 = 7 days, Purchase 2 = 7 days
            const purchase1 = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            const purchase2 = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });

            const currentActive = await subscriptionRepo.findActiveByTenantId(customerA.tenant.id);
            const baselineExpiry = currentActive ? new Date(currentActive.expires_at).getTime() : Date.now();

            // Activate both purchases concurrently
            const [act1, act2] = await Promise.all([
                customerPurchaseService.activateSubscriptionFromPayment({ paymentId: purchase1.payment.id, status: 'SUCCESS' }),
                customerPurchaseService.activateSubscriptionFromPayment({ paymentId: purchase2.payment.id, status: 'SUCCESS' }),
            ]);

            assert.strictEqual(act1.success, true);
            assert.strictEqual(act2.success, true);

            // Latest active subscription must reflect both 7-day extensions (total 14 days added to baseline)
            const finalActive = await subscriptionRepo.findActiveByTenantId(customerA.tenant.id);
            const finalExpiry = new Date(finalActive.expires_at).getTime();

            const expectedExpiry = baselineExpiry + 14 * 86400 * 1000;
            const diffMs = Math.abs(finalExpiry - expectedExpiry);
            assert.ok(diffMs < 3000, `Final expiry (${finalExpiry}) must equal baseline (${baselineExpiry}) + 14 days. Diff: ${diffMs}ms`);
        });
    });
});
