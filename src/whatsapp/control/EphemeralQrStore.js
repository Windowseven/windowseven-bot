/**
 * Windowseven MD Ephemeral QR Store
 * Strictly in-memory ephemeral authentication material storage with automatic TTL expiration.
 *
 * INVARIANT: Raw QR payloads are NEVER persisted to database tables and NEVER written to logs.
 */
class EphemeralQrStore {
    constructor() {
        // Map<`${tenantId}:${connectionId}`, { qr: string, expiresAt: number, timer: Timeout }>
        this.store = new Map();
    }

    _key(tenantId, connectionId) {
        return `${tenantId}:${connectionId}`;
    }

    /**
     * Stores an ephemeral QR payload with a strict time-to-live and generation epoch.
     *
     * @param {string} tenantId
     * @param {string} connectionId
     * @param {string} qr - Ephemeral QR payload from Baileys
     * @param {number} [ttlSeconds=60]
     * @param {number} [leaseEpoch=null] - Authoritative worker generation lease epoch
     */
    set(tenantId, connectionId, qr, ttlSeconds = 60, leaseEpoch = null) {
        if (!tenantId || !connectionId || !qr) return;

        const key = this._key(tenantId, connectionId);
        const existing = this.store.get(key);
        if (existing && existing.timer) {
            clearTimeout(existing.timer);
        }

        const expiresAt = Date.now() + ttlSeconds * 1000;
        const timer = setTimeout(() => {
            this.delete(tenantId, connectionId);
        }, ttlSeconds * 1000);

        if (typeof timer.unref === 'function') {
            timer.unref();
        }

        this.store.set(key, {
            qr,
            leaseEpoch: leaseEpoch !== null && leaseEpoch !== undefined ? Number(leaseEpoch) : null,
            expiresAt: new Date(expiresAt).toISOString(),
            expiresAtMs: expiresAt,
            timer,
        });
    }

    /**
     * Retrieves current ephemeral QR payload if not expired and correctly tenant-scoped and generation-matched.
     *
     * @param {string} tenantId
     * @param {string} connectionId
     * @param {number} [expectedEpoch=null] - Optional lease_epoch of the authoritative connection
     * @returns {{ qr: string, expiresAt: string, leaseEpoch: number|null }|null}
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

        // Generation fencing: If expectedEpoch is specified and QR has an epoch, reject if stale
        if (expectedEpoch !== null && expectedEpoch !== undefined && entry.leaseEpoch !== null && entry.leaseEpoch !== undefined) {
            if (Number(entry.leaseEpoch) !== Number(expectedEpoch)) {
                return null; // Stale generation QR material
            }
        }

        return {
            qr: entry.qr,
            leaseEpoch: entry.leaseEpoch,
            expiresAt: entry.expiresAt,
        };
    }

    /**
     * Deletes and clears the ephemeral QR entry.
     */
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

    /**
     * Clears all entries and pending timers (used in teardown/tests).
     */
    clearAll() {
        for (const entry of this.store.values()) {
            if (entry.timer) {
                clearTimeout(entry.timer);
            }
        }
        this.store.clear();
    }
}

// Global default instance for single-node / in-process execution
const defaultQrStore = new EphemeralQrStore();

module.exports = {
    EphemeralQrStore,
    defaultQrStore,
};
