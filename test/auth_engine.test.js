const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const http = require('node:http');

const {
    UserRepository,
    RefreshTokenRepository,
    AuditLogRepository,
} = require('../src/repositories');
const PasswordService = require('../src/application/services/PasswordService');
const TokenService = require('../src/application/services/TokenService');
const AuthService = require('../src/application/services/AuthService');
const AuthError = require('../src/application/errors/AuthError');
const { createRateLimiter } = require('../src/application/middleware/rateLimiter');
const { createAuthMiddleware } = require('../src/application/middleware/authMiddleware');
const { createAuthHandler, parseCookies } = require('../src/application/http/AuthHandler');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Phase 4B: Authentication Engine & User Identity', () => {
    let pool;
    let userRepo, refreshTokenRepo, auditLogRepo;
    let passwordService, tokenService, authService;
    let server, serverUrl;
    let rateLimiter;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            keyId: 'test-kid',
            issuer: 'windowseven-test-auth',
            audience: 'windowseven-test-api',
            accessTokenTtlSeconds: 2, // 2 seconds for expiration testing
            refreshTokenTtlSeconds: 10,
        });

        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            auditLogRepo,
            passwordService,
            tokenService,
            pool,
        });

        rateLimiter = createRateLimiter({
            windowMs: 1000,
            maxRequests: 5,
        });

        const handler = createAuthHandler({
            authService,
            tokenService,
            rateLimiter,
            cookieOptions: { secure: false }, // HTTP for local testing
            allowedOrigins: ['http://localhost:3000', 'https://app.windowseven.com'],
        });

        server = http.createServer(handler);
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
        const addr = server.address();
        serverUrl = `http://127.0.0.1:${addr.port}`;
    });

    after(async () => {
        if (rateLimiter) rateLimiter.destroy();
        if (server) {
            await new Promise((resolve) => server.close(resolve));
        }
        // Cleanup test data
        await pool.query('DELETE FROM refresh_tokens;');
        await pool.query('DELETE FROM audit_logs;');
        await pool.query('DELETE FROM users WHERE email LIKE $1;', ['%@testauth.com']);
        await pool.end();
    });

    beforeEach(async () => {
        if (rateLimiter) rateLimiter.reset();
    });

    // Helper to send HTTP requests to test server
    async function request(method, path, { headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const reqUrl = new URL(path, serverUrl);
            const req = http.request(reqUrl, {
                method,
                headers: {
                    ...(body ? { 'Content-Type': 'application/json' } : {}),
                    ...headers,
                },
            }, (res) => {
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
            req.on('error', reject);
            if (body) {
                req.write(typeof body === 'string' ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    // -------------------------------------------------------------
    // 1. Password Security (Argon2id)
    // -------------------------------------------------------------
    describe('1. Password Hashing & Verification (Argon2id)', () => {
        it('1.1 should enforce password policy (length and character classes)', () => {
            assert.strictEqual(passwordService.validatePolicy('short').valid, false);
            assert.strictEqual(passwordService.validatePolicy('alllowercase123!').valid, false);
            assert.strictEqual(passwordService.validatePolicy('ALLUPPERCASE123!').valid, false);
            assert.strictEqual(passwordService.validatePolicy('NoSpecial12345').valid, false);
            assert.strictEqual(passwordService.validatePolicy('ValidPassword123!').valid, true);
            // Long passphrase (>= 18 chars) is valid
            assert.strictEqual(passwordService.validatePolicy('correct horse battery staple').valid, true);
        });

        it('1.2 should hash passwords using Argon2id and verify in constant time', async () => {
            const plain = 'StrongPass123!@#';
            const hash = await passwordService.hash(plain);
            assert.ok(hash.startsWith('$argon2id$'), 'Must use Argon2id format');

            const match = await passwordService.verify(hash, plain);
            assert.strictEqual(match, true);

            const wrong = await passwordService.verify(hash, 'WrongPassword123!');
            assert.strictEqual(wrong, false);
        });

        it('1.3 should safely return false on malformed hashes without crashing', async () => {
            const result = await passwordService.verify('not-a-valid-hash', 'password');
            assert.strictEqual(result, false);
        });
    });

    // -------------------------------------------------------------
    // 2. JWT Service (EdDSA / Ed25519)
    // -------------------------------------------------------------
    describe('2. JWT Signing & Verification (EdDSA / Ed25519)', () => {
        it('2.1 should sign an access token with EdDSA and verify claims', () => {
            const token = tokenService.createAccessToken({
                userId: '00000000-0000-0000-0000-000000000001',
                email: 'user1@testauth.com',
            });

            const decoded = tokenService.verifyAccessToken(token);
            assert.strictEqual(decoded.valid, true);
            assert.strictEqual(decoded.payload.sub, '00000000-0000-0000-0000-000000000001');
            assert.strictEqual(decoded.payload.email, 'user1@testauth.com');
            assert.strictEqual(decoded.payload.type, 'access');
            assert.strictEqual(decoded.payload.iss, 'windowseven-test-auth');
            assert.strictEqual(decoded.payload.aud, 'windowseven-test-api');
        });

        it('2.2 should reject expired access tokens', async () => {
            const token = tokenService.createAccessToken({
                userId: '00000000-0000-0000-0000-000000000001',
                email: 'user1@testauth.com',
            });

            // Wait 2.1s for token to expire (TTL was configured to 2s)
            await new Promise((r) => setTimeout(r, 2100));

            const decoded = tokenService.verifyAccessToken(token);
            assert.strictEqual(decoded.valid, false);
            assert.ok(decoded.error.includes('expired'), 'Should detect expired token');
        });

        it('2.3 should reject tampered access tokens (signature verification failure)', () => {
            const token = tokenService.createAccessToken({
                userId: '00000000-0000-0000-0000-000000000001',
                email: 'user1@testauth.com',
            });

            const parts = token.split('.');
            // Tamper with payload (elevate user)
            const payload = JSON.parse(TokenService.base64UrlDecode(parts[1]));
            payload.sub = '00000000-0000-0000-0000-000000000002';
            const tamperedPayload = TokenService.base64UrlEncode(JSON.stringify(payload));
            const tamperedToken = `${parts[0]}.${tamperedPayload}.${parts[2]}`;

            const decoded = tokenService.verifyAccessToken(tamperedToken);
            assert.strictEqual(decoded.valid, false);
            assert.strictEqual(decoded.error, 'Invalid signature');
        });

        it('2.4 should reject tokens signed with unapproved algorithms (e.g. HS256/none)', () => {
            // Fake HS256 header
            const header = TokenService.base64UrlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
            const payload = TokenService.base64UrlEncode(JSON.stringify({ sub: 'u1', type: 'access', exp: 9999999999 }));
            const fakeToken = `${header}.${payload}.fakesig`;

            const decoded = tokenService.verifyAccessToken(fakeToken);
            assert.strictEqual(decoded.valid, false);
            assert.ok(decoded.error.includes('Unsupported JWT algorithm'));
        });
    });

    // -------------------------------------------------------------
    // 3. User Registration
    // -------------------------------------------------------------
    describe('3. User Registration (POST /api/v1/auth/register)', () => {
        it('3.1 should register a new user and return safe representation without password/hash', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'reg1@testauth.com',
                    password: 'SuperSecretPassword123!',
                },
            });

            assert.strictEqual(res.status, 201);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.user.email, 'reg1@testauth.com');
            assert.ok(res.body.data.user.id, 'Must return generated UUID');
            assert.strictEqual(res.body.data.user.password, undefined);
            assert.strictEqual(res.body.data.user.password_hash, undefined);
            assert.strictEqual(res.body.data.user.passwordHash, undefined);

            // Verify password hash exists in DB
            const userInDb = await userRepo.findById(res.body.data.user.id);
            assert.ok(userInDb.password_hash.startsWith('$argon2id$'));

            // Verify audit log recorded
            const logs = await auditLogRepo.listForTenant(null, { action: 'USER_REGISTERED' });
            assert.ok(logs.some((l) => l.actor_user_id === res.body.data.user.id));
        });

        it('3.2 should reject invalid email addresses', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'not-an-email',
                    password: 'SuperSecretPassword123!',
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'VALIDATION_ERROR');
        });

        it('3.3 should reject weak passwords', async () => {
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'weakpass@testauth.com',
                    password: 'short',
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'WEAK_PASSWORD');
        });

        it('3.4 should reject duplicate email addresses case-insensitively', async () => {
            // First registration
            await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'casecheck@testauth.com',
                    password: 'SuperSecretPassword123!',
                },
            });

            // Duplicate registration with mixed casing
            const res = await request('POST', '/api/v1/auth/register', {
                body: {
                    email: 'CASECHECK@testauth.com',
                    password: 'SuperSecretPassword123!',
                },
            });

            assert.strictEqual(res.status, 409);
            assert.strictEqual(res.body.error.code, 'EMAIL_ALREADY_EXISTS');
        });
    });

    // -------------------------------------------------------------
    // 4. User Login
    // -------------------------------------------------------------
    describe('4. User Login (POST /api/v1/auth/login)', () => {
        before(async () => {
            await authService.register({
                email: 'logintest@testauth.com',
                password: 'LoginPassword123!',
            });
        });

        it('4.1 should login successfully, set HTTP-only cookie, and return access token', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: 'logintest@testauth.com',
                    password: 'LoginPassword123!',
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.accessToken);
            assert.strictEqual(res.body.data.user.email, 'logintest@testauth.com');
            assert.strictEqual(res.body.data.user.password, undefined);
            assert.strictEqual(res.body.data.user.password_hash, undefined);

            // Check cookie
            const setCookie = res.headers['set-cookie'];
            assert.ok(setCookie, 'Must set Set-Cookie header');
            const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
            assert.ok(cookieStr.includes('refreshToken='));
            assert.ok(cookieStr.includes('HttpOnly'));
            assert.ok(cookieStr.includes('Path=/api/v1/auth'));

            // Raw refresh token MUST NOT appear in the database
            const cookies = parseCookies(cookieStr);
            const rawToken = cookies.refreshToken;
            const dbCheck = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1;', [rawToken]);
            assert.strictEqual(dbCheck.rows.length, 0, 'Raw token must NEVER match token_hash column');

            // Hashed token MUST exist
            const tokenHash = tokenService.hashRefreshToken(rawToken);
            const hashCheck = await pool.query('SELECT * FROM refresh_tokens WHERE token_hash = $1;', [tokenHash]);
            assert.strictEqual(hashCheck.rows.length, 1);
        });

        it('4.2 should reject wrong password with generic error without leaking account existence', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: 'logintest@testauth.com',
                    password: 'WrongPassword123!',
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
            assert.strictEqual(res.body.error.message, 'Invalid email or password');
        });

        it('4.3 should reject non-existent email with identical generic error', async () => {
            const res = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: 'doesnotexist@testauth.com',
                    password: 'SomePassword123!',
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'INVALID_CREDENTIALS');
            assert.strictEqual(res.body.error.message, 'Invalid email or password');
        });

        it('4.4 should enforce rate limiting on repeated login requests', async () => {
            // Send 6 requests rapidly (limit is 5 per second)
            const results = [];
            for (let i = 0; i < 6; i++) {
                results.push(await request('POST', '/api/v1/auth/login', {
                    body: { email: 'ratelimit@testauth.com', password: 'Password123!' },
                }));
            }

            const lastRes = results[results.length - 1];
            assert.strictEqual(lastRes.status, 429);
            assert.strictEqual(lastRes.body.error.code, 'RATE_LIMITED');
        });
    });

    // -------------------------------------------------------------
    // 5. Refresh Token Rotation & Reuse Detection
    // -------------------------------------------------------------
    describe('5. Refresh Token Rotation & Family Reuse Detection', () => {
        let user;
        let initialRefreshToken;

        before(async () => {
            const reg = await authService.register({
                email: 'refreshtest@testauth.com',
                password: 'RefreshPassword123!',
            });
            user = reg.user;

            const login = await authService.login({
                email: 'refreshtest@testauth.com',
                password: 'RefreshPassword123!',
            });
            initialRefreshToken = login.refreshToken;
        });

        it('5.1 should rotate refresh token and issue new access token atomically', async () => {
            const refreshRes = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${initialRefreshToken}`,
                    'X-Requested-With': 'XMLHttpRequest', // CSRF protection
                },
            });

            assert.strictEqual(refreshRes.status, 200);
            assert.ok(refreshRes.body.data.accessToken);

            // Cookie should have been updated with new refresh token
            const setCookie = refreshRes.headers['set-cookie'];
            assert.ok(setCookie);
            const cookies = parseCookies(Array.isArray(setCookie) ? setCookie[0] : setCookie);
            const rotatedRefreshToken = cookies.refreshToken;

            assert.notStrictEqual(rotatedRefreshToken, initialRefreshToken, 'Must rotate to a new token');

            // Old token must be marked revoked with replaced_by_token_id in DB
            const oldHash = tokenService.hashRefreshToken(initialRefreshToken);
            const oldRecord = await refreshTokenRepo.findByHash(oldHash);
            assert.ok(oldRecord.revoked_at !== null, 'Old token must have revoked_at set');
            assert.ok(oldRecord.replaced_by_token_id !== null, 'Old token must reference successor');

            // New token must be active
            const newHash = tokenService.hashRefreshToken(rotatedRefreshToken);
            const newRecord = await refreshTokenRepo.findByHash(newHash);
            assert.strictEqual(newRecord.revoked_at, null);
            assert.strictEqual(newRecord.family_id, oldRecord.family_id, 'Must preserve family_id');
        });

        it('5.2 REUSE DETECTION: presenting an old rotated token must revoke the ENTIRE family', async () => {
            // Re-present initialRefreshToken (which was already rotated in 5.1)
            const replayRes = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${initialRefreshToken}`,
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });

            assert.strictEqual(replayRes.status, 401);
            assert.strictEqual(replayRes.body.error.code, 'REFRESH_TOKEN_REUSED');
            assert.ok(replayRes.body.error.message.includes('reuse detected'));

            // Verify ALL tokens in the family are now revoked in the database
            const oldHash = tokenService.hashRefreshToken(initialRefreshToken);
            const oldRecord = await refreshTokenRepo.findByHash(oldHash);
            const familyTokens = await pool.query(
                'SELECT * FROM refresh_tokens WHERE family_id = $1;',
                [oldRecord.family_id]
            );

            assert.ok(familyTokens.rows.length >= 2);
            assert.ok(
                familyTokens.rows.every((t) => t.revoked_at !== null),
                'All tokens in the compromised family must be revoked'
            );
        });

        it('5.3 Concurrency: simultaneous refresh requests on same token should not corrupt family', async () => {
            // Fresh login
            const freshLogin = await authService.login({
                email: 'refreshtest@testauth.com',
                password: 'RefreshPassword123!',
            });
            const tokenToRotate = freshLogin.refreshToken;

            // Fire 2 refresh requests concurrently
            const [p1, p2] = await Promise.allSettled([
                authService.refresh({ rawRefreshToken: tokenToRotate }),
                authService.refresh({ rawRefreshToken: tokenToRotate }),
            ]);

            // Exactly one must succeed, or one succeeds and the second triggers reuse detection
            const fulfilled = [p1, p2].filter((p) => p.status === 'fulfilled');
            const rejected = [p1, p2].filter((p) => p.status === 'rejected');

            assert.strictEqual(fulfilled.length, 1, 'Only one rotation must succeed');
            assert.strictEqual(rejected.length, 1, 'The competing request must be rejected');
        });

        it('5.4 should reject refresh requests that supply token in body without cookie', async () => {
            const login = await authService.login({
                email: 'refreshtest@testauth.com',
                password: 'RefreshPassword123!',
            });

            const res = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'X-Requested-With': 'XMLHttpRequest',
                },
                body: {
                    refreshToken: login.refreshToken,
                },
            });

            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, 'INVALID_REFRESH_TOKEN');
            assert.ok(res.body.error.message.includes('cookie'));
        });

        it('5.5 REPEATED REUSE: presenting a revoked token multiple times continuously fails and preserves revocation', async () => {
            const login = await authService.login({
                email: 'refreshtest@testauth.com',
                password: 'RefreshPassword123!',
            });
            const oldToken = login.refreshToken;

            // 1st rotate -> succeeds
            const r1 = await authService.refresh({ rawRefreshToken: oldToken });
            assert.ok(r1.accessToken);

            // 1st reuse attempt of oldToken -> fails with REFRESH_TOKEN_REUSED
            await assert.rejects(
                () => authService.refresh({ rawRefreshToken: oldToken }),
                (err) => err.code === 'REFRESH_TOKEN_REUSED'
            );

            // 2nd reuse attempt of oldToken -> fails again
            await assert.rejects(
                () => authService.refresh({ rawRefreshToken: oldToken }),
                (err) => err.code === 'REFRESH_TOKEN_REUSED'
            );

            // Verify successor token in the family was also revoked by reuse detection
            await assert.rejects(
                () => authService.refresh({ rawRefreshToken: r1.refreshToken }),
                (err) => err.code === 'REFRESH_TOKEN_REUSED'
            );
        });
    });

    // -------------------------------------------------------------
    // 6. User Logout
    // -------------------------------------------------------------
    describe('6. User Logout (POST /api/v1/auth/logout)', () => {
        it('6.1 should revoke token family and clear refresh cookie', async () => {
            const login = await authService.login({
                email: 'logintest@testauth.com',
                password: 'LoginPassword123!',
            });

            const res = await request('POST', '/api/v1/auth/logout', {
                headers: {
                    'Cookie': `refreshToken=${login.refreshToken}`,
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);

            // Check cookie cleared
            const setCookie = res.headers['set-cookie'];
            const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
            assert.ok(cookieStr.includes('Max-Age=0'));

            // Token family should be revoked in DB
            const tokenHash = tokenService.hashRefreshToken(login.refreshToken);
            const record = await refreshTokenRepo.findByHash(tokenHash);
            assert.ok(record.revoked_at !== null);
        });

        it('6.2 should succeed idempotently when no cookie or token is provided', async () => {
            const res = await request('POST', '/api/v1/auth/logout');
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
        });

        it('6.3 LOGOUT FAMILY REVOCATION: logout must revoke entire family and subsequent refresh attempts must fail', async () => {
            const login = await authService.login({
                email: 'logintest@testauth.com',
                password: 'LoginPassword123!',
            });
            const activeToken = login.refreshToken;

            // Logout with cookie
            const res = await request('POST', '/api/v1/auth/logout', {
                headers: {
                    'Cookie': `refreshToken=${activeToken}`,
                },
            });
            assert.strictEqual(res.status, 200);

            // Attempt to refresh with the token that was just logged out
            const refreshRes = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${activeToken}`,
                    'X-Requested-With': 'XMLHttpRequest',
                },
            });

            // Since it was revoked during logout, refresh should detect revoked token
            assert.strictEqual(refreshRes.status, 401);
            assert.strictEqual(refreshRes.body.error.code, 'REFRESH_TOKEN_REUSED');
        });
    });

    // -------------------------------------------------------------
    // 7. Identity & Current User (GET /api/v1/auth/me)
    // -------------------------------------------------------------
    describe('7. Current User Identity (GET /api/v1/auth/me)', () => {
        let testUser;
        let accessToken;

        before(async () => {
            const reg = await authService.register({
                email: 'meuser@testauth.com',
                password: 'MyPassword123!',
            });
            testUser = reg.user;

            const login = await authService.login({
                email: 'meuser@testauth.com',
                password: 'MyPassword123!',
            });
            accessToken = login.accessToken;
        });

        it('7.1 should return user profile for authenticated user with valid Bearer token', async () => {
            const res = await request('GET', '/api/v1/auth/me', {
                headers: {
                    'Authorization': `Bearer ${accessToken}`,
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.id, testUser.id);
            assert.strictEqual(res.body.data.email, 'meuser@testauth.com');
            assert.strictEqual(res.body.data.password, undefined);
            assert.strictEqual(res.body.data.password_hash, undefined);
        });

        it('7.2 should reject requests with missing Authorization header', async () => {
            const res = await request('GET', '/api/v1/auth/me');
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'AUTH_REQUIRED');
        });

        it('7.3 should reject requests with malformed Authorization header', async () => {
            const res = await request('GET', '/api/v1/auth/me', {
                headers: {
                    'Authorization': 'Basic dXNlcjpwYXNz',
                },
            });
            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'TOKEN_INVALID');
        });

        it('7.4 should reject requests with forged user token (wrong key)', async () => {
            // Generate token with an alien keypair
            const alienTokenService = new TokenService();
            const forgedToken = alienTokenService.createAccessToken({
                userId: testUser.id,
                email: testUser.email,
            });

            const res = await request('GET', '/api/v1/auth/me', {
                headers: {
                    'Authorization': `Bearer ${forgedToken}`,
                },
            });

            assert.strictEqual(res.status, 401);
            assert.strictEqual(res.body.error.code, 'TOKEN_INVALID');
        });
    });

    // -------------------------------------------------------------
    // 8. Security & Secret Hygiene
    // -------------------------------------------------------------
    describe('8. Security & Secret Hygiene', () => {
        it('8.1 should never leak password hashes in API responses or user representations', async () => {
            const loginRes = await request('POST', '/api/v1/auth/login', {
                body: {
                    email: 'meuser@testauth.com',
                    password: 'MyPassword123!',
                },
            });

            const bodyStr = JSON.stringify(loginRes.body);
            assert.ok(!bodyStr.includes('$argon2id$'), 'Response must never contain password hash');
            assert.ok(!bodyStr.includes('password_hash'), 'Response must never contain password_hash key');
        });

        it('8.2 should record audit logs for critical authentication lifecycle events', async () => {
            const auditLogs = await auditLogRepo.listForTenant(null, { limit: 100 });
            const actions = auditLogs.map((l) => l.action);

            assert.ok(actions.includes('USER_REGISTERED'), 'Must audit USER_REGISTERED');
            assert.ok(actions.includes('LOGIN_SUCCEEDED'), 'Must audit LOGIN_SUCCEEDED');
            assert.ok(actions.includes('LOGIN_FAILED'), 'Must audit LOGIN_FAILED');
            assert.ok(actions.includes('TOKEN_REFRESHED'), 'Must audit TOKEN_REFRESHED');
            assert.ok(actions.includes('TOKEN_REUSE_DETECTED'), 'Must audit TOKEN_REUSE_DETECTED');
            assert.ok(actions.includes('LOGOUT'), 'Must audit LOGOUT');
        });
    });

    // -------------------------------------------------------------
    // 9. CSRF Defense & Allowed Origin Enforcement
    // -------------------------------------------------------------
    describe('9. CSRF Defense & Allowed Origin Enforcement', () => {
        let testToken;

        before(async () => {
            const login = await authService.login({
                email: 'logintest@testauth.com',
                password: 'LoginPassword123!',
            });
            testToken = login.refreshToken;
        });

        it('9.1 should allow refresh request with Origin matching allowedOrigins and set CORS headers', async () => {
            const res = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${testToken}`,
                    'Origin': 'http://localhost:3000',
                },
            });

            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.headers['access-control-allow-origin'], 'http://localhost:3000');
            assert.strictEqual(res.headers['access-control-allow-credentials'], 'true');

            // Rotate testToken
            const setCookie = res.headers['set-cookie'];
            testToken = parseCookies(Array.isArray(setCookie) ? setCookie[0] : setCookie).refreshToken;
        });

        it('9.2 should reject state-changing refresh request with disallowed Origin (403 CSRF_VALIDATION_FAILED)', async () => {
            const res = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${testToken}`,
                    'Origin': 'https://evil-attacker.com',
                },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'CSRF_VALIDATION_FAILED');
            assert.ok(res.body.error.message.includes('Origin not allowed'));
        });

        it('9.3 should reject state-changing refresh request with disallowed Referer origin (403 CSRF_VALIDATION_FAILED)', async () => {
            const res = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${testToken}`,
                    'Referer': 'https://evil-attacker.com/malicious-phishing-page',
                },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'CSRF_VALIDATION_FAILED');
            assert.ok(res.body.error.message.includes('Referer origin not allowed'));
        });

        it('9.4 should reject request when both Origin/Referer and X-Requested-With are absent', async () => {
            const res = await request('POST', '/api/v1/auth/refresh', {
                headers: {
                    'Cookie': `refreshToken=${testToken}`,
                },
            });

            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, 'CSRF_VALIDATION_FAILED');
        });

        it('9.5 should handle CORS preflight OPTIONS request for allowed and disallowed origins', async () => {
            // Allowed origin preflight
            const preflightAllowed = await request('OPTIONS', '/api/v1/auth/refresh', {
                headers: {
                    'Origin': 'https://app.windowseven.com',
                },
            });
            assert.strictEqual(preflightAllowed.status, 204);
            assert.strictEqual(preflightAllowed.headers['access-control-allow-origin'], 'https://app.windowseven.com');
            assert.strictEqual(preflightAllowed.headers['access-control-allow-credentials'], 'true');

            // Disallowed origin preflight
            const preflightDisallowed = await request('OPTIONS', '/api/v1/auth/refresh', {
                headers: {
                    'Origin': 'https://unauthorized-domain.com',
                },
            });
            assert.strictEqual(preflightDisallowed.status, 403);
            assert.strictEqual(preflightDisallowed.body.error.code, 'CSRF_VALIDATION_FAILED');
        });
    });
});
