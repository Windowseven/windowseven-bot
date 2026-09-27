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
const PaymentService = require('../src/application/services/PaymentService');
const { TestPaymentGateway } = require('../src/application/payments');
const { createRestApp } = require('../src/application/http/RestApp');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Payment Simulation & Provider Abstraction Suite', () => {
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
    let paymentGateway;
    let paymentService;
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

    const testSecret = 'sim_test_hmac_secret_998877';

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
            keyId: 'paymentsim-test-kid',
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
            pool,
            userRepo,
            tenantRepo,
            tenantMembershipRepo,
            platformRoleRepo,
            refreshTokenRepo,
            auditLogRepo,
            passwordService,
            tokenService,
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

        paymentGateway = new TestPaymentGateway({
            secretKey: testSecret,
            allowInProduction: true,
        });

        paymentService = new PaymentService({
            pool,
            paymentRepo,
            planRepo,
            subscriptionRepo,
            tenantMembershipRepo,
            platformService,
            paymentGateway,
            platformAuditRepo,
        });

        customerPurchaseService = new CustomerPurchaseService({
            pool,
            planRepo,
            paymentRepo,
            subscriptionRepo,
            tenantMembershipRepo,
            platformService,
            platformAuditRepo,
            paymentGateway,
        });

        appHandler = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo,
            userRepo,
            connRepo: whatsAppConnectionRepo,
            auditLogRepo,
            rateLimiter,
            platformRoleRepo,
            platformAuditRepo,
            platformService,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            customerPurchaseService,
            paymentGateway,
            paymentService,
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;

        // Clean up any leftover test data
        await pool.query("DELETE FROM payments WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@paymentsim.test';");

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

        // Provision Customers with Tanzanian numbers (+2557XXXXXXXX)
        const randA = Math.floor(10000000 + Math.random() * 90000000);
        const randB = Math.floor(10000000 + Math.random() * 90000000);

        customerA = await authService.register({
            email: `custA_${Date.now()}@paymentsim.test`,
            password: 'CustomerPass123!@#',
            phoneNumber: `+2557${randA}`,
        });
        const loginA = await authService.login({
            email: customerA.user.email,
            password: 'CustomerPass123!@#',
        });
        customerAToken = loginA.accessToken;

        customerB = await authService.register({
            email: `custB_${Date.now()}@paymentsim.test`,
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
        await pool.query("DELETE FROM payments WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM plans WHERE id IN ($1, $2, $3);", [plan7Days.id, plan30Days.id, inactivePlan.id]);
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM tenants WHERE id IN ($1, $2);", [customerA.tenant.id, customerB.tenant.id]);
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@paymentsim.test');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@paymentsim.test';");
        await pool.end();
    });

    async function request(method, path, { headers = {}, body = null, rawBody = null } = {}) {
        return new Promise((resolve, reject) => {
            const reqUrl = new URL(path, serverUrl);
            const req = http.request(reqUrl, {
                method,
                headers: {
                    ...(body && !headers['Content-Type'] && !headers['content-type'] ? { 'Content-Type': 'application/json' } : {}),
                    ...headers,
                },
            }, (res) => {
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    if (data && res.headers['content-type']?.includes('application/json')) {
                        try {
                            parsed = JSON.parse(data);
                        } catch {
                            parsed = data;
                        }
                    } else {
                        parsed = data;
                    }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: parsed,
                    });
                });
            });

            req.on('error', reject);

            if (rawBody !== null && rawBody !== undefined) {
                req.write(rawBody);
            } else if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Happy Path End-to-End Vertical Slice
    // ─────────────────────────────────────────────────────────────────────────
    describe('1. Happy Path End-to-End Vertical Slice', () => {
        let purchasedPayment;
        let checkoutDetails;

        it('1.1 should create purchase intent and return checkout representation', async () => {
            const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${customerAToken}` },
                body: { planId: plan7Days.id },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);
            const { payment, plan, checkout } = res.body.data;
            assert.ok(payment.id);
            assert.strictEqual(payment.status, 'PENDING');
            assert.strictEqual(payment.amount, 5000);
            assert.strictEqual(payment.currency, 'TZS');
            assert.ok(payment.transactionReference);

            assert.ok(checkout);
            assert.strictEqual(checkout.provider, 'TEST');
            assert.strictEqual(checkout.providerReference, `TEST-REF-${payment.transactionReference}`);
            assert.ok(checkout.checkoutUrl.includes(payment.transactionReference));

            purchasedPayment = payment;
            checkoutDetails = checkout;

            // Invariant: At initiation time, subscription is NOT active
            const subRes = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(subRes.status, 200);
            assert.strictEqual(subRes.body.data.hasActiveSubscription, false);
        });

        it('1.2 should process signed test callback and activate subscription atomically', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: purchasedPayment.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.status, 'SUCCESS');
            assert.ok(res.body.data.payment);
            assert.strictEqual(res.body.data.payment.status, 'SUCCESS');
            assert.ok(res.body.data.payment.subscription_id);
            assert.ok(res.body.data.subscription);
            assert.strictEqual(res.body.data.subscription.status, 'ACTIVE');
        });

        it('1.3 should reflect ACTIVE subscription at GET /api/v1/me/subscription', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.hasActiveSubscription, true);
            assert.strictEqual(res.body.data.status, 'ACTIVE');
            assert.strictEqual(res.body.data.subscription.planId, plan7Days.id);
            assert.strictEqual(res.body.data.subscription.pricePaid, 5000);
            assert.strictEqual(res.body.data.subscription.durationDays, 7);
        });

        it('1.4 should reflect payment in customer history at GET /api/v1/me/payments', async () => {
            const res = await request('GET', '/api/v1/me/payments', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.payments));
            const found = res.body.data.payments.find((p) => p.id === purchasedPayment.id);
            assert.ok(found);
            assert.strictEqual(found.status, 'SUCCESS');
            assert.strictEqual(found.amount, 5000);
            assert.ok(found.subscriptionId);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Cryptographic Signature & Verification Security
    // ─────────────────────────────────────────────────────────────────────────
    describe('2. Cryptographic Signature & Verification Security', () => {
        let payment2;

        beforeEach(async () => {
            const res = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            payment2 = res.payment;
        });

        it('2.1 missing signature header is rejected with 401 INVALID_SIGNATURE', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: { 'Content-Type': 'application/json' }, // missing signature
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_SIGNATURE');

            const dbPayment = await paymentRepo.findById(payment2.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
        });

        it('2.2 invalid signature is rejected with 401 INVALID_SIGNATURE', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: {
                    ...sim.headers,
                    'x-webhook-signature': '00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff',
                },
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_SIGNATURE');
        });

        it('2.3 tampered payload with valid original signature is rejected with 401 INVALID_SIGNATURE', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
            });

            // Tamper with body: replace amount 5000 with 100
            const tamperedBody = sim.rawBody.replace('5000', '100');

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers, // holds signature of original untampered body
                rawBody: tamperedBody,
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_SIGNATURE');
        });

        it('2.4 missing transaction reference in callback payload is rejected with 400 INVALID_CALLBACK', async () => {
            const payload = {
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            };
            const crypto = require('node:crypto');
            const rawBody = JSON.stringify(payload);
            const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: {
                    'x-webhook-signature': signature,
                    'Content-Type': 'application/json',
                },
                rawBody,
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_CALLBACK');
        });

        it('2.5 unknown transaction reference is rejected with 404 PAYMENT_NOT_FOUND', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: 'TX_NON_EXISTENT_REF_9999',
                status: 'SUCCESS',
                amount: 5000,
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'PAYMENT_NOT_FOUND');
        });

        it('2.6 wrong amount is rejected with 400 AMOUNT_MISMATCH and does NOT mark payment FAILED', async () => {
            // Attacker creates a valid signed callback with lower amount (100 instead of 5000)
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 100, // Underpayment attack
                currency: 'TZS',
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'AMOUNT_MISMATCH');

            // Invariant (Rule 9): Untrusted callback does NOT fail valid internal payment
            const dbPayment = await paymentRepo.findById(payment2.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
            assert.strictEqual(dbPayment.subscription_id, null);
        });

        it('2.7 wrong currency is rejected with 400 CURRENCY_MISMATCH and does NOT mark payment FAILED', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'USD', // Currency mismatch attack
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'CURRENCY_MISMATCH');

            const dbPayment = await paymentRepo.findById(payment2.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
            assert.strictEqual(dbPayment.subscription_id, null);
        });

        it('2.8 provider/customer/tenant spoofing cannot activate another account', async () => {
            // Callback attempts to pass customer B's tenant/user details in payload
            const payload = {
                transactionReference: payment2.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
                tenantId: customerB.tenant.id, // Spoofing attempt
                customerUserId: customerB.user.id,
            };
            const crypto = require('node:crypto');
            const rawBody = JSON.stringify(payload);
            const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: {
                    'x-webhook-signature': signature,
                    'Content-Type': 'application/json',
                },
                rawBody,
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);

            // DB Record: Strictly activated for Customer A's tenant (internal payment record is authoritative)
            const sub = await subscriptionRepo.findById(res.body.data.subscription.id);
            assert.strictEqual(sub.tenant_id, customerA.tenant.id);
            assert.strictEqual(sub.customer_user_id, customerA.user.id);
            assert.notStrictEqual(sub.tenant_id, customerB.tenant.id);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Payment State Transitions
    // ─────────────────────────────────────────────────────────────────────────
    describe('3. Payment State Transitions', () => {
        let payment3;

        beforeEach(async () => {
            const res = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            payment3 = res.payment;
        });

        it('3.1 valid provider FAILED callback transitions payment to FAILED with failure reason', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment3.transactionReference,
                status: 'FAILED',
                amount: 5000,
                currency: 'TZS',
                failureReason: 'Mobile money subscriber cancelled transaction',
            });

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.status, 'FAILED');
            assert.strictEqual(res.body.data.payment.status, 'FAILED');
            assert.strictEqual(res.body.data.subscription, null);

            const dbPayment = await paymentRepo.findById(payment3.id);
            assert.strictEqual(dbPayment.status, 'FAILED');
            assert.strictEqual(dbPayment.failure_reason, 'Mobile money subscriber cancelled transaction');
            assert.strictEqual(dbPayment.subscription_id, null);
        });

        it('3.2 FAILED payment does not create a customer subscription', async () => {
            const beforeCount = (await subscriptionRepo.findAll({ tenantId: customerA.tenant.id })).length;

            const sim = paymentGateway.simulateCallback({
                transactionReference: payment3.transactionReference,
                status: 'FAILED',
                amount: 5000,
                currency: 'TZS',
                failureReason: 'Insufficient funds',
            });

            await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            const afterCount = (await subscriptionRepo.findAll({ tenantId: customerA.tenant.id })).length;
            assert.strictEqual(afterCount, beforeCount);
        });

        it('3.3 PENDING payment never activates subscription without callback', async () => {
            const dbPayment = await paymentRepo.findById(payment3.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
            assert.strictEqual(dbPayment.subscription_id, null);
        });

        it('3.4 unsupported provider status is rejected safely without mutating DB payment', async () => {
            const payload = {
                transactionReference: payment3.transactionReference,
                status: 'SOME_UNKNOWN_STATUS',
                amount: 5000,
                currency: 'TZS',
            };
            const crypto = require('node:crypto');
            const rawBody = JSON.stringify(payload);
            const signature = crypto.createHmac('sha256', testSecret).update(rawBody).digest('hex');

            const res = await request('POST', '/api/v1/payments/callback', {
                headers: {
                    'x-webhook-signature': signature,
                    'Content-Type': 'application/json',
                },
                rawBody,
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_CALLBACK');

            const dbPayment = await paymentRepo.findById(payment3.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Idempotency & Replay Defense
    // ─────────────────────────────────────────────────────────────────────────
    describe('4. Idempotency & Replay Defense', () => {
        let payment4;

        beforeEach(async () => {
            const res = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            payment4 = res.payment;
        });

        it('4.1 repeated successful callback returns ALREADY_PROCESSED safely', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment4.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });

            // First callback: activates
            const res1 = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });
            assert.strictEqual(res1.status, 200);
            assert.strictEqual(res1.body.data.status, 'SUCCESS');
            const subId = res1.body.data.subscription.id;

            // Second callback (replay): returns ALREADY_PROCESSED
            const res2 = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });
            assert.strictEqual(res2.status, 200);
            assert.strictEqual(res2.body.data.status, 'ALREADY_PROCESSED');
            assert.strictEqual(res2.body.data.subscription.id, subId);
        });

        it('4.2 duplicate callback does not create a duplicate subscription', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment4.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });

            await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            const initialSubs = await subscriptionRepo.findAll({ tenantId: customerA.tenant.id });

            // Replay 3 times
            for (let i = 0; i < 3; i++) {
                await request('POST', '/api/v1/payments/callback', {
                    headers: sim.headers,
                    rawBody: sim.rawBody,
                });
            }

            const afterSubs = await subscriptionRepo.findAll({ tenantId: customerA.tenant.id });
            assert.strictEqual(afterSubs.length, initialSubs.length);
        });

        it('4.3 duplicate callback does not double-extend subscription expiry date', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment4.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });

            const res1 = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });
            const originalExpiry = res1.body.data.subscription.expires_at;

            // Replay callback
            const res2 = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });

            assert.strictEqual(res2.body.data.status, 'ALREADY_PROCESSED');
            const replayedSub = await subscriptionRepo.findById(res1.body.data.subscription.id);
            assert.strictEqual(
                new Date(replayedSub.expires_at).toISOString(),
                new Date(originalExpiry).toISOString()
            );
        });

        it('4.4 concurrent duplicate callbacks result in exactly one activation', async () => {
            const sim = paymentGateway.simulateCallback({
                transactionReference: payment4.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });

            // Fire 5 concurrent requests simultaneously
            const results = await Promise.all([
                request('POST', '/api/v1/payments/callback', { headers: sim.headers, rawBody: sim.rawBody }),
                request('POST', '/api/v1/payments/callback', { headers: sim.headers, rawBody: sim.rawBody }),
                request('POST', '/api/v1/payments/callback', { headers: sim.headers, rawBody: sim.rawBody }),
                request('POST', '/api/v1/payments/callback', { headers: sim.headers, rawBody: sim.rawBody }),
                request('POST', '/api/v1/payments/callback', { headers: sim.headers, rawBody: sim.rawBody }),
            ]);

            results.forEach((r) => {
                assert.strictEqual(r.status, 200);
                assert.ok(r.body.data.status === 'SUCCESS' || r.body.data.status === 'ALREADY_PROCESSED');
            });

            const successCount = results.filter((r) => r.body.data.status === 'SUCCESS').length;
            const alreadyProcessedCount = results.filter((r) => r.body.data.status === 'ALREADY_PROCESSED').length;

            assert.strictEqual(successCount, 1);
            assert.strictEqual(alreadyProcessedCount, 4);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Renewal Rules: Active vs Expired Entitlements
    // ─────────────────────────────────────────────────────────────────────────
    describe('5. Renewal Rules: Active vs Expired Entitlements', () => {
        it('5.1 active subscription uses additive renewal preserving remaining duration', async () => {
            // First payment: 7 days
            const p1 = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
            });
            const sim1 = paymentGateway.simulateCallback({
                transactionReference: p1.payment.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });
            const res1 = await request('POST', '/api/v1/payments/callback', {
                headers: sim1.headers,
                rawBody: sim1.rawBody,
            });
            const sub1 = res1.body.data.subscription;
            const expiry1 = new Date(sub1.expires_at).getTime();

            // Second payment: 30 days while 7-day plan is active
            const p2 = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan30Days.id,
            });
            const sim2 = paymentGateway.simulateCallback({
                transactionReference: p2.payment.transactionReference,
                status: 'SUCCESS',
                amount: 15000,
                currency: 'TZS',
            });
            const res2 = await request('POST', '/api/v1/payments/callback', {
                headers: sim2.headers,
                rawBody: sim2.rawBody,
            });
            const sub2 = res2.body.data.subscription;
            const expiry2 = new Date(sub2.expires_at).getTime();

            // Expected: exactly 30 days added to prior expiry1
            const diffDays = Math.round((expiry2 - expiry1) / (24 * 3600 * 1000));
            assert.strictEqual(diffDays, 30);
        });

        it('5.2 expired subscription starts renewal from NOW', async () => {
            // Expire any existing active subscriptions for Customer B
            await pool.query("UPDATE customer_subscriptions SET status = 'EXPIRED', expires_at = NOW() - INTERVAL '1 day' WHERE tenant_id = $1;", [customerB.tenant.id]);

            // Create an expired subscription in DB for customer B
            const pastDate = new Date(Date.now() - 5 * 86400 * 1000);
            await subscriptionRepo.create({
                tenantId: customerB.tenant.id,
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
                pricePaid: 5000,
                currency: 'TZS',
                durationDays: 7,
                status: 'EXPIRED',
                expiresAt: pastDate,
            });

            const p = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
            });
            const before = Date.now();
            const sim = paymentGateway.simulateCallback({
                transactionReference: p.payment.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });
            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });
            const after = Date.now();

            const sub = res.body.data.subscription;
            const subExpiry = new Date(sub.expires_at).getTime();
            const expectedMin = before + 7 * 86400 * 1000;
            const expectedMax = after + 7 * 86400 * 1000;

            assert.ok(subExpiry >= expectedMin - 1000 && subExpiry <= expectedMax + 1000);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Historical Pricing Snapshot Immutability
    // ─────────────────────────────────────────────────────────────────────────
    describe('6. Historical Pricing Snapshot Immutability', () => {
        it('6.1 pricePaid in subscription remains unchanged when plan price changes later', async () => {
            const p = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerA.user.id,
                planId: plan7Days.id,
            });
            const sim = paymentGateway.simulateCallback({
                transactionReference: p.payment.transactionReference,
                status: 'SUCCESS',
                amount: 5000,
                currency: 'TZS',
            });
            const res = await request('POST', '/api/v1/payments/callback', {
                headers: sim.headers,
                rawBody: sim.rawBody,
            });
            const sub = res.body.data.subscription;
            assert.strictEqual(Number(sub.price_paid), 5000);

            // Admin updates plan price to 9999
            await planRepo.update(plan7Days.id, { price: 9999.00 });

            // Verified: subscription still records 5000
            const freshSub = await subscriptionRepo.findById(sub.id);
            assert.strictEqual(Number(freshSub.price_paid), 5000);

            // Revert plan price
            await planRepo.update(plan7Days.id, { price: 5000.00 });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Customer & Tenant Isolation
    // ─────────────────────────────────────────────────────────────────────────
    describe('7. Customer & Tenant Isolation', () => {
        it('7.1 Customer A cannot view Customer B payments via GET /api/v1/me/payments', async () => {
            const resA = await request('GET', '/api/v1/me/payments', {
                headers: { Authorization: `Bearer ${customerAToken}` },
            });
            assert.strictEqual(resA.status, 200);

            const resB = await request('GET', '/api/v1/me/payments', {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(resB.status, 200);

            const paymentsA = resA.body.data.payments;
            const paymentsB = resB.body.data.payments;

            paymentsA.forEach((p) => {
                assert.strictEqual(p.tenantId, customerA.tenant.id);
            });
            paymentsB.forEach((p) => {
                assert.strictEqual(p.tenantId, customerB.tenant.id);
            });

            // Set intersection should be empty
            const idsA = new Set(paymentsA.map((p) => p.id));
            const overlap = paymentsB.filter((p) => idsA.has(p.id));
            assert.strictEqual(overlap.length, 0);
        });

        it('7.2 Unauthenticated request to /api/v1/me/payments is rejected with 401', async () => {
            const res = await request('GET', '/api/v1/me/payments');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Initiation Failure Safety
    // ─────────────────────────────────────────────────────────────────────────
    describe('8. Initiation Failure Safety', () => {
        it('8.1 Provider initiation failure leaves database payment state consistent', async () => {
            // Count subscriptions before call
            const beforeSubs = await subscriptionRepo.findAll({ tenantId: customerA.tenant.id });

            // Create a custom gateway that throws on initiation
            const failingGateway = new TestPaymentGateway({ allowInProduction: true });
            failingGateway.initiatePayment = async () => {
                throw new Error('Simulated gateway timeout during initiation');
            };

            const failingPurchaseService = new CustomerPurchaseService({
                pool,
                planRepo,
                paymentRepo,
                subscriptionRepo,
                tenantMembershipRepo,
                platformService,
                paymentGateway: failingGateway,
            });

            await assert.rejects(
                async () => {
                    await failingPurchaseService.createPurchaseIntent({
                        customerUserId: customerA.user.id,
                        planId: plan7Days.id,
                    });
                },
                /Simulated gateway timeout/
            );

            // Invariant: No new subscription was created
            const afterSubs = await subscriptionRepo.findAll({ tenantId: customerA.tenant.id });
            assert.strictEqual(afterSubs.length, beforeSubs.length);
        });

        it('8.2 Checkout initiation never activates subscription prematurely', async () => {
            const purchase = await customerPurchaseService.createPurchaseIntent({
                customerUserId: customerB.user.id,
                planId: plan7Days.id,
            });

            const dbPayment = await paymentRepo.findById(purchase.payment.id);
            assert.strictEqual(dbPayment.status, 'PENDING');
            assert.strictEqual(dbPayment.subscription_id, null);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Production Environment Safeguard
    // ─────────────────────────────────────────────────────────────────────────
    describe('9. Production Environment Safeguard', () => {
        it('9.1 TestPaymentGateway throws immediately in production mode when allowInProduction is false', () => {
            const origEnv = process.env.NODE_ENV;
            try {
                process.env.NODE_ENV = 'production';
                assert.throws(
                    () => new TestPaymentGateway({ allowInProduction: false }),
                    /TestPaymentGateway cannot be used in production environment/
                );
            } finally {
                process.env.NODE_ENV = origEnv;
            }
        });
    });
});
