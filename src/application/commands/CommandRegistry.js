class CommandRegistry {
    constructor() {
        this.commands = new Map();
        this.aliases = new Map();
    }

    /**
     * Registers a command handler.
     * @param {import('./CommandHandler')} handler
     */
    register(handler) {
        if (!handler || !handler.name) {
            throw new Error('[CommandRegistry] Invalid command handler');
        }
        this.commands.set(handler.name, handler);
        for (const alias of handler.aliases) {
            this.aliases.set(alias, handler);
        }
    }

    /**
     * Finds a command handler by name or alias.
     * @param {string} commandName
     * @returns {import('./CommandHandler')|null}
     */
    find(commandName) {
        if (!commandName) return null;
        const normalized = commandName.toLowerCase().trim();
        return this.commands.get(normalized) || this.aliases.get(normalized) || null;
    }

    /**
     * Returns whether a command name or alias is registered in the migrated application registry.
     * @param {string} commandName
     * @returns {boolean}
     */
    isMigrated(commandName) {
        return this.find(commandName) !== null;
    }

    /**
     * Returns a list of all registered primary command names.
     * @returns {Array<string>}
     */
    getMigratedNames() {
        return Array.from(this.commands.keys());
    }
}

module.exports = CommandRegistry;
