'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    WhatsAppConnectionRepository,
    WorkerRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
    RefreshTokenRepository,
    AuditLogRepository,
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

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass@127.0.0.1:5433/windowseven_test';

describe('Admin → Customer Cross-System End-to-End Suite', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let platformIdempotencyRepo;
    let connRepo;
    let workerRepo;
    let planRepo;
    let subscriptionRepo;
    let paymentRepo;
    let refreshTokenRepo;
    let auditLogRepo;

    let passwordService;
    let tokenService;
    let authService;
    let platformService;
    let connectionService;
    let customerPurchaseService;
    let paymentGateway;
    let paymentService;
    let notificationService;
    let commandGateway;
    let eventPublisher;

    let server;
    let serverUrl;

    // Identities
    let adminUser;
    let adminToken;

    let cust1User;
    let cust1Tenant;
    let cust1Token;
    let cust1Phone;

    let cust2User;
    let cust2Tenant;
    let cust2Token;
    let cust2Phone;

    let testPlan;
    let cust1Sub;
    let cust1Payment;

    async function request(method, path, { headers = {}, body = null } = {}) {
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
            if (body) {
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
        platformIdempotencyRepo = new PlatformIdempotencyRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        workerRepo = new WorkerRepository(pool);
        planRepo = new PlanRepository(pool);
        subscriptionRepo = new SubscriptionRepository(pool);
        paymentRepo = new PaymentRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'cross-sys-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 3600,
            refreshTokenTtlSeconds: 604800,
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

        commandGateway = new ConnectionCommandGateway({ pool });
        eventPublisher = new LocalEventPublisher();

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
            commandGateway,
            eventPublisher,
        });

        connectionService = new ConnectionService({
            pool,
            connRepo,
            auditLogRepo,
            commandGateway,
            qrStore: defaultQrStore,
            pairingStore: defaultPairingCodeStore,
        });

        paymentGateway = new TestPaymentGateway({
            secretKey: 'cross_sys_secret_key',
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

        notificationService = new SubscriptionNotificationService({
            pool,
            subscriptionRepo,
            eventPublisher,
        });

        const appHandler = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo,
            userRepo,
            connRepo,
            auditLogRepo,
            platformRoleRepo,
            platformAuditRepo,
            platformIdempotencyRepo,
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
        serverUrl = `http://127.0.0.1:${server.address().port}`;

        // 1. Create Admin User & Token
        const adminEmail = `admin_cross_${Date.now()}@windowseven.test`;
        const adminPasswordHash = await passwordService.hash('AdminMaster123!@#');
        const adminUserRow = await userRepo.create({
            email: adminEmail,
            passwordHash: adminPasswordHash,
            phoneNumber: `+255700${Math.floor(100000 + Math.random() * 900000)}`,
        });
        adminUser = adminUserRow;
        await platformRoleRepo.assignRole({ userId: adminUser.id, role: 'ADMIN' });

        const adminLogin = await authService.login({
            email: adminEmail,
            password: 'AdminMaster123!@#',
        });
        adminToken = adminLogin.accessToken;

        // 2. Create Dynamic Customers
        const rand1 = Math.floor(10000000 + Math.random() * 90000000);
        cust1Phone = `+2557${rand1}`;
        const reg1 = await authService.register({
            email: `cust1_${Date.now()}_${rand1}@customer.test`,
            password: 'Customer123!@#',
            phoneNumber: cust1Phone,
        });
        cust1User = reg1.user;
        cust1Tenant = reg1.tenant;
        const login1 = await authService.login({ email: cust1User.email, password: 'Customer123!@#' });
        cust1Token = login1.accessToken;

        const rand2 = Math.floor(10000000 + Math.random() * 90000000);
        cust2Phone = `+2557${rand2}`;
        const reg2 = await authService.register({
            email: `cust2_${Date.now()}_${rand2}@customer.test`,
            password: 'Customer123!@#',
            phoneNumber: cust2Phone,
        });
        cust2User = reg2.user;
        cust2Tenant = reg2.tenant;
        const login2 = await authService.login({ email: cust2User.email, password: 'Customer123!@#' });
        cust2Token = login2.accessToken;

        // 3. Create initial Plan
        testPlan = await planRepo.create({
            name: `E2E Pro Tier ${Date.now()}`,
            price: 10000.00,
            currency: 'TZS',
            durationDays: 30,
            description: 'E2E Testing Tier',
            status: 'ACTIVE',
        });

        // 4. Provision initial subscription & payment for Customer 1
        cust1Sub = await subscriptionRepo.create({
            tenantId: cust1Tenant.id,
            customerUserId: cust1User.id,
            planId: testPlan.id,
            pricePaid: 10000.00,
            currency: 'TZS',
            durationDays: 30,
            status: 'ACTIVE',
            expiresAt: new Date(Date.now() + 20 * 24 * 60 * 60 * 1000),
        });

        cust1Payment = await paymentRepo.create({
            tenantId: cust1Tenant.id,
            customerUserId: cust1User.id,
            planId: testPlan.id,
            amount: 10000.00,
            currency: 'TZS',
            provider: 'TEST',
            transactionReference: `TX_HISTORICAL_${Date.now()}`,
            status: 'SUCCESS',
            subscriptionId: cust1Sub.id,
        });
    });

    after(async () => {
        defaultQrStore.clearAll();
        defaultPairingCodeStore.clearAll();
        if (commandGateway) commandGateway.removeAllListeners();
        if (notificationService) notificationService.stop();
        if (server) {
            server.closeAllConnections?.();
            await new Promise((resolve) => server.close(resolve));
        }

        // Cleanup
        await pool.query("DELETE FROM subscription_notifications WHERE tenant_id IN ($1, $2);", [cust1Tenant.id, cust2Tenant.id]);
        await pool.query("DELETE FROM payments WHERE customer_user_id IN ($1, $2);", [cust1User.id, cust2User.id]);
        await pool.query("DELETE FROM customer_subscriptions WHERE customer_user_id IN ($1, $2);", [cust1User.id, cust2User.id]);
        await pool.query("DELETE FROM whatsapp_connections WHERE tenant_id IN ($1, $2);", [cust1Tenant.id, cust2Tenant.id]);
        await pool.query("DELETE FROM plans WHERE id = $1;", [testPlan.id]);
        await pool.query("DELETE FROM platform_user_roles WHERE user_id = $1;", [adminUser.id]);
        await pool.query("DELETE FROM tenant_memberships WHERE user_id IN ($1, $2);", [cust1User.id, cust2User.id]);
        await pool.query("DELETE FROM tenants WHERE id IN ($1, $2);", [cust1Tenant.id, cust2Tenant.id]);
        await pool.query("DELETE FROM refresh_tokens WHERE user_id IN ($1, $2, $3);", [adminUser.id, cust1User.id, cust2User.id]);
        await pool.query("DELETE FROM users WHERE id IN ($1, $2, $3);", [adminUser.id, cust1User.id, cust2User.id]);
        await pool.end();
    });

    // =========================================================================
    // 1. ADMIN PLAN PRICE UPDATE & HISTORICAL SNAPSHOT PRESERVATION
    // =========================================================================
    describe('1. Plan Mutations & Historical Price Invariants', () => {
        it('1.1 Admin updates plan price: returns resulting state and writes audit log', async () => {
            const res = await request('PUT', `/api/v1/admin/plans/${testPlan.id}`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { price: 15000.00 },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.id, testPlan.id);
            assert.strictEqual(Number(res.body.data.price), 15000);

            // Verify audit record
            const { rows: auditRows } = await pool.query(
                `SELECT * FROM platform_audit_logs WHERE action = 'PLAN_UPDATED' AND target_id = $1 ORDER BY created_at DESC LIMIT 1;`,
                [testPlan.id]
            );
            assert.strictEqual(auditRows.length, 1);
            assert.strictEqual(auditRows[0].actor_user_id, adminUser.id);
        });

        it('1.2 Customer 1 historical subscription & payment remain at original price (10000)', async () => {
            // Customer 1 subscription API
            const subRes = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(subRes.status, 200);
            assert.strictEqual(Number(subRes.body.data.subscription.pricePaid), 10000);

            // Customer 1 payments API
            const payRes = await request('GET', `/api/v1/me/payments/${cust1Payment.id}`, {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(payRes.status, 200);
            assert.strictEqual(payRes.body.data.payment.amount, 10000);
        });

        it('1.3 Customer 2 sees updated price (15000) in catalog and on purchase intent', async () => {
            const catRes = await request('GET', '/api/v1/plans');
            assert.strictEqual(catRes.status, 200);
            const planInCatalog = catRes.body.data.plans.find((p) => p.id === testPlan.id);
            assert.ok(planInCatalog);
            assert.strictEqual(planInCatalog.price, 15000);

            const purchaseRes = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${cust2Token}` },
                body: { planId: testPlan.id },
            });
            assert.strictEqual(purchaseRes.status, 201);
            assert.strictEqual(purchaseRes.body.data.payment.amount, 15000);
        });
    });

    // =========================================================================
    // 2. ADMIN SUBSCRIPTION OPERATIONS (GRANT, EXTEND, CANCEL)
    // =========================================================================
    describe('2. Admin Subscription Operations & Customer Effects', () => {
        let grantedSubId;

        it('2.1 Admin manually grants subscription to Customer 2: returns new sub, logs audit, immediately visible to Customer 2', async () => {
            const grantRes = await request('POST', `/api/v1/admin/customers/${cust2Tenant.id}/subscriptions/grant`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: {
                    planId: testPlan.id,
                    reason: 'Promotion grant for early tester',
                },
            });

            assert.strictEqual(grantRes.status, 201);
            assert.strictEqual(grantRes.body.success, true);
            assert.strictEqual(grantRes.body.data.status, 'MANUALLY_GRANTED');
            assert.strictEqual(grantRes.body.data.tenant_id, cust2Tenant.id);
            assert.strictEqual(Number(grantRes.body.data.price_paid), 0);
            grantedSubId = grantRes.body.data.id;

            // Verify audit record
            const { rows: auditRows } = await pool.query(
                `SELECT * FROM platform_audit_logs WHERE action = 'SUBSCRIPTION_GRANTED' AND target_id = $1;`,
                [grantedSubId]
            );
            assert.strictEqual(auditRows.length, 1);
            assert.strictEqual(auditRows[0].reason, 'Promotion grant for early tester');

            // Customer 2 immediately sees active subscription
            const subRes = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(subRes.status, 200);
            assert.strictEqual(subRes.body.data.status, 'MANUALLY_GRANTED');
            assert.strictEqual(subRes.body.data.hasActiveSubscription, true);

            // Customer 2 overview immediately reflects active state
            const ovRes = await request('GET', '/api/v1/me/overview', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(ovRes.status, 200);
            assert.strictEqual(ovRes.body.data.subscription.hasActiveSubscription, true);
            assert.strictEqual(ovRes.body.data.quickActions.canStartConnection, true);
            assert.strictEqual(ovRes.body.data.quickActions.needsSubscription, false);
        });

        it('2.2 Admin extends subscription: returns resulting extended state, increases customer daysRemaining', async () => {
            const extRes = await request('POST', `/api/v1/admin/subscriptions/${grantedSubId}/extend`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: {
                    additionalDays: 14,
                    reason: 'Good customer compensation',
                },
            });

            assert.strictEqual(extRes.status, 200);
            assert.strictEqual(extRes.body.success, true);
            assert.strictEqual(extRes.body.data.id, grantedSubId);
            assert.strictEqual(extRes.body.data.duration_days, testPlan.duration_days + 14);

            // Customer 2 receives increased daysRemaining
            const subRes = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(subRes.status, 200);
            assert.strictEqual(subRes.body.data.daysRemaining > 30, true);
        });

        it('2.3 Admin cancels subscription: returns CANCELLED status, logs audit, instantly revokes customer entitlement', async () => {
            const cancelRes = await request('POST', `/api/v1/admin/subscriptions/${grantedSubId}/cancel`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: 'Violation of acceptable use terms' },
            });

            assert.strictEqual(cancelRes.status, 200);
            assert.strictEqual(cancelRes.body.success, true);
            assert.strictEqual(cancelRes.body.data.status, 'CANCELLED');

            // Customer 2 subscription becomes CANCELLED and inactive
            const subRes = await request('GET', '/api/v1/me/subscription', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(subRes.status, 200);
            assert.strictEqual(subRes.body.data.status, 'CANCELLED');
            assert.strictEqual(subRes.body.data.hasActiveSubscription, false);

            // Customer 2 overview reflects needsSubscription
            const ovRes = await request('GET', '/api/v1/me/overview', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(ovRes.status, 200);
            assert.strictEqual(ovRes.body.data.quickActions.needsSubscription, true);
            assert.strictEqual(ovRes.body.data.quickActions.canStartConnection, false);

            // Customer 2 blocked from starting connection
            const connRes = await request('POST', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });
            assert.strictEqual(connRes.status, 403);
            assert.strictEqual(connRes.body.error.code, 'SUBSCRIPTION_REQUIRED');
        });
    });

    // =========================================================================
    // 3. ADMIN CONNECTION DISCONNECT
    // =========================================================================
    describe('3. Admin Connection Disconnect', () => {
        let cust1ConnId;

        it('3.1 Customer 1 starts connection, Admin force-disconnects it with reason', async () => {
            // Customer 1 provisions connection
            const startRes = await request('POST', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${cust1Token}` },
                body: { phoneNumber: cust1Phone, displayName: 'Cust 1 Bot' },
            });
            assert.strictEqual(startRes.status, 200);
            cust1ConnId = startRes.body.data.connection.id;

            // Admin disconnects
            const discRes = await request('POST', `/api/v1/admin/connections/${cust1ConnId}/disconnect`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: 'Network maintenance restart' },
            });
            assert.strictEqual(discRes.status, 200);
            assert.strictEqual(discRes.body.success, true);
            assert.strictEqual(discRes.body.data.connectionId, cust1ConnId);
            assert.strictEqual(discRes.body.data.actualState, 'SOCKET_STOPPING');
            assert.strictEqual(discRes.body.data.desiredState, 'STOPPED');

            // Audit record written
            const { rows: auditRows } = await pool.query(
                `SELECT * FROM platform_audit_logs WHERE action = 'CONNECTION_FORCE_DISCONNECT_REQUESTED' AND target_id = $1;`,
                [cust1ConnId]
            );
            assert.strictEqual(auditRows.length, 1);
            assert.strictEqual(auditRows[0].reason, 'Network maintenance restart');
        });
    });

    // =========================================================================
    // 4. ADMIN CUSTOMER LIFECYCLE (SUSPEND, REACTIVATE, DEACTIVATE)
    // =========================================================================
    describe('4. Customer Account Lifecycle (Suspend, Reactivate, Deactivate)', () => {
        it('4.1 Admin suspends Customer 1: returns SUSPENDED status, blocks customer mutations', async () => {
            const suspRes = await request('POST', `/api/v1/admin/customers/${cust1Tenant.id}/suspend`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: 'Payment dispute investigation' },
            });

            assert.strictEqual(suspRes.status, 200);
            assert.strictEqual(suspRes.body.data.status, 'SUSPENDED');

            // Customer 1 /me reflects SUSPENDED
            const meRes = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(meRes.status, 200);
            assert.strictEqual(meRes.body.data.tenant.status, 'SUSPENDED');

            // Customer 1 overview reflects disabled quickActions
            const ovRes = await request('GET', '/api/v1/me/overview', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(ovRes.status, 200);
            assert.strictEqual(ovRes.body.data.quickActions.canStartConnection, false);
            assert.strictEqual(ovRes.body.data.quickActions.canRenewSubscription, false);

            // Mutating action rejected with 403 TENANT_SUSPENDED
            const mutRes = await request('POST', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(mutRes.status, 403);
            assert.strictEqual(mutRes.body.error.code, 'TENANT_SUSPENDED');
        });

        it('4.2 Admin reactivates Customer 1: returns ACTIVE status, restores customer operations', async () => {
            const reactRes = await request('POST', `/api/v1/admin/customers/${cust1Tenant.id}/reactivate`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: 'Dispute resolved satisfactorily' },
            });

            assert.strictEqual(reactRes.status, 200);
            assert.strictEqual(reactRes.body.data.status, 'ACTIVE');

            // Customer 1 /me reflects ACTIVE
            const meRes = await request('GET', '/api/v1/me', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(meRes.status, 200);
            assert.strictEqual(meRes.body.data.tenant.status, 'ACTIVE');

            // Customer 1 can now start connection again
            const connRes = await request('POST', '/api/v1/me/connection', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });
            assert.strictEqual(connRes.status, 200);
        });

        it('4.3 Admin deactivates Customer 2 (terminal): returns DEACTIVATED, permanently blocks operations', async () => {
            const deactRes = await request('POST', `/api/v1/admin/customers/${cust2Tenant.id}/deactivate`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: 'Customer requested account closure' },
            });

            assert.strictEqual(deactRes.status, 200);
            assert.strictEqual(deactRes.body.data.status, 'DEACTIVATED');

            // Mutating actions permanently blocked with 403 TENANT_DEACTIVATED
            const mutRes = await request('POST', '/api/v1/me/subscriptions/purchase', {
                headers: { Authorization: `Bearer ${cust2Token}` },
                body: { planId: testPlan.id },
            });
            assert.strictEqual(mutRes.status, 403);
            assert.strictEqual(mutRes.body.error.code, 'TENANT_DEACTIVATED');
        });
    });

    // =========================================================================
    // 5. NOTIFICATION LIFECYCLE, RETRIEVAL & ISOLATION
    // =========================================================================
    describe('5. Notification Lifecycle & Customer Retrieval', () => {
        it('5.1 Notification recorded for Customer 1 is retrievable via GET /api/v1/me/notifications', async () => {
            // Record a notification for Customer 1
            await subscriptionRepo.recordNotification(cust1Sub.id, cust1Tenant.id, '3_DAYS_BEFORE');

            const res = await request('GET', '/api/v1/me/notifications', {
                headers: { Authorization: `Bearer ${cust1Token}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.notifications));
            assert.strictEqual(res.body.data.notifications.length >= 1, true);

            const notif = res.body.data.notifications.find((n) => n.subscriptionId === cust1Sub.id);
            assert.ok(notif);
            assert.strictEqual(notif.type, '3_DAYS_BEFORE');
            assert.strictEqual(notif.title, 'Subscription Expiring Soon');
            assert.ok(notif.message.includes('will expire in 3 days'));
        });

        it('5.2 Tenant Isolation: Customer 2 cannot see Customer 1 notifications', async () => {
            const res = await request('GET', '/api/v1/me/notifications', {
                headers: { Authorization: `Bearer ${cust2Token}` },
            });

            assert.strictEqual(res.status, 200);
            assert.deepStrictEqual(res.body.data.notifications, []);
            assert.strictEqual(res.body.data.pagination.total, 0);
        });
    });

    // =========================================================================
    // 6. VALIDATION & ERROR CONTRACTS
    // =========================================================================
    describe('6. Validation & Error Contracts', () => {
        it('6.1 Admin plan price update with negative price returns 400 VALIDATION_ERROR', async () => {
            const res = await request('PUT', `/api/v1/admin/plans/${testPlan.id}`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { price: -500 },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('6.2 Admin customer suspend without reason returns 400 VALIDATION_ERROR', async () => {
            const res = await request('POST', `/api/v1/admin/customers/${cust1Tenant.id}/suspend`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: { reason: '   ' },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('6.3 Admin subscription cancel without reason returns 400 VALIDATION_ERROR', async () => {
            const res = await request('POST', `/api/v1/admin/subscriptions/${cust1Sub.id}/cancel`, {
                headers: { Authorization: `Bearer ${adminToken}` },
                body: {},
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('6.4 Plan delete returns 400 PLAN_IN_USE when referenced by existing subscription', async () => {
            const res = await request('DELETE', `/api/v1/admin/plans/${testPlan.id}`, {
                headers: { Authorization: `Bearer ${adminToken}` },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'PLAN_IN_USE');
        });
    });
});
