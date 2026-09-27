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
const PlatformRoleRepository = require('./PlatformRoleRepository');
const PlatformAuditRepository = require('./PlatformAuditRepository');
const { PlatformIdempotencyRepository, computePlatformRequestHash } = require('./PlatformIdempotencyRepository');
const PlanRepository = require('./PlanRepository');
const SubscriptionRepository = require('./SubscriptionRepository');
const PaymentRepository = require('./PaymentRepository');

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
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    computePlatformRequestHash,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
};
