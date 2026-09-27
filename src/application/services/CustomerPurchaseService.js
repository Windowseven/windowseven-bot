'use strict';

const ApiError = require('../errors/ApiError');

/**
 * Windowseven MD Customer Purchase Application Service (Slice 2B)
 * Manages customer-owned purchase intents and subscription activation domain rules.
 */
class CustomerPurchaseService {
    constructor({
        pool,
        planRepo,
        paymentRepo,
        subscriptionRepo,
        tenantMembershipRepo,
        platformService = null,
        platformAuditRepo = null,
        paymentGateway = null,
    }) {
        if (!pool || !planRepo || !paymentRepo || !subscriptionRepo || !tenantMembershipRepo) {
            throw new Error('[CustomerPurchaseService] pool, planRepo, paymentRepo, subscriptionRepo, and tenantMembershipRepo are required');
        }
        this.pool = pool;
        this.planRepo = planRepo;
        this.paymentRepo = paymentRepo;
        this.subscriptionRepo = subscriptionRepo;
        this.tenantMembershipRepo = tenantMembershipRepo;
        this.platformService = platformService;
        this.platformAuditRepo = platformAuditRepo;
        this.paymentGateway = paymentGateway;
    }

    /**
     * Creates a customer purchase intent (PENDING payment record) strictly for the authenticated customer.
     * Enforces server-authoritative plan attributes; client amounts, currencies, and durations are ignored.
     * If paymentGateway is configured, delegates provider initiation to generate checkout metadata.
     *
     * @param {object} params
     * @param {string} params.customerUserId - Authenticated customer's user UUID
     * @param {string} params.planId - Desired plan UUID
     * @param {string} [params.provider='MANUAL'] - Payment provider identifier
     * @returns {Promise<object>} Purchase intent details
     */
    async createPurchaseIntent({ customerUserId, planId, provider = 'MANUAL' }) {
        if (!customerUserId) {
            throw ApiError.unauthorized('Customer authentication required', 'AUTH_REQUIRED');
        }
        if (!planId) {
            throw ApiError.badRequest('planId is required', 'VALIDATION_ERROR');
        }

        // 1. Authoritative customer tenant derived strictly from database membership
        const memberships = await this.tenantMembershipRepo.listTenantsForUser(customerUserId);
        const ownerMembership = memberships.find((m) => m.role === 'OWNER') || memberships[0] || null;
        if (!ownerMembership) {
            throw ApiError.notFound('Customer tenant not found', 'TENANT_NOT_FOUND');
        }
        if (ownerMembership.tenant_status === 'DEACTIVATED') {
            throw ApiError.forbidden('Customer account has been deactivated', 'TENANT_DEACTIVATED');
        }
        if (ownerMembership.tenant_status === 'SUSPENDED') {
            throw ApiError.forbidden('Customer account is suspended. Purchases are disabled.', 'TENANT_SUSPENDED');
        }
        const tenantId = ownerMembership.tenant_id;

        // 2. Authoritative plan lookup and validation
        const plan = await this.planRepo.findById(planId);
        if (!plan) {
            throw ApiError.notFound('Plan not found', 'PLAN_NOT_FOUND');
        }
        if (plan.status !== 'ACTIVE') {
            throw ApiError.badRequest('Plan is not currently active', 'PLAN_NOT_ACTIVE');
        }

        // 3. Generate safe unique transaction reference
        const transactionReference = `TX_CUST_${Date.now()}_${Math.random().toString(36).substring(2, 8).toUpperCase()}`;

        // 4. Create PENDING payment record with authoritative plan pricing
        const payment = await this.paymentRepo.create({
            tenantId,
            customerUserId,
            planId: plan.id,
            amount: Number(plan.price),
            currency: plan.currency,
            provider: provider.toUpperCase(),
            transactionReference,
            status: 'PENDING',
            metadata: {
                planName: plan.name,
                durationDays: plan.duration_days,
            },
        });

        // 5. Provider Initiation (if payment gateway configured)
        let checkout = null;
        if (this.paymentGateway) {
            const gatewayResult = await this.paymentGateway.initiatePayment({
                payment,
                plan,
                customer: { id: customerUserId },
            });
            if (gatewayResult) {
                checkout = {
                    provider: gatewayResult.provider,
                    providerReference: gatewayResult.providerReference,
                    checkoutUrl: gatewayResult.checkoutUrl,
                };
            }
        }

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
            checkout,
        };
    }

    /**
     * Authoritative subscription activation from verified payment.
     * Enforces customer ownership when invoked in customer context.
     *
     * @param {object} params
     * @param {string} [params.paymentId]
     * @param {string} [params.transactionReference]
     * @param {string} [params.status='SUCCESS']
     * @param {string} [params.failureReason]
     * @param {string} [params.customerUserId] - If provided, verifies customer ownership
     */
    async activateSubscriptionFromPayment({ paymentId = null, transactionReference = null, status = 'SUCCESS', failureReason = null, customerUserId = null }) {
        if (customerUserId) {
            let payment;
            if (paymentId) {
                payment = await this.paymentRepo.findById(paymentId);
            } else if (transactionReference) {
                payment = await this.paymentRepo.findByTransactionReference(transactionReference);
            }
            if (payment && payment.customer_user_id !== customerUserId) {
                throw ApiError.forbidden('Cannot activate a payment belonging to another customer', 'FORBIDDEN');
            }
        }

        if (this.platformService && typeof this.platformService.activateSubscriptionFromPayment === 'function') {
            return this.platformService.activateSubscriptionFromPayment({ paymentId, transactionReference, status, failureReason });
        }
        throw new Error('[CustomerPurchaseService] PlatformService activation method is required');
    }
}

module.exports = CustomerPurchaseService;
