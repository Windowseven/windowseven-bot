const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Pool } = require("pg");

const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    PlatformRoleRepository,
    RefreshTokenRepository,
    AuditLogRepository,
    PlatformAuditRepository,
    WhatsAppConnectionRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
    WorkerRepository,
} = require("../src/repositories");

const PasswordService = require("../src/application/services/PasswordService");
const TokenService = require("../src/application/services/TokenService");
const AuthService = require("../src/application/services/AuthService");
const PlatformService = require("../src/application/services/PlatformService");
const ConnectionService = require("../src/application/services/ConnectionService");
const { defaultQrStore } = require("../src/whatsapp/control/EphemeralQrStore");
const { defaultPairingCodeStore } = require("../src/whatsapp/control/EphemeralPairingCodeStore");
const { ConnectionCommandGateway } = require("../src/whatsapp/control/ConnectionCommandGateway");
const { LocalEventPublisher } = require("../src/application/realtime/EventPublisher");
const { createRestApp } = require("../src/application/http/RestApp");
const { createRateLimiter } = require("../src/application/middleware/rateLimiter");

const TEST_DB_URL = process.env.TEST_DATABASE_URL || "postgresql://testuser@127.0.0.1:5433/windowseven_test";

describe("Customer WhatsApp Connection & Pairing Flow (Step 1 & 2)", () => {
    let pool;
    let userRepo;
    let tenantRepo;
    let tenantMembershipRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let refreshTokenRepo;
    let auditLogRepo;
    let connRepo;
    let planRepo;
    let subscriptionRepo;
    let paymentRepo;
    let workerRepo;

    let passwordService;
    let tokenService;
    let authService;
    let platformService;
    let connectionService;
    let commandGateway;
    let eventPublisher;
    let rateLimiter;
    let appHandler;
    let server;
    let serverUrl;

    // Test accounts
    let customerA, tokenA, tenantAId;
    let customerB, tokenB, tenantBId;
    let customerNoSub, tokenNoSub, tenantNoSubId;
    let customerExpired, tokenExpired, tenantExpiredId;
    let activePlan;

    // Mock WorkerNode for pairing code testing
    let mockWorker;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        tenantMembershipRepo = new TenantMembershipRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        refreshTokenRepo = new RefreshTokenRepository(pool);
        auditLogRepo = new AuditLogRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        planRepo = new PlanRepository(pool);
        subscriptionRepo = new SubscriptionRepository(pool);
        paymentRepo = new PaymentRepository(pool);
        workerRepo = new WorkerRepository(pool);

        passwordService = new PasswordService();
        tokenService = new TokenService({
            jwtSecret: "test-conn-jwt-secret-very-secure-32chars",
            accessTokenTtl: "1h",
            refreshTokenTtl: "7d",
        });

        authService = new AuthService({
            userRepo,
            tenantRepo,
            tenantMembershipRepo,
            platformRoleRepo,
            refreshTokenRepo,
            auditLogRepo,
            passwordService,
            tokenService,
            pool,
        });

        platformService = new PlatformService({
            pool,
            tenantRepo,
            connRepo,
            workerRepo,
            platformAuditRepo,
            platformRoleRepo,
            planRepo,
            subscriptionRepo,
            paymentRepo,
        });

        commandGateway = new ConnectionCommandGateway({ pool });
        eventPublisher = new LocalEventPublisher();

        connectionService = new ConnectionService({
            pool,
            connRepo,
            auditLogRepo,
            commandGateway,
            qrStore: defaultQrStore,
            pairingStore: defaultPairingCodeStore,
        });

        rateLimiter = createRateLimiter({
            windowMs: 60 * 1000,
            maxRequests: 500,
        });

        appHandler = createRestApp({
            pool,
            tokenService,
            authService,
            tenantRepo,
            tenantMembershipRepo,
            userRepo,
            auditLogRepo,
            whatsAppConnectionRepo: connRepo,
            platformRoleRepo,
            planRepo,
            subscriptionRepo,
            paymentRepo,
            connectionService,
            platformService,
            rateLimiter,
            cookieOptions: { secure: false },
        });

        server = http.createServer(appHandler);
        await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
        const addr = server.address();
        serverUrl = "http://127.0.0.1:" + addr.port;

        // Create standard plan
        activePlan = await planRepo.create({
            name: "Conn Test Plan " + Date.now(),
            price: 20000.00,
            currency: "TZS",
            durationDays: 30,
            description: "Connection test plan",
            status: "ACTIVE",
        });

        const ts = Date.now();
        // 1. Customer A: Has active subscription
        customerA = await authService.register({
            email: "customera_" + ts + "@conntest.com",
            password: "CustomerPass123!@#",
            phoneNumber: "+25571" + (ts % 10000000).toString().padStart(7, '0'),
        });
        const loginA = await authService.login({
            email: customerA.user.email,
            password: "CustomerPass123!@#",
        });
        tokenA = loginA.accessToken;
        tenantAId = customerA.tenant.id;
        await subscriptionRepo.create({
            tenantId: tenantAId,
            customerUserId: customerA.user.id,
            planId: activePlan.id,
            pricePaid: 20000.00,
            currency: "TZS",
            durationDays: 30,
            status: "ACTIVE",
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
        });

        // 2. Customer B: Has MANUALLY_GRANTED subscription
        customerB = await authService.register({
            email: "customerb_" + ts + "@conntest.com",
            password: "CustomerPass123!@#",
            phoneNumber: "+25572" + (ts % 10000000).toString().padStart(7, '0'),
        });
        const loginB = await authService.login({
            email: customerB.user.email,
            password: "CustomerPass123!@#",
        });
        tokenB = loginB.accessToken;
        tenantBId = customerB.tenant.id;
        await subscriptionRepo.create({
            tenantId: tenantBId,
            customerUserId: customerB.user.id,
            planId: activePlan.id,
            pricePaid: 0.00,
            currency: "TZS",
            durationDays: 14,
            status: "MANUALLY_GRANTED",
            expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
        });

        // 3. Customer No Sub: Registered but no subscription
        customerNoSub = await authService.register({
            email: "customernosub_" + ts + "@conntest.com",
            password: "CustomerPass123!@#",
            phoneNumber: "+25573" + (ts % 10000000).toString().padStart(7, '0'),
        });
        const loginNoSub = await authService.login({
            email: customerNoSub.user.email,
            password: "CustomerPass123!@#",
        });
        tokenNoSub = loginNoSub.accessToken;
        tenantNoSubId = customerNoSub.tenant.id;

        // 4. Customer Expired: Has expired subscription
        customerExpired = await authService.register({
            email: "customerexpired_" + ts + "@conntest.com",
            password: "CustomerPass123!@#",
            phoneNumber: "+25574" + (ts % 10000000).toString().padStart(7, '0'),
        });
        const loginExpired = await authService.login({
            email: customerExpired.user.email,
            password: "CustomerPass123!@#",
        });
        tokenExpired = loginExpired.accessToken;
        tenantExpiredId = customerExpired.tenant.id;
        await subscriptionRepo.create({
            tenantId: tenantExpiredId,
            customerUserId: customerExpired.user.id,
            planId: activePlan.id,
            pricePaid: 20000.00,
            currency: "TZS",
            durationDays: 30,
            status: "EXPIRED",
            expiresAt: new Date(Date.now() - 1000),
        });

        // Register a mock WorkerNode with commandGateway
        mockWorker = {
            workerId: "mock-worker-1",
            requestPairingCode: async (connectionId, phoneNumber) => {
                return "1234-5678";
            },
        };
        commandGateway.registerWorkerNode(mockWorker);
    });

    after(async () => {
        defaultQrStore.clearAll();
        defaultPairingCodeStore.clearAll();
        commandGateway.removeAllListeners();
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
    });

    function request(method, path, { headers = {}, body = null } = {}) {
        return new Promise((resolve, reject) => {
            const url = new URL(path, serverUrl);
            const req = http.request(url, { method, headers }, (res) => {
                let data = "";
                res.on("data", (chunk) => { data += chunk; });
                res.on("end", () => {
                    let parsed = null;
                    try { parsed = JSON.parse(data); } catch (_) { parsed = data; }
                    resolve({ status: res.statusCode, headers: res.headers, body: parsed });
                });
            });
            req.on("error", reject);
            if (body) {
                req.setHeader("Content-Type", "application/json");
                req.write(typeof body === "string" ? body : JSON.stringify(body));
            }
            req.end();
        });
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Subscription Entitlement Gate
    // ─────────────────────────────────────────────────────────────────────────
    describe("Subscription Entitlement Gate", () => {
        it("Customer with NO subscription receives 403 SUBSCRIPTION_REQUIRED on POST /me/connection", async () => {
            const res = await request("POST", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenNoSub },
                body: { displayName: "No Sub Bot" },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, "SUBSCRIPTION_REQUIRED");
        });

        it("Customer with EXPIRED subscription receives 403 SUBSCRIPTION_REQUIRED on POST /me/connection", async () => {
            const res = await request("POST", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenExpired },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, "SUBSCRIPTION_REQUIRED");
        });

        it("Customer with NO subscription receives 403 SUBSCRIPTION_REQUIRED on pairing code request", async () => {
            const res = await request("POST", "/api/v1/me/connection/pairing-code", {
                headers: { Authorization: "Bearer " + tokenNoSub },
                body: { phoneNumber: "255711222003" },
            });
            assert.strictEqual(res.status, 403);
            assert.strictEqual(res.body.error.code, "SUBSCRIPTION_REQUIRED");
        });

        it("Customer with ACTIVE subscription can start connection (200 OK)", async () => {
            const res = await request("POST", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenA },
                body: { displayName: "Customer A Bot" },
            });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.connection);
            assert.strictEqual(res.body.data.connection.desiredState, "RUNNING");
            assert.strictEqual(res.body.data.connection.tenantId, tenantAId);
        });

        it("Customer with MANUALLY_GRANTED subscription can start connection (200 OK)", async () => {
            const res = await request("POST", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenB },
                body: { displayName: "Customer B Bot" },
            });
            assert.strictEqual(res.status, 200);
            assert.ok(res.body.data.connection);
            assert.strictEqual(res.body.data.connection.desiredState, "RUNNING");
            assert.strictEqual(res.body.data.connection.tenantId, tenantBId);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. One Connection Per Customer Invariant & Reuse
    // ─────────────────────────────────────────────────────────────────────────
    describe("One Connection Invariant & Reuse", () => {
        it("Second POST /me/connection reuses existing connection without creating duplicate", async () => {
            const conn1 = await connRepo.findByTenantId(tenantAId);
            assert.ok(conn1);

            const res = await request("POST", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenA },
                body: { displayName: "Updated Name" },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.id, conn1.id);

            const allConnA = await connRepo.listForTenant(tenantAId);
            assert.strictEqual(allConnA.length, 1);
        });

        it("Database unique constraint uq_whatsapp_connections_tenant_unique blocks duplicate insert", async () => {
            await assert.rejects(
                async () => {
                    await connRepo.createForTenant(tenantAId, {
                        displayName: "Duplicate Attempt",
                    });
                },
                (err) => {
                    return err.code === "23505" || err.message.includes("unique");
                },
                "PostgreSQL must strictly reject duplicate tenant connection"
            );
        });

        it("Concurrent connection creation safely converges to one connection", async () => {
            const promises = [
                request("POST", "/api/v1/me/connection", { headers: { Authorization: "Bearer " + tokenB } }),
                request("POST", "/api/v1/me/connection", { headers: { Authorization: "Bearer " + tokenB } }),
                request("POST", "/api/v1/me/connection", { headers: { Authorization: "Bearer " + tokenB } }),
            ];
            const responses = await Promise.all(promises);
            for (const r of responses) {
                assert.strictEqual(r.status, 200);
            }
            const allConnB = await connRepo.listForTenant(tenantBId);
            assert.strictEqual(allConnB.length, 1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Security, Anti-Enumeration & IDOR Protections
    // ─────────────────────────────────────────────────────────────────────────
    describe("Security & IDOR Protections", () => {
        it("Customer A cannot see Customer B connection via GET /me/connection", async () => {
            const resA = await request("GET", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenA },
            });
            assert.strictEqual(resA.status, 200);
            assert.strictEqual(resA.body.data.connection.tenantId, tenantAId);

            const resB = await request("GET", "/api/v1/me/connection", {
                headers: { Authorization: "Bearer " + tokenB },
            });
            assert.strictEqual(resB.status, 200);
            assert.strictEqual(resB.body.data.connection.tenantId, tenantBId);
            assert.notStrictEqual(resA.body.data.connection.id, resB.body.data.connection.id);
        });

        it("Customer submitting arbitrary tenantId in body or query is completely ignored", async () => {
            const res = await request("POST", "/api/v1/me/connection?tenantId=" + tenantBId, {
                headers: { Authorization: "Bearer " + tokenA },
                body: { tenantId: tenantBId },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.tenantId, tenantAId);
        });

        it("Customer A cannot fetch Customer B QR code", async () => {
            const connB = await connRepo.findByTenantId(tenantBId);
            defaultQrStore.set(tenantBId, connB.id, "b-secret-qr-payload", 60, connB.leaseEpoch);

            const resA = await request("GET", "/api/v1/me/connection/qr", {
                headers: { Authorization: "Bearer " + tokenA },
            });
            assert.strictEqual(resA.status, 404);
            assert.strictEqual(resA.body.error.code, "QR_NOT_AVAILABLE");

            const resB = await request("GET", "/api/v1/me/connection/qr", {
                headers: { Authorization: "Bearer " + tokenB },
            });
            assert.strictEqual(resB.status, 200);
            assert.strictEqual(resB.body.data.qr, "b-secret-qr-payload");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Ephemeral QR & Generation Fencing
    // ─────────────────────────────────────────────────────────────────────────
    describe("Ephemeral QR & Generation Fencing", () => {
        it("returns QR when active and unexpired", async () => {
            const connA = await connRepo.findByTenantId(tenantAId);
            defaultQrStore.set(tenantAId, connA.id, "a-test-qr-code", 60, connA.leaseEpoch);

            const res = await request("GET", "/api/v1/me/connection/qr", {
                headers: { Authorization: "Bearer " + tokenA },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.qr, "a-test-qr-code");
            assert.ok(res.body.data.expiresAt);
        });

        it("stale generation QR (mismatched lease_epoch) is rejected", async () => {
            const connA = await connRepo.findByTenantId(tenantAId);
            defaultQrStore.set(tenantAId, connA.id, "stale-qr", 60, (connA.leaseEpoch || 1) + 999);

            const res = await request("GET", "/api/v1/me/connection/qr", {
                headers: { Authorization: "Bearer " + tokenA },
            });
            assert.strictEqual(res.status, 404);
            assert.strictEqual(res.body.error.code, "QR_NOT_AVAILABLE");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. Pairing Code Flow
    // ─────────────────────────────────────────────────────────────────────────
    describe("Pairing Code Flow", () => {
        it("fails safely if connection has not been acquired by a worker", async () => {
            const res = await request("POST", "/api/v1/me/connection/pairing-code", {
                headers: { Authorization: "Bearer " + tokenA },
                body: { phoneNumber: "255711222001" },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, "CONNECTION_NOT_ACTIVE");
        });

        it("successfully returns pairing code when worker has leased the connection", async () => {
            const connA = await connRepo.findByTenantId(tenantAId);
            await pool.query(
                "UPDATE whatsapp_connections SET assigned_worker_id = 'mock-worker-1', lease_epoch = 1, lease_expires_at = NOW() + INTERVAL '30 seconds', actual_state = 'ACTIVE' WHERE id = $1",
                [connA.id]
            );

            const res = await request("POST", "/api/v1/me/connection/pairing-code", {
                headers: { Authorization: "Bearer " + tokenA },
                body: { phoneNumber: "255711222001" },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.code, "1234-5678");
            assert.ok(res.body.data.expiresAt);

            const stored = defaultPairingCodeStore.get(tenantAId, connA.id, 1);
            assert.ok(stored);
            assert.strictEqual(stored.code, "1234-5678");
        });

        it("fails safely when assigned worker is offline/unreachable", async () => {
            const connA = await connRepo.findByTenantId(tenantAId);
            await pool.query(
                "UPDATE whatsapp_connections SET assigned_worker_id = 'offline-worker-999', lease_epoch = 1 WHERE id = $1",
                [connA.id]
            );

            const res = await request("POST", "/api/v1/me/connection/pairing-code", {
                headers: { Authorization: "Bearer " + tokenA },
                body: { phoneNumber: "255711222001" },
            });
            assert.strictEqual(res.status, 400);
            assert.strictEqual(res.body.error.code, "WORKER_UNAVAILABLE");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Disconnect Flow & Invariants
    // ─────────────────────────────────────────────────────────────────────────
    describe("Disconnect Flow", () => {
        it("Customer can gracefully disconnect own connection (desired_state -> STOPPED)", async () => {
            const res = await request("POST", "/api/v1/me/connection/disconnect", {
                headers: { Authorization: "Bearer " + tokenA },
            });
            assert.strictEqual(res.status, 200);
            assert.strictEqual(res.body.data.connection.desired_state, "STOPPED");

            const inDb = await connRepo.findByTenantId(tenantAId);
            assert.strictEqual(inDb.desiredState, "STOPPED");
        });

        it("Disconnecting connection does NOT cancel or delete subscription", async () => {
            const sub = await subscriptionRepo.findActiveByTenantId(tenantAId);
            assert.ok(sub);
            assert.strictEqual(sub.status, "ACTIVE");
        });
    });
});
