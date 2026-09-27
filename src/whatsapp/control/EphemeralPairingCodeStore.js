/**
 * Windowseven MD Ephemeral Pairing Code Store
 * Strictly in-memory ephemeral pairing code storage with automatic TTL expiration.
 *
 * INVARIANT: Pairing codes are NEVER persisted to database tables and NEVER logged to persistent storage.
 */
class EphemeralPairingCodeStore {
    constructor() {
        // Map<`${tenantId}:${connectionId}`, { code: string, expiresAt: string, expiresAtMs: number, leaseEpoch: number|null, timer: Timeout }>
        this.store = new Map();
    }

    _key(tenantId, connectionId) {
        return `${tenantId}:${connectionId}`;
    }

    /**
     * Stores an ephemeral pairing code with a strict TTL and generation lease epoch.
     *
     * @param {string} tenantId
     * @param {string} connectionId
     * @param {string} code - Ephemeral pairing code (e.g., ABCD-EFGH)
     * @param {number} [ttlSeconds=120]
     * @param {number} [leaseEpoch=null]
     */
    set(tenantId, connectionId, code, ttlSeconds = 120, leaseEpoch = null) {
        if (!tenantId || !connectionId || !code) return;

        const key = this._key(tenantId, connectionId);
        const existing = this.store.get(key);
        if (existing && existing.timer) {
            clearTimeout(existing.timer);
        }

        const expiresAt = Date.now() + ttlSeconds * 1000;
        const timer = setTimeout(() => {
            this.delete(tenantId, connectionId);
        }, ttlSeconds * 1000);

        if (typeof timer.unref === "function") {
            timer.unref();
        }

        this.store.set(key, {
            code,
            leaseEpoch: leaseEpoch !== null && leaseEpoch !== undefined ? Number(leaseEpoch) : null,
            expiresAt: new Date(expiresAt).toISOString(),
            expiresAtMs: expiresAt,
            timer,
        });
    }

    /**
     * Retrieves current ephemeral pairing code if not expired and correctly tenant-scoped and generation-matched.
     *
     * @param {string} tenantId
     * @param {string} connectionId
     * @param {number} [expectedEpoch=null]
     * @returns {{ code: string, expiresAt: string, leaseEpoch: number|null }|null}
     */
    get(tenantId, connectionId, expectedEpoch = null) {
        if (!tenantId || !connectionId) return null;

        const key = this._key(tenantId, connectionId);
        const entry = this.store.get(key);
        if (!entry) return null;

        if (Date.now() >= entry.expiresAtMs) {
            this.delete(tenantId, connectionId);
            return null;
        }

        if (expectedEpoch !== null && expectedEpoch !== undefined && entry.leaseEpoch !== null && entry.leaseEpoch !== undefined) {
            if (Number(entry.leaseEpoch) !== Number(expectedEpoch)) {
                return null;
            }
        }

        return {
            code: entry.code,
            leaseEpoch: entry.leaseEpoch,
            expiresAt: entry.expiresAt,
        };
    }

    delete(tenantId, connectionId) {
        const key = this._key(tenantId, connectionId);
        const entry = this.store.get(key);
        if (entry) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
            this.store.delete(key);
            return true;
        }
        return false;
    }

    clearAll() {
        for (const entry of this.store.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.store.clear();
    }
}

const defaultPairingCodeStore = new EphemeralPairingCodeStore();

module.exports = {
    EphemeralPairingCodeStore,
    defaultPairingCodeStore,
};
