const argon2 = require('argon2');

/**
 * Windowseven MD Password Service
 * Implements Argon2id password hashing and constant-time verification per RFC 9106.
 */
class PasswordService {
    constructor(options = {}) {
        // In test environments or constrained setups, options can be overridden
        this.memoryCost = options.memoryCost || (process.env.NODE_ENV === 'test' ? 4096 : 65536);
        this.timeCost = options.timeCost || (process.env.NODE_ENV === 'test' ? 1 : 3);
        this.parallelism = options.parallelism || (process.env.NODE_ENV === 'test' ? 1 : 4);
        this.hashLength = options.hashLength || 32;
    }

    /**
     * Validates password strength policy.
     * Minimum 12 characters. Allows long passphrases up to 256 characters.
     *
     * @param {string} password
     * @returns {{ valid: boolean, error?: string }}
     */
    validatePolicy(password) {
        if (!password || typeof password !== 'string') {
            return { valid: false, error: 'Password is required and must be a string' };
        }

        if (password.length < 12) {
            return { valid: false, error: 'Password must be at least 12 characters long' };
        }

        if (password.length > 256) {
            return { valid: false, error: 'Password must not exceed 256 characters' };
        }

        // Long passphrases (>= 18 chars) are inherently high-entropy
        if (password.length >= 18) {
            return { valid: true };
        }

        // Standard 12-17 char passwords require diversity
        const hasUpper = /[A-Z]/.test(password);
        const hasLower = /[a-z]/.test(password);
        const hasDigit = /[0-9]/.test(password);
        const hasSpecial = /[^A-Za-z0-9]/.test(password);

        if (!hasUpper || !hasLower || !hasDigit || !hasSpecial) {
            return {
                valid: false,
                error: 'Password must include uppercase, lowercase, numeric, and special characters',
            };
        }

        return { valid: true };
    }

    /**
     * Hashes a password using Argon2id.
     *
     * @param {string} password
     * @returns {Promise<string>} Encoded Argon2id hash
     */
    async hash(password) {
        const policy = this.validatePolicy(password);
        if (!policy.valid) {
            throw new Error(`Password policy violation: ${policy.error}`);
        }

        return argon2.hash(password, {
            type: argon2.argon2id,
            memoryCost: this.memoryCost,
            timeCost: this.timeCost,
            parallelism: this.parallelism,
            hashLength: this.hashLength,
        });
    }

    /**
     * Verifies a plaintext password against an Argon2id hash in constant time.
     *
     * @param {string} hash - Encoded Argon2id hash from database
     * @param {string} plainPassword - Plaintext candidate password
     * @returns {Promise<boolean>} True if match, false otherwise
     */
    async verify(hash, plainPassword) {
        if (!hash || !plainPassword || typeof hash !== 'string' || typeof plainPassword !== 'string') {
            return false;
        }

        try {
            return await argon2.verify(hash, plainPassword);
        } catch (err) {
            // Malformed hash or verification failure returns false without leaking errors
            return false;
        }
    }
}

module.exports = PasswordService;
