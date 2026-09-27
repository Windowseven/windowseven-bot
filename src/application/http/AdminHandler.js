const ApiError = require("../errors/ApiError");
const { computePlatformRequestHash } = require("../../repositories/PlatformIdempotencyRepository");
const { requirePlatformRole: defaultRequirePlatformRole } = require("../middleware/platformAuthMiddleware");

/**
 * Registers all Windowseven Admin business routes under /api/v1/admin/*.
 */
function registerAdminRoutes({
    router,
    platformService,
    platformIdempotencyRepo = null,
    pool = null,
    platformAuthMiddleware,
    requirePlatformRole = defaultRequirePlatformRole,
    sendJson,
    readJsonBody,
}) {
    const adminAuth = async (req, res, next) => {
        await platformAuthMiddleware(req, res, async () => {
            const roles = req.platformUser?.roles || [];
            // Operational platform authority is ADMIN
            const hasAdmin = roles.includes("ADMIN") || roles.includes("SUPER_ADMIN") || roles.includes("PLATFORM_ADMIN");
            if (!hasAdmin) {
                res.statusCode = 403;
                res.setHeader("Content-Type", "application/json");
                return res.end(JSON.stringify({
                    success: false,
                    error: {
                        code: "PLATFORM_ACCESS_DENIED",
                        message: "Admin privilege required.",
                    },
                    meta: { timestamp: new Date().toISOString() },
                }));
            }
            if (typeof next === "function") await next();
        });
    };

    async function handleIdempotentMutation(req, res, actionFn, defaultStatus = 200) {
        const body = await readJsonBody(req);
        const idempotencyKey = req.headers["idempotency-key"] || req.headers["Idempotency-Key"];

        if (!idempotencyKey || !platformIdempotencyRepo || !pool) {
            const result = await actionFn(body);
            return sendJson(res, defaultStatus, result);
        }

        const trimmedKey = String(idempotencyKey).trim();
        const requestHash = computePlatformRequestHash(req.method, req.url, body);
        const actorUserId = req.platformUser.id;

        const client = await pool.connect();
        let reservation;
        try {
            await client.query("BEGIN");
            reservation = await platformIdempotencyRepo.reserveKey(client, {
                actorUserId,
                idempotencyKey: trimmedKey,
                requestHash,
            });
            await client.query("COMMIT");
        } catch (err) {
            await client.query("ROLLBACK").catch(() => {});
            client.release();
            throw err;
        }

        if (!reservation.isNew) {
            client.release();
            const existing = reservation.record;
            if (existing.request_hash !== requestHash) {
                throw ApiError.unprocessableEntity(
                    "Idempotency key has already been used with a different request payload.",
                    "IDEMPOTENCY_KEY_MISMATCH"
                );
            }
            if (existing.status === "PENDING") {
                throw ApiError.conflict(
                    "A request with this idempotency key is currently being processed.",
                    "IDEMPOTENCY_CONFLICT"
                );
            }
            if (existing.status === "COMPLETED") {
                res.setHeader("X-Cache", "IDEMPOTENT-REPLAY");
                return sendJson(res, existing.response_status_code || defaultStatus, existing.response_body);
            }
        }

        let result;
        try {
            result = await actionFn(body);
        } catch (err) {
            await pool.query("DELETE FROM platform_idempotency_keys WHERE id = $1;", [reservation.record.id]).catch(() => {});
            client.release();
            throw err;
        }

        try {
            await platformIdempotencyRepo.completeKey(client, {
                id: reservation.record.id,
                statusCode: defaultStatus,
                responseBody: result,
            });
        } finally {
            client.release();
        }

        return sendJson(res, defaultStatus, result);
    }

    function getAuditContext(req) {
        return {
            actorUserId: req.platformUser?.id || null,
            actorRole: req.platformUser?.role || "ADMIN",
            ipAddress: req.ip || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || null,
            userAgent: req.headers["user-agent"] || null,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // 1. OVERVIEW & HEALTH
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/overview", [adminAuth], async (req, res) => {
        const overview = await platformService.getAdminOverview();
        return sendJson(res, 200, overview);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 2. CUSTOMERS
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/customers", [adminAuth], async (req, res) => {
        const search = req.query.search || null;
        const status = req.query.status || null;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        const customers = await platformService.listCustomers({ search, status, limit, offset });
        return sendJson(res, 200, customers, { limit, offset });
    });

    router.add("GET", "/api/v1/admin/customers/:id", [adminAuth], async (req, res) => {
        const overview = await platformService.getCustomerOverview(req.params.id);
        return sendJson(res, 200, overview);
    });

    router.add("POST", "/api/v1/admin/customers/:id/suspend", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.suspendCustomer(req.params.id, {
                reason: body.reason,
                ...ctx,
            });
        }, 200);
    });

    router.add("POST", "/api/v1/admin/customers/:id/reactivate", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.reactivateCustomer(req.params.id, {
                reason: body.reason,
                ...ctx,
            });
        }, 200);
    });

    router.add("POST", "/api/v1/admin/customers/:id/deactivate", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.deactivateCustomer(req.params.id, {
                reason: body.reason,
                ...ctx,
            });
        }, 200);
    });

    router.add("POST", "/api/v1/admin/connections/:id/disconnect", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.disconnectCustomerConnection(req.params.id, {
                reason: body.reason,
                ...ctx,
            });
        }, 200);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 3. PLANS
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/plans", [adminAuth], async (req, res) => {
        const status = req.query.status || null;
        const plans = await platformService.listPlans({ status });
        return sendJson(res, 200, plans);
    });

    router.add("POST", "/api/v1/admin/plans", [adminAuth], async (req, res) => {
        const body = await readJsonBody(req);
        const ctx = getAuditContext(req);
        const plan = await platformService.createPlan({
            name: body.name,
            price: body.price,
            currency: body.currency,
            durationDays: body.durationDays,
            description: body.description,
            status: body.status,
        }, ctx);
        return sendJson(res, 201, plan);
    });

    router.add("PUT", "/api/v1/admin/plans/:id", [adminAuth], async (req, res) => {
        const body = await readJsonBody(req);
        const ctx = getAuditContext(req);
        const plan = await platformService.updatePlan(req.params.id, body, ctx);
        return sendJson(res, 200, plan);
    });

    router.add("PATCH", "/api/v1/admin/plans/:id/status", [adminAuth], async (req, res) => {
        const body = await readJsonBody(req);
        if (!body.status) throw ApiError.badRequest("status is required", "VALIDATION_ERROR");
        const ctx = getAuditContext(req);
        const plan = await platformService.setPlanStatus(req.params.id, body.status, ctx);
        return sendJson(res, 200, plan);
    });

    router.add("DELETE", "/api/v1/admin/plans/:id", [adminAuth], async (req, res) => {
        const ctx = getAuditContext(req);
        try {
            const deleted = await platformService.deletePlan(req.params.id, ctx);
            return sendJson(res, 200, { deleted: true, id: req.params.id });
        } catch (err) {
            if (err.code === "PLAN_IN_USE") {
                throw ApiError.badRequest(err.message, "PLAN_IN_USE");
            }
            throw err;
        }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 4. SUBSCRIPTIONS
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/subscriptions", [adminAuth], async (req, res) => {
        const tenantId = req.query.tenantId || null;
        const customerUserId = req.query.customerUserId || null;
        const status = req.query.status || null;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        const subs = await platformService.listSubscriptions({ tenantId, customerUserId, status, limit, offset });
        return sendJson(res, 200, subs, { limit, offset });
    });

    router.add("POST", "/api/v1/admin/subscriptions/:id/extend", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.extendSubscription(req.params.id, {
                additionalDays: body.additionalDays,
                reason: body.reason,
            }, ctx);
        }, 200);
    });

    router.add("POST", "/api/v1/admin/customers/:id/subscriptions/grant", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.grantSubscription({
                customerId: req.params.id,
                planId: body.planId,
                reason: body.reason,
            }, ctx);
        }, 201);
    });

    router.add("POST", "/api/v1/admin/subscriptions/grant", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.grantSubscription({
                customerId: body.customerId,
                planId: body.planId,
                reason: body.reason,
            }, ctx);
        }, 201);
    });

    router.add("POST", "/api/v1/admin/subscriptions/:id/cancel", [adminAuth], async (req, res) => {
        return handleIdempotentMutation(req, res, async (body) => {
            const ctx = getAuditContext(req);
            return platformService.cancelSubscription(req.params.id, {
                reason: body.reason,
            }, ctx);
        }, 200);
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 5. PAYMENTS (Query Only - Strictly NO refund endpoints)
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/payments", [adminAuth], async (req, res) => {
        const tenantId = req.query.tenantId || null;
        const customerUserId = req.query.customerUserId || null;
        const status = req.query.status || null;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        const payments = await platformService.listPayments({ tenantId, customerUserId, status, limit, offset });
        return sendJson(res, 200, payments, { limit, offset });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 6. GROUPS ACROSS CUSTOMERS (Operational View)
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/groups", [adminAuth], async (req, res) => {
        const search = req.query.search || null;
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;

        const groups = await platformService.listAdminGroups({ search, limit, offset });
        return sendJson(res, 200, groups, { limit, offset });
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 7. AUDIT LOGS
    // ─────────────────────────────────────────────────────────────────────────
    router.add("GET", "/api/v1/admin/audit", [adminAuth], async (req, res) => {
        const limit = parseInt(req.query.limit, 10) || 50;
        const offset = parseInt(req.query.offset, 10) || 0;
        const action = req.query.action || null;
        const actorUserId = req.query.actorUserId || null;
        const targetType = req.query.targetType || null;
        const targetId = req.query.targetId || null;

        const logs = await platformService.queryAuditLogs({ limit, offset, action, actorUserId, targetType, targetId });
        return sendJson(res, 200, logs, { limit, offset });
    });
}

module.exports = {
    registerAdminRoutes,
};
