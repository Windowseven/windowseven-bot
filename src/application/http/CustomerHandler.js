'use strict';

/**
 * Windowseven MD Customer Product HTTP Handlers (Slice 2A)
 * Exposes customer-facing profile, public plan catalog, and customer subscription read APIs.
 */

const ApiError = require('../errors/ApiError');

function registerCustomerRoutes({
    router,
    authService,
    planRepo,
    subscriptionRepo,
    paymentRepo = null,
    tenantMembershipRepo,
    customerPurchaseService = null,
    connectionService = null,
    authMiddleware,
    sendJson,
    readJsonBody = null,
}) {
    if (!router || !authService || !authMiddleware || !sendJson) {
        throw new Error('[registerCustomerRoutes] router, authService, authMiddleware, and sendJson are required');
    }

    function getNotificationTitle(type) {
        switch (type) {
            case '3_DAYS_BEFORE':
                return 'Subscription Expiring Soon';
            case '24_HOURS_BEFORE':
                return 'Subscription Expiring in 24 Hours';
            case 'EXPIRED':
                return 'Subscription Expired';
            default:
                return 'Subscription Notification';
        }
    }

    function getNotificationMessage(type, planName = null) {
        const planText = planName ? ` for your ${planName} plan` : '';
        switch (type) {
            case '3_DAYS_BEFORE':
                return `Your subscription${planText} will expire in 3 days. Please renew to keep your WhatsApp bot active without interruption.`;
            case '24_HOURS_BEFORE':
                return `Your subscription${planText} will expire in less than 24 hours. Renew today to maintain continuous bot service.`;
            case 'EXPIRED':
                return `Your subscription${planText} has expired. Your WhatsApp bot has been paused. Renew your subscription to restore service.`;
            default:
                return `Update regarding your subscription${planText}.`;
        }
    }

    function formatPayment(p) {
        return {
            id: p.id,
            tenantId: p.tenant_id,
            planId: p.plan_id,
            planName: p.plan_name || null,
            plan: p.plan_name || null,
            subscriptionId: p.subscription_id || null,
            amount: Number(p.amount),
            currency: p.currency,
            provider: p.provider,
            transactionReference: p.transaction_reference,
            reference: p.transaction_reference,
            status: p.status,
            failureReason: p.failure_reason || null,
            createdAt: p.created_at,
            updatedAt: p.updated_at,
        };
    }

    function formatSubscription(latestSub) {
        if (!latestSub) {
            return {
                subscription: null,
                status: 'NONE',
                hasActiveSubscription: false,
                daysRemaining: 0,
                secondsRemaining: 0,
                isExpired: false,
            };
        }

        const now = new Date();
        const expiresAt = new Date(latestSub.expires_at);
        let isExpired = false;
        let effectiveStatus = latestSub.status;

        if (effectiveStatus === 'ACTIVE' || effectiveStatus === 'MANUALLY_GRANTED') {
            if (expiresAt <= now) {
                effectiveStatus = 'EXPIRED';
                isExpired = true;
            }
        } else if (effectiveStatus === 'EXPIRED') {
            isExpired = true;
        }

        const secondsRemaining = Math.max(0, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
        const daysRemaining = Math.ceil(secondsRemaining / 86400);

        const subscriptionData = {
            id: latestSub.id,
            tenantId: latestSub.tenant_id,
            customerUserId: latestSub.customer_user_id,
            planId: latestSub.plan_id,
            planName: latestSub.plan_name || null,
            plan: {
                id: latestSub.plan_id,
                name: latestSub.plan_name || null,
            },
            pricePaid: Number(latestSub.price_paid),
            price_paid: Number(latestSub.price_paid),
            currency: latestSub.currency,
            durationDays: latestSub.duration_days,
            duration_days: latestSub.duration_days,
            status: effectiveStatus,
            startedAt: latestSub.started_at,
            expiresAt: latestSub.expires_at,
            isExpired,
            secondsRemaining,
            daysRemaining,
            createdAt: latestSub.created_at,
            updatedAt: latestSub.updated_at,
        };

        return {
            subscription: subscriptionData,
            status: effectiveStatus,
            hasActiveSubscription: !isExpired && (effectiveStatus === 'ACTIVE' || effectiveStatus === 'MANUALLY_GRANTED'),
            daysRemaining,
            secondsRemaining,
            isExpired,
        };
    }

    /**
     * GET /api/v1/me
     * Returns authenticated customer/user profile and primary tenant context.
     */
    router.get('/api/v1/me', authMiddleware, async (req, res) => {
        const profile = await authService.getMe(req.user.id);
        return sendJson(res, 200, {
            user: {
                id: profile.user.id,
                email: profile.user.email,
                phoneNumber: profile.user.phoneNumber,
                role: profile.user.role,
            },
            tenant: profile.tenant ? {
                id: profile.tenant.id,
                name: profile.tenant.name,
                status: profile.tenant.status,
                role: profile.tenant.role,
            } : null,
        }, { requestId: req.id });
    });

    /**
     * GET /api/v1/me/overview
     * Returns consolidated dashboard summary:
     * - Customer account & primary tenant summary
     * - Current subscription & plan status
     * - WhatsApp connection status & desired state
     * - Recent payments (up to 5)
     * - Recent notifications (up to 5)
     * - Quick action availability
     */
    router.get('/api/v1/me/overview', authMiddleware, async (req, res) => {
        const profile = await authService.getMe(req.user.id);
        const tenantId = await resolveCustomerTenant(req.user.id);

        let subResult = {
            subscription: null,
            status: 'NONE',
            hasActiveSubscription: false,
            daysRemaining: 0,
            secondsRemaining: 0,
            isExpired: false,
        };
        let connection = null;
        let recentPayments = [];
        let recentNotifications = [];

        if (tenantId) {
            // Subscription state
            if (subscriptionRepo) {
                const latestSub = await subscriptionRepo.findLatestByTenantId(tenantId);
                subResult = formatSubscription(latestSub);
            }

            // Connection state
            if (connectionService) {
                connection = await connectionService.getCustomerConnection(tenantId);
            }

            // Recent payments (last 5)
            if (paymentRepo) {
                const rawPayments = await paymentRepo.findAll({
                    customerUserId: req.user.id,
                    limit: 5,
                    offset: 0,
                });
                recentPayments = rawPayments.map(formatPayment);
            }

            // Recent notifications (last 5)
            if (subscriptionRepo && typeof subscriptionRepo.listNotificationsForTenant === 'function') {
                const rawNotifs = await subscriptionRepo.listNotificationsForTenant(tenantId, { limit: 5, offset: 0 });
                recentNotifications = rawNotifs.map((n) => ({
                    id: n.id,
                    subscriptionId: n.subscription_id,
                    planName: n.plan_name || null,
                    type: n.notification_type,
                    title: getNotificationTitle(n.notification_type),
                    message: getNotificationMessage(n.notification_type, n.plan_name),
                    sentAt: n.sent_at,
                    createdAt: n.created_at,
                }));
            }
        }

        const isTenantActive = profile.tenant ? profile.tenant.status === 'ACTIVE' : true;
        const hasActiveSub = subResult.hasActiveSubscription;
        const quickActions = {
            canStartConnection: isTenantActive && hasActiveSub && (!connection || connection.desiredState !== 'RUNNING'),
            canRenewSubscription: isTenantActive && Boolean(subResult.subscription),
            needsSubscription: !hasActiveSub,
        };

        return sendJson(res, 200, {
            customer: {
                user: {
                    id: profile.user.id,
                    email: profile.user.email,
                    phoneNumber: profile.user.phoneNumber,
                    role: profile.user.role,
                },
                tenant: profile.tenant ? {
                    id: profile.tenant.id,
                    name: profile.tenant.name,
                    status: profile.tenant.status,
                    role: profile.tenant.role,
                } : null,
            },
            subscription: subResult,
            connection,
            recentPayments,
            recentNotifications,
            quickActions,
        }, { requestId: req.id });
    });

    /**
     * GET /api/v1/plans
     * Public authoritative catalog of active customer plans.
     */
    router.get('/api/v1/plans', async (req, res) => {
        if (!planRepo) {
            return sendJson(res, 200, { plans: [] }, { requestId: req.id });
        }
        const plans = await planRepo.findAll({ status: 'ACTIVE' });
        const safePlans = (plans || []).map((p) => ({
            id: p.id,
            name: p.name,
            price: Number(p.price),
            currency: p.currency,
            durationDays: p.duration_days,
            duration_days: p.duration_days,
            description: p.description || null,
            status: p.status,
        }));
        return sendJson(res, 200, { plans: safePlans }, { requestId: req.id });
    });

    /**
     * GET /api/v1/me/subscription
     * Returns authenticated customer's subscription derived strictly from session context.
     * Never trusts client-supplied tenantId/customerId from query params, body, or headers.
     */
    router.get('/api/v1/me/subscription', authMiddleware, async (req, res) => {
        if (!tenantMembershipRepo || !subscriptionRepo) {
            return sendJson(res, 200, {
                subscription: null,
                status: 'NONE',
                hasActiveSubscription: false,
            }, { requestId: req.id });
        }

        const tenantId = await resolveCustomerTenant(req.user.id);
        if (!tenantId) {
            return sendJson(res, 200, {
                subscription: null,
                status: 'NONE',
                hasActiveSubscription: false,
            }, { requestId: req.id });
        }

        const latestSub = await subscriptionRepo.findLatestByTenantId(tenantId);
        const subResult = formatSubscription(latestSub);

        return sendJson(res, 200, {
            subscription: subResult.subscription,
            status: subResult.status,
            hasActiveSubscription: subResult.hasActiveSubscription,
            daysRemaining: subResult.daysRemaining,
            secondsRemaining: subResult.secondsRemaining,
            isExpired: subResult.isExpired,
        }, { requestId: req.id });
    });

    /**
     * GET /api/v1/me/payments
     * Returns authenticated customer's payment history with pagination and status filtering.
     * Strictly enforces tenant and customer isolation: only returns payments for req.user.id.
     */
    if (paymentRepo) {
        router.get('/api/v1/me/payments', authMiddleware, async (req, res) => {
            const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
            const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 20));
            const offset = (page - 1) * limit;
            const status = req.query?.status ? String(req.query.status).toUpperCase() : null;

            const [payments, total] = await Promise.all([
                paymentRepo.findAll({
                    customerUserId: req.user.id,
                    status,
                    limit,
                    offset,
                }),
                paymentRepo.count ? paymentRepo.count({
                    customerUserId: req.user.id,
                    status,
                }) : Promise.resolve(0),
            ]);

            const safePayments = (payments || []).map(formatPayment);

            return sendJson(res, 200, {
                payments: safePayments,
                pagination: {
                    page,
                    limit,
                    total,
                    count: safePayments.length,
                },
            }, { requestId: req.id });
        });

        /**
         * GET /api/v1/me/payments/:id
         * Returns single payment details for authenticated customer.
         * Enforces strict customer ownership; returns 404 on IDOR attempts.
         */
        router.get('/api/v1/me/payments/:id', authMiddleware, async (req, res) => {
            const paymentId = req.params.id;
            const payment = await paymentRepo.findById(paymentId);
            if (!payment || payment.customer_user_id !== req.user.id) {
                throw ApiError.notFound('Payment not found', 'RESOURCE_NOT_FOUND');
            }
            return sendJson(res, 200, {
                payment: formatPayment(payment),
            }, { requestId: req.id });
        });
    }

    /**
     * GET /api/v1/me/notifications
     * Returns customer's subscription notification history.
     * Strictly tenant-scoped (never exposes another customer's notifications).
     */
    router.get('/api/v1/me/notifications', authMiddleware, async (req, res) => {
        const tenantId = await resolveCustomerTenant(req.user.id);
        if (!tenantId || !subscriptionRepo || typeof subscriptionRepo.listNotificationsForTenant !== 'function') {
            return sendJson(res, 200, {
                notifications: [],
                pagination: { page: 1, limit: 20, total: 0, count: 0 },
            }, { requestId: req.id });
        }

        const page = Math.max(1, parseInt(req.query?.page, 10) || 1);
        const limit = Math.min(100, Math.max(1, parseInt(req.query?.limit, 10) || 20));
        const offset = (page - 1) * limit;

        const [rawNotifs, total] = await Promise.all([
            subscriptionRepo.listNotificationsForTenant(tenantId, { limit, offset }),
            subscriptionRepo.countNotificationsForTenant ? subscriptionRepo.countNotificationsForTenant(tenantId) : Promise.resolve(0),
        ]);

        const safeNotifications = (rawNotifs || []).map((n) => ({
            id: n.id,
            subscriptionId: n.subscription_id,
            planName: n.plan_name || null,
            type: n.notification_type,
            title: getNotificationTitle(n.notification_type),
            message: getNotificationMessage(n.notification_type, n.plan_name),
            sentAt: n.sent_at,
            createdAt: n.created_at,
        }));

        return sendJson(res, 200, {
            notifications: safeNotifications,
            pagination: {
                page,
                limit,
                total,
                count: safeNotifications.length,
            },
        }, { requestId: req.id });
    });

    /**
     * GET /api/v1/me/support
     * Returns platform support channels, documentation, and customer FAQs.
     */
    router.get('/api/v1/me/support', authMiddleware, async (req, res) => {
        return sendJson(res, 200, {
            support: {
                email: process.env.SUPPORT_EMAIL || 'support@windowseven.local',
                phoneNumber: process.env.SUPPORT_PHONE || '+255700000000',
                whatsappChannel: process.env.SUPPORT_WHATSAPP_URL || 'https://chat.whatsapp.com/windowseven-support',
                documentationUrl: process.env.DOCS_URL || 'https://docs.windowseven.local',
                businessHours: 'Monday - Saturday: 08:00 - 20:00 EAT',
                faq: [
                    {
                        question: 'How do I connect my WhatsApp bot?',
                        answer: 'Navigate to the WhatsApp tab, ensure you have an active subscription, and click Start Connection to display the QR code or request an 8-digit pairing code.',
                    },
                    {
                        question: 'How do renewals work?',
                        answer: 'You can renew your subscription at any time. Any remaining days on your current active subscription are automatically preserved and added to your new plan duration.',
                    },
                    {
                        question: 'What happens when my subscription expires?',
                        answer: 'When your subscription expires, your WhatsApp bot connection will be paused. Your settings, groups, and logs are preserved, and connecting will be available as soon as you renew.',
                    },
                    {
                        question: 'What payment methods can I use?',
                        answer: 'We support automated mobile money payments via M-Pesa, Tigo Pesa, Airtel Money, and HaloPesa.',
                    },
                ],
            },
        }, { requestId: req.id });
    });

    /**
     * POST /api/v1/me/subscriptions/purchase
     * Creates a customer purchase intent (PENDING payment) for the chosen active plan.
     * Client amounts, currencies, and tenantIds are strictly ignored.
     * Does NOT contact FastLipa yet and does NOT activate subscription prematurely.
     */
    if (customerPurchaseService && readJsonBody) {
        router.post('/api/v1/me/subscriptions/purchase', authMiddleware, async (req, res) => {
            const membership = await resolveCustomerPrimaryMembership(req.user.id);
            await assertActiveTenant(membership);

            const body = await readJsonBody(req);
            if (!body || !body.planId) {
                throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');
            }

            const result = await customerPurchaseService.createPurchaseIntent({
                customerUserId: req.user.id,
                planId: body.planId,
                provider: body.provider || 'MANUAL',
            });

            return sendJson(res, 201, result, { requestId: req.id });
        });
    }

    /**
     * Helper to resolve customer primary tenant with OWNER role.
     * Prevents IDOR and parameter tampering.
     */
    async function resolveCustomerTenant(userId) {
        if (!tenantMembershipRepo) return null;
        const memberships = await tenantMembershipRepo.listTenantsForUser(userId);
        const ownerMembership = memberships.find((m) => m.role === 'OWNER') || memberships[0] || null;
        return ownerMembership ? ownerMembership.tenant_id : null;
    }

    async function resolveCustomerPrimaryMembership(userId) {
        if (!tenantMembershipRepo) return null;
        const memberships = await tenantMembershipRepo.listTenantsForUser(userId);
        return memberships.find((m) => m.role === 'OWNER') || memberships[0] || null;
    }

    async function assertActiveTenant(membership) {
        if (!membership) {
            throw ApiError.badRequest('No associated customer account found', 'TENANT_NOT_FOUND');
        }
        if (membership.tenant_status === 'DEACTIVATED') {
            throw ApiError.forbidden('Customer account has been deactivated', 'TENANT_DEACTIVATED');
        }
        if (membership.tenant_status === 'SUSPENDED') {
            throw ApiError.forbidden('Customer account is suspended. Mutating operations are disabled.', 'TENANT_SUSPENDED');
        }
    }

    /**
     * Helper to assert that customer has an active subscription entitlement.
     * Throws 403 SUBSCRIPTION_REQUIRED if subscription is missing or expired.
     */
    async function assertActiveSubscription(tenantId) {
        if (!subscriptionRepo) return true;
        const activeSub = await subscriptionRepo.findActiveByTenantId(tenantId);
        if (!activeSub) {
            throw ApiError.forbidden(
                'Active subscription required to start or pair a WhatsApp connection',
                'SUBSCRIPTION_REQUIRED'
            );
        }
        return activeSub;
    }

    if (connectionService) {
        /**
         * GET /api/v1/me/connection
         * Returns customer's single WhatsApp connection details (or null).
         */
        router.get('/api/v1/me/connection', authMiddleware, async (req, res) => {
            const tenantId = await resolveCustomerTenant(req.user.id);
            if (!tenantId) {
                return sendJson(res, 200, { connection: null }, { requestId: req.id });
            }

            const connection = await connectionService.getCustomerConnection(tenantId);
            return sendJson(res, 200, { connection }, { requestId: req.id });
        });

        /**
         * POST /api/v1/me/connection
         * Idempotently starts or provisions the customer's single WhatsApp connection.
         * Enforces:
         * 1. Customer must have ACTIVE or MANUALLY_GRANTED subscription (403 SUBSCRIPTION_REQUIRED).
         * 2. Exactly one connection per tenant (reuses existing if present).
         * 3. desired_state -> RUNNING.
         */
        router.post('/api/v1/me/connection', authMiddleware, async (req, res) => {
            const membership = await resolveCustomerPrimaryMembership(req.user.id);
            await assertActiveTenant(membership);
            const tenantId = membership.tenant_id;

            // Enforce subscription entitlement rule
            await assertActiveSubscription(tenantId);

            let body = {};
            if (readJsonBody) {
                body = await readJsonBody(req).catch(() => ({}));
            }

            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const connection = await connectionService.getOrCreateCustomerConnection({
                tenantId,
                phoneNumber: body.phoneNumber || null,
                displayName: body.displayName || null,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, { connection }, { requestId: req.id });
        });

        /**
         * GET /api/v1/me/connection/qr
         * Returns ephemeral QR code if available for customer's connection.
         */
        router.get('/api/v1/me/connection/qr', authMiddleware, async (req, res) => {
            const tenantId = await resolveCustomerTenant(req.user.id);
            if (!tenantId) {
                throw ApiError.notFound('Connection not found', 'RESOURCE_NOT_FOUND');
            }

            const conn = await connectionService.getCustomerConnection(tenantId);
            if (!conn) {
                throw ApiError.notFound('Connection not found for customer account', 'RESOURCE_NOT_FOUND');
            }

            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const qrEntry = await connectionService.getQrCode(tenantId, conn.id, {
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, qrEntry, { requestId: req.id });
        });

        /**
         * POST /api/v1/me/connection/pairing-code
         * Requests an ephemeral 8-digit WhatsApp pairing code for phone-number linking.
         * Enforces subscription entitlement.
         */
        router.post('/api/v1/me/connection/pairing-code', authMiddleware, async (req, res) => {
            const membership = await resolveCustomerPrimaryMembership(req.user.id);
            await assertActiveTenant(membership);
            const tenantId = membership.tenant_id;

            // Enforce subscription entitlement rule
            await assertActiveSubscription(tenantId);

            let body = {};
            if (readJsonBody) {
                body = await readJsonBody(req).catch(() => ({}));
            }

            const profile = await authService.getMe(req.user.id);
            const phoneNumber = body.phoneNumber || profile?.user?.phoneNumber;
            if (!phoneNumber) {
                throw ApiError.badRequest('phoneNumber is required for pairing code', 'VALIDATION_ERROR');
            }

            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const pairingResult = await connectionService.requestCustomerPairingCode({
                tenantId,
                phoneNumber,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, pairingResult, { requestId: req.id });
        });

        /**
         * POST /api/v1/me/connection/disconnect
         * Gracefully stops the customer's WhatsApp connection (desired_state -> STOPPED).
         * Invariant: Never deletes customer subscription or account.
         */
        router.post('/api/v1/me/connection/disconnect', authMiddleware, async (req, res) => {
            const membership = await resolveCustomerPrimaryMembership(req.user.id);
            if (membership && membership.tenant_status === 'DEACTIVATED') {
                throw ApiError.forbidden('Customer account has been deactivated', 'TENANT_DEACTIVATED');
            }
            const tenantId = membership ? membership.tenant_id : null;
            if (!tenantId) {
                throw ApiError.notFound('Connection not found', 'RESOURCE_NOT_FOUND');
            }

            const conn = await connectionService.getCustomerConnection(tenantId);
            if (!conn) {
                throw ApiError.notFound('No connection found to disconnect', 'RESOURCE_NOT_FOUND');
            }

            const ipAddress = req.ip || req.socket?.remoteAddress || null;
            const userAgent = req.headers['user-agent'] || null;

            const updated = await connectionService.stopConnection({
                tenantId,
                connectionId: conn.id,
                actorUserId: req.user.id,
                ipAddress,
                userAgent,
            });

            return sendJson(res, 200, {
                connection: updated,
                message: 'WhatsApp connection stopped successfully',
            }, { requestId: req.id });
        });
    }
}

module.exports = {
    registerCustomerRoutes,
};
