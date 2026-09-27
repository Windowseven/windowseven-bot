#!/usr/bin/env node
/**
 * Windowseven MD Platform Administrator Provisioning CLI
 * Safely provisions or elevates a platform administrator offline.
 *
 * Usage:
 *   node scripts/create_platform_admin.js --email admin@example.com [--role SUPER_ADMIN|PLATFORM_ADMIN] [--password <secret>]
 */

const { Pool } = require('pg');
const UserRepository = require('../src/repositories/UserRepository');
const PlatformRoleRepository = require('../src/repositories/PlatformRoleRepository');
const PasswordService = require('../src/application/services/PasswordService');

function parseArgs() {
    const args = process.argv.slice(2);
    const params = {};
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '--email' && args[i + 1]) {
            params.email = args[++i];
        } else if (args[i] === '--role' && args[i + 1]) {
            params.role = args[++i].toUpperCase();
        } else if (args[i] === '--password' && args[i + 1]) {
            params.password = args[++i];
        }
    }
    return params;
}

async function main() {
    const { email, role = 'SUPER_ADMIN', password } = parseArgs();

    if (!email) {
        console.error('Error: --email is required.');
        console.error('Usage: node scripts/create_platform_admin.js --email <email> [--role SUPER_ADMIN|PLATFORM_ADMIN] [--password <secret>]');
        process.exit(1);
    }

    const validRoles = ['PLATFORM_ADMIN', 'SUPER_ADMIN'];
    if (!validRoles.includes(role)) {
        console.error(`Error: Invalid role "${role}". Valid roles: ${validRoles.join(', ')}`);
        process.exit(1);
    }

    const dbUrl = process.env.DATABASE_URL || process.env.TEST_DATABASE_URL || 'postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_dev';
    const pool = new Pool({ connectionString: dbUrl });

    try {
        const userRepo = new UserRepository(pool);
        const platformRoleRepo = new PlatformRoleRepository(pool);
        const passwordService = new PasswordService();

        let user = await userRepo.findByEmail(email);

        if (!user) {
            if (!password) {
                console.error(`Error: User with email "${email}" does not exist. Please provide --password to create the user.`);
                process.exit(1);
            }

            const policyCheck = passwordService.validatePolicy(password);
            if (!policyCheck.valid) {
                console.error(`Error: Password policy violation: ${policyCheck.error}`);
                process.exit(1);
            }

            const passwordHash = await passwordService.hash(password);
            user = await userRepo.create({ email, passwordHash });
            console.log(`[Provisioning] Created new user: ${user.id} (${email})`);
        } else {
            console.log(`[Provisioning] Found existing user: ${user.id} (${email})`);
        }

        const assignment = await platformRoleRepo.assignRole({
            userId: user.id,
            role,
            assignedBy: null,
        });

        console.log(`[Provisioning] Successfully assigned role ${role} to user ${email}:`);
        console.log(`  Role Assignment ID: ${assignment.id}`);
        console.log(`  User ID:            ${user.id}`);
        console.log(`  Assigned Role:      ${assignment.role}`);
        console.log(`  Timestamp:          ${assignment.created_at}`);
    } catch (err) {
        console.error('[Provisioning] Error provisioning platform admin:', err.message);
        process.exit(1);
    } finally {
        await pool.end();
    }
}

if (require.main === module) {
    main();
}

module.exports = { main };
