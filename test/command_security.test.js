const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Command Graceful Fallback & Credentials Handling', () => {
    it('commands/news.js handles missing API key gracefully without crashing', async () => {
        delete process.env.NEWS_API_KEY;
        const newsCommand = require('../commands/news');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await newsCommand(mockSock, 'test@s.whatsapp.net');
        assert.ok(capturedMessage, 'Must send message when NEWS_API_KEY is missing');
        assert.ok(capturedMessage.includes('not configured'), 'Message should indicate service is not configured');
    });

    it('commands/weather.js handles missing API key gracefully without crashing', async () => {
        delete process.env.OPENWEATHER_API_KEY;
        const weatherCommand = require('../commands/weather');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await weatherCommand(mockSock, 'test@s.whatsapp.net', { key: {} }, 'London');
        assert.ok(capturedMessage, 'Must send message when OPENWEATHER_API_KEY is missing');
        assert.ok(capturedMessage.includes('not configured'), 'Message should indicate service is not configured');
    });

    it('commands/gif.js handles missing API key gracefully without crashing', async () => {
        delete process.env.GIPHY_API_KEY;
        const gifCommand = require('../commands/gif');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await gifCommand(mockSock, 'test@s.whatsapp.net', 'cat');
        assert.ok(capturedMessage, 'Must send message when GIPHY_API_KEY is missing');
        assert.ok(capturedMessage.includes('not configured'), 'Message should indicate service is not configured');
    });

    it('commands/owner.js handles missing owner number gracefully without crashing', async () => {
        delete process.env.OWNER_NUMBER;
        const settings = require('../settings');
        const originalOwner = settings.ownerNumber;
        settings.ownerNumber = '';

        const ownerCommand = require('../commands/owner');
        let capturedMessage = null;
        const mockSock = {
            sendMessage: async (chatId, content) => {
                capturedMessage = content.text;
            }
        };

        await ownerCommand(mockSock, 'test@s.whatsapp.net');
        settings.ownerNumber = originalOwner;

        assert.ok(capturedMessage, 'Must send message when owner number is missing');
        assert.ok(capturedMessage.includes('not configured'), 'Message should state owner number is not configured');
    });
});
