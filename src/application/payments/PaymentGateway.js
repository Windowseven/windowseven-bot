'use strict';

/**
 * Windowseven MD - PaymentGateway Contract
 * Abstract provider-agnostic interface establishing contracts for payment initiation,
 * callback verification, and active reconciliation.
 */
class PaymentGateway {
    /**
     * Initiates a payment transaction with the external provider.
     * Provider implementations must normalize their initiation response.
     * Must NEVER activate subscriptions.
     *
     * @param {object} params
     * @param {object} params.payment - The internal payment entity from database
     * @param {object} params.plan - The internal plan entity
     * @param {object} [params.customer] - Customer identity details (id, email, phone)
     * @param {string} [params.callbackUrl] - Webhook callback URL
     * @returns {Promise<{
     *   success: boolean,
     *   provider: string,
     *   providerReference: string,
     *   transactionReference: string,
     *   checkoutUrl?: string,
     *   status: string,
     *   rawResponse?: any
     * }>}
     */
    async initiatePayment(params) {
        throw new Error('[PaymentGateway] initiatePayment must be implemented by provider subclass');
    }

    /**
     * Verifies and normalizes an incoming provider callback/webhook.
     * Strictly separates cryptographic verification from business identity validation.
     *
     * @param {object} params
     * @param {object} params.headers - HTTP request headers
     * @param {object} params.body - Parsed JSON body
     * @param {string|Buffer} [params.rawBody] - Unparsed raw body string for HMAC verification
     * @returns {Promise<{
     *   success: boolean,
     *   transactionReference?: string,
     *   providerReference?: string,
     *   amount?: number,
     *   currency?: string,
     *   status?: 'SUCCESS' | 'FAILED',
     *   failureReason?: string,
     *   error?: string,
     *   rawPayload?: any
     * }>}
     */
    async verifyCallback(params) {
        throw new Error('[PaymentGateway] verifyCallback must be implemented by provider subclass');
    }

    /**
     * Actively queries payment status from provider for reconciliation or fallback.
     *
     * @param {object} params
     * @param {string} params.transactionReference
     * @param {string} [params.providerReference]
     * @returns {Promise<{
     *   status: string,
     *   amount?: number,
     *   currency?: string,
     *   failureReason?: string
     * }>}
     */
    async queryPaymentStatus(params) {
        throw new Error('[PaymentGateway] queryPaymentStatus must be implemented by provider subclass');
    }
}

module.exports = PaymentGateway;
