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

describe('ApplicationPipeline, Managed Group Gate & Failure Isolation', () => {
    let pool;
    let tenantRepo, connRepo, groupRepo, policyRepo, warningRepo;
    let tenant, conn, managedGroup, discoveredGroup;
    let mockSocket;
    let sentMessages = [];
    let deletedMessages = [];
    let kickedParticipants = [];
    let pipeline;

    before(async () => {
        process.env.DATABASE_URL = TEST_DB_URL;
        pool = getPool();
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
        warningRepo = new GroupWarningRepository(pool);

        tenant = await tenantRepo.create({ name: 'Pipeline Test Tenant' });
        conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '4444444444',
            displayName: 'Pipeline Conn',
            status: 'CONNECTED',
        });

        // 1. Managed Group
        managedGroup = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000094@g.us',
            name: 'Managed Group',
            status: 'MANAGED',
        });

        // 2. Discovered Group
        discoveredGroup = await groupRepo.upsertDiscoveredGroup(tenant.id, conn.id, {
            whatsappJid: '120363000000000095@g.us',
            name: 'Discovered Group',
            status: 'DISCOVERED',
        });

        // Configure group policy for managed group: AntiLink enabled (action: warn), max_warnings = 3
        await policyRepo.upsertForTenant(tenant.id, managedGroup.id, {
            antilinkEnabled: true,
            antilinkAction: 'warn',
            maxWarnings: 3,
            warningAction: 'kick',
        });

        // Mock Baileys socket
        mockSocket = {
            user: { id: '254799999999:1@s.whatsapp.net' },
            ev: { on: () => {} },
            sendMessage: async (jid, content, opts) => {
                if (content.delete) {
                    deletedMessages.push({ jid, key: content.delete });
                } else {
                    sentMessages.push({ jid, text: content.text, mentions: content.mentions });
                }
                return { key: { id: 'sent-msg-id' } };
            },
            groupParticipantsUpdate: async (jid, participants, action) => {
                if (action === 'remove') {
                    kickedParticipants.push({ jid, participants });
                }
                return true;
            },
            groupSettingUpdate: async () => true,
            groupMetadata: async (jid) => ({
                id: jid,
                participants: [
                    { id: '254799999999@s.whatsapp.net', admin: 'admin' }, // bot is admin
                    { id: '254700000001@s.whatsapp.net', admin: 'admin' }, // sender 1 is admin
                    { id: '254700000002@s.whatsapp.net', admin: null },    // sender 2 is member
                ],
            }),
        };

        pipeline = createPipeline({ pool, socket: mockSocket });
    });

    after(async () => {
        if (tenant) await tenantRepo.delete(tenant.id).catch(() => {});
        await closePool();
    });

    it('Managed Group Gate: should ignore policies and commands in DISCOVERED groups', async () => {
        sentMessages = [];
        const ctx = createExecutionContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            sock: mockSocket,
            db: pool,
        });

        const event = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-001',
                remoteJid: discoveredGroup.whatsapp_jid,
                sender: '254700000002@s.whatsapp.net',
                text: 'Join https://chat.whatsapp.com/testlink',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: {
                key: { remoteJid: discoveredGroup.whatsapp_jid, id: 'MSG-001', fromMe: false },
                message: { conversation: 'Join https://chat.whatsapp.com/testlink' },
            },
        };

        const result = await pipeline.processMessage(event);
        assert.strictEqual(result.handled, false);
        assert.strictEqual(result.reason, 'group_not_managed');
        assert.strictEqual(sentMessages.length, 0);
    });

    it('Managed Group: should evaluate AntiLink policy, delete message, and issue warning', async () => {
        sentMessages = [];
        deletedMessages = [];
        const ctx = createExecutionContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            sock: mockSocket,
            db: pool,
        });

        const event = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-002',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000002@s.whatsapp.net', // normal member
                text: 'Check out https://chat.whatsapp.com/invite',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: {
                key: { remoteJid: managedGroup.whatsapp_jid, id: 'MSG-002', fromMe: false },
                message: { conversation: 'Check out https://chat.whatsapp.com/invite' },
            },
        };

        const result = await pipeline.processMessage(event);
        assert.strictEqual(result.handled, true);
        assert.strictEqual(result.decision.action, 'WARN');
        assert.strictEqual(deletedMessages.length, 1);
        assert.strictEqual(sentMessages.length, 1);
        assert.match(sentMessages[0].text, /Warning \(1\/3\)/i);
    });

    it('Managed Group: should execute migrated .warn command when issued by admin', async () => {
        sentMessages = [];
        const ctx = createExecutionContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            sock: mockSocket,
            db: pool,
        });

        const event = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-003',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000001@s.whatsapp.net', // group admin
                text: '.warn @254700000002 Spamming links',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: {
                key: { remoteJid: managedGroup.whatsapp_jid, id: 'MSG-003', fromMe: false },
                message: {
                    extendedTextMessage: {
                        text: '.warn @254700000002 Spamming links',
                        contextInfo: {
                            mentionedJid: ['254700000002@s.whatsapp.net'],
                        },
                    },
                },
            },
        };

        const result = await pipeline.processMessage(event);
        assert.strictEqual(result.handled, true);
        assert.strictEqual(result.result.success, true);
        assert.strictEqual(sentMessages.length, 1);
        assert.match(sentMessages[0].text, /WARNING ALERT/i);
    });

    it('should NOT run policies on non-migrated commands and return handled: false for legacy fallback', async () => {
        sentMessages = [];
        const ctx = createExecutionContext({
            tenantId: tenant.id,
            connectionId: conn.id,
            sock: mockSocket,
            db: pool,
        });

        const event = {
            eventType: 'message.received',
            ctx,
            message: {
                id: 'MSG-004',
                remoteJid: managedGroup.whatsapp_jid,
                sender: '254700000002@s.whatsapp.net',
                text: '.ping',
                isGroup: true,
                fromMe: false,
                timestamp: Date.now(),
            },
            raw: {
                key: { remoteJid: managedGroup.whatsapp_jid, id: 'MSG-004', fromMe: false },
                message: { conversation: '.ping' },
            },
        };

        const result = await pipeline.processMessage(event);
        assert.strictEqual(result.handled, false);
        assert.strictEqual(result.reason, 'unmigrated_command');
        // Confirms no policy executed on unmigrated command
        assert.strictEqual(sentMessages.length, 0);
    });

    it('Failure Isolation: unexpected error in pipeline must not throw or crash', async () => {
        // Pass a malformed event that throws during processing
        const brokenEvent = {
            eventType: 'message.received',
            ctx: { tenantId: tenant.id, connectionId: conn.id, sock: null }, // missing sock
            message: { isGroup: true, remoteJid: managedGroup.whatsapp_jid },
        };

        const result = await pipeline.processMessage(brokenEvent);
        assert.strictEqual(result.handled, false);
        // Does not throw to caller!
    });
});
