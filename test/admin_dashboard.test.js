const { describe, it, before, after } = require("node:test");
const assert = require("node:assert");
const http = require("node:http");
const { Pool } = require("pg");
const {
    UserRepository,
    TenantRepository,
    TenantMembershipRepository,
    WhatsAppConnectionRepository,
    WorkerRepository,
    PlatformRoleRepository,
    PlatformAuditRepository,
    PlatformIdempotencyRepository,
    ScheduledModerationTaskRepository,
    GroupRepository,
    GroupPolicyRepository,
    GroupWarningRepository,
    PlanRepository,
    SubscriptionRepository,
    PaymentRepository,
    RefreshTokenRepository,
} = require("../src/repositories");
const TokenService = require("../src/application/services/TokenService");
const AuthService = require("../src/application/services/AuthService");
const PasswordService = require("../src/application/services/PasswordService");
const PlatformService = require("../src/application/services/PlatformService");
const WarningService = require("../src/application/services/WarningService");
const ModerationService = require("../src/application/services/ModerationService");
const PolicyEngine = require("../src/application/policies/PolicyEngine");
const CommandRegistry = require("../src/application/commands/CommandRegistry");
const ApplicationPipeline = require("../src/application/pipeline/ApplicationPipeline");
const { createRestApp } = require("../src/application/http/RestApp");
const { ConnectionCommandGateway } = require("../src/whatsapp/control/ConnectionCommandGateway");
const { LocalEventPublisher } = require("../src/application/realtime/EventPublisher");

const TEST_DB_URL = process.env.TEST_DATABASE_URL || "postgresql://testuser:testpass123@127.0.0.1:5433/windowseven_test";

function makeRequest(server, { method, path, headers = {}, body = null }) {
    return new Promise((resolve, reject) => {
        const addr = server.address();
        const options = {
            hostname: "127.0.0.1",
            port: addr.port,
            path,
            method,
            headers: { ...headers },
        };

        let payload = null;
        if (body !== null) {
            payload = typeof body === "string" ? body : JSON.stringify(body);
            options.headers["Content-Type"] = "application/json";
            options.headers["Content-Length"] = Buffer.byteLength(payload);
        }

        const req = http.request(options, (res) => {
            let data = "";
            res.on("data", (chunk) => { data += chunk; });
            res.on("end", () => {
                let json = null;
                try { json = JSON.parse(data); } catch (e) { json = data; }
                resolve({ statusCode: res.statusCode, headers: res.headers, body: json });
            });
        });
        req.on("error", reject);
        if (payload) req.write(payload);
        req.end();
    });
}

