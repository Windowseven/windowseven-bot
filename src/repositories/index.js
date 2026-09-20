const UserRepository = require('./UserRepository');
const TenantRepository = require('./TenantRepository');
const TenantMembershipRepository = require('./TenantMembershipRepository');
const WhatsAppConnectionRepository = require('./WhatsAppConnectionRepository');
const GroupRepository = require('./GroupRepository');
const GroupPolicyRepository = require('./GroupPolicyRepository');
const GroupWarningRepository = require('./GroupWarningRepository');

const WhatsAppAuthCredentialsRepository = require('./WhatsAppAuthCredentialsRepository');
const WhatsAppAuthKeysRepository = require('./WhatsAppAuthKeysRepository');

const RefreshTokenRepository = require('./RefreshTokenRepository');
const AuditLogRepository = require('./AuditLogRepository');
const WorkerRepository = require('./WorkerRepository');
const { IdempotencyRepository, computeRequestHash } = require('./IdempotencyRepository');
const ConnectionCommandRepository = require('./ConnectionCommandRepository');
const ScheduledModerationTaskRepository = require('./ScheduledModerationTaskRepository');

module.exports = {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    WhatsAppAuthCredentialsRepository,
    WhatsAppAuthKeysRepository,
    RefreshTokenRepository,
    AuditLogRepository,
    WorkerRepository,
    IdempotencyRepository,
    computeRequestHash,
    ConnectionCommandRepository,
    ScheduledModerationTaskRepository,
};
