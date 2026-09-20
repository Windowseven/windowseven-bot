const { describe, it } = require('node:test');
const assert = require('node:assert');

describe('Configuration & Identity Baseline', () => {
    it('should load default Windowseven MD settings without hardcoded PII', () => {
        const settings = require('../settings');
        assert.strictEqual(settings.botName, 'Windowseven MD');
        assert.strictEqual(settings.packname, 'Windowseven MD');
        assert.strictEqual(settings.version, '1.0.0');
        // ownerNumber should not contain the legacy hardcoded number
        assert.notStrictEqual(settings.ownerNumber, '919876543210');
    });

    it('should load config.js APIs without hardcoded API keys', () => {
        const config = require('../config');
        assert.ok(config.APIs);
        assert.ok(config.APIKeys);
        assert.strictEqual(typeof config.WARN_COUNT, 'number');

        // Verify that legacy hardcoded keys are not present
        const legacyKeys = [
            'd90a9e986e18778b',
            '85faf717d0545d14074659ad',
            'dcd720a6f1914e2d9dba9790c188c08c',
            '4902c0f2550f58298ad4146a92b65e10',
            'prince_tech_api_azfsbshfb',
            'qnl7ssQChTdPjsKta2Ax2LMaGXz303tq'
        ];

        for (const [url, key] of Object.entries(config.APIKeys)) {
            for (const legacyKey of legacyKeys) {
                assert.notStrictEqual(key, legacyKey, `Legacy key ${legacyKey} still found for ${url}`);
            }
        }
    });

    it('should handle optional API keys gracefully when unset in environment', () => {
        delete process.env.NEWS_API_KEY;
        delete process.env.OPENWEATHER_API_KEY;
        delete process.env.GIPHY_API_KEY;

        const settings = require('../settings');
        assert.strictEqual(settings.giphyApiKey, '');
    });
});
