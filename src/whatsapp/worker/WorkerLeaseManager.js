const EventEmitter = require('node:events');

/**
 * Windowseven MD Worker Lease Manager
 * Manages proactive heartbeats, generation fencing tokens, and local watchdog failsafe.
 *
 * Invariants:
 * 1. Heartbeat renewal checks: connectionId, workerId, leaseEpoch, lease_expires_at > NOW().
 * 2. If a heartbeat fails or watchdog trips (25s without confirmed renewal),
 *    ConnectionManager.abortConnection() is unconditionally called to kill the local socket.
 */
class WorkerLeaseManager extends EventEmitter {
    /**
     * @param {object} params
     * @param {string} params.workerId
     * @param {import('../../repositories/WhatsAppConnectionRepository')} params.connRepo
     * @param {import('../ConnectionManager')} params.connectionManager
     * @param {import('../../repositories/AuditLogRepository')} [params.auditLogRepo]
     * @param {number} [params.heartbeatIntervalMs=10000]
     * @param {number} [params.watchdogTimeoutMs=25000]
     * @param {number} [params.leaseDurationSeconds=30]
     */
    constructor({
        workerId,
        connRepo,
        connectionManager,
        auditLogRepo = null,
        heartbeatIntervalMs = 10000,
        watchdogTimeoutMs = 25000,
        leaseDurationSeconds = 30,
    }) {
        super();
        if (!workerId || !connRepo || !connectionManager) {
            throw new Error('workerId, connRepo, and connectionManager are required');
        }

        this.workerId = workerId;
        this.connRepo = connRepo;
        this.connectionManager = connectionManager;
        this.auditLogRepo = auditLogRepo;
        this.heartbeatIntervalMs = heartbeatIntervalMs;
        this.watchdogTimeoutMs = watchdogTimeoutMs;
        this.leaseDurationSeconds = leaseDurationSeconds;

        // Map<connectionId, { tenantId, leaseEpoch, lastHeartbeatAt, watchdogTimer } >
        this.leases = new Map();
        this.heartbeatTimer = null;
        this.isStopped = false;
    }

    /**
     * Registers an actively acquired lease under this manager.
     */
    registerLease({ connectionId, tenantId, leaseEpoch }) {
        if (!connectionId || leaseEpoch === undefined) {
            throw new Error('connectionId and leaseEpoch are required');
        }

        const existing = this.leases.get(connectionId);
        if (existing && existing.watchdogTimer) {
            clearTimeout(existing.watchdogTimer);
        }

        const lease = {
            connectionId,
            tenantId,
            leaseEpoch: Number(leaseEpoch),
            lastHeartbeatAt: Date.now(),
            watchdogTimer: null,
        };

        this._armWatchdog(lease);
        this.leases.set(connectionId, lease);
        return lease;
    }

    /**
     * Unregisters a lease (e.g. on clean shutdown or release).
     */
    unregisterLease(connectionId) {
        const lease = this.leases.get(connectionId);
        if (lease) {
            if (lease.watchdogTimer) {
                clearTimeout(lease.watchdogTimer);
            }
            this.leases.delete(connectionId);
            return true;
        }
        return false;
    }

    /**
     * Checks if this manager holds an active lease for connectionId.
     */
    hasLease(connectionId) {
        return this.leases.has(connectionId);
    }

    /**
     * Gets active lease info for a connection.
     */
    getLease(connectionId) {
        return this.leases.get(connectionId) || null;
    }

    /**
     * Starts the periodic heartbeat renewal loop.
     */
    start() {
        if (this.heartbeatTimer) return;
        this.isStopped = false;

        this.heartbeatTimer = setInterval(async () => {
            await this.performHeartbeatSweep();
        }, this.heartbeatIntervalMs);

        if (typeof this.heartbeatTimer.unref === 'function') {
            this.heartbeatTimer.unref();
        }
    }

    /**
     * Performs a heartbeat sweep for all actively leased connections.
     */
    async performHeartbeatSweep() {
        if (this.isStopped || this.leases.size === 0) return;

        const connectionIds = Array.from(this.leases.keys());
        for (const connectionId of connectionIds) {
            const lease = this.leases.get(connectionId);
            if (!lease) continue;

            try {
                const renewed = await this.connRepo.renewLease({
                    connectionId,
                    workerId: this.workerId,
                    leaseEpoch: lease.leaseEpoch,
                    leaseDurationSeconds: this.leaseDurationSeconds,
                });

                if (renewed) {
                    lease.lastHeartbeatAt = Date.now();
                    this._armWatchdog(lease);
                    this.emit('heartbeat_success', { connectionId, leaseEpoch: lease.leaseEpoch });
                } else {
                    // Stale generation or expired lease
                    await this.handleLeaseLost(connectionId, 'HEARTBEAT_RENEWAL_FAILED');
                }
            } catch (err) {
                console.error(`[WorkerLeaseManager] Heartbeat error for ${connectionId}:`, err.message);
                // We do NOT immediately abort on a transient network error; the watchdog
                // timer will trip at 25s if heartbeats continue failing.
            }
        }
    }

    /**
     * Arms/resets the local watchdog failsafe timer.
     */
    _armWatchdog(lease) {
        if (lease.watchdogTimer) {
            clearTimeout(lease.watchdogTimer);
        }

        lease.watchdogTimer = setTimeout(async () => {
            console.warn(`[WorkerLeaseManager] Lease watchdog TRIPPED for ${lease.connectionId}! Heartbeat was not renewed in ${this.watchdogTimeoutMs}ms.`);
            await this.handleLeaseLost(lease.connectionId, 'LEASE_WATCHDOG_TRIPPED');
        }, this.watchdogTimeoutMs);

        if (typeof lease.watchdogTimer.unref === 'function') {
            lease.watchdogTimer.unref();
        }
    }

    /**
     * Handles lease loss or watchdog trip: aborts the Baileys socket and strips local state.
     */
    async handleLeaseLost(connectionId, reason) {
        const lease = this.leases.get(connectionId);
        if (lease && lease.watchdogTimer) {
            clearTimeout(lease.watchdogTimer);
        }
        this.leases.delete(connectionId);

        console.warn(`[WorkerLeaseManager] Terminating connection ${connectionId} due to: ${reason}`);

        // Forcibly abort socket, cancel reconnects, and strip listeners
        await this.connectionManager.abortConnection(connectionId, reason).catch((err) => {
            console.error(`[WorkerLeaseManager] Error aborting socket for ${connectionId}:`, err.message);
        });

        // Record security audit log if auditLogRepo is configured
        if (this.auditLogRepo && lease?.tenantId) {
            await this.auditLogRepo.create({
                tenantId: lease.tenantId,
                actorUserId: null,
                action: 'STALE_GENERATION_REJECTED',
                resourceType: 'WhatsAppConnection',
                resourceId: connectionId,
                metadata: {
                    workerId: this.workerId,
                    leaseEpoch: lease.leaseEpoch,
                    reason,
                },
            }).catch(() => {});
        }

        this.emit('lease_lost', { connectionId, reason, leaseEpoch: lease?.leaseEpoch });
    }

    /**
     * Stops heartbeat loops and clears all active watchdog timers.
     */
    stop() {
        this.isStopped = true;
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }

        for (const lease of this.leases.values()) {
            if (lease.watchdogTimer) {
                clearTimeout(lease.watchdogTimer);
            }
        }
        this.leases.clear();
    }
}

module.exports = WorkerLeaseManager;
