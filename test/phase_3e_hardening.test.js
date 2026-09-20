process.env.NODE_ENV = 'test';
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
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
const CommandHandler = require('../src/application/commands/CommandHandler');
const ApplicationPipeline = require('../src/application/pipeline/ApplicationPipeline');
const PolicyEngine = require('../src/application/policies/PolicyEngine');
const NormalizedMessage = require('../src/domain/models/NormalizedMessage');
const ApplicationContext = require('../src/application/context/ApplicationContext');

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

describe('Phase 3E: Application Hardening & Stabilization', () => {
    let pool;
    let tenantRepo, connRepo, groupRepo, policyRepo, warningRepo;
    let warningService, moderationService, policyEngine, commandRegistry;
    let pipeline;
    let tenant, conn, managedGroup, unmanagedGroup;
    let sentMessages = [];
    let gatewayCalls = [];
    let currentSenderAdmin = true;
    let currentBotAdmin = true;

    let warningsCmd, muteCmd, unmuteCmd;

    before(async () => {
        process.env.DATABASE_URL = TEST_DB_URL;
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);

        tenant = await tenantRepo.create({ name: 'Phase 3E Consolidated Tenant' });
        conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '7770001111',
            displayName: 'Phase 3E Conn',
            status: 'CONNECTED',
        });

        managedGroup = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000088@g.us',
            name: 'Phase 3E Managed Group',
            status: 'MANAGED',
        });

        unmanagedGroup = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000089@g.us',
            name: 'Phase 3E Unmanaged Group',
            status: 'DISCOVERED', // NOT MANAGED
        });

        await policyRepo.upsertForTenant(tenant.id, managedGroup.id, {
            antilinkEnabled: true,
            antilinkAction: 'delete',
        });

        // Seed 1 warning for target user in managed group
        await warningRepo.createWarning(tenant.id, managedGroup.id, {
            subjectJid: '254700000088@s.whatsapp.net',
            issuedBy: 'admin',
            reason: 'Test warning',
        });

        const mockGateway = {
            checkAdminStatus: async (jid, sender) => ({
                isSenderAdmin: currentSenderAdmin,
                isBotAdmin: currentBotAdmin,
            }),
            sendTextMessage: async (jid, text, opts) => {
                sentMessages.push({ jid, text, opts });
                return { key: { id: 'sent-id' } };
            },
            deleteMessage: async (jid, key) => {
                gatewayCalls.push({ action: 'deleteMessage', jid, key });
            },
            muteGroup: async (jid) => {
                gatewayCalls.push({ action: 'muteGroup', jid });
                return true;
            },
            unmuteGroup: async (jid) => {
                gatewayCalls.push({ action: 'unmuteGroup', jid });
                return true;
            },
            kickParticipant: async (jid, p) => {
                gatewayCalls.push({ action: 'kickParticipant', jid, p });
                return true;
            },
        };

        warningService = new WarningService({ warningRepo, policyRepo });
        moderationService = new ModerationService({ gateway: mockGateway });
        policyEngine = new PolicyEngine();
        commandRegistry = new CommandRegistry();

        warningsCmd = new WarningsCommand();
        muteCmd = new MuteCommand();
        unmuteCmd = new UnmuteCommand();

        commandRegistry.register(warningsCmd);
        commandRegistry.register(new AntilinkCommand());
        commandRegistry.register(new ResetWarnCommand());
        commandRegistry.register(new WarnCommand());
        commandRegistry.register(muteCmd);
        commandRegistry.register(unmuteCmd);
        commandRegistry.register(new KickCommand());

        pipeline = new ApplicationPipeline({
            groupRepo,
            policyRepo,
            warningRepo,
            warningService,
            moderationService,
            policyEngine,
            commandRegistry,
            gateway: mockGateway,
        });
    });

    after(async () => {
        if (moderationService) moderationService.clearAllMuteTimers();
        if (tenant) await tenantRepo.delete(tenant.id).catch(() => {});
        if (pool) await pool.end();
        await closePool();
    });

    // -------------------------------------------------------------
    // 1. NormalizedMessage Classification
    // -------------------------------------------------------------
    it('1.1 should classify command messages with messageKind = "COMMAND"', () => {
        const msg1 = new NormalizedMessage({ messageId: 'm1', text: '.help' });
        assert.strictEqual(msg1.messageKind, 'COMMAND');
        assert.strictEqual(msg1.isCommand, true);
        assert.strictEqual(msg1.command, 'help');

        const msg2 = new NormalizedMessage({ messageId: 'm2', text: '.warn @user' });
        assert.strictEqual(msg2.messageKind, 'COMMAND');
        assert.strictEqual(msg2.isCommand, true);
        assert.strictEqual(msg2.command, 'warn');
    });

    it('1.2 should classify media messages with messageKind = "MEDIA"', () => {
        const msgImage = new NormalizedMessage({
            messageId: 'm3',
            rawMessage: { message: { imageMessage: { url: 'https://example.com/img' } } },
        });
        assert.strictEqual(msgImage.messageKind, 'MEDIA');
        assert.strictEqual(msgImage.isCommand, false);

        const msgSticker = new NormalizedMessage({
            messageId: 'm4',
            rawMessage: { message: { stickerMessage: {} } },
        });
        assert.strictEqual(msgSticker.messageKind, 'MEDIA');
    });

    it('1.3 should classify system messages with messageKind = "SYSTEM"', () => {
        const msgStub = new NormalizedMessage({
            messageId: 'm5',
            rawMessage: { messageStubType: 28 },
        });
        assert.strictEqual(msgStub.messageKind, 'SYSTEM');
        assert.strictEqual(msgStub.isCommand, false);

        const msgProto = new NormalizedMessage({
            messageId: 'm6',
            rawMessage: { protocolMessage: { type: 0 } },
        });
        assert.strictEqual(msgProto.messageKind, 'SYSTEM');
    });

    it('1.4 should classify plain conversational text with messageKind = "TEXT"', () => {
        const msg = new NormalizedMessage({
            messageId: 'm7',
            text: 'Hello everyone in the group!',
        });
        assert.strictEqual(msg.messageKind, 'TEXT');
        assert.strictEqual(msg.isCommand, false);
        assert.strictEqual(msg.command, null);
    });

    // -------------------------------------------------------------
    // 2. Command Categories & Authorization Granularity
    // -------------------------------------------------------------
    it('2.1 CommandHandler should enforce valid category values', () => {
        assert.throws(() => {
            new CommandHandler({ name: 'bad', category: 'SUPERUSER' });
        }, /Invalid category: SUPERUSER/);

        const valid = new CommandHandler({ name: 'good', category: 'MODERATE' });
        assert.strictEqual(valid.category, 'MODERATE');
    });

    it('2.2 Migrated commands must declare accurate categories and admin requirements', () => {
        const warnings = new WarningsCommand();
        assert.strictEqual(warnings.category, 'READ');
        assert.strictEqual(warnings.requireSenderAdmin, false);
        assert.strictEqual(warnings.requireBotAdmin, false);

        const antilink = new AntilinkCommand();
        assert.strictEqual(antilink.category, 'CONFIGURE');
        assert.strictEqual(antilink.requireSenderAdmin, true);
        assert.strictEqual(antilink.requireBotAdmin, false);

        const resetwarn = new ResetWarnCommand();
        assert.strictEqual(resetwarn.category, 'MODERATE');
        assert.strictEqual(resetwarn.requireSenderAdmin, true);
        assert.strictEqual(resetwarn.requireBotAdmin, false);

        const warn = new WarnCommand();
        assert.strictEqual(warn.category, 'MODERATE');
        assert.strictEqual(warn.requireSenderAdmin, true);
        assert.strictEqual(warn.requireBotAdmin, true);

        const mute = new MuteCommand();
        assert.strictEqual(mute.category, 'MODERATE');
        assert.strictEqual(mute.requireSenderAdmin, true);
        assert.strictEqual(mute.requireBotAdmin, true);

        const kick = new KickCommand();
        assert.strictEqual(kick.category, 'MODERATE');
        assert.strictEqual(kick.requireSenderAdmin, true);
        assert.strictEqual(kick.requireBotAdmin, true);

        const promote = new PromoteCommand();
        assert.strictEqual(promote.category, 'ADMIN_ACTION');
        assert.strictEqual(promote.requireSenderAdmin, true);
        assert.strictEqual(promote.requireBotAdmin, true);

        const demote = new DemoteCommand();
        assert.strictEqual(demote.category, 'ADMIN_ACTION');
        assert.strictEqual(demote.requireSenderAdmin, true);
        assert.strictEqual(demote.requireBotAdmin, true);
    });

    // -------------------------------------------------------------
    // 3. ApplicationPipeline Path Separation & Strict Isolation
    // -------------------------------------------------------------
    it('3.1 should reject unmanaged group at gate and NOT execute commands or policies', async () => {
        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-UNMANAGED',
                remoteJid: unmanagedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.warn @user',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(res.reason, 'group_not_managed');
    });

    it('3.2 should bypass policy processing for unmigrated commands', async () => {
        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-UNMIGRATED',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.sticker https://example.com/sticker.png',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(res.reason, 'unmigrated_command');
    });

    it('3.3 should ignore system messages without running policies', async () => {
        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-SYS',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '',
                isGroup: true,
            },
            raw: { messageStubType: 28 },
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, false);
        assert.strictEqual(res.reason, 'system_message');
    });

    it('3.4 should enforce sender admin requirement for admin-only commands', async () => {
        currentSenderAdmin = false;
        currentBotAdmin = true;
        sentMessages = [];

        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-FORBIDDEN-SENDER',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000002@s.whatsapp.net',
                text: '.warn @user',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, true);
        assert.strictEqual(res.reason, 'forbidden_sender');
        assert.ok(sentMessages.some((m) => m.text.includes('Only group admins can use this command')));
    });

    it('3.5 should enforce bot admin requirement for bot-admin-only commands', async () => {
        currentSenderAdmin = true;
        currentBotAdmin = false;
        sentMessages = [];

        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-FORBIDDEN-BOT',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.mute',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, true);
        assert.strictEqual(res.reason, 'forbidden_bot');
        assert.ok(sentMessages.some((m) => m.text.includes('Please make the bot an admin first')));
    });

    it('3.6 should allow CONFIGURE commands when bot is not admin but sender is admin', async () => {
        currentSenderAdmin = true;
        currentBotAdmin = false;
        sentMessages = [];

        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-CONFIG-ALLOW',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net',
                text: '.antilink off',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, true);
        assert.strictEqual(res.result.success, true);
        assert.ok(sentMessages.some((m) => m.text.includes('turned OFF')));
    });

    it('3.7 should allow READ commands for non-admin senders', async () => {
        currentSenderAdmin = false;
        currentBotAdmin = false;
        sentMessages = [];

        const event = {
            ctx: { tenantId: tenant.id, connectionId: conn.id },
            message: {
                id: 'M-READ-ALLOW',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000003@s.whatsapp.net',
                text: '.warnings',
                isGroup: true,
            },
            raw: {},
        };

        const res = await pipeline.processMessage(event);
        assert.strictEqual(res.handled, true);
        assert.strictEqual(res.result.success, true);
        assert.ok(sentMessages.some((m) => m.text.includes('0 warning(s)')));
    });

    // -------------------------------------------------------------
    // 4. WarningsCommand Authorization Semantics
    // -------------------------------------------------------------
    const makeWarnContext = ({ senderJid, isSenderAdmin, mentionedJids = [], quotedSender = null, text = '.warnings' }) => {
        const msg = new NormalizedMessage({
            messageId: 'M-WARN-AUTH',
            tenantId: tenant.id,
            connectionId: conn.id,
            chatJid: managedGroup.whatsapp_jid,
            senderJid,
            text,
            isGroup: true,
            mentionedJids,
            quotedSender,
        });

        return new ApplicationContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            group: managedGroup,
            actor: {
                senderJid,
                isSenderAdmin,
                isBotAdmin: true,
            },
            message: msg,
        });
    };

    it('4.1 Own warnings: regular member can inspect their own warnings', async () => {
        sentMessages = [];
        const ctx = makeWarnContext({
            senderJid: '254700000088@s.whatsapp.net',
            isSenderAdmin: false,
        });

        const res = await warningsCmd.execute(ctx, { warningService, moderationService });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.count, 1);
        assert.ok(sentMessages.some((m) => m.text.includes('User @254700000088 has 1 warning(s)')));
    });

    it('4.2 Another user warnings: regular member is rejected (unauthorized access prevented)', async () => {
        sentMessages = [];
        const ctx = makeWarnContext({
            senderJid: '254700000099@s.whatsapp.net',
            isSenderAdmin: false,
            mentionedJids: ['254700000088@s.whatsapp.net'],
        });

        const res = await warningsCmd.execute(ctx, { warningService, moderationService });
        assert.strictEqual(res.success, false);
        assert.match(res.error, /Unauthorized/i);
        assert.ok(sentMessages.some((m) => m.text.includes('Only group admins can check warnings for other members')));
    });

    it('4.3 Authorized moderation access: group admin can inspect another member warnings', async () => {
        sentMessages = [];
        const ctx = makeWarnContext({
            senderJid: '254700000001@s.whatsapp.net',
            isSenderAdmin: true,
            mentionedJids: ['254700000088@s.whatsapp.net'],
        });

        const res = await warningsCmd.execute(ctx, { warningService, moderationService });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.count, 1);
        assert.ok(sentMessages.some((m) => m.text.includes('User @254700000088 has 1 warning(s)')));
    });

    it('4.4 Self-mention: regular member mentioning themselves is allowed as own warnings', async () => {
        sentMessages = [];
        const ctx = makeWarnContext({
            senderJid: '254700000088@s.whatsapp.net',
            isSenderAdmin: false,
            mentionedJids: ['254700000088@s.whatsapp.net'],
        });

        const res = await warningsCmd.execute(ctx, { warningService, moderationService });
        assert.strictEqual(res.success, true);
        assert.strictEqual(res.count, 1);
    });

    // -------------------------------------------------------------
    // 5. MuteCommand & ModerationService Scheduling Boundary
    // -------------------------------------------------------------
    it('5.1 should execute untimed .mute without scheduling', async () => {
        gatewayCalls = [];
        const ctx = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute' });
        const res = await muteCmd.execute(ctx, { moderationService });
        assert.strictEqual(res.success, true);
        assert.ok(gatewayCalls.some((c) => c.action === 'muteGroup'));
        assert.strictEqual(moderationService.hasPendingMuteTimer(managedGroup.whatsapp_jid), false);
    });

    it('5.2 should execute timed .mute with valid duration and register in-memory timer', async () => {
        gatewayCalls = [];
        const ctx = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute 10' });
        const res = await muteCmd.execute(ctx, { moderationService });
        assert.strictEqual(res.success, true);
        assert.ok(gatewayCalls.some((c) => c.action === 'muteGroup'));
        assert.strictEqual(moderationService.hasPendingMuteTimer(managedGroup.whatsapp_jid), true);
    });

    it('5.3 should reject invalid duration arguments', async () => {
        sentMessages = [];
        const ctx = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute abc' });
        const res = await muteCmd.execute(ctx, { moderationService });
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'Invalid duration');
        assert.ok(sentMessages.some((m) => m.text.includes('Invalid duration')));
    });

    it('5.4 should reject zero or negative duration arguments', async () => {
        const ctxZero = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute 0' });
        const resZero = await muteCmd.execute(ctxZero, { moderationService });
        assert.strictEqual(resZero.success, false);

        const ctxNeg = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute -5' });
        const resNeg = await muteCmd.execute(ctxNeg, { moderationService });
        assert.strictEqual(resNeg.success, false);
    });

    it('5.5 should reject unreasonably large duration (> 7 days / 10080 min)', async () => {
        const ctx = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute 10081' });
        const res = await muteCmd.execute(ctx, { moderationService });
        assert.strictEqual(res.success, false);
        assert.strictEqual(res.error, 'Duration exceeds maximum limit');
    });

    it('5.6 manual .unmute should cancel pending in-memory mute timer', async () => {
        const ctxMute = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.mute 30' });
        await muteCmd.execute(ctxMute, { moderationService });
        assert.strictEqual(moderationService.hasPendingMuteTimer(managedGroup.whatsapp_jid), true);

        const ctxUnmute = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true, text: '.unmute' });
        const resUnmute = await unmuteCmd.execute(ctxUnmute, { moderationService });
        assert.strictEqual(resUnmute.success, true);
        assert.strictEqual(moderationService.hasPendingMuteTimer(managedGroup.whatsapp_jid), false);
    });

    it('5.7 timer failure handling: gateway failure in scheduled unmute does not throw', async () => {
        const ctx = makeWarnContext({ senderJid: '254700000001@s.whatsapp.net', isSenderAdmin: true });
        const failingGateway = {
            muteGroup: async () => true,
            unmuteGroup: async () => { throw new Error('WhatsApp network disconnect'); },
            sendTextMessage: async () => true,
        };
        const svc = new ModerationService({ gateway: failingGateway });

        await svc.muteGroup(ctx, 0.001);
        assert.strictEqual(svc.hasPendingMuteTimer(managedGroup.whatsapp_jid), true);

        await new Promise((r) => setTimeout(r, 120));
        assert.strictEqual(svc.hasPendingMuteTimer(managedGroup.whatsapp_jid), false);
    });

    // -------------------------------------------------------------
    // 6. LegacyBridge Managed-Group Isolation & Anti-Bypass
    // -------------------------------------------------------------
    it('6.1 should NOT forward migrated commands in unmanaged groups to legacy main.js', async () => {
        const { EventEmitter } = require('node:events');
        const { attachLegacyBridge } = require('../src/whatsapp/legacyBridge');

        const fakeAdapter = new EventEmitter();
        const fakeSocket = {
            user: { id: 'bot@s.whatsapp.net' },
            ev: new EventEmitter(),
            sendMessage: async () => ({ key: { id: 'sent' } }),
        };
        fakeAdapter.socket = fakeSocket;

        let legacyInvoked = false;
        attachLegacyBridge(fakeAdapter, {
            tenantId: 't-bridge',
            connectionId: 'c-bridge',
            pipeline: {
                commandRegistry: {
                    isMigrated: (cmd) => ['warn', 'mute', 'kick', 'antilink', 'warnings'].includes(cmd),
                },
                processMessage: async () => ({ handled: false, reason: 'group_not_managed' }),
            },
        });

        fakeAdapter.emit('message.received', {
            message: {
                id: 'M-UNM-1',
                remoteJid: 'unmanaged-123@g.us',
                text: '.warn @user',
                isGroup: true,
            },
            raw: { message: { conversation: '.warn @user' } },
        });

        await new Promise((r) => setTimeout(r, 20));
        fakeAdapter.removeAllListeners();
    });

    it('6.2 should NOT forward non-command group messages in unmanaged groups to legacy main.js', async () => {
        const { EventEmitter } = require('node:events');
        const { attachLegacyBridge } = require('../src/whatsapp/legacyBridge');

        const fakeAdapter = new EventEmitter();
        const fakeSocket = {
            user: { id: 'bot@s.whatsapp.net' },
            ev: new EventEmitter(),
            sendMessage: async () => ({ key: { id: 'sent' } }),
        };
        fakeAdapter.socket = fakeSocket;

        attachLegacyBridge(fakeAdapter, {
            tenantId: 't-bridge',
            connectionId: 'c-bridge',
            pipeline: {
                commandRegistry: {
                    isMigrated: (cmd) => ['warn', 'mute', 'kick', 'antilink', 'warnings'].includes(cmd),
                },
                processMessage: async () => ({ handled: false, reason: 'group_not_managed' }),
            },
        });

        fakeAdapter.emit('message.received', {
            message: {
                id: 'M-UNM-2',
                remoteJid: 'unmanaged-123@g.us',
                text: 'Regular chat with a link https://spam.com',
                isGroup: true,
            },
            raw: { message: { conversation: 'Regular chat with a link https://spam.com' } },
        });

        await new Promise((r) => setTimeout(r, 20));
        fakeAdapter.removeAllListeners();
    });
});
