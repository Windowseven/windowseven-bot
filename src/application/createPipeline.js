const GroupRepository = require('../repositories/GroupRepository');
const GroupPolicyRepository = require('../repositories/GroupPolicyRepository');
const GroupWarningRepository = require('../repositories/GroupWarningRepository');

const WhatsAppModerationGateway = require('../gateways/WhatsAppModerationGateway');
const WarningService = require('./services/WarningService');
const ModerationService = require('./services/ModerationService');
const PolicyEngine = require('./policies/PolicyEngine');
const CommandRegistry = require('./commands/CommandRegistry');
const ApplicationPipeline = require('./pipeline/ApplicationPipeline');

// Migrated Commands
const WarnCommand = require('./commands/moderation/WarnCommand');
const WarningsCommand = require('./commands/moderation/WarningsCommand');
const ResetWarnCommand = require('./commands/moderation/ResetWarnCommand');
const AntilinkCommand = require('./commands/moderation/AntilinkCommand');
const MuteCommand = require('./commands/moderation/MuteCommand');
const UnmuteCommand = require('./commands/moderation/UnmuteCommand');
const KickCommand = require('./commands/moderation/KickCommand');
const PromoteCommand = require('./commands/moderation/PromoteCommand');
const DemoteCommand = require('./commands/moderation/DemoteCommand');

/**
 * Creates and wires an ApplicationPipeline for a specific Baileys socket and database pool.
 *
 * @param {object} params
 * @param {import('pg').Pool} params.pool
 * @param {object} params.socket - Baileys socket instance
 * @returns {ApplicationPipeline}
 */
function createPipeline({ pool, socket }) {
    if (!pool || !socket) {
        throw new Error('[createPipeline] Database pool and Baileys socket are required');
    }

    const groupRepo = new GroupRepository(pool);
    const policyRepo = new GroupPolicyRepository(pool);
    const warningRepo = new GroupWarningRepository(pool);

    const gateway = new WhatsAppModerationGateway(socket);
    const warningService = new WarningService({ warningRepo, policyRepo });
    const moderationService = new ModerationService({ gateway });
    const policyEngine = new PolicyEngine();

    const commandRegistry = new CommandRegistry();
    commandRegistry.register(new WarnCommand());
    commandRegistry.register(new WarningsCommand());
    commandRegistry.register(new ResetWarnCommand());
    commandRegistry.register(new AntilinkCommand());
    commandRegistry.register(new MuteCommand());
    commandRegistry.register(new UnmuteCommand());
    commandRegistry.register(new KickCommand());
    commandRegistry.register(new PromoteCommand());
    commandRegistry.register(new DemoteCommand());

    return new ApplicationPipeline({
        groupRepo,
        policyRepo,
        warningRepo,
        warningService,
        moderationService,
        policyEngine,
        commandRegistry,
        gateway,
    });
}

module.exports = { createPipeline };
