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
const CommandRegistry = require('../src/application/commands/CommandRegistry');
const ApplicationContext = require('../src/application/context/ApplicationContext');
const NormalizedMessage = require('../src/domain/models/NormalizedMessage');

const WarnCommand = require('../src/application/commands/moderation/WarnCommand');
const WarningsCommand = require('../src/application/commands/moderation/WarningsCommand');
const ResetWarnCommand = require('../src/application/commands/moderation/ResetWarnCommand');
const AntilinkCommand = require('../src/application/commands/moderation/AntilinkCommand');
const MuteCommand = require('../src/application/commands/moderation/MuteCommand');
const UnmuteCommand = require('../src/application/commands/moderation/UnmuteCommand');
const KickCommand = require('../src/application/commands/moderation/KickCommand');
const PromoteCommand = require('../src/application/commands/moderation/PromoteCommand');
const DemoteCommand = require('../src/application/commands/moderation/DemoteCommand');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Migrated Commands Execution & Command Registry', () => {
    let pool;
    let tenantRepo, connRepo, groupRepo, policyRepo, warningRepo;
    let warningService, moderationService;
    let tenant, conn, group;
    let registry;
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

        tenant = await tenantRepo.create({ name: 'Commands Test Tenant' });
        conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '5555555555',
            displayName: 'Commands Conn',
            status: 'CONNECTED',
        });
        group = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000098@g.us',
            name: 'Commands Group',
            status: 'MANAGED',
        });

        warningService = new WarningService({ warningRepo, policyRepo });
        mockGateway = {
            muteGroup: async (jid) => { gatewayCalls.push({ action: 'mute', jid }); return true; },
            unmuteGroup: async (jid) => { gatewayCalls.push({ action: 'unmute', jid }); return true; },
            kickParticipant: async (jid, p) => { gatewayCalls.push({ action: 'kick', jid, p }); return true; },
            promoteParticipant: async (jid, p) => { gatewayCalls.push({ action: 'promote', jid, p }); return true; },
            demoteParticipant: async (jid, p) => { gatewayCalls.push({ action: 'demote', jid, p }); return true; },
            sendTextMessage: async (jid, t, opts) => {
                gatewayCalls.push({ action: 'send', jid, t, mentions: opts?.mentions });
                return { key: { id: 'm-sent' } };
            },
        };
        moderationService = new ModerationService({ gateway: mockGateway });

        registry = new CommandRegistry();
        registry.register(new WarnCommand());
        registry.register(new WarningsCommand());
        registry.register(new ResetWarnCommand());
        registry.register(new AntilinkCommand());
        registry.register(new MuteCommand());
        registry.register(new UnmuteCommand());
        registry.register(new KickCommand());
        registry.register(new PromoteCommand());
        registry.register(new DemoteCommand());
    });

    after(async () => {
        if (tenant) await tenantRepo.delete(tenant.id).catch(() => {});
        await closePool();
    });

    const createCtx = (text, { mentionedJids = [], quotedSender = null } = {}) => {
        const msg = new NormalizedMessage({
            messageId: 'M-CMD-1',
            tenantId: tenant.id,
            connectionId: conn.id,
            chatJid: group.whatsapp_jid,
            senderJid: '254700000001@s.whatsapp.net',
            botJid: '254799999999@s.whatsapp.net',
            text,
            isGroup: true,
            mentionedJids,
            quotedSender,
        });

        return new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group,
            actor: {
                senderJid: '254700000001@s.whatsapp.net',
                isSenderAdmin: true,
                isBotAdmin: true,
            },
            message: msg,
        });
    };

    it('CommandRegistry should resolve commands and aliases correctly', () => {
        assert.ok(registry.isMigrated('warn'));
        assert.ok(registry.isMigrated('warning')); // alias
        assert.ok(registry.isMigrated('mute'));
        assert.ok(registry.isMigrated('silence')); // alias
        assert.ok(registry.isMigrated('kick'));
        assert.ok(registry.isMigrated('remove')); // alias
        assert.ok(registry.isMigrated('antilink'));
        assert.strictEqual(registry.isMigrated('ping'), false);
    });

    it('AntilinkCommand: should configure antilink on, set, and off in PostgreSQL', async () => {
        const services = { policyRepo, moderationService };
        const cmd = registry.find('antilink');

        // .antilink on
        const ctxOn = createCtx('.antilink on');
        const resOn = await cmd.execute(ctxOn, services);
        assert.strictEqual(resOn.success, true);
        const policyOn = await policyRepo.findByGroupIdForTenant(group.id, tenant.id);
        assert.strictEqual(policyOn.antilink_enabled, true);

        // .antilink set kick
        const ctxSet = createCtx('.antilink set kick');
        const resSet = await cmd.execute(ctxSet, services);
        assert.strictEqual(resSet.success, true);
        const policySet = await policyRepo.findByGroupIdForTenant(group.id, tenant.id);
        assert.strictEqual(policySet.antilink_action, 'kick');

        // .antilink off
        const ctxOff = createCtx('.antilink off');
        const resOff = await cmd.execute(ctxOff, services);
        assert.strictEqual(resOff.success, true);
        const policyOff = await policyRepo.findByGroupIdForTenant(group.id, tenant.id);
        assert.strictEqual(policyOff.antilink_enabled, false);
    });

    it('WarnCommand, WarningsCommand & ResetWarnCommand: should manage warnings cycle', async () => {
        gatewayCalls = [];
        const services = { warningService, moderationService };
        const warnCmd = registry.find('warn');
        const warningsCmd = registry.find('warnings');
        const resetCmd = registry.find('resetwarn');

        const targetJid = '254700000009@s.whatsapp.net';

        // 1. Issue warn
        const ctxWarn = createCtx('.warn @254700000009 Bad behaviour', { mentionedJids: [targetJid] });
        const resWarn = await warnCmd.execute(ctxWarn, services);
        assert.strictEqual(resWarn.success, true);

        // 2. Check warnings
        const ctxCheck = createCtx('.warnings @254700000009', { mentionedJids: [targetJid] });
        const resCheck = await warningsCmd.execute(ctxCheck, services);
        assert.strictEqual(resCheck.success, true);
        assert.strictEqual(resCheck.count, 1);

        // 3. Reset warnings
        const ctxReset = createCtx('.resetwarn @254700000009', { mentionedJids: [targetJid] });
        const resReset = await resetCmd.execute(ctxReset, services);
        assert.strictEqual(resReset.success, true);
        assert.strictEqual(resReset.clearedCount, 1);

        // 4. Check again (should be 0)
        const resCheck2 = await warningsCmd.execute(ctxCheck, services);
        assert.strictEqual(resCheck2.count, 0);
    });

    it('KickCommand, PromoteCommand & DemoteCommand: should dispatch to ModerationService', async () => {
        gatewayCalls = [];
        const services = { moderationService };
        const targetJid = '254700000010@s.whatsapp.net';

        // Kick
        const kickCmd = registry.find('kick');
        const ctxKick = createCtx('.kick @254700000010', { mentionedJids: [targetJid] });
        const resKick = await kickCmd.execute(ctxKick, services);
        assert.strictEqual(resKick.success, true);
        assert.ok(gatewayCalls.some((c) => c.action === 'kick' && c.p === targetJid));

        // Promote
        const promoteCmd = registry.find('promote');
        const ctxPromote = createCtx('.promote @254700000010', { mentionedJids: [targetJid] });
        const resPromote = await promoteCmd.execute(ctxPromote, services);
        assert.strictEqual(resPromote.success, true);
        assert.ok(gatewayCalls.some((c) => c.action === 'promote' && c.p === targetJid));

        // Demote
        const demoteCmd = registry.find('demote');
        const ctxDemote = createCtx('.demote @254700000010', { mentionedJids: [targetJid] });
        const resDemote = await demoteCmd.execute(ctxDemote, services);
        assert.strictEqual(resDemote.success, true);
        assert.ok(gatewayCalls.some((c) => c.action === 'demote' && c.p === targetJid));
    });
});
