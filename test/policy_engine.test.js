const { describe, it } = require('node:test');
const assert = require('node:assert');
const AntiLinkPolicy = require('../src/application/policies/AntiLinkPolicy');
const AntiBadwordPolicy = require('../src/application/policies/AntiBadwordPolicy');
const PolicyEngine = require('../src/application/policies/PolicyEngine');
const NormalizedMessage = require('../src/domain/models/NormalizedMessage');

describe('PolicyEngine, Policies & Deterministic Precedence', () => {
    const createMockMessage = (text, sender = '254700000001@s.whatsapp.net') => {
        return new NormalizedMessage({
            messageId: 'MSG-001',
            tenantId: '11111111-1111-1111-1111-111111111111',
            connectionId: '22222222-2222-2222-2222-222222222222',
            chatJid: '120363000000000001@g.us',
            senderJid: sender,
            botJid: '254799999999@s.whatsapp.net',
            text,
            isGroup: true,
        });
    };

    it('should evaluate AntiLinkPolicy and trigger DELETE for prohibited links', () => {
        const policy = new AntiLinkPolicy();
        const msg = createMockMessage('Please join our group: https://chat.whatsapp.com/ABCDEF123456');
        const groupPolicy = { antilink_enabled: true, antilink_action: 'delete' };
        const actor = { isSenderAdmin: false };

        const decision = policy.evaluate({ message: msg, groupPolicy, actor });
        assert.strictEqual(decision.action, 'DELETE');
        assert.strictEqual(decision.policyName, 'AntiLinkPolicy');
    });

    it('should evaluate AntiLinkPolicy and trigger KICK when configured', () => {
        const policy = new AntiLinkPolicy();
        const msg = createMockMessage('Check this link: www.example.com');
        const groupPolicy = { antilink_enabled: true, antilink_action: 'kick' };
        const actor = { isSenderAdmin: false };

        const decision = policy.evaluate({ message: msg, groupPolicy, actor });
        assert.strictEqual(decision.action, 'KICK');
    });

    it('should exempt WhatsApp group administrators from AntiLinkPolicy', () => {
        const policy = new AntiLinkPolicy();
        const msg = createMockMessage('https://chat.whatsapp.com/ABCDEF123456');
        const groupPolicy = { antilink_enabled: true, antilink_action: 'kick' };
        const actor = { isSenderAdmin: true }; // Admin sender

        const decision = policy.evaluate({ message: msg, groupPolicy, actor });
        assert.strictEqual(decision.action, 'ALLOW');
    });

    it('should evaluate AntiBadwordPolicy and trigger configured action for bad words', () => {
        const policy = new AntiBadwordPolicy();
        const msg = createMockMessage('You are an idiot and a bastard');
        const groupPolicy = { antibadword_enabled: true, antibadword_action: 'warn' };
        const actor = { isSenderAdmin: false };

        const decision = policy.evaluate({ message: msg, groupPolicy, actor });
        assert.strictEqual(decision.action, 'WARN');
        assert.strictEqual(decision.policyName, 'AntiBadwordPolicy');
    });

    it('should resolve multiple policies by deterministic severity precedence (KICK > DELETE > WARN)', () => {
        const engine = new PolicyEngine();
        // Message contains BOTH a link and a bad word
        const msg = createMockMessage('Hey bastard visit https://badlink.com');
        
        // Scenario 1: Badword = WARN, Link = KICK -> KICK wins
        const groupPolicy1 = {
            antibadword_enabled: true,
            antibadword_action: 'warn',
            antilink_enabled: true,
            antilink_action: 'kick',
        };
        const decision1 = engine.evaluate({ message: msg, groupPolicy: groupPolicy1, actor: { isSenderAdmin: false } });
        assert.strictEqual(decision1.action, 'KICK');
        assert.strictEqual(decision1.policyName, 'AntiLinkPolicy');

        // Scenario 2: Badword = DELETE, Link = WARN -> DELETE wins
        const groupPolicy2 = {
            antibadword_enabled: true,
            antibadword_action: 'delete',
            antilink_enabled: true,
            antilink_action: 'warn',
        };
        const decision2 = engine.evaluate({ message: msg, groupPolicy: groupPolicy2, actor: { isSenderAdmin: false } });
        assert.strictEqual(decision2.action, 'DELETE');
        assert.strictEqual(decision2.policyName, 'AntiBadwordPolicy');
    });

    it('should allow benign messages without violations', () => {
        const engine = new PolicyEngine();
        const msg = createMockMessage('Good morning everyone! How is the project going?');
        const groupPolicy = {
            antibadword_enabled: true,
            antibadword_action: 'delete',
            antilink_enabled: true,
            antilink_action: 'kick',
        };
        const decision = engine.evaluate({ message: msg, groupPolicy, actor: { isSenderAdmin: false } });
        assert.strictEqual(decision.action, 'ALLOW');
    });
});
