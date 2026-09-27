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
    WorkerRepository,
} = require('../src/repositories');

const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const PlatformService = require('../src/application/services/PlatformService');
const ConnectionService = require('../src/application/services/ConnectionService');
const CustomerPurchaseService = require('../src/application/services/CustomerPurchaseService');
const PaymentService = require('../src/application/services/PaymentService');
const { TestPaymentGateway } = require('../src/application/payments');
const { defaultQrStore } = require('../src/whatsapp/control/EphemeralQrStore');
const { defaultPairingCodeStore } = require('../src/whatsapp/control/EphemeralPairingCodeStore');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { createRestApp } = require('../src/application/http/RestApp');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass@127.0.0.1:5433/windowseven_test';

describe('Customer Dashboard Backend Readiness Suite', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let refreshTokenRepo;
    let auditLogRepo;
    let connRepo;
    let planRepo;
    let subscriptionRepo;
    let paymentRepo;
    let workerRepo;

    let passwordService;
    let tokenService;
    let authService;
    let platformService;
    let connectionService;
    let customerPurchaseService;
    let paymentGateway;
    let paymentService;
    let commandGateway;
    let rateLimiter;
    let appHandler;
    let server;
    let serverUrl;

    const testSecret = 'dash_readiness_secret_123';
    let planStarter;
    let planPro;

    let phoneA;
    let phoneB;

    // Customer A (Active subscriber with connection, payments, notifications)
    let customerA;
    let tokenA;
    let tenantA;
    let subA;
    let paymentA1;
    let paymentA2;

    // Customer B (Empty state: no sub, no connection, no payments)
    let customerB;
    let tokenB;
    let tenantB;

    async function request(method, path, { headers = {}, body = null, rawBody = null } = {}) {
        return new Promise((resolve, reject) => {
            const reqUrl = new URL(path, serverUrl);
            const req = http.request(reqUrl, {
                method,
                agent: false,
                headers: {
                    Connection: 'close',
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

            if (rawBody) {
                req.write(rawBody);
            } else if (body) {
                req.write(JSON.stringify(body));
            }
            req.end();
        });
    }

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        planRepo = new PlanRepository(pool);
        subscriptionRepo = new SubscriptionRepository(pool);
        paymentRepo = new PaymentRepository(pool);
        workerRepo = new WorkerRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'dash-ready-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 3600,
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
            connRepo,
            workerRepo,
            platformAuditRepo,
            platformRoleRepo,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            userRepo,
        });

        commandGateway = new ConnectionCommandGateway({ pool });

        connectionService = new ConnectionService({
            pool,
            connRepo,
            auditLogRepo,
            commandGateway,
            qrStore: defaultQrStore,
            pairingStore: defaultPairingCodeStore,
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
            connRepo,
            auditLogRepo,
            rateLimiter,
            platformRoleRepo,
            platformAuditRepo,
            platformService,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            connectionService,
            customerPurchaseService,
            paymentGateway,
            paymentService,
            cookieOptions: { secure: false },
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;

        // Create test plans
        planStarter = await planRepo.create({
            name: `Starter Plan ${Date.now()}`,
            price: 10000.00,
            currency: 'TZS',
            durationDays: 14,
            description: 'Starter tier plan',
            status: 'ACTIVE',
        });

        planPro = await planRepo.create({
            name: `Pro Plan ${Date.now()}`,
            price: 30000.00,
            currency: 'TZS',
            durationDays: 30,
            description: 'Professional tier plan',
            status: 'ACTIVE',
        });

        // Generate distinct random phone numbers for Customer A and Customer B
        const randA = Math.floor(10000000 + Math.random() * 90000000);
        phoneA = `+2557${randA}`;
        const randB = Math.floor(10000000 + Math.random() * 90000000);
        phoneB = `+2557${randB}`;

        // Register Customer A
        const regA = await authService.register({
            email: `dash_cust_a_${Date.now()}_${randA}@readiness.test`,
            password: 'CustomerPass123!@#',
            phoneNumber: phoneA,
        });
        customerA = regA.user;
        tenantA = regA.tenant;
        const loginA = await authService.login({
            email: customerA.email,
            password: 'CustomerPass123!@#',
        });
        tokenA = loginA.accessToken;

        // Provision active subscription for Customer A
        subA = await subscriptionRepo.create({
            tenantId: tenantA.id,
            customerUserId: customerA.id,
            planId: planPro.id,
            pricePaid: 30000.00,
            currency: 'TZS',
            durationDays: 30,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 25 * 24 * 60 * 60 * 1000),
        });

        // Create payments for Customer A (1 SUCCESS, 1 PENDING)
        paymentA1 = await paymentRepo.create({
            tenantId: tenantA.id,
            customerUserId: customerA.id,
            planId: planPro.id,
            amount: 30000.00,
            currency: 'TZS',
            provider: 'TEST',
            transactionReference: `TX_A1_${Date.now()}_${randA}`,
            status: 'SUCCESS',
            subscriptionId: subA.id,
        });

        paymentA2 = await paymentRepo.create({
            tenantId: tenantA.id,
            customerUserId: customerA.id,
            planId: planStarter.id,
            amount: 10000.00,
            currency: 'TZS',
            provider: 'TEST',
            transactionReference: `TX_A2_${Date.now()}_${randA}`,
            status: 'PENDING',
        });

        // Record a notification for Customer A
        await subscriptionRepo.recordNotification(subA.id, tenantA.id, '3_DAYS_BEFORE');

        // Provision a connection for Customer A
        await connRepo.createForTenant(tenantA.id, {
            phoneNumber: phoneA,
            displayName: 'My Test Bot',
            status: 'CONNECTED',
            desiredState: 'RUNNING',
            actualState: 'ACTIVE',
        });

        // Register Customer B (Empty state: no sub, no connection, no payments)
        const regB = await authService.register({
            email: `dash_cust_b_${Date.now()}_${randB}@readiness.test`,
            password: 'CustomerPass123!@#',
            phoneNumber: phoneB,
        });
        customerB = regB.user;
        tenantB = regB.tenant;
        const loginB = await authService.login({
            email: customerB.email,
            password: 'CustomerPass123!@#',
        });
        tokenB = loginB.accessToken;
    });

    after(async () => {
        defaultQrStore.clearAll();
        defaultPairingCodeStore.clearAll();
        if (commandGateway) commandGateway.removeAllListeners();
        if (rateLimiter) rateLimiter.destroy();
        if (server) {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        }

        // Cleanup
        await pool.query("DELETE FROM subscription_notifications WHERE tenant_id IN ($1, $2);", [tenantA.id, tenantB.id]);
        await pool.query("DELETE FROM payments WHERE customer_user_id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.query("DELETE FROM whatsapp_connections WHERE tenant_id IN ($1, $2);", [tenantA.id, tenantB.id]);
        await pool.query("DELETE FROM plans WHERE id IN ($1, $2);", [planStarter.id, planPro.id]);
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.query("DELETE FROM tenants WHERE id IN ($1, $2);", [tenantA.id, tenantB.id]);
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.query("DELETE FROM users WHERE id IN ($1, $2);", [customerA.id, customerB.id]);
        await pool.end();
    });

    beforeEach(() => {
        if (rateLimiter) rateLimiter.reset();
    });

    // =========================================================================
    // 1. OVERVIEW (GET /api/v1/me/overview)
    // =========================================================================
    describe('1. Overview (GET /api/v1/me/overview)', () => {
        it('1.1 should return complete overview for active customer', async () => {
            const res = await request('GET', '/api/v1/me/overview', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            const data = res.body.data;

            // Customer details
            assert.strictEqual(data.customer.user.id, customerA.id);
            assert.strictEqual(data.customer.user.email, customerA.email);
            assert.strictEqual(data.customer.tenant.id, tenantA.id);
            assert.strictEqual(data.customer.tenant.role, 'OWNER');

            // Subscription details
            assert.strictEqual(data.subscription.status, 'ACTIVE');
            assert.strictEqual(data.subscription.hasActiveSubscription, true);
            assert.strictEqual(data.subscription.subscription.id, subA.id);
            assert.strictEqual(data.subscription.daysRemaining > 0, true);

            // WhatsApp connection details
            assert.ok(data.connection);
            assert.strictEqual(data.connection.desiredState, 'RUNNING');

            // Recent payments & notifications
            assert.strictEqual(Array.isArray(data.recentPayments), true);
            assert.strictEqual(data.recentPayments.length >= 2, true);
            assert.strictEqual(Array.isArray(data.recentNotifications), true);
            assert.strictEqual(data.recentNotifications.length >= 1, true);

            // Quick actions
            assert.strictEqual(data.quickActions.canRenewSubscription, true);
            assert.strictEqual(data.quickActions.needsSubscription, false);
        });

        it('1.2 should return correct empty state for customer with no subscription or connection', async () => {
            const res = await request('GET', '/api/v1/me/overview', {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            assert.strictEqual(res.status, 200);
            const data = res.body.data;

            assert.strictEqual(data.customer.user.id, customerB.id);
            assert.strictEqual(data.subscription.status, 'NONE');
            assert.strictEqual(data.subscription.hasActiveSubscription, false);
            assert.strictEqual(data.subscription.subscription, null);
            assert.strictEqual(data.connection, null);
            assert.deepStrictEqual(data.recentPayments, []);
            assert.deepStrictEqual(data.recentNotifications, []);
            assert.strictEqual(data.quickActions.needsSubscription, true);
            assert.strictEqual(data.quickActions.canStartConnection, false);
        });

        it('1.3 should reject unauthenticated request with 401 AUTH_REQUIRED', async () => {
            const res = await request('GET', '/api/v1/me/overview');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });
    });

    // =========================================================================
    // 2. SUBSCRIPTION (GET /api/v1/me/subscription & GET /api/v1/plans)
    // =========================================================================
    describe('2. Subscription & Plans', () => {
        it('2.1 GET /api/v1/plans returns active plans catalog', async () => {
            const res = await request('GET', '/api/v1/plans');
            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.plans));
            const starter = res.body.data.plans.find((p) => p.id === planStarter.id);
            assert.ok(starter);
            assert.strictEqual(Number(starter.price), 10000);
            assert.strictEqual(starter.currency, 'TZS');
            assert.strictEqual(starter.durationDays, 14);
        });

        it('2.2 GET /api/v1/me/subscription returns authoritative subscription info', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.status, 'ACTIVE');
            assert.strictEqual(res.body.data.hasActiveSubscription, true);
            assert.strictEqual(res.body.data.subscription.id, subA.id);
            assert.strictEqual(Number(res.body.data.subscription.pricePaid), 30000);
            assert.strictEqual(res.body.data.subscription.currency, 'TZS');
        });

        it('2.3 Customer B receives honest empty subscription state (status: NONE)', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.subscription, null);
            assert.strictEqual(res.body.data.status, 'NONE');
            assert.strictEqual(res.body.data.hasActiveSubscription, false);
        });
    });

    // =========================================================================
    // 3. WHATSAPP CONNECTION
    // =========================================================================
    describe('3. WhatsApp Connection', () => {
        it('3.1 Customer A can retrieve own connection state', async () => {
            const res = await request('GET', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.connection);
            assert.strictEqual(res.body.data.connection.desiredState, 'RUNNING');
        });

        it('3.2 Customer B (no sub) has connection: null and is blocked from starting', async () => {
            const readRes = await request('GET', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${tokenB}` },
            });
            assert.strictEqual(readRes.status, 200);
            assert.strictEqual(readRes.body.data.connection, null);

            const startRes = await request('POST', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${tokenB}` },
                body: { phoneNumber: phoneB },
            });
            assert.strictEqual(startRes.status, 403);
            assert.strictEqual(startRes.body.error.code, 'SUBSCRIPTION_REQUIRED');
        });
    });

    // =========================================================================
    // 4. PAYMENTS & HISTORY (GET /api/v1/me/payments & /api/v1/me/payments/:id)
    // =========================================================================
    describe('4. Payments & History', () => {
        it('4.1 should return payment history with consistent fields (plan, amount, currency, status, reference)', async () => {
            const res = await request('GET', '/api/v1/me/payments', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.payments));
            assert.strictEqual(res.body.data.payments.length >= 2, true);

            const p1 = res.body.data.payments.find((p) => p.id === paymentA1.id);
            assert.ok(p1);
            assert.strictEqual(p1.status, 'SUCCESS');
            assert.strictEqual(p1.amount, 30000);
            assert.strictEqual(p1.currency, 'TZS');
            assert.strictEqual(p1.reference, paymentA1.transaction_reference);
            assert.ok(p1.createdAt);

            const p2 = res.body.data.payments.find((p) => p.id === paymentA2.id);
            assert.ok(p2);
            assert.strictEqual(p2.status, 'PENDING');
        });

        it('4.2 should support pagination (?page=1&limit=1)', async () => {
            const res = await request('GET', '/api/v1/me/payments?page=1&limit=1', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.payments.length, 1);
            assert.ok(res.body.data.pagination);
            assert.strictEqual(res.body.data.pagination.page, 1);
            assert.strictEqual(res.body.data.pagination.limit, 1);
            assert.strictEqual(res.body.data.pagination.total >= 2, true);
        });

        it('4.3 should support status filtering (?status=SUCCESS)', async () => {
            const res = await request('GET', '/api/v1/me/payments?status=SUCCESS', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.payments.every((p) => p.status === 'SUCCESS'));
        });

        it('4.4 Customer B receives empty payments array and total: 0', async () => {
            const res = await request('GET', '/api/v1/me/payments', {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.body.data.payments, []);
            assert.strictEqual(res.body.data.pagination.total, 0);
        });

        it('4.5 should return single payment details for Customer A (GET /api/v1/me/payments/:id)', async () => {
            const res = await request('GET', `/api/v1/me/payments/${paymentA1.id}`, {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.payment);
            assert.strictEqual(res.body.data.payment.id, paymentA1.id);
            assert.strictEqual(res.body.data.payment.reference, paymentA1.transaction_reference);
            assert.strictEqual(res.body.data.payment.status, 'SUCCESS');
        });

        it('4.6 IDOR Protection: Customer B cannot view Customer A payment details', async () => {
            const res = await request('GET', `/api/v1/me/payments/${paymentA1.id}`, {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');
        });
    });

    // =========================================================================
    // 5. NOTIFICATIONS (GET /api/v1/me/notifications)
    // =========================================================================
    describe('5. Notifications (GET /api/v1/me/notifications)', () => {
        it('5.1 should return customer notifications with friendly title and message', async () => {
            const res = await request('GET', '/api/v1/me/notifications', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.notifications));
            assert.strictEqual(res.body.data.notifications.length >= 1, true);

            const notif = res.body.data.notifications[0];
            assert.strictEqual(notif.type, '3_DAYS_BEFORE');
            assert.strictEqual(notif.title, 'Subscription Expiring Soon');
            assert.strictEqual(typeof notif.message, 'string');
            assert.ok(notif.sentAt);
        });

        it('5.2 should support pagination on notifications', async () => {
            const res = await request('GET', '/api/v1/me/notifications?page=1&limit=10', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.pagination);
            assert.strictEqual(res.body.data.pagination.page, 1);
            assert.strictEqual(res.body.data.pagination.limit, 10);
            assert.strictEqual(res.body.data.pagination.total >= 1, true);
        });

        it('5.3 IDOR Protection: Customer B cannot view Customer A notifications', async () => {
            const res = await request('GET', '/api/v1/me/notifications', {
                headers: { Authorization: `Bearer ${tokenB}` },
            });

            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.body.data.notifications, []);
            assert.strictEqual(res.body.data.pagination.total, 0);
        });
    });

    // =========================================================================
    // 6. ACCOUNT (GET /api/v1/me)
    // =========================================================================
    describe('6. Account (GET /api/v1/me)', () => {
        it('6.1 should return customer identity without exposing password hash or internal secrets', async () => {
            const res = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.user.id, customerA.id);
            assert.strictEqual(res.body.data.user.email, customerA.email);
            assert.strictEqual(res.body.data.tenant.id, tenantA.id);
            assert.strictEqual(res.body.data.user.password, undefined);
            assert.strictEqual(res.body.data.user.password_hash, undefined);
        });
    });

    // =========================================================================
    // 7. SUPPORT (GET /api/v1/me/support)
    // =========================================================================
    describe('7. Support (GET /api/v1/me/support)', () => {
        it('7.1 should return platform contact channels and customer FAQs', async () => {
            const res = await request('GET', '/api/v1/me/support', {
                headers: { Authorization: `Bearer ${tokenA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.support);
            assert.ok(res.body.data.support.email);
            assert.ok(res.body.data.support.whatsappChannel);
            assert.ok(Array.isArray(res.body.data.support.faq));
            assert.strictEqual(res.body.data.support.faq.length >= 3, true);
        });
    });
});
