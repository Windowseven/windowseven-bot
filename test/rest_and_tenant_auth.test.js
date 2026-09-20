const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const http = require('node:http');

const {
    UserRepository,
    RefreshTokenRepository,
    AuditLogRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
} = require('../src/repositories');
const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const { createRestApp } = require('../src/application/http/RestApp');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Phase 4C: REST Core & Tenant Authorization Middleware', () => {
    let pool;
    let userRepo, refreshTokenRepo, auditLogRepo, tenantRepo, tenantMembershipRepo, whatsAppConnectionRepo;
    let passwordService, tokenService, authService;
    let server, serverUrl;

    // Test identities and tokens
    let userOwnerA, tokenOwnerA;
    let userAdminA, tokenAdminA;
    let userMemberA, tokenMemberA;
    let userOwnerB, tokenOwnerB;
    let userNoTenants, tokenNoTenants;

    let tenantA, tenantB;
    let connectionA, connectionB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        whatsAppConnectionRepo = new WhatsAppConnectionRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'test-rest-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 300,
        });

        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            auditLogRepo,
            passwordService,
            tokenService,
            pool,
        });

        // Cleanup any stale test data from previous runs
        await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id IN (SELECT id FROM tenants WHERE name IN (\'Alpha Corp\', \'Beta Industries\', \'Delta Enterprises\'));');
        await pool.query('DELETE FROM tenant_memberships WHERE tenant_id IN (SELECT id FROM tenants WHERE name IN (\'Alpha Corp\', \'Beta Industries\', \'Delta Enterprises\'));');
        await pool.query('DELETE FROM tenants WHERE name IN (\'Alpha Corp\', \'Beta Industries\', \'Delta Enterprises\');');
        await pool.query('DELETE FROM audit_logs WHERE actor_user_id IN (SELECT id FROM users WHERE email LIKE $1);', ['%@tenanttest.com']);
        await pool.query('DELETE FROM refresh_tokens WHERE user_id IN (SELECT id FROM users WHERE email LIKE $1);', ['%@tenanttest.com']);
        await pool.query('DELETE FROM users WHERE email LIKE $1;', ['%@tenanttest.com']);

        // 1. Create test users
        const regOwnerA = await authService.register({ email: 'owner_a@tenanttest.com', password: 'Password123!@#' });
        userOwnerA = regOwnerA.user;
        tokenOwnerA = tokenService.createAccessToken({ userId: userOwnerA.id, email: userOwnerA.email });

        const regAdminA = await authService.register({ email: 'admin_a@tenanttest.com', password: 'Password123!@#' });
        userAdminA = regAdminA.user;
        tokenAdminA = tokenService.createAccessToken({ userId: userAdminA.id, email: userAdminA.email });

        const regMemberA = await authService.register({ email: 'member_a@tenanttest.com', password: 'Password123!@#' });
        userMemberA = regMemberA.user;
        tokenMemberA = tokenService.createAccessToken({ userId: userMemberA.id, email: userMemberA.email });

        const regOwnerB = await authService.register({ email: 'owner_b@tenanttest.com', password: 'Password123!@#' });
        userOwnerB = regOwnerB.user;
        tokenOwnerB = tokenService.createAccessToken({ userId: userOwnerB.id, email: userOwnerB.email });

        const regNoTenants = await authService.register({ email: 'notenants@tenanttest.com', password: 'Password123!@#' });
        userNoTenants = regNoTenants.user;
        tokenNoTenants = tokenService.createAccessToken({ userId: userNoTenants.id, email: userNoTenants.email });

        // 2. Create Tenant A with memberships
        tenantA = await tenantRepo.create({ name: 'Alpha Corp' });
        await tenantMembershipRepo.create({ tenantId: tenantA.id, userId: userOwnerA.id, role: 'OWNER' });
        await tenantMembershipRepo.create({ tenantId: tenantA.id, userId: userAdminA.id, role: 'ADMIN' });
        await tenantMembershipRepo.create({ tenantId: tenantA.id, userId: userMemberA.id, role: 'MEMBER' });

        // 3. Create Tenant B with memberships
        tenantB = await tenantRepo.create({ name: 'Beta Industries' });
        await tenantMembershipRepo.create({ tenantId: tenantB.id, userId: userOwnerB.id, role: 'OWNER' });

        // 4. Create connections for IDOR tests
        connectionA = await whatsAppConnectionRepo.createForTenant(tenantA.id, {
            phoneNumber: '255711111111',
            displayName: 'Alpha WhatsApp Bot',
            status: 'CONNECTED',
        });

        connectionB = await whatsAppConnectionRepo.createForTenant(tenantB.id, {
            phoneNumber: '255722222222',
            displayName: 'Beta WhatsApp Bot',
            status: 'CONNECTED',
        });

        // 5. Build REST HTTP Application
        const app = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo,
            userRepo,
            auditLogRepo,
            whatsAppConnectionRepo,
            allowedOrigins: ['http://localhost:3000', 'https://app.windowseven.com'],
            cookieOptions: { secure: false },
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
    });

    after(async () => {
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        // Cleanup test data
        await pool.query('DELETE FROM whatsapp_connections WHERE tenant_id IN ($1, $2);', [tenantA?.id, tenantB?.id]);
        await pool.query('DELETE FROM tenant_memberships WHERE tenant_id IN ($1, $2);', [tenantA?.id, tenantB?.id]);
        await pool.query('DELETE FROM tenants WHERE id IN ($1, $2);', [tenantA?.id, tenantB?.id]);
        await pool.query('DELETE FROM refresh_tokens;');
        await pool.query('DELETE FROM audit_logs;');
        await pool.query('DELETE FROM users WHERE email LIKE $1;', ['%@tenanttest.com']);
        await pool.end();
    });

    // Helper to send HTTP requests to test server
    async function request(method, path, { headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const reqUrl = new URL(path, serverUrl);
            const payload = body ? (typeof body === 'string' ? body : JSON.stringify(body)) : null;
            let responseReceived = false;

            const req = http.request(reqUrl, {
                method,
                headers: {
                    ...(payload ? {
                        'Content-Type': 'application/json',
                        'Content-Length': Buffer.byteLength(payload),
                    } : {}),
                    ...headers,
                },
            }, (res) => {
                responseReceived = true;
                let data = '';
                res.on('data', (chunk) => { data += chunk; });
                res.on('end', () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (e) { parsed = data; }
                    resolve({
                        status: res.statusCode,
                        headers: res.headers,
                        body: parsed,
                    });
                });
            });

            req.on('error', (err) => {
                if (responseReceived || err.code === 'ECONNRESET' || err.code === 'EPIPE') {
                    return;
                }
                reject(err);
            });

            if (payload) {
                req.write(payload);
            }
            req.end();
        });
    }

    // -------------------------------------------------------------
    // 1. REST HTTP Core & Protocol Standards
    // -------------------------------------------------------------
    describe('1. REST HTTP Core & Protocol Standards', () => {
        it('1.1 should handle 404 Route Not Found with standard error envelope', async () => {
            const res = await request('GET', '/api/v1/nonexistent/endpoint');
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.success, false);
            assert.strictEqual(res.body.error.code, 'ROUTE_NOT_FOUND');
            assert.ok(res.body.meta.requestId);
            assert.ok(res.body.meta.timestamp);
        });

        it('1.2 should return 405 Method Not Allowed with Allow header on unsupported method', async () => {
            // /health/live only supports GET
            const res = await request('POST', '/health/live');
            assert.strictEqual(res.status, 405);
            assert.strictEqual(res.body.error.code, 'METHOD_NOT_ALLOWED');
            assert.ok(res.headers.allow.includes('GET'));
        });

        it('1.3 should generate a valid X-Request-ID when header is missing', async () => {
            const res = await request('GET', '/health/live');
            assert.strictEqual(res.status, 200);
            assert.ok(res.headers['x-request-id'], 'Must include X-Request-ID header');
            assert.strictEqual(res.headers['x-request-id'], res.body.meta.requestId);
        });

        it('1.4 should preserve a valid client-provided X-Request-ID', async () => {
            const clientReqId = 'custom-client-req-id-12345';
            const res = await request('GET', '/health/live', {
                headers: { 'X-Request-ID': clientReqId },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers['x-request-id'], clientReqId);
            assert.strictEqual(res.body.meta.requestId, clientReqId);
        });

        it('1.5 should replace a malformed or oversized X-Request-ID with a fresh UUID', async () => {
            const oversizedId = 'A'.repeat(70); // Exceeds 64-char limit
            const res = await request('GET', '/health/live', {
                headers: { 'X-Request-ID': oversizedId },
            });
            assert.strictEqual(res.status, 200);
            assert.notStrictEqual(res.headers['x-request-id'], oversizedId);
            assert.strictEqual(res.headers['x-request-id'].length, 36, 'Should generate standard UUIDv4');
        });

        it('1.6 should reject oversized request payload exceeding 100KB with 413', async () => {
            const largeBody = { data: 'X'.repeat(105 * 1024) };
            const res = await request('POST', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
                body: largeBody,
            });
            assert.strictEqual(res.status, 413);
            assert.strictEqual(res.body.error.code, 'PAYLOAD_TOO_LARGE');
        });

        it('1.7 should reject malformed JSON with 400 MALFORMED_JSON', async () => {
            const res = await request('POST', '/api/v1/tenants', {
                headers: {
                    'Authorization': `Bearer ${tokenOwnerA}`,
                    'Content-Type': 'application/json',
                },
                body: '{ not valid json :::',
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'MALFORMED_JSON');
        });

        it('1.8 should serve live and ready health endpoints', async () => {
            const live = await request('GET', '/health/live');
            assert.strictEqual(live.status, 200);
            assert.strictEqual(live.body.data.status, 'alive');

            const ready = await request('GET', '/health/ready');
            assert.strictEqual(ready.status, 200);
            assert.strictEqual(ready.body.data.status, 'ready');
            assert.strictEqual(ready.body.data.database, 'connected');
        });
    });

    // -------------------------------------------------------------
    // 2. Authentication Boundary Integration
    // -------------------------------------------------------------
    describe('2. Authentication Boundary Integration', () => {
        it('2.1 should reject requests with missing Authorization header (401)', async () => {
            const res = await request('GET', '/api/v1/tenants');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('2.2 should reject requests with malformed Authorization header (401)', async () => {
            const res = await request('GET', '/api/v1/tenants', {
                headers: { 'Authorization': 'NotBearer token' },
            });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'TOKEN_INVALID');
        });

        it('2.3 should reject requests with an expired access token (401)', () => {
            const expiredToken = tokenService.createAccessToken({
                userId: userOwnerA.id,
                email: userOwnerA.email,
                extraClaims: { exp: Math.floor(Date.now() / 1000) - 10 },
            });

            return request('GET', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${expiredToken}` },
            }).then((res) => {
                assert.strictEqual(res.status, 401);
                assert.strictEqual(res.body.error.code, 'TOKEN_EXPIRED');
            });
        });

        it('2.4 should reject requests with a token signed by an untrusted key (401)', async () => {
            const rogueTokenService = new TokenService();
            const forgedToken = rogueTokenService.createAccessToken({
                userId: userOwnerA.id,
                email: userOwnerA.email,
            });

            const res = await request('GET', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${forgedToken}` },
            });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'TOKEN_INVALID');
        });
    });

    // -------------------------------------------------------------
    // 3. Tenant Creation & Transactional Integrity
    // -------------------------------------------------------------
    describe('3. Tenant Creation & Transactional Integrity', () => {
        it('3.1 should create a new tenant, assign creator as OWNER, and record audit log atomically', async () => {
            const res = await request('POST', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
                body: { name: 'Delta Enterprises' },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.tenant.name, 'Delta Enterprises');
            assert.strictEqual(res.body.data.membership.role, 'OWNER');

            const newTenantId = res.body.data.tenant.id;

            // Verify membership in DB
            const membership = await tenantMembershipRepo.findByTenantAndUser(newTenantId, userOwnerA.id);
            assert.strictEqual(membership.role, 'OWNER');

            // Verify audit log in DB
            const auditLogs = await auditLogRepo.listForTenant(newTenantId, { action: 'TENANT_CREATED' });
            assert.strictEqual(auditLogs.length, 1);
            assert.strictEqual(auditLogs[0].actor_user_id, userOwnerA.id);

            // Cleanup
            await tenantMembershipRepo.delete(newTenantId, userOwnerA.id);
            await tenantRepo.delete(newTenantId);
        });

        it('3.2 should reject tenant creation with invalid or empty name (400)', async () => {
            const res = await request('POST', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
                body: { name: '   ' },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });
    });

    // -------------------------------------------------------------
    // 4. Tenant Context & Membership Authorization
    // -------------------------------------------------------------
    describe('4. Tenant Context Resolution & Membership Verification', () => {
        it('4.1 should return user tenant list for authenticated user', async () => {
            const res = await request('GET', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.tenants));
            assert.ok(res.body.data.tenants.some((t) => t.id === tenantA.id));
        });

        it('4.2 should resolve tenant context when user is a valid member (200)', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}`, {
                headers: { 'Authorization': `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.tenant.id, tenantA.id);
            assert.strictEqual(res.body.data.tenant.currentUserRole, 'MEMBER');
        });

        it('4.3 should reject access with 403 TENANT_ACCESS_DENIED when user is not a member of tenant', async () => {
            // userOwnerB attempts to access Tenant A
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'TENANT_ACCESS_DENIED');

            // Verify security audit recorded for unauthorized access attempt
            const logs = await auditLogRepo.listForTenant(tenantA.id, { action: 'UNAUTHORIZED_TENANT_ACCESS_ATTEMPT' });
            assert.ok(logs.some((l) => l.actor_user_id === userOwnerB.id));
        });

        it('4.4 should return 404 TENANT_NOT_FOUND when tenant does not exist in database', async () => {
            const nonExistentTenantId = '00000000-0000-0000-0000-999999999999';
            const res = await request('GET', `/api/v1/tenants/${nonExistentTenantId}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'TENANT_NOT_FOUND');
        });

        it('4.5 should return 400 VALIDATION_ERROR on malformed tenant UUID', async () => {
            const res = await request('GET', '/api/v1/tenants/not-a-valid-uuid', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });
    });

    // -------------------------------------------------------------
    // 5. Hierarchical Role Authorization & Membership Lifecycle
    // -------------------------------------------------------------
    describe('5. Hierarchical Role Authorization & Member Management', () => {
        let tempUser;

        before(async () => {
            const reg = await authService.register({ email: 'temp_member@tenanttest.com', password: 'Password123!@#' });
            tempUser = reg.user;
        });

        after(async () => {
            await tenantMembershipRepo.delete(tenantA.id, tempUser.id);
        });

        it('5.1 MEMBER role can read members list', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenMemberA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.ok(Array.isArray(res.body.data.members));
            assert.ok(res.body.data.members.length >= 3);
        });

        it('5.2 MEMBER role is rejected from adding members (403 INSUFFICIENT_ROLE)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenMemberA}` },
                body: { email: 'temp_member@tenanttest.com', role: 'MEMBER' },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'INSUFFICIENT_ROLE');
        });

        it('5.3 ADMIN role cannot assign the OWNER role (403 FORBIDDEN)', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { email: 'temp_member@tenanttest.com', role: 'OWNER' },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'FORBIDDEN');
        });

        it('5.4 ADMIN role can add a new MEMBER', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { email: 'temp_member@tenanttest.com', role: 'MEMBER' },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.data.member.email, 'temp_member@tenanttest.com');
            assert.strictEqual(res.body.data.member.role, 'MEMBER');
        });

        it('5.5 should reject adding an already existing member with 409 CONFLICT', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { email: 'temp_member@tenanttest.com', role: 'MEMBER' },
            });

            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.error.code, 'MEMBERSHIP_ALREADY_EXISTS');
        });

        it('5.6 should reject adding non-existent email with 404 USER_NOT_FOUND', async () => {
            const res = await request('POST', `/api/v1/tenants/${tenantA.id}/members`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { email: 'doesnotexist_anywhere@tenanttest.com', role: 'MEMBER' },
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'USER_NOT_FOUND');
        });

        it('5.7 ADMIN role is rejected from modifying member roles (403 INSUFFICIENT_ROLE)', async () => {
            const res = await request('PATCH', `/api/v1/tenants/${tenantA.id}/members/${tempUser.id}`, {
                headers: { 'Authorization': `Bearer ${tokenAdminA}` },
                body: { role: 'ADMIN' },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'INSUFFICIENT_ROLE');
        });

        it('5.8 OWNER role can update a member role', async () => {
            const res = await request('PATCH', `/api/v1/tenants/${tenantA.id}/members/${tempUser.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
                body: { role: 'ADMIN' },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.member.role, 'ADMIN');
        });

        it('5.9 OWNER role can remove a member', async () => {
            const res = await request('DELETE', `/api/v1/tenants/${tenantA.id}/members/${tempUser.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.success, true);

            // Verify removed in DB
            const check = await tenantMembershipRepo.findByTenantAndUser(tenantA.id, tempUser.id);
            assert.strictEqual(check, null);
        });
    });

    // -------------------------------------------------------------
    // 6. Sole OWNER Concurrency & Invariant Protection
    // -------------------------------------------------------------
    describe('6. Sole OWNER Concurrency & Invariant Protection', () => {
        it('6.1 should reject demoting the sole OWNER of a tenant (400 SOLE_OWNER_REQUIRED)', async () => {
            const res = await request('PATCH', `/api/v1/tenants/${tenantB.id}/members/${userOwnerB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
                body: { role: 'ADMIN' },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'SOLE_OWNER_REQUIRED');
        });

        it('6.2 should reject removing the sole OWNER of a tenant (400 SOLE_OWNER_REQUIRED)', async () => {
            const res = await request('DELETE', `/api/v1/tenants/${tenantB.id}/members/${userOwnerB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'SOLE_OWNER_REQUIRED');
        });

        it('6.3 Concurrency: simultaneous demotion requests on sole OWNER must all be rejected', async () => {
            // Attempt 2 concurrent demotions of userOwnerB
            const [r1, r2] = await Promise.all([
                request('PATCH', `/api/v1/tenants/${tenantB.id}/members/${userOwnerB.id}`, {
                    headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
                    body: { role: 'MEMBER' },
                }),
                request('PATCH', `/api/v1/tenants/${tenantB.id}/members/${userOwnerB.id}`, {
                    headers: { 'Authorization': `Bearer ${tokenOwnerB}` },
                    body: { role: 'MEMBER' },
                }),
            ]);

            assert.strictEqual(r1.status, 400);
            assert.strictEqual(r2.status, 400);
            assert.strictEqual(r1.body.error.code, 'SOLE_OWNER_REQUIRED');
            assert.strictEqual(r2.body.error.code, 'SOLE_OWNER_REQUIRED');

            // Invariant verified: user remains OWNER in DB
            const check = await tenantMembershipRepo.findByTenantAndUser(tenantB.id, userOwnerB.id);
            assert.strictEqual(check.role, 'OWNER');
        });
    });

    // -------------------------------------------------------------
    // 7. Resource Ownership & IDOR Protection (Cases A - F)
    // -------------------------------------------------------------
    describe('7. Resource Ownership & IDOR Protection (Cases A - F)', () => {
        it('Case A: User in Tenant A requests Tenant A resource -> 200 OK', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connectionA.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.connection.id, connectionA.id);
            assert.strictEqual(res.body.data.connection.tenant_id, tenantA.id);
        });

        it('Case B: User in Tenant A requests Tenant B path -> 403 TENANT_ACCESS_DENIED', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantB.id}/connections/${connectionB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'TENANT_ACCESS_DENIED');
        });

        it('Case C: User with no membership requests Tenant A resource -> 403 TENANT_ACCESS_DENIED', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connectionA.id}`, {
                headers: { 'Authorization': `Bearer ${tokenNoTenants}` },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'TENANT_ACCESS_DENIED');
        });

        it('Case D: User in Tenant A requests connection belonging to Tenant B via Tenant A path -> 404 RESOURCE_NOT_FOUND', async () => {
            // IDOR Attempt: swapping resource ID to access Tenant B's connection while in Tenant A context
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections/${connectionB.id}`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'RESOURCE_NOT_FOUND');
            assert.strictEqual(res.body.error.message, 'Connection not found');
        });

        it('Case E: Manipulated tenant ID is verified against authenticated user membership', async () => {
            // Try accessing non-existent or foreign tenant ID
            const foreignTenantId = '00000000-0000-0000-0000-111111111111';
            const res = await request('GET', `/api/v1/tenants/${foreignTenantId}/connections`, {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
            });

            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, 'TENANT_NOT_FOUND');
        });

        it('Case F: Unauthenticated request to tenant resource -> 401 AUTH_REQUIRED', async () => {
            const res = await request('GET', `/api/v1/tenants/${tenantA.id}/connections`);
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('Repository-Level Verification: findByIdForTenant strictly enforces tenant isolation in SQL', async () => {
            // Direct repository query with mismatched tenant_id must return null
            const foundCrossTenant = await whatsAppConnectionRepo.findByIdForTenant(connectionB.id, tenantA.id);
            assert.strictEqual(foundCrossTenant, null, 'Repository must return null when tenant_id does not match');

            // Correct tenant_id returns resource
            const foundCorrect = await whatsAppConnectionRepo.findByIdForTenant(connectionB.id, tenantB.id);
            assert.ok(foundCorrect);
            assert.strictEqual(foundCorrect.id, connectionB.id);
        });
    });

    // -------------------------------------------------------------
    // 8. Security & Secret Hygiene
    // -------------------------------------------------------------
    describe('8. Security & Secret Hygiene', () => {
        it('8.1 should never expose database errors, SQL strings, or stack traces in response', async () => {
            // Send request with an invalid syntax that triggers an internal error or validation error
            const res = await request('POST', '/api/v1/tenants', {
                headers: { 'Authorization': `Bearer ${tokenOwnerA}` },
                body: { name: null },
            });

            const bodyStr = JSON.stringify(res.body);
            assert.ok(!bodyStr.includes('SELECT'), 'Must never leak SQL query');
            assert.ok(!bodyStr.includes('INSERT'), 'Must never leak SQL query');
            assert.ok(!bodyStr.includes('stack'), 'Must never leak stack trace');
            assert.ok(!bodyStr.includes('/Users/'), 'Must never leak filesystem path');
        });

        it('8.2 should record audit logs for critical tenant lifecycle events', async () => {
            const logs = await auditLogRepo.listForTenant(tenantA.id, { limit: 50 });
            const actions = logs.map((l) => l.action);

            assert.ok(actions.includes('MEMBER_ADDED'), 'Must audit MEMBER_ADDED');
            assert.ok(actions.includes('MEMBER_ROLE_UPDATED'), 'Must audit MEMBER_ROLE_UPDATED');
            assert.ok(actions.includes('MEMBER_REMOVED'), 'Must audit MEMBER_REMOVED');
            assert.ok(actions.includes('UNAUTHORIZED_TENANT_ACCESS_ATTEMPT'), 'Must audit UNAUTHORIZED_TENANT_ACCESS_ATTEMPT');
        });
    });
});
