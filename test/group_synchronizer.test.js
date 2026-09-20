const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { migrateUp } = require('../src/database/migrator');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
} = require('../src/repositories');
const { createExecutionContext } = require('../src/whatsapp/ExecutionContext');
const GroupSynchronizer = require('../src/whatsapp/GroupSynchronizer');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('GroupSynchronizer Discovery, Idempotency, Status Preservation & Isolation', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let groupRepo;
    let synchronizer;

    let tenantA, tenantB;
    let connA, connB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        synchronizer = new GroupSynchronizer(pool);

        await migrateUp(pool);
        await pool.query('DELETE FROM tenants CASCADE;');

        tenantA = await tenantRepo.create({ name: 'Group Sync Tenant A' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '255700000301',
            displayName: 'Sync Bot A',
        });

        tenantB = await tenantRepo.create({ name: 'Group Sync Tenant B' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '255700000302',
            displayName: 'Sync Bot B',
        });
    });

    after(async () => {
        await pool.end();
    });

    it('should discover and persist groups from groupFetchAllParticipating idempotently', async () => {
        const mockSocketA = {
            user: { id: '255700000301:1@s.whatsapp.net' },
            groupFetchAllParticipating: async () => ({
                '120363000000000051@g.us': {
                    id: '120363000000000051@g.us',
                    subject: 'Alpha Logistics Team',
                },
                '120363000000000052@g.us': {
                    id: '120363000000000052@g.us',
                    subject: 'Alpha Developers Chat',
                },
            }),
        };

        const ctxA = createExecutionContext({ tenantId: tenantA.id, connectionId: connA.id, socket: mockSocketA });

        // 1. Initial sync
        const res1 = await synchronizer.syncAllParticipatingGroups(ctxA);
        assert.strictEqual(res1.success, true);
        assert.strictEqual(res1.syncedCount, 2);

        // Verify in DB
        const groupsInDb = await groupRepo.listForTenant(tenantA.id);
        assert.strictEqual(groupsInDb.length, 2);
        assert.strictEqual(groupsInDb[0].status, 'DISCOVERED');
        assert.strictEqual(groupsInDb[1].status, 'DISCOVERED');

        // 2. Idempotent re-sync: should not duplicate rows
        const res2 = await synchronizer.syncAllParticipatingGroups(ctxA);
        assert.strictEqual(res2.success, true);
        assert.strictEqual(res2.syncedCount, 2);

        const groupsInDbAfter = await groupRepo.listForTenant(tenantA.id);
        assert.strictEqual(groupsInDbAfter.length, 2, 'Row count must remain 2 after re-sync');
    });

    it('should PRESERVE MANAGED status across discovery sweeps (no accidental downgrade)', async () => {
        // Manually promote group 1 to MANAGED
        const found = await groupRepo.findByJidForTenant('120363000000000051@g.us', tenantA.id);
        assert.ok(found);

        const promoted = await groupRepo.updateStatusForTenant(found.id, tenantA.id, 'MANAGED');
        assert.strictEqual(promoted.status, 'MANAGED');

        // Re-run discovery sweep which fetches the group again with DISCOVERED intent
        const mockSocketA = {
            user: { id: '255700000301:1@s.whatsapp.net' },
            groupFetchAllParticipating: async () => ({
                '120363000000000051@g.us': {
                    id: '120363000000000051@g.us',
                    subject: 'Alpha Logistics Team Renamed',
                },
            }),
        };
        const ctxA = createExecutionContext({ tenantId: tenantA.id, connectionId: connA.id, socket: mockSocketA });

        await synchronizer.syncAllParticipatingGroups(ctxA);

        // Verify: name was updated, but status REMAINS 'MANAGED'
        const afterSync = await groupRepo.findByJidForTenant('120363000000000051@g.us', tenantA.id);
        assert.strictEqual(afterSync.status, 'MANAGED', 'MANAGED status must not be downgraded to DISCOVERED');
        assert.strictEqual(afterSync.name, 'Alpha Logistics Team Renamed');
    });

    it('should detect bot removal and transition group to UNMANAGED', async () => {
        const mockSocketA = {
            user: { id: '255700000301:1@s.whatsapp.net' },
        };
        const ctxA = createExecutionContext({ tenantId: tenantA.id, connectionId: connA.id, socket: mockSocketA });

        // Case 1: Another participant is removed -> group status is untouched
        await synchronizer.handleGroupParticipantsChanged(ctxA, {
            group: { jid: '120363000000000051@g.us' },
            action: 'remove',
            participants: [{ jid: '255799999999@s.whatsapp.net' }], // ordinary user
        });

        const check1 = await groupRepo.findByJidForTenant('120363000000000051@g.us', tenantA.id);
        assert.strictEqual(check1.status, 'MANAGED', 'Removing an ordinary participant must not unmanage the group');

        // Case 2: The bot account itself is removed -> group becomes UNMANAGED
        await synchronizer.handleGroupParticipantsChanged(ctxA, {
            group: { jid: '120363000000000051@g.us' },
            action: 'remove',
            participants: [{ jid: '255700000301@s.whatsapp.net' }], // bot itself
        });

        const check2 = await groupRepo.findByJidForTenant('120363000000000051@g.us', tenantA.id);
        assert.strictEqual(check2.status, 'UNMANAGED', 'Removing the bot account must transition group to UNMANAGED');
    });

    it('should handle real-time group discovered and updated events', async () => {
        const mockSocketA = { user: { id: '255700000301:1@s.whatsapp.net' } };
        const ctxA = createExecutionContext({ tenantId: tenantA.id, connectionId: connA.id, socket: mockSocketA });

        // 1. group discovered
        await synchronizer.handleGroupDiscovered(ctxA, {
            group: {
                jid: '120363000000000077@g.us',
                name: 'Realtime Group Event',
            },
        });

        const g1 = await groupRepo.findByJidForTenant('120363000000000077@g.us', tenantA.id);
        assert.ok(g1);
        assert.strictEqual(g1.name, 'Realtime Group Event');

        // 2. group updated
        await synchronizer.handleGroupUpdated(ctxA, {
            group: {
                jid: '120363000000000077@g.us',
                name: 'Realtime Group Renamed',
            },
        });

        const g2 = await groupRepo.findByJidForTenant('120363000000000077@g.us', tenantA.id);
        assert.strictEqual(g2.name, 'Realtime Group Renamed');
    });

    it('should isolate group synchronization across tenants', async () => {
        const mockSocketB = {
            user: { id: '255700000302:1@s.whatsapp.net' },
            groupFetchAllParticipating: async () => ({
                '120363000000000099@g.us': {
                    id: '120363000000000099@g.us',
                    subject: 'Beta Private Group',
                },
            }),
        };
        const ctxB = createExecutionContext({ tenantId: tenantB.id, connectionId: connB.id, socket: mockSocketB });

        await synchronizer.syncAllParticipatingGroups(ctxB);

        // Tenant A must not see Tenant B group
        const forA = await groupRepo.findByJidForTenant('120363000000000099@g.us', tenantA.id);
        assert.strictEqual(forA, null);

        // Tenant B sees it
        const forB = await groupRepo.findByJidForTenant('120363000000000099@g.us', tenantB.id);
        assert.ok(forB);
        assert.strictEqual(forB.tenant_id, tenantB.id);
    });

    it('should isolate sync failure (sync error does not throw or crash connection)', async () => {
        const brokenSocket = {
            groupFetchAllParticipating: async () => {
                throw new Error('Baileys network timeout fetching groups');
            },
        };
        const brokenCtx = createExecutionContext({ tenantId: tenantA.id, connectionId: connA.id, socket: brokenSocket });

        // Must not throw
        const res = await synchronizer.syncAllParticipatingGroups(brokenCtx);
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.syncedCount, 0);
        assert.ok(res.error.includes('timeout'));
    });
});
