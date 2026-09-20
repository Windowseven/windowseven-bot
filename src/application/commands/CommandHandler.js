class CommandHandler {
    /**
     * @param {object} options
     * @param {string} options.name
     * @param {Array<string>} [options.aliases]
     * @param {'READ'|'CONFIGURE'|'MODERATE'|'ADMIN_ACTION'} [options.category]
     * @param {boolean} [options.requireGroup]
     * @param {boolean} [options.requireSenderAdmin]
     * @param {boolean} [options.requireBotAdmin]
     */
    constructor({
        name,
        aliases = [],
        description = '',
        category = 'READ',
        requireGroup = true,
        requireSenderAdmin = false,
        requireBotAdmin = false,
    }) {
        if (!name) throw new Error('[CommandHandler] Command name is required');
        const validCategories = ['READ', 'CONFIGURE', 'MODERATE', 'ADMIN_ACTION'];
        if (!validCategories.includes(category)) {
            throw new Error(`[CommandHandler] Invalid category: ${category}. Expected one of: ${validCategories.join(', ')}`);
        }
        this.name = name.toLowerCase();
        this.aliases = aliases.map((a) => a.toLowerCase());
        this.description = description;
        this.category = category;
        this.requireGroup = Boolean(requireGroup);
        this.requireSenderAdmin = Boolean(requireSenderAdmin);
        this.requireBotAdmin = Boolean(requireBotAdmin);
    }

    /**
     * Executes the command. Subclasses must implement this.
     * @param {import('../context/ApplicationContext')} appCtx
     * @param {object} services - Injected domain services { warningService, moderationService, policyRepo, ... }
     * @returns {Promise<{ success: boolean, message?: string, error?: string }>}
     */
    async execute(appCtx, services) {
        throw new Error(`[CommandHandler] execute() must be implemented by ${this.constructor.name}`);
    }
}

module.exports = CommandHandler;
