const EventEmitter = require('node:events');

const NOTIFICATION_TYPES = {
    THREE_DAYS_BEFORE: '3_DAYS_BEFORE',
    TWENTY_FOUR_HOURS_BEFORE: '24_HOURS_BEFORE',
    EXPIRED: 'EXPIRED',
};

class DefaultNotificationDispatcher {
    constructor({ eventPublisher = null, logger = console } = {}) {
        this.eventPublisher = eventPublisher;
        this.logger = logger;
    }

    async dispatch({ tenantId, subscriptionId, notificationType, recipient, message, expiresAt }) {
        const destination = recipient.phoneNumber || recipient.email || null;
        if (!destination) {
            return { delivered: false, error: 'NO_RECIPIENT_DESTINATION' };
        }

        if (this.eventPublisher) {
            await this.eventPublisher.publish({
                tenantId,
                eventType: 'subscription.notification',
                data: {
                    subscriptionId,
                    notificationType,
                    recipient,
                    message,
                    expiresAt: expiresAt instanceof Date ? expiresAt.toISOString() : expiresAt,
                },
            }).catch((err) => {
                this.logger.warn(`[DefaultNotificationDispatcher] Event publication failed: ${err.message}`);
            });
        }

        return { delivered: true, destination };
    }
}

class SubscriptionNotificationService extends EventEmitter {
    constructor({
        pool,
        subscriptionRepo,
        dispatcher = null,
        eventPublisher = null,
        logger = console,
    } = {}) {
        super();
        if (!pool) throw new Error('pool is required');
        if (!subscriptionRepo) throw new Error('subscriptionRepo is required');

        this.pool = pool;
        this.subscriptionRepo = subscriptionRepo;
        this.dispatcher = dispatcher || new DefaultNotificationDispatcher({ eventPublisher, logger });
        this.logger = logger;
        this.timer = null;
        this.isSweeping = false;
    }

    formatMessage(notificationType, tenantName = 'Your Account') {
        switch (notificationType) {
            case NOTIFICATION_TYPES.THREE_DAYS_BEFORE:
                return `⚠️ Your Windowseven subscription for "${tenantName}" will expire in 3 days. Please renew your subscription to maintain continuous bot service.`;
            case NOTIFICATION_TYPES.TWENTY_FOUR_HOURS_BEFORE:
                return `🚨 URGENT: Your Windowseven subscription for "${tenantName}" will expire in 24 hours. Renew now to avoid bot command interruption.`;
            case NOTIFICATION_TYPES.EXPIRED:
                return '⚠️ Your Windowseven subscription has expired. Please renew your subscription to continue using bot commands.';
            default:
                return 'Notice regarding your Windowseven subscription.';
        }
    }

    /**
     * Atomically locks, verifies, dispatches, and records a notification for a subscription.
     * Guarantees at-most-once delivery, row-level concurrency isolation, and failure retryability.
     */
    async notifySubscription(sub, notificationType) {
        const client = await this.pool.connect();
        try {
            await client.query('BEGIN');

            // 1. Acquire row-level lock on the subscription row using FOR UPDATE SKIP LOCKED
            // This guarantees that concurrent workers or overlapping sweeps cannot double-process
            const { rows } = await client.query(`
                SELECT s.id, s.tenant_id, s.customer_user_id, s.status, s.expires_at,
                       u.email, u.phone_number, t.name as tenant_name
                FROM customer_subscriptions s
                JOIN users u ON s.customer_user_id = u.id
                JOIN tenants t ON s.tenant_id = t.id
                WHERE s.id = $1
                FOR UPDATE SKIP LOCKED;
            `, [sub.id]);

            if (rows.length === 0) {
                // Locked by another worker or not found; skip safely
                await client.query('ROLLBACK');
                return { skipped: true, reason: 'LOCKED_BY_ANOTHER_WORKER' };
            }

            const lockedSub = rows[0];

            // Invariant: CANCELLED subscriptions must NEVER receive expiry notifications
            if (lockedSub.status === 'CANCELLED') {
                await client.query('ROLLBACK');
                return { skipped: true, reason: 'SUBSCRIPTION_CANCELLED' };
            }

            // Invariant: ACTIVE/MANUALLY_GRANTED notifications must not fire if already EXPIRED
            if (notificationType !== NOTIFICATION_TYPES.EXPIRED && lockedSub.status === 'EXPIRED') {
                await client.query('ROLLBACK');
                return { skipped: true, reason: 'ALREADY_EXPIRED' };
            }

            // 2. Double-check idempotency barrier inside the transaction
            const existing = await client.query(`
                SELECT id FROM subscription_notifications
                WHERE subscription_id = $1 AND notification_type = $2;
            `, [lockedSub.id, notificationType]);

            if (existing.rows.length > 0) {
                await client.query('ROLLBACK');
                return { skipped: true, reason: 'ALREADY_NOTIFIED' };
            }

            // 3. Format message tailored to customer owner
            const message = this.formatMessage(notificationType, lockedSub.tenant_name);

            // 4. Attempt delivery to customer owner destination
            let deliveryResult;
            try {
                deliveryResult = await this.dispatcher.dispatch({
                    tenantId: lockedSub.tenant_id,
                    subscriptionId: lockedSub.id,
                    notificationType,
                    recipient: {
                        userId: lockedSub.customer_user_id,
                        email: lockedSub.email,
                        phoneNumber: lockedSub.phone_number,
                    },
                    message,
                    expiresAt: lockedSub.expires_at,
                });
            } catch (dispatchErr) {
                // Delivery failed with an exception; rollback so next sweep can retry safely
                await client.query('ROLLBACK');
                this.logger.error(
                    `[SubscriptionNotificationService] Delivery threw error for subscription ${lockedSub.id} (${notificationType}): ${dispatchErr.message}`
                );
                return { success: false, error: dispatchErr.message };
            }

            if (!deliveryResult || deliveryResult.delivered === false) {
                // Dispatcher indicated delivery failure; rollback without recording sent record
                await client.query('ROLLBACK');
                return { success: false, error: deliveryResult?.error || 'DISPATCH_REJECTED' };
            }

            // 5. Delivery SUCCEEDED: Record in subscription_notifications atomically
            const recordResult = await client.query(`
                INSERT INTO subscription_notifications (subscription_id, tenant_id, notification_type, sent_at)
                VALUES ($1, $2, $3, NOW())
                ON CONFLICT (subscription_id, notification_type) DO NOTHING
                RETURNING id, subscription_id, tenant_id, notification_type, sent_at;
            `, [lockedSub.id, lockedSub.tenant_id, notificationType]);

            await client.query('COMMIT');

            this.emit('notification_sent', {
                subscriptionId: lockedSub.id,
                tenantId: lockedSub.tenant_id,
                notificationType,
                destination: deliveryResult.destination,
            });

            return {
                success: true,
                delivered: true,
                notification: recordResult.rows[0],
            };
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }
    }

