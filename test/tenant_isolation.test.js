const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { migrateUp } = require('../src/database/migrator');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupPolicyRepository,
} = require('../src/repositories');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Cross-Tenant Data Isolation & Forged ID Protection', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let groupRepo;
    let policyRepo;

    // Test entities
    let tenantA, tenantB;
    let connA, connB;
    let groupA, groupB;
    let policyA, policyB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);

        // Ensure migrations applied
        await migrateUp(pool);

        // Clean tables
        await pool.query('DELETE FROM tenants CASCADE;');

        // 1. Provision Tenant A and resources
        tenantA = await tenantRepo.create({ name: 'Tenant Alpha Corp' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '255700000001',
            displayName: 'Alpha WhatsApp Bot',
            status: 'CONNECTED',
        });
        groupA = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000010@g.us',
            name: 'Alpha VIP Group',
            status: 'MANAGED',
        });
        policyA = await policyRepo.upsertForTenant(tenantA.id, groupA.id, {
            antilinkEnabled: true,
            antilinkAction: 'kick',
            maxWarnings: 3,
            welcomeEnabled: true,
            welcomeMessage: 'Welcome to Alpha VIP',
        });

        // 2. Provision Tenant B and resources
        tenantB = await tenantRepo.create({ name: 'Tenant Beta Ltd' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '255700000002',
            displayName: 'Beta WhatsApp Bot',
            status: 'CONNECTED',
        });
        groupB = await groupRepo.upsertDiscoveredGroup(tenantB.id, connB.id, {
            whatsappJid: '120363000000000020@g.us',
            name: 'Beta Community Group',
            status: 'MANAGED',
        });
        policyB = await policyRepo.upsertForTenant(tenantB.id, groupB.id, {
            antilinkEnabled: false,
            maxWarnings: 5,
            welcomeEnabled: true,
            welcomeMessage: 'Welcome to Beta Community',
        });
    });

    after(async () => {
        await pool.end();
    });

    it('should deny Tenant A read access to Tenant B resources', async () => {
        // Tenant A querying Connection B
        const conn = await connRepo.findByIdForTenant(connB.id, tenantA.id);
        assert.strictEqual(conn, null, 'Tenant A must not be able to retrieve Connection B');

        // Tenant A querying Group B by ID
        const grpById = await groupRepo.findByIdForTenant(groupB.id, tenantA.id);
        assert.strictEqual(grpById, null, 'Tenant A must not be able to retrieve Group B by ID');

        // Tenant A querying Group B by WhatsApp JID
        const grpByJid = await groupRepo.findByJidForTenant(groupB.whatsapp_jid, tenantA.id);
        assert.strictEqual(grpByJid, null, 'Tenant A must not be able to retrieve Group B by WhatsApp JID');

        // Tenant A querying GroupPolicy B
        const policy = await policyRepo.findByGroupIdForTenant(groupB.id, tenantA.id);
        assert.strictEqual(policy, null, 'Tenant A must not be able to retrieve Policy B');
    });

    it('should deny Tenant B read access to Tenant A resources', async () => {
        // Tenant B querying Connection A
        const conn = await connRepo.findByIdForTenant(connA.id, tenantB.id);
        assert.strictEqual(conn, null, 'Tenant B must not be able to retrieve Connection A');

        // Tenant B querying Group A by ID
        const grpById = await groupRepo.findByIdForTenant(groupA.id, tenantB.id);
        assert.strictEqual(grpById, null, 'Tenant B must not be able to retrieve Group A by ID');

        // Tenant B querying Group A by WhatsApp JID
        const grpByJid = await groupRepo.findByJidForTenant(groupA.whatsapp_jid, tenantB.id);
        assert.strictEqual(grpByJid, null, 'Tenant B must not be able to retrieve Group A by WhatsApp JID');

        // Tenant B querying GroupPolicy A
        const policy = await policyRepo.findByGroupIdForTenant(groupA.id, tenantB.id);
        assert.strictEqual(policy, null, 'Tenant B must not be able to retrieve Policy A');
    });

    it('should reject forged ID attack on WhatsAppConnection update and delete', async () => {
        // Tenant A attempts to disconnect Tenant B's connection using valid connB.id
        const updateAttempt = await connRepo.updateStatusForTenant(connB.id, tenantA.id, 'DISCONNECTED');
        assert.strictEqual(updateAttempt, null, 'Cross-tenant status update must return null');

        // Verify Conn B remains untouched
        const connBCheck = await connRepo.findByIdForTenant(connB.id, tenantB.id);
        assert.strictEqual(connBCheck.status, 'CONNECTED', 'Conn B status must remain CONNECTED');

        // Tenant A attempts to delete Tenant B's connection using valid connB.id
        const deleteAttempt = await connRepo.deleteForTenant(connB.id, tenantA.id);
        assert.strictEqual(deleteAttempt, null, 'Cross-tenant delete must return null');

        // Verify Conn B is not deleted
        const connBAfter = await connRepo.findByIdForTenant(connB.id, tenantB.id);
        assert.ok(connBAfter, 'Conn B must not be deleted by Tenant A');
    });

    it('should reject forged ID attack on Group update and delete', async () => {
        // Tenant A attempts to change Tenant B's Group status to UNMANAGED using valid groupB.id
        const updateAttempt = await groupRepo.updateStatusForTenant(groupB.id, tenantA.id, 'UNMANAGED');
        assert.strictEqual(updateAttempt, null, 'Cross-tenant group status update must return null');

        // Verify Group B status remains MANAGED
        const groupBCheck = await groupRepo.findByIdForTenant(groupB.id, tenantB.id);
        assert.strictEqual(groupBCheck.status, 'MANAGED');

        // Tenant A attempts to delete Tenant B's group using valid groupB.id
        const deleteAttempt = await groupRepo.deleteForTenant(groupB.id, tenantA.id);
        assert.strictEqual(deleteAttempt, null, 'Cross-tenant group delete must return null');

        // Verify Group B still exists
        const groupBAfter = await groupRepo.findByIdForTenant(groupB.id, tenantB.id);
        assert.ok(groupBAfter, 'Group B must not be deleted by Tenant A');
    });

    it('should reject forged ID attack on GroupPolicy upsert and delete', async () => {
        // Tenant A attempts to overwrite Tenant B's policy for Group B
        // Because of composite foreign key (tenant_id, group_id) -> groups(tenant_id, id),
        // PostgreSQL itself rejects this attempt with a foreign key violation!
        await assert.rejects(
            async () => {
                await policyRepo.upsertForTenant(tenantA.id, groupB.id, {
                    antilinkEnabled: true,
                    antilinkAction: 'delete',
                });
            },
            (err) => err.code === '23503',
            'Cross-tenant policy upsert must be rejected by foreign key constraint'
        );

        // Verify Policy B is intact
        const policyBCheck = await policyRepo.findByGroupIdForTenant(groupB.id, tenantB.id);
        assert.strictEqual(policyBCheck.welcome_message, 'Welcome to Beta Community');

        // Tenant A attempts to delete Tenant B's policy
        const deleteAttempt = await policyRepo.deleteForTenant(groupB.id, tenantA.id);
        assert.strictEqual(deleteAttempt, null, 'Cross-tenant policy delete must return null');

        // Verify Policy B still exists
        const policyBAfter = await policyRepo.findByGroupIdForTenant(groupB.id, tenantB.id);
        assert.ok(policyBAfter, 'Policy B must remain intact');
    });

    it('should verify collection queries only return resources belonging to requested tenant', async () => {
        // List connections
        const connsA = await connRepo.listForTenant(tenantA.id);
        assert.strictEqual(connsA.length, 1);
        assert.strictEqual(connsA[0].id, connA.id);

        const connsB = await connRepo.listForTenant(tenantB.id);
        assert.strictEqual(connsB.length, 1);
        assert.strictEqual(connsB[0].id, connB.id);

        // List groups
        const groupsA = await groupRepo.listForTenant(tenantA.id);
        assert.strictEqual(groupsA.length, 1);
        assert.strictEqual(groupsA[0].id, groupA.id);

        const groupsB = await groupRepo.listForTenant(tenantB.id);
        assert.strictEqual(groupsB.length, 1);
        assert.strictEqual(groupsB[0].id, groupB.id);
    });
});
