const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { getPool, closePool } = require('../src/database/client');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
} = require('../src/repositories');
const { createPipeline } = require('../src/application/createPipeline');
const { createExecutionContext } = require('../src/whatsapp/ExecutionContext');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Cross-Tenant Policy, Warning & Connection Isolation', () => {
    let pool;
    let tenantRepo, connRepo, groupRepo, policyRepo, warningRepo;
    let tenantA, connA, groupA;
    let tenantB, connB, groupB;
    let mockSocket;
    let pipeline;

    before(async () => {
        process.env.DATABASE_URL = TEST_DB_URL;
        pool = getPool();
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);

        // Setup Tenant A
        tenantA = await tenantRepo.create({ name: 'Tenant A Cross Attack' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '1111111111',
            displayName: 'Conn A',
            status: 'CONNECTED',
        });
        groupA = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000096@g.us',
            name: 'Group A',
            status: 'MANAGED',
        });
        await policyRepo.upsertForTenant(tenantA.id, groupA.id, {
            antilinkEnabled: true,
            antilinkAction: 'kick',
            maxWarnings: 1,
        });

        // Setup Tenant B
        tenantB = await tenantRepo.create({ name: 'Tenant B Cross Attack' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '2222222222',
            displayName: 'Conn B',
            status: 'CONNECTED',
        });
        groupB = await groupRepo.upsertDiscoveredGroup(tenantB.id, connB.id, {
            whatsappJid: '120363000000000097@g.us',
            name: 'Group B',
            status: 'MANAGED',
        });
        await policyRepo.upsertForTenant(tenantB.id, groupB.id, {
            antilinkEnabled: false,
            maxWarnings: 5,
        });

        mockSocket = {
            user: { id: '254799999999@s.whatsapp.net' },
            sendMessage: async () => ({ key: { id: 'm1' } }),
            groupParticipantsUpdate: async () => true,
            groupSettingUpdate: async () => true,
            groupMetadata: async () => ({ participants: [] }),
        };

        pipeline = createPipeline({ pool, socket: mockSocket });
    });

    after(async () => {
        if (tenantA) await tenantRepo.delete(tenantA.id).catch(() => {});
        if (tenantB) await tenantRepo.delete(tenantB.id).catch(() => {});
        await closePool();
    });

    it('Forged Group ID: Tenant A cannot read Tenant B group policies', async () => {
        // Tenant A tries to read Tenant B's group policy by passing groupB.id
        const policy = await policyRepo.findByGroupIdForTenant(groupB.id, tenantA.id);
        assert.strictEqual(policy, null);
    });

    it('Forged Group ID: Tenant A cannot mutate Tenant B group policies', async () => {
        // Tenant A tries to overwrite Tenant B's policy
        await assert.rejects(
            async () => {
                await policyRepo.upsertForTenant(tenantA.id, groupB.id, {
                    antilinkEnabled: true,
                    antilinkAction: 'delete',
                });
            },
            (err) => {
                assert.match(err.message, /foreign key constraint|violates foreign key/i);
                return true;
            }
        );

        // Verify Tenant B's policy remains unchanged
        const policyB = await policyRepo.findByGroupIdForTenant(groupB.id, tenantB.id);
        assert.strictEqual(policyB.antilink_enabled, false);
        assert.strictEqual(policyB.max_warnings, 5);
    });

    it('Connection Isolation: Connection A cannot execute pipeline operations on Group B', async () => {
        // Message arrives on Connection A claiming to be for Group B (which is owned by Connection B under Tenant B)
        const ctx = createExecutionContext({
            tenantId: tenantA.id,
            connectionId: connA.id,
            sock: mockSocket,
            db: pool,
        });

        const crossEvent = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-CROSS-01',
                remoteJid: groupB.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.warn @254700000002',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: { key: { remoteJid: groupB.whatsapp_jid } },
        };

        const res = await pipeline.processMessage(crossEvent);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(res.reason, 'unresolved_or_mismatched_group');
    });

    it('Tenant Isolation: Context with Tenant A ID and Connection B ID is rejected', async () => {
        // Mismatched tenantId and connectionId in event
        const ctx = createExecutionContext({
            tenantId: tenantA.id,
            connectionId: connB.id, // connection belongs to Tenant B!
            sock: mockSocket,
            db: pool,
        });

        const mismatchedEvent = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-CROSS-02',
                remoteJid: groupA.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.warn @254700000002',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: { key: { remoteJid: groupA.whatsapp_jid } },
        };

        const res = await pipeline.processMessage(mismatchedEvent);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(res.reason, 'unresolved_or_mismatched_group');
    });
});