describe("Windowseven Admin Business Layer & Admin Dashboard Suite", () => {
    let pool;
    let server;
    let tokenService;
    let authService;
    let platformService;
    let userRepo;
    let tenantRepo;
    let membershipRepo;
    let connRepo;
    let planRepo;
    let subRepo;
    let paymentRepo;
    let platformRoleRepo;
    let platformAuditRepo;
    let groupRepo;

    let adminUser;
    let adminToken;
    let customerUser;
    let customerToken;
    let testTenant;
    let testConnection;
    let testPlan;
    let testSub;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tokenService = new TokenService({
            jwtSecret: "test-jwt-secret-key-32-chars-long-min!!",
            jwtExpiresIn: 900,
            refreshTokenTtl: 604800,
        });
        const passwordService = new PasswordService();
        userRepo = new UserRepository(pool);
        tenantRepo = new TenantRepository(pool);
        membershipRepo = new TenantMembershipRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        planRepo = new PlanRepository(pool);
        subRepo = new SubscriptionRepository(pool);
        paymentRepo = new PaymentRepository(pool);
        platformRoleRepo = new PlatformRoleRepository(pool);
        platformAuditRepo = new PlatformAuditRepository(pool);
        groupRepo = new GroupRepository(pool);

        const refreshTokenRepo = new RefreshTokenRepository(pool);
        authService = new AuthService({
            userRepo,
            refreshTokenRepo,
            passwordService,
            tokenService,
            pool,
        });

        platformService = new PlatformService({
            pool,
            tenantRepo,
            connRepo,
            workerRepo: new WorkerRepository(pool),
            platformAuditRepo,
            platformRoleRepo,
            taskRepo: new ScheduledModerationTaskRepository(pool),
            groupRepo,
            planRepo,
            subscriptionRepo: subRepo,
            paymentRepo,
            userRepo,
            commandGateway: new ConnectionCommandGateway(),
            eventPublisher: new LocalEventPublisher(),
        });

        const app = createRestApp({
            tokenService,
            authService,
            userRepo,
            tenantRepo,
            tenantMembershipRepo: membershipRepo,
            whatsAppConnectionRepo: connRepo,
            platformService,
            platformRoleRepo,
            platformAuditRepo,
            pool,
        });

        server = http.createServer(app);
        await new Promise((resolve) => server.listen(0, resolve));

        // 1. Setup Admin User with ADMIN platform role
        const adminEmail = "admin." + Date.now() + "@windowseven.bot";
        adminUser = await userRepo.create({
            email: adminEmail,
            passwordHash: await passwordService.hash("AdminPass123!"),
            phoneNumber: "0799" + Math.floor(100000 + Math.random() * 900000),
        });
        await platformRoleRepo.assignRole({
            userId: adminUser.id,
            role: "ADMIN",
        });
        adminToken = tokenService.createAccessToken({ userId: adminUser.id, email: adminUser.email });

        // 2. Setup Customer User (non-admin)
        const custPhone = "0766" + Math.floor(100000 + Math.random() * 900000);
        customerUser = await userRepo.create({
            email: custPhone + "@windowseven.bot",
            passwordHash: await passwordService.hash("CustPass123!"),
            phoneNumber: custPhone,
        });
        customerToken = tokenService.createAccessToken({ userId: customerUser.id, email: customerUser.email });

        // Setup Tenant for Customer
        testTenant = await tenantRepo.create({ name: "Customer Workspace " + custPhone });
        await membershipRepo.create({
            tenantId: testTenant.id,
            userId: customerUser.id,
            role: "OWNER",
        });

        // Setup Connection
        testConnection = await connRepo.createForTenant(testTenant.id, {
            phoneNumber: custPhone,
            displayName: "Customer WhatsApp",
            status: "ACTIVE",
            actualState: "ACTIVE",
            desiredState: "RUNNING",
        });

        // Setup Group
        await groupRepo.upsertDiscoveredGroup(testTenant.id, testConnection.id, {
            whatsappJid: "120363000000000001@g.us",
            name: "Customer VIP Group",
            status: "MANAGED",
        });
    });

    after(async () => {
        if (server) await new Promise((resolve) => server.close(resolve));
        if (pool) await pool.end();
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. Product Roles & Access Control
    // ─────────────────────────────────────────────────────────────────────────
    describe("1. Product Roles & Access Control", () => {
        it("rejects unauthenticated requests with 401 AUTH_REQUIRED", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/overview",
            });
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.error.code, "AUTH_REQUIRED");
        });

        it("rejects customer without ADMIN role with 403 PLATFORM_ACCESS_DENIED", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/overview",
                headers: { Authorization: "Bearer " + customerToken },
            });
            assert.strictEqual(res.statusCode, 403);
            assert.strictEqual(res.body.error.code, "PLATFORM_ACCESS_DENIED");
        });

        it("allows ADMIN operational authority access to overview", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/overview",
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.customers !== undefined);
            assert.ok(res.body.data.subscriptions !== undefined);
            assert.ok(res.body.data.connections !== undefined);
            assert.ok(res.body.data.payments !== undefined);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. Customer Identity (Phone Registration & Login)
    // ─────────────────────────────────────────────────────────────────────────
    describe("2. Customer Identity & Registration", () => {
        const newPhone = "+255788" + Math.floor(100000 + Math.random() * 900000);
        const newEmail = "customer_" + Date.now() + "@windowseven.bot";

        it("registers customer using email, phone number, and password", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/auth/register",
                body: {
                    email: newEmail,
                    phoneNumber: newPhone,
                    password: "SecurePassword123!",
                },
            });
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.success, true);
            assert.strictEqual(res.body.data.user.phoneNumber, newPhone);
            assert.strictEqual(res.body.data.user.email, newEmail);
            assert.ok(res.body.data.tenant);
        });

        it("rejects duplicate registration with same phone number with 409", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/auth/register",
                body: {
                    email: "another_" + Date.now() + "@windowseven.bot",
                    phoneNumber: newPhone,
                    password: "SecurePassword123!",
                },
            });
            assert.strictEqual(res.statusCode, 409);
            assert.strictEqual(res.body.error.code, "PHONE_ALREADY_EXISTS");
        });

        it("rejects login attempt using registered phone number as identifier", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/auth/login",
                body: {
                    identifier: newPhone,
                    password: "SecurePassword123!",
                },
            });
            assert.strictEqual(res.statusCode, 401);
            assert.strictEqual(res.body.error.code, "INVALID_CREDENTIALS");
        });

        it("logs in customer successfully using email and password", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/auth/login",
                body: {
                    email: newEmail,
                    password: "SecurePassword123!",
                },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.success, true);
            assert.ok(res.body.data.accessToken);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. Customer Management & Search
    // ─────────────────────────────────────────────────────────────────────────
    describe("3. Customer Management & Search", () => {
        it("lists customers with phone number and tenant details", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/customers",
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.data));
            assert.ok(res.body.data.length > 0);
        });

        it("searches customers by phone number", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/customers?search=" + testConnection.phone_number,
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.length, 1);
            assert.strictEqual(res.body.data[0].phone_number, testConnection.phone_number);
        });

        it("retrieves holistic customer overview", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/customers/" + testTenant.id,
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.customer.id, testTenant.id);
            assert.strictEqual(res.body.data.customer.owner.phone_number, testConnection.phone_number);
            assert.strictEqual(res.body.data.connection.id, testConnection.id);
            assert.strictEqual(res.body.data.groups.totalCount, 1);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. Customer Lifecycle Operations (Mandatory Reasons & Audit)
    // ─────────────────────────────────────────────────────────────────────────
    describe("4. Customer Lifecycle Operations", () => {
        it("fails to suspend customer without mandatory reason (400)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/suspend",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason: "   " },
            });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
        });

        it("suspends customer with mandatory reason and logs audit entry", async () => {
            const reason = "Suspension due to terms violation test";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/suspend",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, "SUSPENDED");

            // Verify audit entry
            const auditRes = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/audit?action=TENANT_SUSPENDED&targetId=" + testTenant.id,
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(auditRes.statusCode, 200);
            assert.strictEqual(auditRes.body.data.length, 1);
            assert.strictEqual(auditRes.body.data[0].reason, reason);
        });

        it("reactivates suspended customer with mandatory reason", async () => {
            const reason = "Customer resolved policy violation";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/reactivate",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, "ACTIVE");
        });

        it("deactivates customer with mandatory reason (terminal operation)", async () => {
            const reason = "Customer requested permanent account deletion";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/deactivate",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, "DEACTIVATED");
        });

        it("rejects reactivating a deactivated customer (terminal lifecycle constraint)", async () => {
            const reason = "Attempted reactivation of deactivated account";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/reactivate",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason },
            });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, "TENANT_DEACTIVATED");

            // Reset tenant status to ACTIVE for subsequent test suites
            await pool.query("UPDATE tenants SET status = 'ACTIVE' WHERE id = $1;", [testTenant.id]);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. WhatsApp Connection Disconnect
    // ─────────────────────────────────────────────────────────────────────────
    describe("5. WhatsApp Disconnect", () => {
        it("disconnects WhatsApp connection cleanly without touching customer subscription", async () => {
            const reason = "Manual disconnect requested by user support";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/connections/" + testConnection.id + "/disconnect",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.desiredState, "STOPPED");
            assert.strictEqual(res.body.data.actualState, "SOCKET_STOPPING");

            // Customer tenant remains ACTIVE
            const tenantCheck = await tenantRepo.findById(testTenant.id);
            assert.strictEqual(tenantCheck.status, "ACTIVE");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. Plans & Pricing (Security & Integrity)
    // ─────────────────────────────────────────────────────────────────────────
    describe("6. Plans & Pricing", () => {
        it("rejects plan creation with negative price (400)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/plans",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    name: "Invalid Plan",
                    price: -500,
                    durationDays: 30,
                },
            });
            assert.strictEqual(res.statusCode, 400);
        });

        it("creates an authoritative plan with valid price and duration", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/plans",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    name: "Pro 30 Days",
                    price: 7500,
                    currency: "TZS",
                    durationDays: 30,
                    description: "Full group moderation and utility suite",
                    status: "ACTIVE",
                },
            });
            assert.strictEqual(res.statusCode, 201);
            testPlan = res.body.data;
            assert.strictEqual(testPlan.name, "Pro 30 Days");
            assert.strictEqual(Number(testPlan.price), 7500);
            assert.strictEqual(testPlan.duration_days, 30);
        });

        it("updates plan fields and toggles status", async () => {
            const res = await makeRequest(server, {
                method: "PATCH",
                path: "/api/v1/admin/plans/" + testPlan.id + "/status",
                headers: { Authorization: "Bearer " + adminToken },
                body: { status: "INACTIVE" },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, "INACTIVE");

            // Re-activate
            await makeRequest(server, {
                method: "PATCH",
                path: "/api/v1/admin/plans/" + testPlan.id + "/status",
                headers: { Authorization: "Bearer " + adminToken },
                body: { status: "ACTIVE" },
            });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. Subscriptions & Manual Operations
    // ─────────────────────────────────────────────────────────────────────────
    describe("7. Subscriptions & Manual Operations", () => {
        it("manually grants subscription with price 0 and mandatory reason", async () => {
            const reason = "Complimentary trial granted by support";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/subscriptions/grant",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    planId: testPlan.id,
                    reason,
                },
            });
            assert.strictEqual(res.statusCode, 201);
            testSub = res.body.data;
            assert.strictEqual(testSub.status, "MANUALLY_GRANTED");
            assert.strictEqual(Number(testSub.price_paid), 0);
            assert.strictEqual(testSub.duration_days, 30);
            assert.strictEqual(testSub.tenant_id, testTenant.id);

            // Verify audit entry
            const auditRes = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/audit?action=SUBSCRIPTION_GRANTED&targetId=" + testSub.id,
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(auditRes.statusCode, 200);
            assert.strictEqual(auditRes.body.data[0].reason, reason);
        });

        it("manual grant ignores client durationDays and strictly enforces authoritative plan duration", async () => {
            const reason = "Promotional grant with attempted duration override";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/subscriptions/grant",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    planId: testPlan.id,
                    durationDays: 14, // Attempted override
                    reason,
                },
            });
            assert.strictEqual(res.statusCode, 201);
            // Must strictly match plan's duration (30 days), NOT the client-provided 14
            assert.strictEqual(res.body.data.duration_days, 30);
            assert.strictEqual(Number(res.body.data.price_paid), 0);
        });

        it("manual grant fails without planId (400 VALIDATION_ERROR)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/customers/" + testTenant.id + "/subscriptions/grant",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    reason: "Missing planId",
                },
            });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, "VALIDATION_ERROR");
        });

        it("manually extends subscription by +7 days with mandatory reason", async () => {
            const initialExpiry = new Date(testSub.expires_at).getTime();
            const reason = "Extension due to scheduled maintenance downtime";
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/subscriptions/" + testSub.id + "/extend",
                headers: { Authorization: "Bearer " + adminToken },
                body: {
                    additionalDays: 7,
                    reason,
                },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.strictEqual(res.body.data.status, "ACTIVE");
            assert.strictEqual(res.body.data.duration_days, 37);

            const newExpiry = new Date(res.body.data.expires_at).getTime();
            assert.ok(newExpiry > initialExpiry);
        });

        it("prevents deletion of plan referenced by subscription", async () => {
            const res = await makeRequest(server, {
                method: "DELETE",
                path: "/api/v1/admin/plans/" + testPlan.id,
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 400);
            assert.strictEqual(res.body.error.code, "PLAN_IN_USE");
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 8. Subscription Expiry Enforcement in Inbound Pipeline
    // ─────────────────────────────────────────────────────────────────────────
    describe("8. Subscription Expiry Enforcement in Pipeline", () => {
        let pipeline;
        let mockGateway;
        let groupPolicyRepo;
        let warningRepo;
        let warningService;
        let moderationService;
        let policyEngine;
        let commandRegistry;

        before(() => {
            groupPolicyRepo = new GroupPolicyRepository(pool);
            warningRepo = new GroupWarningRepository(pool);
            warningService = new WarningService({ warningRepo, pool });
            mockGateway = {
                sentMessages: [],
                async sendTextMessage(jid, text) {
                    this.sentMessages.push({ jid, text });
                    return { success: true };
                },
                async sendMessage(jid, text) {
                    this.sentMessages.push({ jid, text });
                    return { success: true };
                },
                async checkAdminStatus() {
                    return { isSenderAdmin: true, isBotAdmin: true };
                },
            };
            moderationService = new ModerationService({ gateway: mockGateway });
            policyEngine = new PolicyEngine();
            commandRegistry = new CommandRegistry();
            commandRegistry.register({
                name: "ping",
                aliases: [],
                description: "Latency check",
                execute: async () => ({ pong: true }),
            });

            pipeline = new ApplicationPipeline({
                groupRepo,
                policyRepo: groupPolicyRepo,
                warningRepo,
                warningService,
                moderationService,
                policyEngine,
                commandRegistry,
                gateway: mockGateway,
                tenantRepo,
                subscriptionRepo: subRepo,
                enforceSubscription: true,
            });
        });

        it("blocks commands with renewal prompt when subscription is expired", async () => {
            // Set subscription expiry into the past for test tenant
            await pool.query(
                "UPDATE customer_subscriptions SET expires_at = NOW() - INTERVAL '1 hour', status = 'EXPIRED' WHERE tenant_id = $1;",
                [testTenant.id]
            );

            const result = await pipeline.processMessage({
                ctx: {
                    tenantId: testTenant.id,
                    connectionId: testConnection.id,
                },
                message: {
                    id: "msg_expiry_test",
                    remoteJid: "120363000000000001@g.us",
                    sender: "255712345678@s.whatsapp.net",
                    isGroup: true,
                    text: ".ping",
                    timestamp: Math.floor(Date.now() / 1000),
                },
            });

            assert.strictEqual(result.handled, true);
            assert.strictEqual(result.reason, "subscription_expired");
            assert.ok(mockGateway.sentMessages.some(m => m.text.includes("subscription has expired")));

            // Connection state remains intact
            const conn = await connRepo.findById(testConnection.id);
            assert.ok(conn !== null);
        });

        it("immediately restores command execution when subscription is renewed", async () => {
            // Renew / extend subscription
            await subRepo.extendSubscription(testSub.id, 30);
            mockGateway.sentMessages = [];

            const result = await pipeline.processMessage({
                ctx: {
                    tenantId: testTenant.id,
                    connectionId: testConnection.id,
                },
                message: {
                    id: "msg_renewed_test",
                    remoteJid: "120363000000000001@g.us",
                    sender: "255712345678@s.whatsapp.net",
                    isGroup: true,
                    text: ".ping",
                    timestamp: Math.floor(Date.now() / 1000),
                },
            });

            assert.strictEqual(result.handled, true);
            assert.deepStrictEqual(result.result, { pong: true });
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 9. Customer Purchase Flow, Payments & Revenue Derivation
    // ─────────────────────────────────────────────────────────────────────────
    describe("9. Customer Purchase Flow, Payments & Revenue Derivation", () => {
        before(async () => {
            await paymentRepo.create({
                tenantId: testTenant.id,
                customerUserId: customerUser.id,
                planId: testPlan.id,
                amount: 7500,
                currency: "TZS",
                provider: "M-PESA",
                transactionReference: "MPESA_TEST_" + Date.now(),
                status: "SUCCESS",
            });
        });

        it("allows customer to view active plans catalog via GET /api/v1/plans", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/plans",
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.data.plans));
            assert.ok(res.body.data.plans.some(p => p.id === testPlan.id));
        });

        it("customer initiates subscription purchase outside /admin (POST /api/v1/tenants/:id/subscriptions/purchase)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/tenants/" + testTenant.id + "/subscriptions/purchase",
                headers: { Authorization: "Bearer " + customerToken },
                body: {
                    planId: testPlan.id,
                    provider: "M-PESA",
                },
            });
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.payment.status, "PENDING");
            assert.strictEqual(Number(res.body.data.payment.amount), 7500);
            assert.strictEqual(res.body.data.plan.durationDays, 30);
        });

        it("client-supplied payment amount cannot override DB plan price", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/tenants/" + testTenant.id + "/subscriptions/purchase",
                headers: { Authorization: "Bearer " + customerToken },
                body: {
                    planId: testPlan.id,
                    amount: 5, // Client attempts to underpay
                    price: 1,
                    provider: "AIRTEL-MONEY",
                },
            });
            assert.strictEqual(res.statusCode, 201);
            // Server loads authoritative plan price (7500), ignoring client tampering
            assert.strictEqual(Number(res.body.data.payment.amount), 7500);
        });

        it("customer completes subscription checkout outside /admin (POST /api/v1/tenants/:id/subscriptions/checkout)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/tenants/" + testTenant.id + "/subscriptions/checkout",
                headers: { Authorization: "Bearer " + customerToken },
                body: {
                    planId: testPlan.id,
                },
            });
            assert.strictEqual(res.statusCode, 201);
            assert.strictEqual(res.body.data.payment.status, "SUCCESS");
            assert.strictEqual(res.body.data.subscription.status, "ACTIVE");
            assert.strictEqual(Number(res.body.data.subscription.price_paid), 7500);
        });

        it("lists payments across platform in Admin with status filter", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/payments?status=SUCCESS",
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.data));
            assert.ok(res.body.data.length >= 1);
            assert.strictEqual(res.body.data[0].status, "SUCCESS");
        });

        it("successful payments alone contribute to 30-day revenue (failed payments & grants contribute 0)", async () => {
            // Insert a failed payment of 100,000 TZS
            await paymentRepo.create({
                tenantId: testTenant.id,
                customerUserId: customerUser.id,
                planId: testPlan.id,
                amount: 100000,
                currency: "TZS",
                provider: "M-PESA",
                transactionReference: "MPESA_FAIL_" + Date.now(),
                status: "FAILED",
                failureReason: "Insufficient funds",
            });

            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/overview",
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);

            // Revenue calculation must sum only successful payments
            const { revenue30d, successCount } = res.body.data.payments;
            assert.ok(revenue30d >= 7500, "Revenue must reflect successful payments");
            // Failed payment must NOT inflate revenue
            assert.ok(revenue30d < 100000, "Failed payments must NOT be included in revenue");
        });

        it("strictly prohibits admin refund endpoint (404/405)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/admin/payments/dummy_id/refund",
                headers: { Authorization: "Bearer " + adminToken },
                body: { reason: "test refund" },
            });
            assert.ok([404, 405].includes(res.statusCode));
        });

        it("strictly prohibits customer refund endpoint (404/405)", async () => {
            const res = await makeRequest(server, {
                method: "POST",
                path: "/api/v1/tenants/" + testTenant.id + "/payments/dummy_id/refund",
                headers: { Authorization: "Bearer " + customerToken },
                body: { reason: "test customer refund" },
            });
            assert.ok([404, 405].includes(res.statusCode));
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 10. Groups Operational View (No Surveillance)
    // ─────────────────────────────────────────────────────────────────────────
    describe("10. Groups Operational View", () => {
        it("lists groups across customers without message contents", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/api/v1/admin/groups",
                headers: { Authorization: "Bearer " + adminToken },
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(Array.isArray(res.body.data));
            const group = res.body.data.find(g => g.jid === "120363000000000001@g.us");
            assert.ok(group);
            assert.strictEqual(group.name, "Customer VIP Group");
            assert.strictEqual(group.status, "MANAGED");
            assert.strictEqual(group.messages, undefined);
            assert.strictEqual(group.message_text, undefined);
        });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 11. Static Admin Dashboard Serving
    // ─────────────────────────────────────────────────────────────────────────
    describe("11. Static Admin Dashboard Serving", () => {
        it("serves /admin with index.html", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/admin",
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(String(res.headers["content-type"]).includes("text/html"));
            assert.ok(String(res.body).includes("Windowseven Admin"));
        });

        it("serves /admin/admin.css with text/css", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/admin/admin.css",
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(String(res.headers["content-type"]).includes("text/css"));
            assert.ok(String(res.body).includes("--bg-primary"));
        });

        it("serves /admin/admin.js with application/javascript", async () => {
            const res = await makeRequest(server, {
                method: "GET",
                path: "/admin/admin.js",
            });
            assert.strictEqual(res.statusCode, 200);
            assert.ok(String(res.headers["content-type"]).includes("application/javascript"));
            assert.ok(String(res.body).includes("AdminApp"));
        });
    });
});
