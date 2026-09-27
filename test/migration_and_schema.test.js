const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { migrateUp, migrateDown, getMigrationStatus } = require('../src/database/migrator');
const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    GroupRepository,
    GroupPolicyRepository,
} = require('../src/repositories');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Database Migrations & Relational Schema Foundation', () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let groupRepo;
    let policyRepo;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        groupRepo = new GroupRepository(pool);
        policyRepo = new GroupPolicyRepository(pool);
    });

    after(async () => {
        await pool.end();
    });

    it('should verify migration UP -> DOWN -> UP lifecycle reproducibility', async () => {
        // Rollback any existing state
        await migrateDown(pool, 11);
        const statusDown = await getMigrationStatus(pool);
        assert.ok(statusDown.every((s) => !s.applied), 'All migrations should be reverted');

        // Apply all migrations UP
        const appliedFirst = await migrateUp(pool);
        assert.strictEqual(appliedFirst.length, 10);
        assert.deepStrictEqual(appliedFirst, [
            '001_initial_schema',
            '002_whatsapp_auth',
            '003_group_warnings',
            '004_api_auth_and_audit',
            '005_connection_lifecycle_and_worker_ownership',
            '006_policy_moderation_and_durable_commands',
            '007_worker_fencing_and_remote_outcomes',
            '008_platform_administration',
            '009_admin_business_layer',
            '010_customer_connection_unique',
        ]);

        const statusUp = await getMigrationStatus(pool);
        assert.ok(statusUp.every((s) => s.applied), 'All migrations should be applied');

        // Rollback DOWN 1 step (rolls back 010_customer_connection_unique)
        const rolledBack = await migrateDown(pool, 1);
        assert.strictEqual(rolledBack.length, 1);
        assert.strictEqual(rolledBack[0], '010_customer_connection_unique');

        // Verify status shows 001-009 applied, 010 pending
        const statusPartial = await getMigrationStatus(pool);
        const mapPartial = new Map(statusPartial.map((s) => [s.name, s.applied]));
        assert.strictEqual(mapPartial.get('001_initial_schema'), true);
        assert.strictEqual(mapPartial.get('002_whatsapp_auth'), true);
        assert.strictEqual(mapPartial.get('003_group_warnings'), true);
        assert.strictEqual(mapPartial.get('004_api_auth_and_audit'), true);
        assert.strictEqual(mapPartial.get('005_connection_lifecycle_and_worker_ownership'), true);
        assert.strictEqual(mapPartial.get('006_policy_moderation_and_durable_commands'), true);
        assert.strictEqual(mapPartial.get('007_worker_fencing_and_remote_outcomes'), true);
        assert.strictEqual(mapPartial.get('008_platform_administration'), true);
        assert.strictEqual(mapPartial.get('009_admin_business_layer'), true);
        assert.strictEqual(mapPartial.get('010_customer_connection_unique'), false);

        // Re-apply UP again to leave database ready for tests
        const appliedSecond = await migrateUp(pool);
        assert.strictEqual(appliedSecond.length, 1);
        assert.strictEqual(appliedSecond[0], '010_customer_connection_unique');
    });

    it('should create users and enforce case-insensitive email uniqueness at DB level', async () => {
        // Clean table
        await pool.query('DELETE FROM users;');

        // Create initial user
        const user1 = await userRepo.create({ email: 'Junior@example.com' });
        assert.ok(user1.id);
        assert.strictEqual(user1.email, 'Junior@example.com');

        // Attempt duplicate with different casing (junior@example.com)
        await assert.rejects(
            async () => {
                await userRepo.create({ email: 'junior@example.com' });
            },
            (err) => {
                // PostgreSQL code 23505 = unique_violation
                return err.code === '23505' || err.message.includes('unique');
            },
            'Database must reject case-insensitive duplicate email'
        );

        // Case-insensitive lookup succeeds
        const found = await userRepo.findByEmail('JUNIOR@EXAMPLE.COM');
        assert.ok(found);
        assert.strictEqual(found.id, user1.id);
    });

    it('should enforce Tenant entity creation and validation', async () => {
        await pool.query('DELETE FROM tenants CASCADE;');

        const tenant = await tenantRepo.create({ name: 'Acme Logistics' });
        assert.ok(tenant.id);
        assert.strictEqual(tenant.name, 'Acme Logistics');

        const fetched = await tenantRepo.findById(tenant.id);
        assert.strictEqual(fetched.name, 'Acme Logistics');

        const updated = await tenantRepo.update(tenant.id, { name: 'Acme Global' });
        assert.strictEqual(updated.name, 'Acme Global');

        await assert.rejects(async () => {
            await tenantRepo.create({ name: '' });
        }, /name is required/);
    });

    it('should enforce TenantMembership unique constraint and role validation', async () => {
        const user = await userRepo.create({ email: 'owner@acme.com' });
        const tenant = await tenantRepo.create({ name: 'Membership Test Workspace' });

        // Create valid membership
        const membership = await membershipRepo.create({
            tenantId: tenant.id,
            userId: user.id,
            role: 'OWNER',
        });
        assert.strictEqual(membership.role, 'OWNER');

        // Duplicate membership for same user in same tenant must fail
        await assert.rejects(
            async () => {
                await membershipRepo.create({
                    tenantId: tenant.id,
                    userId: user.id,
                    role: 'ADMIN',
                });
            },
            (err) => err.code === '23505'
        );

        // Invalid role must be rejected by CHECK constraint
        await assert.rejects(
            async () => {
                await membershipRepo.create({
                    tenantId: tenant.id,
                    userId: (await userRepo.create({ email: 'other@acme.com' })).id,
                    role: 'SUPER_ADMIN_INVALID',
                });
            },
            /Invalid role/
        );
    });

    it('should enforce WhatsAppConnection status constraints and tenant association', async () => {
        const tenant = await tenantRepo.create({ name: 'Connection Test Tenant' });

        const conn = await connRepo.createForTenant(tenant.id, {
            phoneNumber: '255712345678',
            displayName: 'Support Bot',
            status: 'CREATED',
        });
        assert.strictEqual(conn.tenant_id, tenant.id);
        assert.strictEqual(conn.status, 'CREATED');

        // Update status to CONNECTED
        const updated = await connRepo.updateStatusForTenant(conn.id, tenant.id, 'CONNECTED');
        assert.strictEqual(updated.status, 'CONNECTED');

        // Invalid status rejected
        await assert.rejects(async () => {
            await connRepo.createForTenant(tenant.id, { status: 'UNKNOWN_STATUS' });
        }, /Invalid status/);
    });

    it('should enforce composite foreign key rejecting mismatched Tenant and Connection on Group', async () => {
        // Tenant A with Connection A
        const tenantA = await tenantRepo.create({ name: 'Tenant A' });
        const connA = await connRepo.createForTenant(tenantA.id, { displayName: 'Conn A' });

        // Tenant B with Connection B
        const tenantB = await tenantRepo.create({ name: 'Tenant B' });
        const connB = await connRepo.createForTenant(tenantB.id, { displayName: 'Conn B' });

        // Legal insert: Tenant A owns Conn A, creating Group under Tenant A + Conn A succeeds
        const legalGroup = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000001@g.us',
            name: 'Legal Group A',
        });
        assert.ok(legalGroup.id);
        assert.strictEqual(legalGroup.tenant_id, tenantA.id);

        // ILLEGAL insert: Attempting to insert a Group with Tenant A but Connection B!
        // The composite foreign key (tenant_id, connection_id) -> whatsapp_connections(tenant_id, id)
        // MUST be rejected by PostgreSQL at the engine level (code 23503)
        await assert.rejects(
            async () => {
                await pool.query(
                    `INSERT INTO groups (tenant_id, connection_id, whatsapp_jid, name)
                     VALUES ($1, $2, $3, $4);`,
                    [tenantA.id, connB.id, '120363000000000002@g.us', 'Mismatched Group']
                );
            },
            (err) => {
                return err.code === '23503' && err.message.includes('fk_groups_connection_tenant');
            },
            'PostgreSQL must reject mismatched (tenant_id, connection_id) composite foreign key'
        );
    });

    it('should enforce composite foreign key rejecting mismatched Tenant and Group on GroupPolicy', async () => {
        const tenantA = await tenantRepo.create({ name: 'Tenant A Policy Test' });
        const connA = await connRepo.createForTenant(tenantA.id, { displayName: 'Conn A' });
        const groupA = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000003@g.us',
            name: 'Group A Policy',
        });

        const tenantB = await tenantRepo.create({ name: 'Tenant B Policy Test' });

        // Legal policy insert
        const legalPolicy = await policyRepo.upsertForTenant(tenantA.id, groupA.id, {
            antilinkEnabled: true,
            antilinkAction: 'kick',
            maxWarnings: 5,
        });
        assert.strictEqual(legalPolicy.tenant_id, tenantA.id);
        assert.strictEqual(legalPolicy.antilink_action, 'kick');
        assert.strictEqual(legalPolicy.max_warnings, 5);

        // Create a second group under Tenant A that has no policy yet
        const groupA2 = await groupRepo.upsertDiscoveredGroup(tenantA.id, connA.id, {
            whatsappJid: '120363000000000004@g.us',
            name: 'Group A2 Policy Test',
        });

        // ILLEGAL policy insert: Tenant B attempting to create policy for Tenant A's Group A2!
        // The composite foreign key (tenant_id, group_id) -> groups(tenant_id, id)
        // MUST be rejected by PostgreSQL at the engine level (code 23503)
        await assert.rejects(
            async () => {
                await pool.query(
                    `INSERT INTO group_policies (tenant_id, group_id, antilink_enabled)
                     VALUES ($1, $2, $3);`,
                    [tenantB.id, groupA2.id, true]
                );
            },
            (err) => {
                return err.code === '23503' && err.message.includes('fk_group_policies_group_tenant');
            },
            'PostgreSQL must reject mismatched (tenant_id, group_id) composite foreign key'
        );
    });

    it('should enforce Phase 4E Group↔Connection composite foreign key constraint and new tables', async () => {
        const tenant1 = await tenantRepo.create({ name: 'Tenant 1 Invariant' });
        const tenant2 = await tenantRepo.create({ name: 'Tenant 2 Invariant' });
        const conn1 = await connRepo.createForTenant(tenant1.id, { displayName: 'Conn 1' });
        const conn2 = await connRepo.createForTenant(tenant2.id, { displayName: 'Conn 2' });

        const group1 = await groupRepo.upsertDiscoveredGroup(tenant1.id, conn1.id, {
            whatsappJid: '120363000000000099@g.us',
            name: 'Group 1 on Conn 1',
        });

        // Legal insert into connection_commands matching tenant, connection, and group
        const resLegal = await pool.query(
            `INSERT INTO connection_commands (tenant_id, connection_id, group_id, command_type, payload)
             VALUES ($1, $2, $3, 'MUTE_GROUP', '{"durationMinutes": 10}'::jsonb)
             RETURNING id, command_type, status;`,
            [tenant1.id, conn1.id, group1.id]
        );
        assert.strictEqual(resLegal.rows.length, 1);
        assert.strictEqual(resLegal.rows[0].status, 'PENDING');

        // ILLEGAL insert: group1 belongs to conn1, but command specifies conn2!
        // The composite foreign key (tenant_id, connection_id, group_id) -> groups(tenant_id, connection_id, id)
        // MUST be rejected by PostgreSQL (code 23503)
        await assert.rejects(
            async () => {
                await pool.query(
                    `INSERT INTO connection_commands (tenant_id, connection_id, group_id, command_type, payload)
                     VALUES ($1, $2, $3, 'MUTE_GROUP', '{"durationMinutes": 10}'::jsonb);`,
                    [tenant1.id, conn2.id, group1.id]
                );
            },
            (err) => {
                return (err.code === '23503' && err.message.includes('fk_connection_commands_group')) || err.code === '23503';
            },
            'PostgreSQL must reject command linking Group 1 to mismatched Connection 2'
        );

        // Verify api_idempotency_keys uniqueness on (tenant_id, user_id, idempotency_key)
        const testUser = await userRepo.create({ email: 'idemp_user@example.com' });
        await pool.query(
            `INSERT INTO api_idempotency_keys (tenant_id, user_id, idempotency_key, request_hash)
             VALUES ($1, $2, 'key-123', 'hash-abc');`,
            [tenant1.id, testUser.id]
        );

        await assert.rejects(
            async () => {
                await pool.query(
                    `INSERT INTO api_idempotency_keys (tenant_id, user_id, idempotency_key, request_hash)
                     VALUES ($1, $2, 'key-123', 'hash-different');`,
                    [tenant1.id, testUser.id]
                );
            },
            (err) => err.code === '23505',
            'PostgreSQL must reject duplicate idempotency key for same tenant and user'
        );
    });
});
