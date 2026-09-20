const ApiError = require('../errors/ApiError');

const ALLOWED_TOP_LEVEL_KEYS = new Set([
    'antilinkEnabled', 'antilink_enabled',
    'antilinkAction', 'antilink_action',
    'antibadwordEnabled', 'antibadword_enabled',
    'antibadwordAction', 'antibadword_action',
    'maxWarnings', 'max_warnings',
    'warningAction', 'warning_action',
    'welcomeEnabled', 'welcome_enabled',
    'welcomeMessage', 'welcome_message',
    'goodbyeEnabled', 'goodbye_enabled',
    'goodbyeMessage', 'goodbye_message',
    'chatbotEnabled', 'chatbot_enabled',
    'settings',
]);

const FORBIDDEN_IDENTITY_KEYS = new Set([
    'id',
    'tenant_id',
    'tenantId',
    'connection_id',
    'connectionId',
    'group_id',
    'groupId',
    'created_at',
    'createdAt',
    'updated_at',
    'updatedAt',
]);

const FORBIDDEN_PATTERN = /token|secret|password|auth|private/i;

class PolicyValidator {
    /**
     * Validates and sanitizes a policy update payload.
     * Throws ApiError.unprocessableEntity (422) if validation fails.
     *
     * @param {object} payload
     * @returns {object} Clean validated policy data with camelCase keys
     */
    static validate(payload) {
        if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw ApiError.unprocessableEntity('Policy payload must be a JSON object', 'VALIDATION_ERROR');
        }

        // Check for unknown or forbidden identity keys
        for (const key of Object.keys(payload)) {
            if (FORBIDDEN_IDENTITY_KEYS.has(key)) {
                throw ApiError.unprocessableEntity(
                    `Cannot modify read-only or identity property: "${key}"`,
                    'VALIDATION_ERROR',
                    [{ field: key, message: `Property "${key}" is forbidden` }]
                );
            }
            if (!ALLOWED_TOP_LEVEL_KEYS.has(key)) {
                throw ApiError.unprocessableEntity(
                    `Unknown policy property: "${key}"`,
                    'VALIDATION_ERROR',
                    [{ field: key, message: `Property "${key}" is not supported` }]
                );
            }
        }

        const out = {};

        // antilinkEnabled / antilink_enabled
        const antilinkVal = payload.antilinkEnabled !== undefined ? payload.antilinkEnabled : payload.antilink_enabled;
        if (antilinkVal !== undefined) {
            if (typeof antilinkVal !== 'boolean') {
                throw ApiError.unprocessableEntity('antilink_enabled must be a boolean', 'VALIDATION_ERROR');
            }
            out.antilinkEnabled = antilinkVal;
        }

        // antilinkAction / antilink_action
        const antilinkAct = payload.antilinkAction !== undefined ? payload.antilinkAction : payload.antilink_action;
        if (antilinkAct !== undefined) {
            const valid = ['delete', 'warn', 'kick'];
            if (!valid.includes(antilinkAct)) {
                throw ApiError.unprocessableEntity(`antilink_action must be one of: ${valid.join(', ')}`, 'VALIDATION_ERROR');
            }
            out.antilinkAction = antilinkAct;
        }

        // antibadwordEnabled / antibadword_enabled
        const antibadVal = payload.antibadwordEnabled !== undefined ? payload.antibadwordEnabled : payload.antibadword_enabled;
        if (antibadVal !== undefined) {
            if (typeof antibadVal !== 'boolean') {
                throw ApiError.unprocessableEntity('antibadword_enabled must be a boolean', 'VALIDATION_ERROR');
            }
            out.antibadwordEnabled = antibadVal;
        }

        // antibadwordAction / antibadword_action
        const antibadAct = payload.antibadwordAction !== undefined ? payload.antibadwordAction : payload.antibadword_action;
        if (antibadAct !== undefined) {
            const valid = ['delete', 'warn', 'kick'];
            if (!valid.includes(antibadAct)) {
                throw ApiError.unprocessableEntity(`antibadword_action must be one of: ${valid.join(', ')}`, 'VALIDATION_ERROR');
            }
            out.antibadwordAction = antibadAct;
        }

        // maxWarnings / max_warnings
        const maxWarnVal = payload.maxWarnings !== undefined ? payload.maxWarnings : payload.max_warnings;
        if (maxWarnVal !== undefined) {
            const num = Number(maxWarnVal);
            if (!Number.isInteger(num) || num < 1 || num > 20) {
                throw ApiError.unprocessableEntity('max_warnings must be an integer between 1 and 20', 'VALIDATION_ERROR');
            }
            out.maxWarnings = num;
        }

