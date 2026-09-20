const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { getPool, closePool } = require('../src/database/client');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupWarningRepository,
} = require('../src/repositories');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('GroupWarningRepository & Warning Isolation', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let groupRepo;
    let warningRepo;

    let tenantA, tenantB;
    let connA, connB;
    let groupA, groupB;

    before(async () => {
        process.env.DATABASE_URL = TEST_DB_URL;
        pool = getPool();
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        warningRepo = new GroupWarningRepository(pool);

        // Setup Tenant A
        tenantA = await tenantRepo.create({ name: 'Tenant A Warning Test' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '1111111111',
            displayName: 'Conn A',
            status: 'CONNECTED',
        });
        groupA = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000091@g.us',
            name: 'Group A',
            status: 'MANAGED',
        });

        // Setup Tenant B
        tenantB = await tenantRepo.create({ name: 'Tenant B Warning Test' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '2222222222',
            displayName: 'Conn B',
            status: 'CONNECTED',
        });
        groupB = await groupRepo.upsertDiscoveredGroup(tenantB.id, connB.id, {
            whatsappJid: '120363000000000092@g.us',
            name: 'Group B',
            status: 'MANAGED',
        });
    });

    after(async () => {
        if (tenantA) await tenantRepo.delete(tenantA.id).catch(() => {});
        if (tenantB) await tenantRepo.delete(tenantB.id).catch(() => {});
        await closePool();
    });

    it('should create and count warnings for a subject in a tenant-owned group', async () => {
        const subjectJid = '254700000001@s.whatsapp.net';
        const issuerJid = '254700000002@s.whatsapp.net';

        const warn1 = await warningRepo.createWarning(tenantA.id, groupA.id, {
            subjectJid,
            issuedBy: issuerJid,
            reason: 'Spamming sticker',
        });

        assert.ok(warn1.id);
        assert.strictEqual(warn1.tenant_id, tenantA.id);
        assert.strictEqual(warn1.group_id, groupA.id);
        assert.strictEqual(warn1.reason, 'Spamming sticker');

        const warn2 = await warningRepo.createWarning(tenantA.id, groupA.id, {
            subjectJid,
            issuedBy: issuerJid,
            reason: 'Inappropriate language',
        });

        const count = await warningRepo.countWarningsForSubject(tenantA.id, groupA.id, subjectJid);
        assert.strictEqual(count, 2);

        const list = await warningRepo.listWarningsForSubject(tenantA.id, groupA.id, subjectJid);
        assert.strictEqual(list.length, 2);
        assert.strictEqual(list[0].id, warn2.id); // Newest first
    });

    it('should reset warnings for a subject cleanly', async () => {
        const subjectJid = '254700000001@s.whatsapp.net';

        const cleared = await warningRepo.resetWarningsForSubject(tenantA.id, groupA.id, subjectJid);
        assert.strictEqual(cleared, 2);

        const countAfter = await warningRepo.countWarningsForSubject(tenantA.id, groupA.id, subjectJid);
        assert.strictEqual(countAfter, 0);
    });

    it('should enforce composite foreign key rejecting mismatched tenant and group', async () => {
        // Attempt to insert warning with Tenant A ID but Group B (which belongs to Tenant B)
        await assert.rejects(
            async () => {
                await warningRepo.createWarning(tenantA.id, groupB.id, {
                    subjectJid: '254700000001@s.whatsapp.net',
                    issuedBy: '254700000002@s.whatsapp.net',
                    reason: 'Cross tenant attack',
                });
            },
            (err) => {
                assert.match(err.message, /foreign key constraint|violates foreign key/i);
                return true;
            }
        );
    });

    it('should isolate warnings completely across tenants (no cross-tenant leakage)', async () => {
        const subjectJid = '254799999999@s.whatsapp.net';

        // Issue warning in Tenant B
        await warningRepo.createWarning(tenantB.id, groupB.id, {
            subjectJid,
            issuedBy: '254788888888@s.whatsapp.net',
            reason: 'Tenant B private violation',
        });

        // Tenant A queries for the same subject in Group A
        const countTenantA = await warningRepo.countWarningsForSubject(tenantA.id, groupA.id, subjectJid);
        assert.strictEqual(countTenantA, 0);

        // Tenant A tries to query Group B
        const countTenantAonGroupB = await warningRepo.countWarningsForSubject(tenantA.id, groupB.id, subjectJid);
        assert.strictEqual(countTenantAonGroupB, 0);

        // Tenant A tries to reset warnings in Group B
        const resetTenantAonGroupB = await warningRepo.resetWarningsForSubject(tenantA.id, groupB.id, subjectJid);
        assert.strictEqual(resetTenantAonGroupB, 0);

        // Confirm Tenant B still has its warning
        const countTenantB = await warningRepo.countWarningsForSubject(tenantB.id, groupB.id, subjectJid);
        assert.strictEqual(countTenantB, 1);
    });
});
