'use strict';

const ApiError = require('../errors/ApiError');

/**
 * Windowseven MD - Core Payment Lifecycle & Orchestration Service
 * Coordinates provider-agnostic payment initiation and webhook callback validation.
 * Strictly separates cryptographic verification from business identity validation.
 * Delegates subscription activation to authoritative PlatformService.
 */
class PaymentService {
    constructor({
        pool,
        paymentRepo,
        planRepo,
        subscriptionRepo,
        tenantMembershipRepo = null,
        platformService,
        paymentGateway,
        platformAuditRepo = null,
    }) {
        if (!pool || !paymentRepo || !planRepo || !subscriptionRepo || !platformService || !paymentGateway) {
            throw new Error('[PaymentService] pool, paymentRepo, planRepo, subscriptionRepo, platformService, and paymentGateway are required');
        }
        this.pool = pool;
        this.paymentRepo = paymentRepo;
        this.planRepo = planRepo;
        this.subscriptionRepo = subscriptionRepo;
        this.tenantMembershipRepo = tenantMembershipRepo;
        this.platformService = platformService;
        this.paymentGateway = paymentGateway;
        this.platformAuditRepo = platformAuditRepo;
    }

    /**
     * Initiates customer payment flow:
     * 1. Validates plan and customer tenant
     * 2. Creates PENDING payment record with authoritative plan pricing
     * 3. Calls paymentGateway.initiatePayment()
     * 4. Returns payment, plan, and checkout representation
     *
     * @param {object} params
     * @param {string} params.customerUserId
     * @param {string} params.planId
     * @param {string} [params.provider]
     * @param {string} [params.callbackUrl]
     * @returns {Promise<object>}
     */
    async initiatePayment({ customerUserId, planId, provider = null, callbackUrl = null }) {
        if (!customerUserId) {
            throw ApiError.unauthorized('Customer authentication required', 'AUTH_REQUIRED');
        }
        if (!planId) {
            throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');
        }

        let tenantId = null;
        if (this.tenantMembershipRepo) {
            const memberships = await this.tenantMembershipRepo.listTenantsForUser(customerUserId);
            const ownerMembership = memberships.find((m) => m.role === 'OWNER') || memberships[0] || null;
            if (!ownerMembership) {
                throw ApiError.notFound('Customer tenant not found', 'TENANT_NOT_FOUND');
            }
            tenantId = ownerMembership.tenant_id;
        }

        const plan = await this.planRepo.findById(planId);
        if (!plan) {
            throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'ACTIVE') {
            throw ApiError.badRequest('Plan is not currently active', 'PLAN_NOT_ACTIVE');
        }

        const activeProvider = (provider || this.paymentGateway.providerName || 'TEST').toUpperCase();
        const transactionReference = `TX_CUST_${Date.now()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        const payment = await this.paymentRepo.create({
            tenantId,
            customerUserId,
            planId: plan.id,
            amount: Number(plan.price),
            currency: plan.currency,
            provider: activeProvider,
            transactionReference,
            status: 'PENDING',
            metadata: {
                planName: plan.name,
                durationDays: plan.duration_days,
            },
        });

        // Delegate initiation to PaymentGateway
        const gatewayResult = await this.paymentGateway.initiatePayment({
            payment,
            plan,
            customer: { id: customerUserId },
            callbackUrl,
        });

        return {
            payment: {
                id: payment.id,
                transactionReference: payment.transaction_reference,
                amount: Number(payment.amount),
                currency: payment.currency,
                status: payment.status,
                createdAt: payment.created_at,
            },
            plan: {
                id: plan.id,
                name: plan.name,
                price: Number(plan.price),
                currency: plan.currency,
                durationDays: plan.duration_days,
            },
            checkout: gatewayResult ? {
                provider: gatewayResult.provider,
                providerReference: gatewayResult.providerReference,
                checkoutUrl: gatewayResult.checkoutUrl,
            } : null,
        };
    }

    /**
     * Handles incoming provider callback/webhook:
     * 1. Cryptographic verification via paymentGateway.verifyCallback
     * 2. Authoritative database payment lookup with row lock (FOR UPDATE)
     * 3. Idempotency check: If already SUCCESS + subscription_id, returns ALREADY_PROCESSED
     * 4. Amount and currency precision validation (invalid callback != failed payment)
     * 5. Delegates activation to authoritative PlatformService engine
     *
     * @param {object} params
     * @param {object} params.headers
     * @param {object} params.body
     * @param {string|Buffer} [params.rawBody]
     * @returns {Promise<object>}
     */
    async handleCallback({ headers, body, rawBody = null }) {
        // 1. Separate cryptographic verification from business validation
        const verification = await this.paymentGateway.verifyCallback({ headers, body, rawBody });
        if (!verification.success) {
            if (verification.error === 'MISSING_SIGNATURE' || verification.error === 'INVALID_SIGNATURE') {
                throw ApiError.unauthorized('Invalid or missing webhook signature', 'INVALID_SIGNATURE');
            }
            if (verification.error === 'MISSING_TRANSACTION_REFERENCE') {
                throw ApiError.badRequest('Missing transaction reference in callback payload', 'INVALID_CALLBACK');
            }
            if (verification.error === 'UNSUPPORTED_STATUS') {
                throw ApiError.badRequest('Unsupported provider payment status', 'INVALID_CALLBACK');
            }
            throw ApiError.badRequest(verification.error || 'Invalid callback payload', 'INVALID_CALLBACK');
        }

        const client = await this.pool.connect();
        let payment;
        try {
            await client.query('BEGIN');

            // 2. Fetch payment with row-level lock (FOR UPDATE)
            const { rows } = await client.query(
                'SELECT * FROM payments WHERE transaction_reference = $1 FOR UPDATE;',
                [verification.transactionReference]
            );
            payment = rows[0] || null;

            if (!payment) {
                await client.query('ROLLBACK');
                throw ApiError.notFound('Payment not found for transaction reference', 'PAYMENT_NOT_FOUND');
            }

            // 3. Idempotency / Replay Defense:
            // If already SUCCESS and has a subscription_id, return ALREADY_PROCESSED immediately with zero mutations
            if (payment.status === 'SUCCESS' && payment.subscription_id) {
                const existingSub = await this.subscriptionRepo.findById(payment.subscription_id, client);
                await client.query('COMMIT');
                return {
                    success: true,
                    status: 'ALREADY_PROCESSED',
                    payment,
                    subscription: existingSub,
                };
            }

            // 4. Validate Amount and Currency (Rule 9: Invalid callback != Failed payment)
            // Reject callback, do NOT mark valid payment as FAILED!
            if (verification.amount !== undefined && verification.amount !== null) {
                if (Number(verification.amount) !== Number(payment.amount)) {
                    await client.query('ROLLBACK');
                    if (this.platformAuditRepo) {
                        await this.platformAuditRepo.record({
                            actorUserId: null,
                            actorRole: 'SYSTEM',
                            action: 'PAYMENT_CALLBACK_TAMPER_DETECTED',
                            targetType: 'PAYMENT',
                            targetId: payment.id,
                            targetTenantId: payment.tenant_id,
                            reason: `Amount mismatch: expected ${payment.amount}, received ${verification.amount}`,
                            metadata: {
                                expectedAmount: Number(payment.amount),
                                receivedAmount: Number(verification.amount),
                                transactionReference: payment.transaction_reference,
                            },
                        }).catch(() => {});
                    }
                    throw ApiError.badRequest('Payment amount does not match authoritative plan pricing', 'AMOUNT_MISMATCH');
                }
            }

            if (verification.currency && verification.currency.toUpperCase() !== payment.currency.toUpperCase()) {
                await client.query('ROLLBACK');
                throw ApiError.badRequest('Payment currency does not match authoritative plan currency', 'CURRENCY_MISMATCH');
            }

            await client.query('COMMIT');
        } catch (err) {
            await client.query('ROLLBACK').catch(() => {});
            throw err;
        } finally {
            client.release();
        }

        // 5. Delegate activation strictly to authoritative PlatformService engine
        const activation = await this.platformService.activateSubscriptionFromPayment({
            paymentId: payment.id,
            transactionReference: payment.transaction_reference,
            status: verification.status,
            failureReason: verification.failureReason,
        });

        return {
            success: activation.success,
            status: activation.alreadyActivated
                ? 'ALREADY_PROCESSED'
                : (activation.success ? 'SUCCESS' : 'FAILED'),
            payment: activation.payment,
            subscription: activation.subscription,
        };
    }
}

module.exports = PaymentService;
