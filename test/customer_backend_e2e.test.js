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
const { SubscriptionNotificationService } = require('../src/application/services/SubscriptionNotificationService');
const { TestPaymentGateway } = require('../src/application/payments');
const { defaultQrStore } = require('../src/whatsapp/control/EphemeralQrStore');
const { defaultPairingCodeStore } = require('../src/whatsapp/control/EphemeralPairingCodeStore');
const { ConnectionCommandGateway } = require('../src/whatsapp/control/ConnectionCommandGateway');
const { LocalEventPublisher } = require('../src/application/realtime/EventPublisher');
const { createRestApp } = require('../src/application/http/RestApp');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass@127.0.0.1:5433/windowseven_test';

describe('Customer Backend End-to-End Complete Journey', () => {
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
    let eventPublisher;
    let rateLimiter;
    let appHandler;
    let server;
    let serverUrl;

    const testSecret = 'cust_e2e_hmac_secret_445566';
    let testPlan;
    let customerPhone;
    let customerEmail;
    const customerPassword = 'CustomerSecure123!@#';

    // State preserved across journey
    let customerUser;
    let customerToken;
    let customerTenant;
    let activeSubscription;
    let customerConnection;
    let dispatchedNotifications = [];

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
            keyId: 'cust-e2e-kid',
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
        eventPublisher = new LocalEventPublisher();

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

        // Create standard plan
        testPlan = await planRepo.create({
            name: `E2E Journey Plan ${Date.now()}`,
            price: 25000.00,
            currency: 'TZS',
            durationDays: 30,
            description: 'Comprehensive E2E Plan',
            status: 'ACTIVE',
        });

        const rand = Math.floor(10000000 + Math.random() * 90000000);
        customerPhone = `+2557${rand}`;
        customerEmail = `e2e_cust_${Date.now()}@journey.test`;
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

        // Clean up test database data
        await pool.query("DELETE FROM subscription_notifications WHERE subscription_id IN (SELECT id FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test'));");
        await pool.query("DELETE FROM payments WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        await pool.query("DELETE FROM whatsapp_connections WHERE tenant_id IN (SELECT tenant_id FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test'));");
        if (testPlan) {
            await pool.query("DELETE FROM plans WHERE id = $1;", [testPlan.id]);
        }
        const tenantIdsRes = await pool.query("SELECT tenant_id FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        await pool.query("DELETE FROM platform_user_roles WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        if (tenantIdsRes.rows.length > 0) {
            const tIds = tenantIdsRes.rows.map((r) => r.tenant_id);
            await pool.query("DELETE FROM tenants WHERE id = ANY($1);", [tIds]);
        }
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE '%@journey.test');");
        await pool.query("DELETE FROM users WHERE email LIKE '%@journey.test';");
        await pool.end();
    });

    beforeEach(() => {
        if (rateLimiter) rateLimiter.reset();
    });

    // =========================================================================
    // THE 14-STEP CUSTOMER JOURNEY
    // =========================================================================

    it('Step 1: Customer Registration (POST /api/v1/auth/register)', async () => {
        const res = await request('POST', '/api/v1/auth/register', {
            body: {
                email: customerEmail,
                password: customerPassword,
                phoneNumber: customerPhone,
            },
        });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.data.user);
        assert.ok(res.body.data.tenant);
        assert.strictEqual(res.body.data.user.email, customerEmail);
        assert.strictEqual(res.body.data.user.role, 'CUSTOMER');

        customerUser = res.body.data.user;
        customerTenant = res.body.data.tenant;

        // Verify membership role in database is OWNER
        const membership = await tenantMembershipRepo.findByTenantAndUser(customerTenant.id, customerUser.id);
        assert.strictEqual(membership.role, 'OWNER');

        // Invariant: No subscription created on registration
        const sub = await subscriptionRepo.findActiveByTenantId(customerTenant.id);
        assert.strictEqual(sub, null);
    });

    it('Step 2: Customer Login (POST /api/v1/auth/login)', async () => {
        const res = await request('POST', '/api/v1/auth/login', {
            body: {
                email: customerEmail,
                password: customerPassword,
            },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.data.accessToken);
        customerToken = res.body.data.accessToken;
    });

    it('Step 3: Resolve Customer Context (GET /api/v1/me)', async () => {
        const res = await request('GET', '/api/v1/me', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.user.id, customerUser.id);
        assert.strictEqual(res.body.data.user.email, customerEmail);
        assert.strictEqual(res.body.data.tenant.id, customerTenant.id);
        assert.strictEqual(res.body.data.tenant.role, 'OWNER');
    });

    it('Step 4: List Active Plans (GET /api/v1/plans)', async () => {
        const res = await request('GET', '/api/v1/plans', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(Array.isArray(res.body.data.plans));
        const found = res.body.data.plans.find((p) => p.id === testPlan.id);
        assert.ok(found);
        assert.strictEqual(found.name, testPlan.name);
        assert.strictEqual(Number(found.price), 25000);
    });

    let purchaseResponse;
    it('Step 5: Purchase Intent (POST /api/v1/me/subscriptions/purchase)', async () => {
        const res = await request('POST', '/api/v1/me/subscriptions/purchase', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: {
                planId: testPlan.id,
                paymentMethod: 'TEST_GATEWAY',
                customerPhone: customerPhone,
            },
        });

        assert.strictEqual(res.status, 201);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.data.payment.id);
        assert.ok(res.body.data.payment.transactionReference);
        assert.strictEqual(res.body.data.payment.status, 'PENDING');
        assert.strictEqual(Number(res.body.data.payment.amount), 25000);
        assert.strictEqual(res.body.data.payment.currency, 'TZS');

        purchaseResponse = res.body.data;
    });

    it('Step 6: Payment Simulation Callback (POST /api/v1/payments/callback)', async () => {
        const sim = paymentGateway.simulateCallback({
            transactionReference: purchaseResponse.payment.transactionReference,
            status: 'SUCCESS',
            amount: 25000.00,
            currency: 'TZS',
            providerTransactionId: `TX_${Date.now()}`,
        });

        const res = await request('POST', '/api/v1/payments/callback', {
            headers: sim.headers,
            rawBody: sim.rawBody,
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.status, 'SUCCESS');
    });

    it('Step 7: Active Subscription Verified (GET /api/v1/me/subscription)', async () => {
        const res = await request('GET', '/api/v1/me/subscription', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.data.subscription);
        assert.strictEqual(res.body.data.subscription.status, 'ACTIVE');
        assert.strictEqual(res.body.data.subscription.planId, testPlan.id);
        assert.strictEqual(res.body.data.subscription.tenantId, customerTenant.id);

        activeSubscription = res.body.data.subscription;
    });

    it('Step 8: Create WhatsApp Connection (POST /api/v1/me/connection)', async () => {
        const res = await request('POST', '/api/v1/me/connection', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: {
                phoneNumber: customerPhone,
            },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.ok(res.body.data.connection);
        assert.strictEqual(res.body.data.connection.tenantId, customerTenant.id);
        assert.strictEqual(res.body.data.connection.desiredState, 'RUNNING');

        customerConnection = res.body.data.connection;

        // Invariant: Second call idempotently returns the same single connection
        const secondRes = await request('POST', '/api/v1/me/connection', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: { phoneNumber: customerPhone },
        });
        assert.strictEqual(secondRes.status, 200);
        assert.strictEqual(secondRes.body.data.connection.id, customerConnection.id);
    });

    it('Step 9: Retrieve Connection State (GET /api/v1/me/connection)', async () => {
        const res = await request('GET', '/api/v1/me/connection', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });

        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.body.success, true);
        assert.strictEqual(res.body.data.connection.id, customerConnection.id);
        assert.strictEqual(res.body.data.connection.desiredState, 'RUNNING');
    });

    it('Step 10: Ephemeral QR & Pairing Code Flow', async () => {
        // 10a. No QR yet -> 404
        const noQrRes = await request('GET', '/api/v1/me/connection/qr', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });
        assert.strictEqual(noQrRes.status, 404);
        assert.strictEqual(noQrRes.body.error.code, 'QR_NOT_AVAILABLE');

        // 10b. Publish ephemeral QR
        defaultQrStore.set(
            customerTenant.id,
            customerConnection.id,
            '2@test-qr-string-code,dummy,ref',
            60,
            customerConnection.leaseEpoch || 0
        );

        const qrRes = await request('GET', '/api/v1/me/connection/qr', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });
        assert.strictEqual(qrRes.status, 200);
        assert.strictEqual(qrRes.body.success, true);
        assert.strictEqual(qrRes.body.data.qr, '2@test-qr-string-code,dummy,ref');

        // 10c. Ephemeral pairing code request
        const pairingRes = await request('POST', '/api/v1/me/connection/pairing-code', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: { phoneNumber: customerPhone },
        });
        assert.ok([200, 400, 503].includes(pairingRes.status));
        if (pairingRes.status === 400) {
            assert.strictEqual(pairingRes.body.error.code, 'CONNECTION_NOT_ACTIVE');
        }
    });

    it('Step 11: Simulate Expiry Approach & Notification Sweep (3_DAYS_BEFORE & 24_HOURS_BEFORE)', async () => {
        const dispatcher = {
            dispatch: async (params) => {
                dispatchedNotifications.push(params);
                return { delivered: true, timestamp: Date.now() };
            },
        };

        const notifService = new SubscriptionNotificationService({
            pool,
            subscriptionRepo,
            dispatcher,
        });

        // 11a. Advance subscription expiry to 48 hours remaining (in (24h, 72h] window)
        const in48Hours = new Date(Date.now() + 48 * 60 * 60 * 1000);
        await pool.query('UPDATE customer_subscriptions SET expires_at = $1 WHERE id = $2;', [
            in48Hours,
            activeSubscription.id,
        ]);

        await notifService.sweep();
        const customerNotifs1 = dispatchedNotifications.filter(d => d.recipient.phoneNumber === customerPhone);
        assert.strictEqual(customerNotifs1.length, 1);
        assert.strictEqual(customerNotifs1[0].notificationType, '3_DAYS_BEFORE');
        assert.strictEqual(customerNotifs1[0].recipient.phoneNumber, customerPhone);
        assert.strictEqual(customerNotifs1[0].recipient.phoneNumber.includes('@g.us'), false);

        // Verify idempotency: second sweep sends 0 for this customer
        const countBefore = dispatchedNotifications.filter(d => d.recipient.phoneNumber === customerPhone).length;
        await notifService.sweep();
        const countAfter = dispatchedNotifications.filter(d => d.recipient.phoneNumber === customerPhone).length;
        assert.strictEqual(countAfter, countBefore);

        // 11b. Advance subscription expiry to 12 hours remaining (in (0, 24h] window)
        const in12Hours = new Date(Date.now() + 12 * 60 * 60 * 1000);
        await pool.query('UPDATE customer_subscriptions SET expires_at = $1 WHERE id = $2;', [
            in12Hours,
            activeSubscription.id,
        ]);

        await notifService.sweep();
        const customerNotifs2 = dispatchedNotifications.filter(d => d.recipient.phoneNumber === customerPhone);
        assert.strictEqual(customerNotifs2.length, 2);
        assert.strictEqual(customerNotifs2[1].notificationType, '24_HOURS_BEFORE');
        assert.strictEqual(customerNotifs2[1].recipient.phoneNumber, customerPhone);
    });

    it('Step 12: Simulate Expiry (Transition to EXPIRED & Gating Enforcement)', async () => {
        const dispatcher = {
            dispatch: async (params) => {
                dispatchedNotifications.push(params);
                return { delivered: true, timestamp: Date.now() };
            },
        };

        const notifService = new SubscriptionNotificationService({
            pool,
            subscriptionRepo,
            dispatcher,
        });

        // 12a. Move expires_at to 10 seconds in the past
        const pastDate = new Date(Date.now() - 10000);
        await pool.query('UPDATE customer_subscriptions SET expires_at = $1 WHERE id = $2;', [
            pastDate,
            activeSubscription.id,
        ]);

        // Run sweep: should expire subscription and dispatch EXPIRED notification
        const sweepResult = await notifService.sweep();
        assert.strictEqual(sweepResult.expiredStatusCount >= 1, true);
        assert.strictEqual(sweepResult.expiredSent >= 1, true);

        // Verify DB subscription state is EXPIRED
        const dbSub = await subscriptionRepo.findById(activeSubscription.id);
        assert.strictEqual(dbSub.status, 'EXPIRED');

        // Verify EXPIRED notification recorded
        const notifCheck = await pool.query(
            "SELECT * FROM subscription_notifications WHERE subscription_id = $1 AND notification_type = 'EXPIRED';",
            [activeSubscription.id]
        );
        assert.strictEqual(notifCheck.rows.length, 1);

        // 12b. Verify Entitlement Gating: connection start rejected with 403 SUBSCRIPTION_REQUIRED
        const connAttempt = await request('POST', '/api/v1/me/connection', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: { phoneNumber: customerPhone },
        });
        assert.strictEqual(connAttempt.status, 403);
        assert.strictEqual(connAttempt.body.error.code, 'SUBSCRIPTION_REQUIRED');

        const pairingAttempt = await request('POST', '/api/v1/me/connection/pairing-code', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: { phoneNumber: customerPhone },
        });
        assert.strictEqual(pairingAttempt.status, 403);
        assert.strictEqual(pairingAttempt.body.error.code, 'SUBSCRIPTION_REQUIRED');
    });

    it('Step 13: Purchase Renewal & Verify Stacked Duration', async () => {
        // Customer purchases renewal
        const renewPurchaseRes = await request('POST', '/api/v1/me/subscriptions/purchase', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: {
                planId: testPlan.id,
                paymentMethod: 'TEST_GATEWAY',
                customerPhone: customerPhone,
            },
        });

        assert.strictEqual(renewPurchaseRes.status, 201);
        const renewData = renewPurchaseRes.body.data;

        // Payment callback simulates successful payment
        const renewSim = paymentGateway.simulateCallback({
            transactionReference: renewData.payment.transactionReference,
            status: 'SUCCESS',
            amount: 25000.00,
            currency: 'TZS',
            providerTransactionId: `TX_RENEW_${Date.now()}`,
        });

        const callbackRes = await request('POST', '/api/v1/payments/callback', {
            headers: renewSim.headers,
            rawBody: renewSim.rawBody,
        });
        assert.strictEqual(callbackRes.status, 200);

        // Verify subscription is ACTIVE again
        const subRes = await request('GET', '/api/v1/me/subscription', {
            headers: { Authorization: `Bearer ${customerToken}` },
        });
        assert.strictEqual(subRes.status, 200);
        assert.strictEqual(subRes.body.data.subscription.status, 'ACTIVE');
        // Expiry should now be in the future (~30 days from now)
        const newExpiry = new Date(subRes.body.data.subscription.expiresAt).getTime();
        assert.strictEqual(newExpiry > Date.now() + 28 * 24 * 60 * 60 * 1000, true);
    });

    it('Step 14: Disconnect Connection (POST /api/v1/me/connection/disconnect)', async () => {
        const disconnectRes = await request('POST', '/api/v1/me/connection/disconnect', {
            headers: { Authorization: `Bearer ${customerToken}` },
            body: { reason: 'Customer requested disconnect via dashboard' },
        });

        assert.strictEqual(disconnectRes.status, 200);
        assert.strictEqual(disconnectRes.body.success, true);
        assert.ok(disconnectRes.body.data.connection);
        assert.strictEqual(disconnectRes.body.data.connection.desired_state || disconnectRes.body.data.connection.desiredState, 'STOPPED');

        // Confirm in database
        const dbConn = await connRepo.findById(customerConnection.id);
        assert.strictEqual(dbConn.desired_state, 'STOPPED');
    });

    // =========================================================================
    // MULTI-TENANT ISOLATION & ATTACK DEFENSE
    // =========================================================================
    describe('Multi-Tenant Isolation & Attack Defense', () => {
        let customerBToken;
        let customerBTenant;

        before(async () => {
            const randB = Math.floor(10000000 + Math.random() * 90000000);
            const regB = await authService.register({
                email: `cust_b_${Date.now()}@journey.test`,
                password: customerPassword,
                phoneNumber: `+2557${randB}`,
            });
            customerBTenant = regB.tenant;
            const loginB = await authService.login({
                email: regB.user.email,
                password: customerPassword,
            });
            customerBToken = loginB.accessToken;
        });

        it('Customer B cannot access Customer A connection', async () => {
            const res = await request('GET', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection, null);
        });

        it('Customer B cannot access Customer A subscription', async () => {
            const res = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${customerBToken}` },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.subscription, null);
            assert.strictEqual(res.body.data.hasActiveSubscription, false);
        });

        it('Unauthenticated requests to customer APIs are rejected with 401', async () => {
            const res = await request('GET', '/api/v1/me');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('Tampered payment webhook cannot activate subscriptions', async () => {
            const tamperedSim = paymentGateway.simulateCallback({
                transactionReference: 'NON_EXISTENT_REF',
                status: 'SUCCESS',
                amount: 1000,
                currency: 'TZS',
            });

            // Tamper the signature header
            const badHeaders = { ...tamperedSim.headers, 'x-webhook-signature': 'bad_hmac_hex_value_0000' };
            const res = await request('POST', '/api/v1/payments/callback', {
                headers: badHeaders,
                rawBody: tamperedSim.rawBody,
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_SIGNATURE');
        });
    });
});
