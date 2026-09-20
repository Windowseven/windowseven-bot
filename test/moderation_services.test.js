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
const WarningService = require('../src/application/services/WarningService');
const ModerationService = require('../src/application/services/ModerationService');
const ApplicationContext = require('../src/application/context/ApplicationContext');
const NormalizedMessage = require('../src/domain/models/NormalizedMessage');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('WarningService & ModerationService Dual Authorization', () => {
    let pool;
    let tenantRepo, connRepo, groupRepo, policyRepo, warningRepo;
    let warningService, moderationService;
    let tenant, conn, group;

    // Mock Gateway recording actions
    let mockGateway;
    let gatewayCalls = [];

    before(async () => {
        process.env.DATABASE_URL = TEST_DB_URL;
        pool = getPool();
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);

        tenant = await tenantRepo.create({ name: 'Service Test Tenant' });
        conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '3333333333',
            displayName: 'Service Conn',
            status: 'CONNECTED',
        });
        group = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000093@g.us',
            name: 'Service Test Group',
            status: 'MANAGED',
        });

        // Configure group policy with max_warnings = 2
        await policyRepo.upsertForTenant(tenant.id, group.id, {
            maxWarnings: 2,
            warningAction: 'kick',
        });

        warningService = new WarningService({ warningRepo, policyRepo });

        mockGateway = {
            muteGroup: async (jid) => { gatewayCalls.push({ action: 'mute', jid }); return true; },
            unmuteGroup: async (jid) => { gatewayCalls.push({ action: 'unmute', jid }); return true; },
            kickParticipant: async (jid, p) => { gatewayCalls.push({ action: 'kick', jid, p }); return true; },
            promoteParticipant: async (jid, p) => { gatewayCalls.push({ action: 'promote', jid, p }); return true; },
            demoteParticipant: async (jid, p) => { gatewayCalls.push({ action: 'demote', jid, p }); return true; },
            deleteMessage: async (jid, k) => { gatewayCalls.push({ action: 'delete', jid, k }); return true; },
            sendTextMessage: async (jid, t) => { gatewayCalls.push({ action: 'send', jid, t }); return { id: 'msg-1' }; },
        };

        moderationService = new ModerationService({ gateway: mockGateway });
    });

    after(async () => {
        if (tenant) await tenantRepo.delete(tenant.id).catch(() => {});
        await closePool();
    });

    it('WarningService should track warnings and return escalation decision when threshold is reached', async () => {
        const subjectJid = '254711111111@s.whatsapp.net';
        const issuedBy = '254722222222@s.whatsapp.net';

        // Warning 1
        const res1 = await warningService.issueWarning({
            tenantId: tenant.id,
            groupId: group.id,
            subjectJid,
            issuedBy,
            reason: 'First warning',
        });
        assert.strictEqual(res1.warningCount, 1);
        assert.strictEqual(res1.maxWarnings, 2);
        assert.strictEqual(res1.shouldEscalate, false);

        // Warning 2 (Threshold reached: 2 >= 2)
        const res2 = await warningService.issueWarning({
            tenantId: tenant.id,
            groupId: group.id,
            subjectJid,
            issuedBy,
            reason: 'Second warning',
        });
        assert.strictEqual(res2.warningCount, 2);
        assert.strictEqual(res2.shouldEscalate, true);
        assert.strictEqual(res2.escalationAction, 'kick');
    });

    it('ModerationService should reject actions when group is not MANAGED', async () => {
        const unmanagedGroup = { ...group, status: 'DISCOVERED' };
        const appCtx = new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group: unmanagedGroup,
            actor: { senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, isBotAdmin: true },
            message: new NormalizedMessage({
                messageId: 'M1',
                tenantId: tenant.id,
                connectionId: conn.id,
                chatJid: group.whatsapp_jid,
                senderJid: '254700000001@s.whatsapp.net',
                botJid: '254799999999@s.whatsapp.net',
                text: '.mute',
            }),
        });

        const res = await moderationService.muteGroup(appCtx);
        assert.strictEqual(res.success, false);
        assert.match(res.error, /not managed/i);
    });

    it('ModerationService should reject actions when bot is not a WhatsApp group admin', async () => {
        const appCtx = new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group,
            actor: { senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, isBotAdmin: false }, // bot is NOT admin
            message: new NormalizedMessage({
                messageId: 'M1',
                tenantId: tenant.id,
                connectionId: conn.id,
                chatJid: group.whatsapp_jid,
                senderJid: '254700000001@s.whatsapp.net',
                botJid: '254799999999@s.whatsapp.net',
                text: '.mute',
            }),
        });

        const res = await moderationService.muteGroup(appCtx);
        assert.strictEqual(res.success, false);
        assert.match(res.error, /bot must be an admin/i);
    });

    it('ModerationService should reject admin-required actions when sender is not an admin', async () => {
        const appCtx = new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group,
            actor: { senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: false, isBotAdmin: true }, // sender is NOT admin
            message: new NormalizedMessage({
                messageId: 'M1',
                tenantId: tenant.id,
                connectionId: conn.id,
                chatJid: group.whatsapp_jid,
                senderJid: '254700000001@s.whatsapp.net',
                botJid: '254799999999@s.whatsapp.net',
                text: '.promote',
            }),
        });

        const res = await moderationService.promoteParticipant(appCtx, '254733333333@s.whatsapp.net');
        assert.strictEqual(res.success, false);
        assert.match(res.error, /only group admins/i);
    });

    it('ModerationService should execute mute and unmute when dual authorization succeeds', async () => {
        gatewayCalls = [];
        const appCtx = new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group,
            actor: { senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, isBotAdmin: true },
            message: new NormalizedMessage({
                messageId: 'M1',
                tenantId: tenant.id,
                connectionId: conn.id,
                chatJid: group.whatsapp_jid,
                senderJid: '254700000001@s.whatsapp.net',
                botJid: '254799999999@s.whatsapp.net',
                text: '.mute',
            }),
        });

        const muteRes = await moderationService.muteGroup(appCtx);
        assert.strictEqual(muteRes.success, true);
        assert.strictEqual(gatewayCalls[0].action, 'mute');

        const unmuteRes = await moderationService.unmuteGroup(appCtx);
        assert.strictEqual(unmuteRes.success, true);
        assert.strictEqual(gatewayCalls[1].action, 'unmute');
    });
});
