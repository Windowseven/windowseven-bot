'use strict';

const crypto = require('node:crypto');
const PaymentGateway = require('./PaymentGateway');

/**
 * Windowseven MD - TestPaymentGateway
 * Deterministic payment simulation provider for automated testing and local development.
 * strictly separated from domain business logic; enforces production safeguard.
 */
class TestPaymentGateway extends PaymentGateway {
    /**
     * @param {object} [options]
     * @param {string} [options.secretKey] - Shared secret for HMAC-SHA256 signature verification
     * @param {boolean} [options.allowInProduction=false] - Explicit override for test execution
     */
    constructor(options = {}) {
        super();
        const isProduction = process.env.NODE_ENV === 'production';
        if (isProduction && !options.allowInProduction) {
            throw new Error('[PaymentGateway] TestPaymentGateway cannot be used in production environment');
        }

        this.secretKey = options.secretKey || process.env.PAYMENT_TEST_SECRET || 'test_payment_hmac_secret_2026';
        this.providerName = 'TEST';
    }

    /**
     * Initiates a simulated payment transaction.
     * Generates a deterministic provider reference and test checkout representation.
     * Never activates subscriptions.
     *
     * @param {object} params
     * @param {object} params.payment
     * @param {object} params.plan
     * @param {object} [params.customer]
     * @param {string} [params.callbackUrl]
     * @returns {Promise<object>}
     */
    async initiatePayment({ payment, plan, customer = null, callbackUrl = null }) {
        if (!payment) {
            throw new Error('[TestPaymentGateway] payment entity is required');
        }
        const ref = payment.transactionReference || payment.transaction_reference;
        if (!ref) {
            throw new Error('[TestPaymentGateway] payment transactionReference is required');
        }

        const providerReference = `TEST-REF-${ref}`;
        const checkoutUrl = `https://checkout.windowseven.local/test-pay/${ref}`;

        return {
            success: true,
            provider: this.providerName,
            providerReference,
            transactionReference: ref,
            checkoutUrl,
            status: 'PENDING',
            rawResponse: {
                initiated: true,
                mode: 'SIMULATION',
                timestamp: new Date().toISOString(),
            },
        };
    }

    /**
     * Test helper to generate a valid, cryptographically signed callback payload.
     *
     * @param {object} params
     * @param {string} params.transactionReference
     * @param {string} [params.status='SUCCESS']
     * @param {number} params.amount
     * @param {string} [params.currency='TZS']
     * @param {string} [params.failureReason=null]
     * @param {string} [params.providerReference=null]
     * @returns {{ headers: object, body: object, rawBody: string }}
     */
    simulateCallback({
        transactionReference,
        status = 'SUCCESS',
        amount,
        currency = 'TZS',
        failureReason = null,
        providerReference = null,
    }) {
        if (!transactionReference) {
            throw new Error('[TestPaymentGateway] transactionReference is required to simulate callback');
        }

        const payload = {
            transactionReference,
            providerReference: providerReference || `TEST-REF-${transactionReference}`,
            status: String(status).toUpperCase(),
            amount: Number(amount),
            currency: String(currency).toUpperCase(),
            failureReason: failureReason || null,
            timestamp: new Date().toISOString(),
        };

        const rawBody = JSON.stringify(payload);
        const signature = crypto
            .createHmac('sha256', this.secretKey)
            .update(rawBody)
            .digest('hex');

        return {
            headers: {
                'x-webhook-signature': signature,
                'content-type': 'application/json',
            },
            body: payload,
            rawBody,
        };
    }

    /**
     * Cryptographically verifies and normalizes provider callback.
     * Separates signature validation from application business logic.
     *
     * @param {object} params
     * @param {object} params.headers
     * @param {object} params.body
     * @param {string|Buffer} [params.rawBody]
     * @returns {Promise<object>}
     */
    async verifyCallback({ headers = {}, body = {}, rawBody = null }) {
        // 1. Extract signature header (case-insensitive lookup)
        const headerKeys = Object.keys(headers || {});
        const sigKey = headerKeys.find(
            (k) => k.toLowerCase() === 'x-webhook-signature' || k.toLowerCase() === 'x-signature'
        );
        const signature = sigKey ? headers[sigKey] : null;

        if (!signature || typeof signature !== 'string') {
            return {
                success: false,
                error: 'MISSING_SIGNATURE',
            };
        }

        // 2. Compute expected HMAC-SHA256 signature
        const contentToVerify = rawBody !== null && rawBody !== undefined
            ? (typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8'))
            : JSON.stringify(body || {});

        const expectedSignature = crypto
            .createHmac('sha256', this.secretKey)
            .update(contentToVerify)
            .digest('hex');

        // Timing-safe comparison to prevent side-channel timing attacks
        let signaturesMatch = false;
        try {
            const sigBuf = Buffer.from(signature, 'hex');
            const expBuf = Buffer.from(expectedSignature, 'hex');
            if (sigBuf.length === expBuf.length && crypto.timingSafeEqual(sigBuf, expBuf)) {
                signaturesMatch = true;
            }
        } catch {
            signaturesMatch = false;
        }

        if (!signaturesMatch) {
            return {
                success: false,
                error: 'INVALID_SIGNATURE',
            };
        }

        // 3. Extract and normalize fields
        const payload = body || {};
        const transactionReference = payload.transactionReference || payload.transaction_reference;
        if (!transactionReference || typeof transactionReference !== 'string') {
            return {
                success: false,
                error: 'MISSING_TRANSACTION_REFERENCE',
            };
        }

        const rawStatus = payload.status ? String(payload.status).toUpperCase() : null;
        if (rawStatus !== 'SUCCESS' && rawStatus !== 'FAILED') {
            return {
                success: false,
                error: 'UNSUPPORTED_STATUS',
            };
        }

        const amount = payload.amount !== undefined && payload.amount !== null
            ? Number(payload.amount)
            : null;

        const currency = payload.currency
            ? String(payload.currency).toUpperCase()
            : null;

        const failureReason = payload.failureReason || payload.failure_reason || null;
        const providerReference = payload.providerReference || payload.provider_reference || null;

        return {
            success: true,
            transactionReference,
            providerReference,
            amount,
            currency,
            status: rawStatus,
            failureReason,
            rawPayload: payload,
        };
    }

    /**
     * Reconciliation query contract.
     */
    async queryPaymentStatus({ transactionReference, providerReference = null }) {
        return {
            status: 'PENDING',
            transactionReference,
            providerReference,
        };
    }
}

module.exports = TestPaymentGateway;
