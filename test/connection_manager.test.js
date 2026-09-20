const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { DisconnectReason } = require('@whiskeysockets/baileys');
const { migrateUp } = require('../src/database/migrator');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    WhatsAppAuthCredentialsRepository,
} = require('../src/repositories');
const ConnectionManager = require('../src/whatsapp/ConnectionManager');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('ConnectionManager Lifecycle, Reconnect & Failure Isolation', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let credsRepo;
    let manager;

    let tenantA, tenantB;
    let connA1, connA2, connB1;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        credsRepo = new WhatsAppAuthCredentialsRepository(pool);

        await migrateUp(pool);
        await pool.query('DELETE FROM tenants CASCADE;');

        // Provision Tenant A with two connections
        tenantA = await tenantRepo.create({ name: 'CM Tenant A' });
        connA1 = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '255700000101',
            displayName: 'A1 Bot',
        });
        connA2 = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '255700000102',
            displayName: 'A2 Bot',
        });

        // Provision Tenant B with one connection
        tenantB = await tenantRepo.create({ name: 'CM Tenant B' });
        connB1 = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '255700000201',
            displayName: 'B1 Bot',
        });

        manager = new ConnectionManager(pool);
    });

    after(async () => {
        if (manager) {
            await manager.shutdown();
        }
        await pool.end();
    });

    it('should create and register a connection and synchronize database status', async () => {
        const runtimeConn = await manager.createConnection(tenantA.id, connA1.id, {
            pairingCode: true,
            socketOverrides: {
                // Keep socket offline/silent for unit testing
                connectTimeoutMs: 1000,
            },
        });

        assert.ok(runtimeConn);
        assert.strictEqual(runtimeConn.connectionId, connA1.id);
        assert.strictEqual(runtimeConn.tenantId, tenantA.id);
        assert.strictEqual(runtimeConn.status, 'CONNECTING');

        // Check registry lookup
        const lookup = manager.getConnection(connA1.id);
        assert.strictEqual(lookup.connectionId, connA1.id);
        assert.strictEqual(manager.hasConnection(connA1.id), true);

        // Check PostgreSQL status synchronized to CONNECTING
        const dbStatus = await connRepo.findByIdForTenant(connA1.id, tenantA.id);
        assert.strictEqual(dbStatus.status, 'CONNECTING');
    });

    it('should reject duplicate registration of the same connection', async () => {
        await assert.rejects(
            async () => {
                await manager.createConnection(tenantA.id, connA1.id);
            },
            /already registered/,
            'ConnectionManager must prevent registering the same connection twice'
        );
    });

    it('should reject registration when tenant ownership does not match', async () => {
        // Attempting to register Conn B1 under Tenant A
        await assert.rejects(
            async () => {
                await manager.createConnection(tenantA.id, connB1.id);
            },
            /not found for tenant/,
            'ConnectionManager must validate tenant ownership against PostgreSQL'
        );
    });

    it('should isolate failures across multiple connections (A1 failure does not affect A2 or B1)', async () => {
        // Register Connection A2
        await manager.createConnection(tenantA.id, connA2.id, {
            pairingCode: true,
            socketOverrides: { connectTimeoutMs: 1000 },
        });

        // Register Connection B1
        await manager.createConnection(tenantB.id, connB1.id, {
            pairingCode: true,
            socketOverrides: { connectTimeoutMs: 1000 },
        });

        assert.strictEqual(manager.listActiveConnections().length, 3);

        // Now simulate a failure/disconnect specifically on Connection A1
        await manager.disconnectConnection(connA1.id, 'simulated_crash');

        // Verify Connection A1 is unmounted / disconnected
        assert.strictEqual(manager.hasConnection(connA1.id), false);
        const a1DbStatus = await connRepo.findByIdForTenant(connA1.id, tenantA.id);
        assert.strictEqual(a1DbStatus.status, 'DISCONNECTED');

        // Verify Connection A2 is STILL registered, active, and untouched
        assert.strictEqual(manager.hasConnection(connA2.id), true);
        const a2 = manager.getConnection(connA2.id);
        assert.strictEqual(a2.status, 'CONNECTING');

        // Verify Connection B1 is STILL registered, active, and untouched
        assert.strictEqual(manager.hasConnection(connB1.id), true);
        const b1 = manager.getConnection(connB1.id);
        assert.strictEqual(b1.status, 'CONNECTING');

        // Verify B1's DB record remains intact
        const b1DbStatus = await connRepo.findByIdForTenant(connB1.id, tenantB.id);
        assert.strictEqual(b1DbStatus.status, 'CONNECTING');
    });

    it('should classify fatal disconnect (loggedOut / 401) and abort reconnect', async () => {
        const connB1Runtime = manager.getConnection(connB1.id);

        // Simulate a fatal loggedOut event from Baileys
        await manager._handleConnectionUpdate(connB1Runtime, {
            connection: 'close',
            lastDisconnect: {
                error: {
                    output: {
                        statusCode: DisconnectReason.loggedOut, // 401
                    },
                },
            },
        });

        // Status becomes DISCONNECTED, reconnect timer must NOT be scheduled
        assert.strictEqual(connB1Runtime.status, 'DISCONNECTED');
        assert.strictEqual(connB1Runtime.lifecycleState, 'STOPPED');
        assert.strictEqual(connB1Runtime.reconnectTimer, null);

        // Verify DB status updated
        const dbStatus = await connRepo.findByIdForTenant(connB1.id, tenantB.id);
        assert.strictEqual(dbStatus.status, 'DISCONNECTED');
    });

    it('should classify recoverable disconnect and schedule reconnect with backoff', async () => {
        const connA2Runtime = manager.getConnection(connA2.id);

        // Simulate a recoverable connectionClosed event
        await manager._handleConnectionUpdate(connA2Runtime, {
            connection: 'close',
            lastDisconnect: {
                error: {
                    output: {
                        statusCode: DisconnectReason.connectionClosed, // 428
                    },
                },
            },
        });

        // Lifecycle moves to RECONNECTING and timer is scheduled
        assert.strictEqual(connA2Runtime.lifecycleState, 'RECONNECTING');
        assert.ok(connA2Runtime.reconnectTimer !== null);
        assert.strictEqual(connA2Runtime.reconnectAttempts, 1);

        // Clean up timer
        clearTimeout(connA2Runtime.reconnectTimer);
        connA2Runtime.reconnectTimer = null;
    });

    it('should gracefully shutdown all connections and clear timers', async () => {
        await manager.shutdown();
        assert.strictEqual(manager.connections.size, 0);
        assert.strictEqual(manager.listActiveConnections().length, 0);
    });
});