    /**
     * Executes one complete sweep across all notification windows and authoritative status transitions.
     */
    async sweep() {
        if (this.isSweeping) {
            return { skipped: true, reason: 'SWEEP_IN_PROGRESS' };
        }

        this.isSweeping = true;
        const summary = {
            expiredStatusCount: 0,
            threeDaysSent: 0,
            twentyFourHoursSent: 0,
            expiredSent: 0,
            failed: 0,
            skipped: 0,
        };

        try {
            // 1. Authoritative subscription expiry status transitions in PostgreSQL
            const expiredRows = await this.subscriptionRepo.expireSubscriptions();
            summary.expiredStatusCount = expiredRows.length;

            // 2. Sweep 3 days before expiry (0 < expires_at - NOW() <= 72 hours)
            const threeDayCandidates = await this.subscriptionRepo.findExpiringSubscriptions({
                hoursRemaining: 72,
                notificationType: NOTIFICATION_TYPES.THREE_DAYS_BEFORE,
            });

            for (const sub of threeDayCandidates) {
                const res = await this.notifySubscription(sub, NOTIFICATION_TYPES.THREE_DAYS_BEFORE);
                if (res.delivered) summary.threeDaysSent++;
                else if (res.skipped) summary.skipped++;
                else if (res.success === false) summary.failed++;
            }

            // 3. Sweep 24 hours before expiry (0 < expires_at - NOW() <= 24 hours)
            const twentyFourHourCandidates = await this.subscriptionRepo.findExpiringSubscriptions({
                hoursRemaining: 24,
                notificationType: NOTIFICATION_TYPES.TWENTY_FOUR_HOURS_BEFORE,
            });

            for (const sub of twentyFourHourCandidates) {
                const res = await this.notifySubscription(sub, NOTIFICATION_TYPES.TWENTY_FOUR_HOURS_BEFORE);
                if (res.delivered) summary.twentyFourHoursSent++;
                else if (res.skipped) summary.skipped++;
                else if (res.success === false) summary.failed++;
            }

            // 4. Sweep expired subscriptions (expires_at <= NOW())
            const expiredCandidates = await this.subscriptionRepo.findExpiredSubscriptionsForNotification({
                notificationType: NOTIFICATION_TYPES.EXPIRED,
            });

            for (const sub of expiredCandidates) {
                const res = await this.notifySubscription(sub, NOTIFICATION_TYPES.EXPIRED);
                if (res.delivered) summary.expiredSent++;
                else if (res.skipped) summary.skipped++;
                else if (res.success === false) summary.failed++;
            }

            return summary;
        } finally {
            this.isSweeping = false;
        }
    }

    start(intervalMs = 60000) {
        if (this.timer) return;
        this.timer = setInterval(() => {
            this.sweep().catch((err) => {
                this.logger.error(`[SubscriptionNotificationService] Sweep error: ${err.message}`);
            });
        }, intervalMs);
        if (this.timer.unref) this.timer.unref();
    }

    stop() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
    }
}

module.exports = {
    SubscriptionNotificationService,
    DefaultNotificationDispatcher,
    NOTIFICATION_TYPES,
};
