const { describe, it } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

describe('Security & Environment Hygiene', () => {
    it('should ignore .env and sensitive directories in .gitignore', () => {
        const gitignoreContent = fs.readFileSync(path.join(__dirname, '../.gitignore'), 'utf8');
        assert.ok(gitignoreContent.includes('.env'), '.gitignore must include .env');
        assert.ok(gitignoreContent.includes('session/'), '.gitignore must include session/');
        assert.ok(gitignoreContent.includes('!.env.example'), '.gitignore must keep !.env.example trackable');
    });

    it('should have .env.example with placeholders and no real secrets', () => {
        const envExamplePath = path.join(__dirname, '../.env.example');
        assert.ok(fs.existsSync(envExamplePath), '.env.example must exist');

        const content = fs.readFileSync(envExamplePath, 'utf8');
        assert.ok(content.includes('NEWS_API_KEY='), 'Must define NEWS_API_KEY in .env.example');
        assert.ok(content.includes('OPENWEATHER_API_KEY='), 'Must define OPENWEATHER_API_KEY in .env.example');
        assert.ok(content.includes('OWNER_NUMBER='), 'Must define OWNER_NUMBER in .env.example');

        // Check that known compromised keys are not in .env.example
        const knownCompromisedSecrets = [
            'd90a9e986e18778b',
            '85faf717d0545d14074659ad',
            'dcd720a6f1914e2d9dba9790c188c08c',
            '4902c0f2550f58298ad4146a92b65e10',
            'prince_tech_api_azfsbshfb',
            'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq',
            '919876543210',
            '917023951514'
        ];

        for (const secret of knownCompromisedSecrets) {
            assert.ok(!content.includes(secret), `Compromised secret ${secret} must not appear in .env.example`);
        }
    });

    it('should sanitize data/owner.json and data/premium.json from hardcoded PII', () => {
        const ownerData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/owner.json'), 'utf8'));
        const premiumData = JSON.parse(fs.readFileSync(path.join(__dirname, '../data/premium.json'), 'utf8'));

        assert.ok(Array.isArray(ownerData), 'owner.json must be an array');
        assert.ok(Array.isArray(premiumData), 'premium.json must be an array');

        // Ensure legacy personal numbers are not hardcoded
        assert.ok(!ownerData.includes('917023951514'), 'Personal phone number found in owner.json');
        assert.ok(!premiumData.includes('917023951514'), 'Personal phone number found in premium.json');
    });

    it('should have neutralized dangerous .update command', async () => {
        const updateCommand = require('../commands/update');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await updateCommand(mockSock, 'test@s.whatsapp.net', { key: {} });
        assert.ok(capturedMessage, 'updateCommand should send a response');
        assert.ok(capturedMessage.includes('disabled for security reasons'), 'Must inform user that .update is disabled');
    });

    it('should have neutralized dangerous .clearsession command', async () => {
        const clearSessionCommand = require('../commands/clearsession');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await clearSessionCommand(mockSock, 'test@s.whatsapp.net', { key: {} });
        assert.ok(capturedMessage, 'clearSessionCommand should send a response');
        assert.ok(capturedMessage.includes('disabled for security reasons'), 'Must inform user that .clearsession is disabled');
    });

    it('should have neutralized channel forwarding / newsletter spoofing in lib/messageConfig.js', () => {
        const { channelInfo } = require('../lib/messageConfig');
        assert.ok(typeof channelInfo === 'object', 'channelInfo must be an object');
        assert.strictEqual(channelInfo.contextInfo, undefined, 'channelInfo must not inject contextInfo forwarding');
    });
});
