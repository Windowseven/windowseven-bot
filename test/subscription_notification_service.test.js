const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    SubscriptionRepository,
    PlanRepository,
} = require('../src/repositories');

const {
    SubscriptionNotificationService,
    NOTIFICATION_TYPES,
} = require('../src/application/services/SubscriptionNotificationService');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Subscription Notification Service & Expiry Lifecycle', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let subRepo;
    let planRepo;

    let testPlan;
    let customerUserA, customerUserB;
    let tenantA, tenantB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        subRepo = new SubscriptionRepository(pool);
        planRepo = new PlanRepository(pool);

        // Ensure a test plan exists
        testPlan = await planRepo.create({
            name: 'Notification Test Plan',
            description: 'For testing notifications',
            price: 15000,
            currency: 'TZS',
            durationDays: 30,
        });

        // Setup Customer A
        customerUserA = await userRepo.create({
            email: `notif_cust_a_${Date.now()}@test.com`,
            phoneNumber: '255711000001',
        });
        tenantA = await tenantRepo.create({ name: 'Tenant Notif A' });
        await membershipRepo.create({ tenantId: tenantA.id, userId: customerUserA.id, role: 'OWNER' });

        // Setup Customer B
        customerUserB = await userRepo.create({
            email: `notif_cust_b_${Date.now()}@test.com`,
            phoneNumber: '255711000002',
        });
        tenantB = await tenantRepo.create({ name: 'Tenant Notif B' });
        await membershipRepo.create({ tenantId: tenantB.id, userId: customerUserB.id, role: 'OWNER' });
    });

    after(async () => {
        await pool.query('DELETE FROM subscription_notifications CASCADE;');
        await pool.query('DELETE FROM customer_subscriptions CASCADE;');
        await pool.query('DELETE FROM plans WHERE id = $1;', [testPlan.id]);
        await pool.query('DELETE FROM tenants CASCADE;');
        await pool.query('DELETE FROM users CASCADE;');
        await pool.end();
    });

    beforeEach(async () => {
        await pool.query('DELETE FROM subscription_notifications CASCADE;');
        await pool.query('DELETE FROM customer_subscriptions CASCADE;');
    });

    // =========================================================================
    // 1. ELIGIBILITY
    // =========================================================================
    describe('1. Eligibility', () => {
        it('1. Subscription receives 3-day notification when 0 < expires_at - NOW() <= 72h', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Create sub expiring in 48 hours (in 3-day window: > 24h and <= 72h)
            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 48 * 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.threeDaysSent, 1);
            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].subscriptionId, sub.id);
            assert.strictEqual(delivered[0].notificationType, '3_DAYS_BEFORE');
            assert.strictEqual(delivered[0].recipient.phoneNumber, '255711000001');

            // Verify PostgreSQL persistence
            const { rows } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1 AND notification_type = $2;',
                [sub.id, '3_DAYS_BEFORE']
            );
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].tenant_id, tenantA.id);
        });

        it('2. Subscription receives 24-hour notification when 0 < expires_at - NOW() <= 24h', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Create sub expiring in 12 hours (in 24-hour window)
            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 12 * 60 * 60 * 1000),
            });

            // Pre-record 3-day notification as already sent so only 24-hour triggers
            await subRepo.recordNotification(sub.id, tenantA.id, '3_DAYS_BEFORE');

            const summary = await service.sweep();
            assert.strictEqual(summary.twentyFourHoursSent, 1);
            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].subscriptionId, sub.id);
            assert.strictEqual(delivered[0].notificationType, '24_HOURS_BEFORE');

            // Verify DB record
            const { rows } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1 AND notification_type = $2;',
                [sub.id, '24_HOURS_BEFORE']
            );
            assert.strictEqual(rows.length, 1);
        });

        it('3. Expired subscription receives EXPIRED notification when expires_at <= NOW()', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Sub expired 1 hour ago
            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() - 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.expiredStatusCount, 1, 'Should transition status to EXPIRED');
            assert.strictEqual(summary.expiredSent, 1, 'Should send EXPIRED notification');
            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].notificationType, 'EXPIRED');

            // Verify subscription status transitioned to EXPIRED in database
            const inDb = await subRepo.findById(sub.id);
            assert.strictEqual(inDb.status, 'EXPIRED');

            // Verify DB notification record
            const { rows } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1 AND notification_type = $2;',
                [sub.id, 'EXPIRED']
            );
            assert.strictEqual(rows.length, 1);
        });

        it('4. Subscription outside notification windows receives nothing (> 72h)', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Expiring in 10 days
            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 10 * 24 * 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.threeDaysSent, 0);
            assert.strictEqual(summary.twentyFourHoursSent, 0);
            assert.strictEqual(summary.expiredSent, 0);
            assert.strictEqual(delivered.length, 0);
        });
    });

    // =========================================================================
    // 2. IDEMPOTENCY
    // =========================================================================
    describe('2. Idempotency', () => {
        it('5. Running sweep twice does not duplicate notification', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 36 * 60 * 60 * 1000),
            });

            // First sweep
            const summary1 = await service.sweep();
            assert.strictEqual(summary1.threeDaysSent, 1);
            assert.strictEqual(delivered.length, 1);

            // Second sweep immediately
            const summary2 = await service.sweep();
            assert.strictEqual(summary2.threeDaysSent, 0);
            assert.strictEqual(delivered.length, 1, 'Delivery count must remain strictly 1');

            // DB count must be exactly 1
            const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM subscription_notifications;');
            assert.strictEqual(rows[0].count, 1);
        });

        it('6. Process restart (new service instance) does not duplicate notification', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service1 = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 18 * 60 * 60 * 1000),
            });

            await service1.sweep();
            assert.strictEqual(delivered.length, 2); // 3-day and 24-hour both eligible for <= 24h

            // Simulate process restart with clean instance reading PostgreSQL
            const service2 = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });
            const summaryRestart = await service2.sweep();

            assert.strictEqual(summaryRestart.threeDaysSent, 0);
            assert.strictEqual(summaryRestart.twentyFourHoursSent, 0);
            assert.strictEqual(delivered.length, 2, 'No notifications re-sent after restart');
        });

        it('7. Concurrent sweeps do not duplicate notification', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    // Add small jitter to simulate realistic async network dispatch
                    await new Promise((r) => setTimeout(r, 15));
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service1 = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });
            const service2 = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 50 * 60 * 60 * 1000),
            });

            // Run both instances concurrently
            const [sum1, sum2] = await Promise.all([
                service1.sweep(),
                service2.sweep(),
            ]);

            const totalSent = sum1.threeDaysSent + sum2.threeDaysSent;
            assert.strictEqual(totalSent, 1, 'Exactly one concurrent worker must deliver the notification');
            assert.strictEqual(delivered.length, 1);

            const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM subscription_notifications;');
            assert.strictEqual(rows[0].count, 1);
        });
    });

    // =========================================================================
    // 3. FAILURE HANDLING & RETRY
    // =========================================================================
    describe('3. Failure Handling & Retry', () => {
        it('8. Failed delivery can be retried safely on subsequent sweep', async () => {
            let attempt = 0;
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    attempt++;
                    if (attempt === 1) {
                        // First attempt throws error (e.g. gateway timeout)
                        throw new Error('NETWORK_TIMEOUT_SIMULATION');
                    }
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 40 * 60 * 60 * 1000),
            });

            // First sweep fails
            const summary1 = await service.sweep();
            assert.strictEqual(summary1.failed, 1);
            assert.strictEqual(delivered.length, 0);

            // DB check: no row should be recorded on failure
            const { rows: rowsAfterFail } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1;',
                [sub.id]
            );
            assert.strictEqual(rowsAfterFail.length, 0);

            // Second sweep retries and succeeds
            const summary2 = await service.sweep();
            assert.strictEqual(summary2.threeDaysSent, 1);
            assert.strictEqual(summary2.failed, 0);
            assert.strictEqual(delivered.length, 1);

            // DB check: now recorded
            const { rows: rowsAfterSuccess } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1;',
                [sub.id]
            );
            assert.strictEqual(rowsAfterSuccess.length, 1);
        });

        it('9. Successful delivery is not sent again after retry', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 40 * 60 * 60 * 1000),
            });

            await service.sweep();
            assert.strictEqual(delivered.length, 1);

            // Sweep again: should not deliver
            await service.sweep();
            assert.strictEqual(delivered.length, 1);
        });

        it('10. Delivery failure does not corrupt subscription state', async () => {
            const dispatcher = {
                dispatch: async () => {
                    throw new Error('PROVIDER_TEMPORARILY_UNAVAILABLE');
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            const originalExpiresAt = new Date(Date.now() + 40 * 60 * 60 * 1000);
            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: originalExpiresAt,
            });

            await service.sweep();

            // Verify subscription row was not modified or corrupted
            const inDb = await subRepo.findById(sub.id);
            assert.strictEqual(inDb.status, 'ACTIVE');
            assert.strictEqual(new Date(inDb.expires_at).getTime(), originalExpiresAt.getTime());
        });
    });

    // =========================================================================
    // 4. CUSTOMER TARGETING & ISOLATION
    // =========================================================================
    describe('4. Customer Targeting & Isolation', () => {
        it('11. Customer A cannot receive Customer B notification (strictly targeted)', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Create sub for Tenant A
            const subA = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 50 * 60 * 60 * 1000),
            });

            // Create sub for Tenant B
            const subB = await subRepo.create({
                tenantId: tenantB.id,
                customerUserId: customerUserB.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 50 * 60 * 60 * 1000),
            });

            await service.sweep();

            assert.strictEqual(delivered.length, 2);

            const deliveryA = delivered.find((d) => d.subscriptionId === subA.id);
            const deliveryB = delivered.find((d) => d.subscriptionId === subB.id);

            assert.ok(deliveryA);
            assert.strictEqual(deliveryA.tenantId, tenantA.id);
            assert.strictEqual(deliveryA.recipient.userId, customerUserA.id);
            assert.strictEqual(deliveryA.recipient.phoneNumber, '255711000001');

            assert.ok(deliveryB);
            assert.strictEqual(deliveryB.tenantId, tenantB.id);
            assert.strictEqual(deliveryB.recipient.userId, customerUserB.id);
            assert.strictEqual(deliveryB.recipient.phoneNumber, '255711000002');
        });

        it('12. Notification destination is always private user channel, never a group chat', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 50 * 60 * 60 * 1000),
            });

            await service.sweep();

            assert.strictEqual(delivered.length, 1);
            assert.strictEqual(delivered[0].recipient.phoneNumber.includes('@g.us'), false);
            assert.strictEqual(delivered[0].recipient.phoneNumber, '255711000001');
        });
    });

    // =========================================================================
    // 5. SUBSCRIPTION STATES
    // =========================================================================
    describe('5. Subscription States', () => {
        it('13. ACTIVE subscription is handled correctly', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 45 * 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.threeDaysSent, 1);
            assert.strictEqual(delivered.length, 1);
        });

        it('14. MANUALLY_GRANTED subscription is handled correctly', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'MANUALLY_GRANTED',
                expiresAt: new Date(Date.now() + 45 * 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.threeDaysSent, 1);
            assert.strictEqual(delivered.length, 1);
        });

        it('15. Already EXPIRED subscription only receives EXPIRED notification once', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            // Create already expired subscription
            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'EXPIRED',
                expiresAt: new Date(Date.now() - 24 * 60 * 60 * 1000),
            });

            const summary1 = await service.sweep();
            assert.strictEqual(summary1.threeDaysSent, 0);
            assert.strictEqual(summary1.twentyFourHoursSent, 0);
            assert.strictEqual(summary1.expiredSent, 1);

            const summary2 = await service.sweep();
            assert.strictEqual(summary2.expiredSent, 0);
            assert.strictEqual(delivered.length, 1);
        });

        it('16. CANCELLED subscription does not receive expiry notifications', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'CANCELLED',
                expiresAt: new Date(Date.now() + 10 * 60 * 60 * 1000),
            });

            const summary = await service.sweep();
            assert.strictEqual(summary.threeDaysSent, 0);
            assert.strictEqual(summary.twentyFourHoursSent, 0);
            assert.strictEqual(summary.expiredSent, 0);
            assert.strictEqual(delivered.length, 0);
        });
    });

    // =========================================================================
    // 6. INTEGRATION
    // =========================================================================
    describe('6. Integration', () => {
        it('17. Notification service uses real SubscriptionRepository', async () => {
            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo });
            assert.strictEqual(service.subscriptionRepo, subRepo);
        });

        it('18. Notification persistence strictly records in PostgreSQL subscription_notifications table', async () => {
            const delivered = [];
            const dispatcher = {
                dispatch: async (params) => {
                    delivered.push(params);
                    return { delivered: true, destination: params.recipient.phoneNumber };
                },
            };

            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo, dispatcher });

            const sub = await subRepo.create({
                tenantId: tenantA.id,
                customerUserId: customerUserA.id,
                planId: testPlan.id,
                durationDays: 30,
                status: 'ACTIVE',
                expiresAt: new Date(Date.now() + 50 * 60 * 60 * 1000),
            });

            await service.sweep();

            const { rows } = await pool.query(
                'SELECT * FROM subscription_notifications WHERE subscription_id = $1;',
                [sub.id]
            );
            assert.strictEqual(rows.length, 1);
            assert.strictEqual(rows[0].subscription_id, sub.id);
            assert.strictEqual(rows[0].tenant_id, tenantA.id);
            assert.strictEqual(rows[0].notification_type, '3_DAYS_BEFORE');
            assert.ok(rows[0].sent_at);
        });

        it('19. Full lifecycle works with background timer start and stop', async () => {
            let sweepCount = 0;
            const service = new SubscriptionNotificationService({ pool, subscriptionRepo: subRepo });
            service.sweep = async () => { sweepCount++; return {}; };

            service.start(25);
            await new Promise((r) => setTimeout(r, 80));
            service.stop();

            assert.ok(sweepCount >= 2, 'Sweep should have executed at least twice');
            assert.strictEqual(service.timer, null, 'Timer must be cleared after stop');
        });
    });
});
