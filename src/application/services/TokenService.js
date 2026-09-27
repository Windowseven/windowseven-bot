const crypto = require('node:crypto');

/**
 * Windowseven MD Token Service
 * Implements RFC 8037 EdDSA (Ed25519) asymmetric JWT signing and verification,
 * and cryptographically secure opaque refresh token generation and SHA-256 hashing.
 */
class TokenService {
    /**
     * @param {object} options
     * @param {string|crypto.KeyObject} [options.privateKey] - Ed25519 Private Key (PEM or KeyObject)
     * @param {string|crypto.KeyObject} [options.publicKey] - Ed25519 Public Key (PEM or KeyObject)
     * @param {string} [options.keyId] - Key ID for header (kid)
     * @param {string} [options.issuer] - Expected JWT issuer (iss)
     * @param {string} [options.audience] - Expected JWT audience (aud)
     * @param {number} [options.accessTokenTtlSeconds] - Access token TTL in seconds (default: 900 / 15m)
     * @param {number} [options.refreshTokenTtlSeconds] - Refresh token TTL in seconds (default: 604800 / 7d)
     */
    constructor(options = {}) {
        this.keyId = options.keyId || process.env.JWT_KEY_ID || 'key-ed25519-v1';
        this.issuer = options.issuer || process.env.JWT_ISSUER || 'windowseven-auth';
        this.audience = options.audience || process.env.JWT_AUDIENCE || 'windowseven-api';
        this.accessTokenTtl = options.accessTokenTtlSeconds || parseInt(process.env.ACCESS_TOKEN_TTL || '900', 10);
        this.refreshTokenTtl = options.refreshTokenTtlSeconds || parseInt(process.env.REFRESH_TOKEN_TTL || '604800', 10);
        this.clock = typeof options.clock === 'function' ? options.clock : () => Date.now();

        if (options.privateKey && options.publicKey) {
            this.privateKey = typeof options.privateKey === 'string'
                ? crypto.createPrivateKey(options.privateKey)
                : options.privateKey;
            this.publicKey = typeof options.publicKey === 'string'
                ? crypto.createPublicKey(options.publicKey)
                : options.publicKey;
        } else if (process.env.JWT_PRIVATE_KEY && process.env.JWT_PUBLIC_KEY) {
            this.privateKey = crypto.createPrivateKey(process.env.JWT_PRIVATE_KEY);
            this.publicKey = crypto.createPublicKey(process.env.JWT_PUBLIC_KEY);
        } else {
            // Development / Test fallback: Ephemeral in-memory keypair
            const pair = crypto.generateKeyPairSync('ed25519');
            this.privateKey = pair.privateKey;
            this.publicKey = pair.publicKey;
        }
    }

    /**
     * Base64URL encode utility
     */
    static base64UrlEncode(data) {
        return Buffer.from(data)
            .toString('base64')
            .replace(/=/g, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
    }

    /**
     * Base64URL decode utility
     */
    static base64UrlDecode(str) {
        let base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4 !== 0) {
            base64 += '=';
        }
        return Buffer.from(base64, 'base64').toString('utf8');
    }

    /**
     * Signs a 15-minute Access JWT using EdDSA (Ed25519).
     *
     * @param {object} params
     * @param {string} params.userId - User UUID (sub)
     * @param {string} params.email - User email
     * @param {object} [params.extraClaims] - Optional additional claims
     * @returns {string} Compact serialized JWT string
     */
    createAccessToken({ userId, email, extraClaims = {} }) {
        if (!userId || !email) {
            throw new Error('userId and email are required to issue an access token');
        }

        const now = Math.floor(this.clock() / 1000);
        const header = {
            alg: 'EdDSA',
            typ: 'JWT',
            kid: this.keyId,
        };

        const payload = {
            sub: userId,
            email: email.trim().toLowerCase(),
            type: 'access',
            iat: now,
            exp: now + this.accessTokenTtl,
            iss: this.issuer,
            aud: this.audience,
            ...extraClaims,
        };

        const encodedHeader = TokenService.base64UrlEncode(JSON.stringify(header));
        const encodedPayload = TokenService.base64UrlEncode(JSON.stringify(payload));
        const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');

        const signature = crypto.sign(null, signingInput, this.privateKey);
        const encodedSignature = Buffer.from(signature).toString('base64url');

        return `${encodedHeader}.${encodedPayload}.${encodedSignature}`;
    }

    /**
     * Verifies an Access JWT string.
     * Enforces EdDSA algorithm, signature, issuer, audience, and expiration.
     *
     * @param {string} token - Compact JWT string
     * @returns {{ valid: boolean, payload?: object, error?: string }}
     */
    verifyAccessToken(token) {
        if (!token || typeof token !== 'string') {
            return { valid: false, error: 'Token string is required' };
        }

        const parts = token.split('.');
        if (parts.length !== 3) {
            return { valid: false, error: 'Malformed JWT structure' };
        }

        const [encodedHeader, encodedPayload, encodedSignature] = parts;

        let header, payload;
        try {
            header = JSON.parse(TokenService.base64UrlDecode(encodedHeader));
            payload = JSON.parse(TokenService.base64UrlDecode(encodedPayload));
        } catch (e) {
            return { valid: false, error: 'Invalid token JSON encoding' };
        }

        // Strict algorithm check: MUST be EdDSA
        if (header.alg !== 'EdDSA') {
            return { valid: false, error: `Unsupported JWT algorithm: ${header.alg}. Only EdDSA is permitted.` };
        }

        // Cryptographic signature verification
        const signingInput = Buffer.from(`${encodedHeader}.${encodedPayload}`, 'utf8');
        const signatureBuffer = Buffer.from(encodedSignature, 'base64url');

        let isSignatureValid = false;
        try {
            isSignatureValid = crypto.verify(null, signingInput, this.publicKey, signatureBuffer);
        } catch (err) {
            return { valid: false, error: 'Cryptographic signature verification failed' };
        }

        if (!isSignatureValid) {
            return { valid: false, error: 'Invalid signature' };
        }

        // Claims validation
        const now = Math.floor(this.clock() / 1000);

        if (!payload.exp || payload.exp <= now) {
            return { valid: false, error: 'Token has expired' };
        }

        if (payload.type !== 'access') {
            return { valid: false, error: `Invalid token type: expected 'access', got '${payload.type}'` };
        }

        if (this.issuer && payload.iss !== this.issuer) {
            return { valid: false, error: `Invalid issuer: expected '${this.issuer}', got '${payload.iss}'` };
        }

        if (this.audience && payload.aud !== this.audience) {
            return { valid: false, error: `Invalid audience: expected '${this.audience}', got '${payload.aud}'` };
        }

        if (!payload.sub) {
            return { valid: false, error: 'Missing subject claim (sub)' };
        }

        return { valid: true, payload };
    }

    /**
     * Generates a high-entropy opaque random refresh token (32 cryptographically secure bytes).
     *
     * @returns {string} 64-character hex string
     */
    generateRefreshToken() {
        return crypto.randomBytes(32).toString('hex');
    }

    /**
     * Computes SHA-256 hash of a refresh token for safe storage in PostgreSQL.
     *
     * @param {string} rawToken
     * @returns {string} 64-character hex hash
     */
    hashRefreshToken(rawToken) {
        if (!rawToken || typeof rawToken !== 'string') {
            throw new Error('Raw refresh token string is required for hashing');
        }
        return crypto.createHash('sha256').update(rawToken).digest('hex');
    }
}

module.exports = TokenService;