        // warningAction / warning_action
        const warnAct = payload.warningAction !== undefined ? payload.warningAction : payload.warning_action;
        if (warnAct !== undefined) {
            const valid = ['warn', 'kick'];
            if (!valid.includes(warnAct)) {
                throw ApiError.unprocessableEntity(`warning_action must be one of: ${valid.join(', ')}`, 'VALIDATION_ERROR');
            }
            out.warningAction = warnAct;
        }

        // welcomeEnabled / welcome_enabled
        const welcomeVal = payload.welcomeEnabled !== undefined ? payload.welcomeEnabled : payload.welcome_enabled;
        if (welcomeVal !== undefined) {
            if (typeof welcomeVal !== 'boolean') {
                throw ApiError.unprocessableEntity('welcome_enabled must be a boolean', 'VALIDATION_ERROR');
            }
            out.welcomeEnabled = welcomeVal;
        }

        // welcomeMessage / welcome_message
        const welcomeMsg = payload.welcomeMessage !== undefined ? payload.welcomeMessage : payload.welcome_message;
        if (welcomeMsg !== undefined) {
            if (welcomeMsg !== null && typeof welcomeMsg !== 'string') {
                throw ApiError.unprocessableEntity('welcome_message must be a string or null', 'VALIDATION_ERROR');
            }
            if (welcomeMsg && welcomeMsg.length > 500) {
                throw ApiError.unprocessableEntity('welcome_message exceeds 500 characters', 'VALIDATION_ERROR');
            }
            out.welcomeMessage = welcomeMsg;
        }

        // goodbyeEnabled / goodbye_enabled
        const goodbyeVal = payload.goodbyeEnabled !== undefined ? payload.goodbyeEnabled : payload.goodbye_enabled;
        if (goodbyeVal !== undefined) {
            if (typeof goodbyeVal !== 'boolean') {
                throw ApiError.unprocessableEntity('goodbye_enabled must be a boolean', 'VALIDATION_ERROR');
            }
            out.goodbyeEnabled = goodbyeVal;
        }

        // goodbyeMessage / goodbye_message
        const goodbyeMsg = payload.goodbyeMessage !== undefined ? payload.goodbyeMessage : payload.goodbye_message;
        if (goodbyeMsg !== undefined) {
            if (goodbyeMsg !== null && typeof goodbyeMsg !== 'string') {
                throw ApiError.unprocessableEntity('goodbye_message must be a string or null', 'VALIDATION_ERROR');
            }
            if (goodbyeMsg && goodbyeMsg.length > 500) {
                throw ApiError.unprocessableEntity('goodbye_message exceeds 500 characters', 'VALIDATION_ERROR');
            }
            out.goodbyeMessage = goodbyeMsg;
        }

        // chatbotEnabled / chatbot_enabled
        const chatbotVal = payload.chatbotEnabled !== undefined ? payload.chatbotEnabled : payload.chatbot_enabled;
        if (chatbotVal !== undefined) {
            if (typeof chatbotVal !== 'boolean') {
                throw ApiError.unprocessableEntity('chatbot_enabled must be a boolean', 'VALIDATION_ERROR');
            }
            out.chatbotEnabled = chatbotVal;
        }

        // settings JSONB validation
        if (payload.settings !== undefined) {
            if (payload.settings === null || typeof payload.settings !== 'object' || Array.isArray(payload.settings)) {
                throw ApiError.unprocessableEntity('settings must be a JSON object', 'VALIDATION_ERROR');
            }

            const serialized = JSON.stringify(payload.settings);
            if (Buffer.byteLength(serialized, 'utf8') > 16 * 1024) {
                throw ApiError.unprocessableEntity('settings payload exceeds 16KB limit', 'VALIDATION_ERROR');
            }

            // Check keys for forbidden patterns (token, secret, auth, password, private)
            PolicyValidator.checkSensitiveKeys(payload.settings);

            out.settings = payload.settings;
        }

        return out;
    }

    /**
     * Recursively checks that an object does not contain sensitive or secret keys.
     */
    static checkSensitiveKeys(obj, path = '') {
        if (!obj || typeof obj !== 'object') return;
        for (const [key, val] of Object.entries(obj)) {
            const currentPath = path ? `${path}.${key}` : key;
            if (FORBIDDEN_PATTERN.test(key)) {
                throw ApiError.unprocessableEntity(
                    `Forbidden setting key: "${currentPath}"`,
                    'VALIDATION_ERROR',
                    [{ field: currentPath, message: 'Settings keys cannot contain sensitive keywords (token, secret, password, auth, private)' }]
                );
            }
            if (val && typeof val === 'object' && !Array.isArray(val)) {
                PolicyValidator.checkSensitiveKeys(val, currentPath);
            }
        }
    }
}

module.exports = PolicyValidator;
