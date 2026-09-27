(function() {
    "use strict";

    const state = {
        token: localStorage.getItem("w7_admin_token") || null,
        adminUser: null,
        activeTab: "overview",
        pendingAction: null,
    };

    async function apiFetch(endpoint, options = {}) {
        const headers = {
            "Content-Type": "application/json",
            ...options.headers,
        };

        if (state.token) {
            headers["Authorization"] = "Bearer " + state.token;
        }

        const res = await fetch(endpoint, {
            ...options,
            headers,
        });

        if (res.status === 401 || res.status === 403) {
            if (endpoint.startsWith("/api/v1/admin/")) {
                showLoginModal();
                throw new Error("Unauthorized");
            }
        }

        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
            const msg = data?.error?.message || ("Request failed: " + res.status);
            throw new Error(msg);
        }

        return data;
    }

    function showAlert(message, type) {
        const banner = document.getElementById("alert-banner");
        banner.className = "alert-banner alert-" + (type || "success");
        banner.textContent = message;
        banner.classList.remove("hidden");
        setTimeout(() => {
            banner.classList.add("hidden");
        }, 5000);
    }

    function openModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.remove("hidden");
    }

    function closeModal(id) {
        const m = document.getElementById(id);
        if (m) m.classList.add("hidden");
    }

    function showLoginModal() {
        openModal("modal-login");
    }

    function switchTab(tabId) {
        state.activeTab = tabId;
        document.querySelectorAll(".nav-item").forEach(el => {
            el.classList.toggle("active", el.dataset.tab === tabId);
        });
        document.querySelectorAll(".tab-pane").forEach(el => {
            el.classList.toggle("active", el.id === "tab-" + tabId);
        });
        const titles = {
            overview: "Overview & Telemetry",
            customers: "Customer Management",
            subscriptions: "Subscriptions",
            plans: "Subscription Plans & Pricing",
            payments: "Payment Transactions",
            groups: "Managed Groups",
            audit: "Platform Audit Trail",
        };
        document.getElementById("page-title").textContent = titles[tabId] || "Admin Dashboard";
        loadCurrentTab();
    }

    function loadCurrentTab() {
        if (state.activeTab === "overview") loadOverview();
        else if (state.activeTab === "customers") loadCustomers();
        else if (state.activeTab === "subscriptions") loadSubscriptions();
        else if (state.activeTab === "plans") loadPlans();
        else if (state.activeTab === "payments") loadPayments();
        else if (state.activeTab === "groups") loadGroups();
        else if (state.activeTab === "audit") loadAuditLogs();
    }


    async function loadOverview() {
        try {
            const res = await apiFetch("/api/v1/admin/overview");
            const data = res.data;

            document.getElementById("metric-total-customers").textContent = data.customers.total;
            document.getElementById("metric-customer-breakdown").textContent =
                "Active: " + data.customers.active + " | Suspended: " + data.customers.suspended + " | Deactivated: " + data.customers.deactivated;

            document.getElementById("metric-active-subs").textContent = data.subscriptions.active;
            document.getElementById("metric-expiring-soon").textContent =
                "Expiring (72h): " + data.subscriptions.expiring_soon + " | Expired: " + data.subscriptions.expired;

            document.getElementById("metric-connections").textContent = data.connections.connected;
            document.getElementById("metric-connections-sub").textContent =
                "Connecting: " + data.connections.connecting + " | Disconnected: " + data.connections.disconnected;

            const rev30d = (data.payments.revenue30d !== undefined) ? data.payments.revenue30d : (data.payments.totalRevenue || 0);
            document.getElementById("metric-revenue").textContent =
                new Intl.NumberFormat("en-TZ", { style: "currency", currency: "TZS" }).format(rev30d);
            document.getElementById("metric-payments-count").textContent =
                "30d Success: " + data.payments.successCount + " / Total Tx: " + data.payments.totalCount;

            const auditRes = await apiFetch("/api/v1/admin/audit?limit=5");
            const activityList = document.getElementById("overview-recent-activity");
            if (auditRes.data && auditRes.data.length > 0) {
                activityList.innerHTML = auditRes.data.map(log => 
                    "<li class="activity-item">" +
                    "<div><strong>" + escapeHtml(log.action) + "</strong> - " + escapeHtml(log.target_type) + " (" + escapeHtml(log.target_id || "") + ")" +
                    (log.reason ? "<br><small class="activity-reason">Reason: " + escapeHtml(log.reason) + "</small>" : "") +
                    "</div>" +
                    "<span class="activity-time">" + new Date(log.created_at).toLocaleTimeString() + "</span>" +
                    "</li>"
                ).join("");
            } else {
                activityList.innerHTML = "<li>No recent activity logged.</li>";
            }
        } catch (e) {
            console.error("Failed to load overview:", e);
        }
    }


    async function loadCustomers() {
        const tbody = document.getElementById("customers-table-body");
        tbody.innerHTML = "<tr><td colspan="8" class="text-center">Loading customers...</td></tr>";

        const search = document.getElementById("customers-search").value;
        const status = document.getElementById("customers-status-filter").value;

        const params = new URLSearchParams();
        if (search) params.set("search", search);
        if (status) params.set("status", status);

        try {
            const res = await apiFetch("/api/v1/admin/customers?" + params.toString());
            const list = res.data;

            if (!list || list.length === 0) {
                tbody.innerHTML = "<tr><td colspan="8" class="text-center">No customers found.</td></tr>";
                return;
            }

            tbody.innerHTML = list.map(c => 
                "<tr>" +
                "<td><strong>" + escapeHtml(c.tenant_name || "-") + "</strong></td>" +
                "<td>" + escapeHtml(c.phone_number || "None") + "</td>" +
                "<td>" + escapeHtml(c.email || "-") + "</td>" +
                "<td><span class="badge badge-" + (c.status || "").toLowerCase() + "">" + escapeHtml(c.status) + "</span></td>" +
                "<td>" + (c.subscription_status ? 
                    "<span class="badge badge-" + c.subscription_status.toLowerCase() + "">" + escapeHtml(c.subscription_status) + "</span>" +
                    "<br><small class="text-muted">" + (c.subscription_plan_name || "") + " (" + formatDate(c.subscription_expires_at) + ")</small>"
                    : "<span class="text-muted">No subscription</span>") + "</td>" +
                "<td>" + c.connection_count + "</td>" +
                "<td>" + c.group_count + "</td>" +
                "<td><button class="btn btn-sm btn-secondary" onclick="window.AdminApp.viewCustomer('" + c.tenant_id + "')">Details</button></td>" +
                "</tr>"
            ).join("");
        } catch (e) {
            tbody.innerHTML = "<tr><td colspan="8" class="text-center text-danger">Error: " + escapeHtml(e.message) + "</td></tr>";
        }
    }

    async function viewCustomer(customerId) {
        openModal("modal-customer");
        const body = document.getElementById("cust-modal-body");
        body.innerHTML = "Loading customer overview...";

        try {
            const res = await apiFetch("/api/v1/admin/customers/" + customerId);
            const d = res.data;
            const c = d.customer;
            const s = d.subscription.current;
            const conn = d.connection;

            let actionsHtml = "";
            if (c.status === "ACTIVE") {
                actionsHtml += "<button class="btn btn-sm btn-warning" onclick="window.AdminApp.promptAction('suspendCustomer', '" + c.id + "', 'Suspend Customer Account')">Suspend Customer</button> ";
            } else if (c.status === "SUSPENDED") {
                actionsHtml += "<button class="btn btn-sm btn-primary" onclick="window.AdminApp.promptAction('reactivateCustomer', '" + c.id + "', 'Reactivate Customer Account')">Reactivate Customer</button> ";
            }
            if (c.status !== "DEACTIVATED") {
                actionsHtml += "<button class="btn btn-sm btn-danger" onclick="window.AdminApp.promptAction('deactivateCustomer', '" + c.id + "', 'Deactivate Customer Account')">Deactivate Customer</button> ";
            } else {
                actionsHtml += "<button class="btn btn-sm btn-primary" onclick="window.AdminApp.promptAction('reactivateCustomer', '" + c.id + "', 'Reactivate Customer Account')">Reactivate Customer</button> ";
            }
            actionsHtml += "<button class="btn btn-sm btn-primary" onclick="window.AdminApp.promptGrantSubscription('" + c.id + "')">+ Grant Subscription</button>";

            let connHtml = "<p class="text-muted">No WhatsApp connection configured.</p>";
            if (conn) {
                connHtml = "<p>JID: <strong>" + escapeHtml(conn.jid || "Not bound") + "</strong></p>" +
                    "<p>Actual State: <span class="badge badge-" + (conn.actual_state || "").toLowerCase() + "">" + conn.actual_state + "</span> | Desired: " + conn.desired_state + "</p>" +
                    "<div style="margin-top:10px;">" +
                    "<button class="btn btn-sm btn-danger" onclick="window.AdminApp.promptAction('disconnectConnection', '" + conn.id + "', 'Disconnect WhatsApp Connection')">Force Disconnect WhatsApp</button>" +
                    "</div>";
            }

            let subHtml = "<p class="text-muted">No subscription history found.</p>";
            if (s) {
                subHtml = "<p>Plan: <strong>" + escapeHtml(s.plan_name || "Custom") + "</strong></p>" +
                    "<p>Status: <span class="badge badge-" + (s.status || "").toLowerCase() + "">" + s.status + "</span></p>" +
                    "<p>Expires: <strong>" + formatDate(s.expires_at) + "</strong></p>" +
                    "<div style="margin-top:10px; display:flex; gap:8px;">" +
                    "<button class="btn btn-sm btn-secondary" onclick="window.AdminApp.promptExtendSubscription('" + s.id + "', 3)">Extend +3 Days</button>" +
                    "<button class="btn btn-sm btn-secondary" onclick="window.AdminApp.promptExtendSubscription('" + s.id + "', 7)">Extend +7 Days</button>" +
                    "</div>";
            }

            let groupListHtml = "<p class="text-muted">No managed groups registered.</p>";
            if (d.groups.items.length > 0) {
                groupListHtml = "<ul>" + d.groups.items.map(g => "<li>" + escapeHtml(g.name || g.jid) + " (" + g.memberCount + " members)</li>").join("") + "</ul>";
            }

            body.innerHTML = 
                "<div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:16px;">" +
                "<div><h2>" + escapeHtml(c.name) + "</h2>" +
                "<p class="text-muted">Account ID: " + c.id + "</p>" +
                "<p>Phone: <strong>" + escapeHtml(c.owner?.phone_number || "Not set") + "</strong> | Email: <strong>" + escapeHtml(c.owner?.email || "-") + "</strong></p></div>" +
                "<div><span class="badge badge-" + (c.status || "").toLowerCase() + "">" + escapeHtml(c.status) + "</span></div>" +
                "</div>" +
                "<div style="margin-bottom:16px; display:flex; gap:8px; flex-wrap:wrap;">" + actionsHtml + "</div>" +
                "<div class="panel" style="margin-bottom:16px;"><div class="panel-header"><h3>WhatsApp Connection</h3></div><div class="panel-body">" + connHtml + "</div></div>" +
                "<div class="panel" style="margin-bottom:16px;"><div class="panel-header"><h3>Subscription</h3></div><div class="panel-body">" + subHtml + "</div></div>" +
                "<div class="panel"><div class="panel-header"><h3>Managed Groups (" + d.groups.totalCount + ")</h3></div><div class="panel-body">" + groupListHtml + "</div></div>";
        } catch (e) {
            body.innerHTML = "<div class="alert-banner alert-danger">" + escapeHtml(e.message) + "</div>";
        }
    }


    async function loadSubscriptions() {
        const tbody = document.getElementById("subs-table-body");
        tbody.innerHTML = "<tr><td colspan="8" class="text-center">Loading subscriptions...</td></tr>";

        const status = document.getElementById("subs-status-filter").value;
        const params = new URLSearchParams();
        if (status) params.set("status", status);

        try {
            const res = await apiFetch("/api/v1/admin/subscriptions?" + params.toString());
            const list = res.data;

            if (!list || list.length === 0) {
                tbody.innerHTML = "<tr><td colspan="8" class="text-center">No subscriptions found.</td></tr>";
                return;
            }

            tbody.innerHTML = list.map(s => 
                "<tr>" +
                "<td>" + escapeHtml(s.customer_phone || s.customer_email || s.tenant_id) + "</td>" +
                "<td>" + escapeHtml(s.plan_name || "Custom") + "</td>" +
                "<td>" + s.price_paid + " " + escapeHtml(s.currency) + "</td>" +
                "<td>" + s.duration_days + " days</td>" +
                "<td><span class="badge badge-" + s.status.toLowerCase() + "">" + escapeHtml(s.status) + "</span></td>" +
                "<td>" + formatDate(s.expires_at) + "</td>" +
                "<td>" + formatDate(s.created_at) + "</td>" +
                "<td>" +
                "<button class="btn btn-sm btn-secondary" onclick="window.AdminApp.promptExtendSubscription('" + s.id + "', 3)">+3d</button> " +
                "<button class="btn btn-sm btn-secondary" onclick="window.AdminApp.promptExtendSubscription('" + s.id + "', 7)">+7d</button>" +
                "</td>" +
                "</tr>"
            ).join("");
        } catch (e) {
            tbody.innerHTML = "<tr><td colspan="8" class="text-center text-danger">Error: " + escapeHtml(e.message) + "</td></tr>";
        }
    }

    async function loadPlans() {
        const container = document.getElementById("plans-container");
        container.innerHTML = "<div class="loading-item">Loading plans...</div>";

        try {
            const res = await apiFetch("/api/v1/admin/plans");
            const plans = res.data;

            if (!plans || plans.length === 0) {
                container.innerHTML = "<div>No subscription plans configured. Create one above.</div>";
                return;
            }

            container.innerHTML = plans.map(p => 
                "<div class="plan-card">" +
                "<div class="plan-card-header"><span class="plan-card-title">" + escapeHtml(p.name) + "</span>" +
                "<span class="badge badge-" + p.status.toLowerCase() + "">" + escapeHtml(p.status) + "</span></div>" +
                "<div class="plan-card-price">" + p.price + " " + escapeHtml(p.currency) + "</div>" +
                "<div class="plan-card-duration">" + p.duration_days + " Days validity</div>" +
                "<div class="plan-card-desc">" + escapeHtml(p.description || "No description") + "</div>" +
                "<div class="plan-card-actions">" +
                "<button class="btn btn-sm btn-secondary" onclick="window.AdminApp.showEditPlanModal('" + p.id + "', '" + escapeHtml(p.name) + "', " + p.price + ", '" + escapeHtml(p.currency) + "', " + p.duration_days + ", '" + escapeHtml(p.description || "") + "', '" + p.status + "')">Edit</button> " +
                "<button class="btn btn-sm " + (p.status === "ACTIVE" ? "btn-warning" : "btn-primary") + "" onclick="window.AdminApp.togglePlanStatus('" + p.id + "', '" + (p.status === "ACTIVE" ? "INACTIVE" : "ACTIVE") + "')">" +
                (p.status === "ACTIVE" ? "Deactivate" : "Activate") + "</button>" +
                "</div>" +
                "</div>"
            ).join("");
        } catch (e) {
            container.innerHTML = "<div class="alert-banner alert-danger">" + escapeHtml(e.message) + "</div>";
        }
    }


    async function loadPayments() {
        const tbody = document.getElementById("payments-table-body");
        tbody.innerHTML = "<tr><td colspan="7" class="text-center">Loading payments...</td></tr>";

        const status = document.getElementById("payments-status-filter").value;
        const params = new URLSearchParams();
        if (status) params.set("status", status);

        try {
            const res = await apiFetch("/api/v1/admin/payments?" + params.toString());
            const list = res.data;

            if (!list || list.length === 0) {
                tbody.innerHTML = "<tr><td colspan="7" class="text-center">No payment records.</td></tr>";
                return;
            }

            tbody.innerHTML = list.map(p => 
                "<tr>" +
                "<td><code>" + escapeHtml(p.transaction_reference || p.id.slice(0, 8)) + "</code></td>" +
                "<td>" + escapeHtml(p.customer_phone || p.customer_email || "-") + "</td>" +
                "<td>" + escapeHtml(p.plan_name || "-") + "</td>" +
                "<td><strong>" + p.amount + " " + escapeHtml(p.currency) + "</strong></td>" +
                "<td>" + escapeHtml(p.provider) + "</td>" +
                "<td><span class="badge badge-" + p.status.toLowerCase() + "">" + escapeHtml(p.status) + "</span></td>" +
                "<td>" + formatDate(p.created_at) + "</td>" +
                "</tr>"
            ).join("");
        } catch (e) {
            tbody.innerHTML = "<tr><td colspan="7" class="text-center text-danger">Error: " + escapeHtml(e.message) + "</td></tr>";
        }
    }

    async function loadGroups() {
        const tbody = document.getElementById("groups-table-body");
        tbody.innerHTML = "<tr><td colspan="6" class="text-center">Loading groups...</td></tr>";

        const search = document.getElementById("groups-search").value;
        const params = new URLSearchParams();
        if (search) params.set("search", search);

        try {
            const res = await apiFetch("/api/v1/admin/groups?" + params.toString());
            const list = res.data;

            if (!list || list.length === 0) {
                tbody.innerHTML = "<tr><td colspan="6" class="text-center">No managed groups.</td></tr>";
                return;
            }

            tbody.innerHTML = list.map(g => 
                "<tr>" +
                "<td><strong>" + escapeHtml(g.name || "Unnamed Group") + "</strong></td>" +
                "<td><code>" + escapeHtml(g.jid) + "</code></td>" +
                "<td>" + escapeHtml(g.tenant_name) + "</td>" +
                "<td><span class="badge badge-" + (g.connection_state || "DISCONNECTED").toLowerCase() + "">" + escapeHtml(g.connection_state || "DISCONNECTED") + "</span></td>" +
                "<td>" + g.member_count + "</td>" +
                "<td>" + formatDate(g.created_at) + "</td>" +
                "</tr>"
            ).join("");
        } catch (e) {
            tbody.innerHTML = "<tr><td colspan="6" class="text-center text-danger">Error: " + escapeHtml(e.message) + "</td></tr>";
        }
    }

    async function loadAuditLogs() {
        const tbody = document.getElementById("audit-table-body");
        tbody.innerHTML = "<tr><td colspan="5" class="text-center">Loading audit logs...</td></tr>";

        try {
            const res = await apiFetch("/api/v1/admin/audit?limit=50");
            const logs = res.data;

            if (!logs || logs.length === 0) {
                tbody.innerHTML = "<tr><td colspan="5" class="text-center">No audit entries.</td></tr>";
                return;
            }

            tbody.innerHTML = logs.map(l => 
                "<tr>" +
                "<td>" + formatDate(l.created_at) + "</td>" +
                "<td><strong>" + escapeHtml(l.action) + "</strong></td>" +
                "<td>" + escapeHtml(l.actor_role) + " (" + escapeHtml(l.actor_user_id ? l.actor_user_id.slice(0, 8) : "SYSTEM") + ")</td>" +
                "<td>" + escapeHtml(l.target_type) + ":" + escapeHtml(l.target_id) + "</td>" +
                "<td>" + escapeHtml(l.reason || JSON.stringify(l.metadata || {})) + "</td>" +
                "</tr>"
            ).join("");
        } catch (e) {
            tbody.innerHTML = "<tr><td colspan="5" class="text-center text-danger">Error: " + escapeHtml(e.message) + "</td></tr>";
        }
    }


    function promptAction(type, targetId, title) {
        state.pendingAction = { type, targetId };
        document.getElementById("reason-modal-title").textContent = title;
        document.getElementById("reason-modal-prompt").textContent = "Please enter the mandatory reason for " + title.toLowerCase() + ":";
        document.getElementById("reason-modal-extra-fields").innerHTML = "";
        document.getElementById("action-reason-input").value = "";
        openModal("modal-reason-action");
    }

    function promptExtendSubscription(subId, days) {
        state.pendingAction = { type: "extendSubscription", targetId: subId, additionalDays: days };
        document.getElementById("reason-modal-title").textContent = "Extend Subscription +" + days + " Days";
        document.getElementById("reason-modal-prompt").textContent = "Please enter the mandatory reason for extending this subscription by " + days + " days:";
        document.getElementById("reason-modal-extra-fields").innerHTML = "";
        document.getElementById("action-reason-input").value = "";
        openModal("modal-reason-action");
    }

    async function promptGrantSubscription(customerId) {
        state.pendingAction = { type: "grantSubscription", targetId: customerId };
        document.getElementById("reason-modal-title").textContent = "Manual Subscription Grant";
        document.getElementById("reason-modal-prompt").textContent = "Select authoritative plan and provide mandatory reason:";
        
        document.getElementById("reason-modal-extra-fields").innerHTML = 
            '<div class="form-group">' +
            '<label>Select Plan (Authoritative Duration):</label>' +
            '<select id="grant-plan-select" class="form-control"><option value="">-- Loading plans... --</option></select>' +
            '</div>';
        document.getElementById("action-reason-input").value = "";
        openModal("modal-reason-action");

        try {
            const plansRes = await apiFetch("/api/v1/admin/plans?status=ACTIVE");
            const plans = plansRes.data || [];
            const selectEl = document.getElementById("grant-plan-select");
            if (selectEl) {
                if (plans.length === 0) {
                    selectEl.innerHTML = "<option value=\"\">No active plans found</option>";
                } else {
                    selectEl.innerHTML = plans.map(p => 
                        '<option value="' + p.id + '">' + escapeHtml(p.name) + ' (' + p.duration_days + ' days - ' + p.price + ' ' + p.currency + ')</option>'
                    ).join("");
                }
            }
        } catch (err) {
            const selectEl = document.getElementById("grant-plan-select");
            if (selectEl) selectEl.innerHTML = "<option value=\"\">Failed to load plans</option>";
        }
    }

    async function submitReasonAction() {
        const reason = document.getElementById("action-reason-input").value.trim();
        if (!reason) {
            alert("A mandatory reason is required for administrative actions.");
            return;
        }

        if (!state.pendingAction) return;
        const { type, targetId, additionalDays } = state.pendingAction;

        try {
            if (type === "suspendCustomer") {
                await apiFetch("/api/v1/admin/customers/" + targetId + "/suspend", {
                    method: "POST",
                    body: JSON.stringify({ reason }),
                });
                showAlert("Customer suspended successfully.");
            } else if (type === "reactivateCustomer") {
                await apiFetch("/api/v1/admin/customers/" + targetId + "/reactivate", {
                    method: "POST",
                    body: JSON.stringify({ reason }),
                });
                showAlert("Customer reactivated successfully.");
            } else if (type === "deactivateCustomer") {
                await apiFetch("/api/v1/admin/customers/" + targetId + "/deactivate", {
                    method: "POST",
                    body: JSON.stringify({ reason }),
                });
                showAlert("Customer deactivated successfully.");
            } else if (type === "disconnectConnection") {
                await apiFetch("/api/v1/admin/connections/" + targetId + "/disconnect", {
                    method: "POST",
                    body: JSON.stringify({ reason }),
                });
                showAlert("Connection force-disconnected successfully.");
            } else if (type === "extendSubscription") {
                await apiFetch("/api/v1/admin/subscriptions/" + targetId + "/extend", {
                    method: "POST",
                    body: JSON.stringify({ additionalDays, reason }),
                });
                showAlert("Subscription extended by " + additionalDays + " days.");
            } else if (type === "grantSubscription") {
                const planId = document.getElementById("grant-plan-select") ? document.getElementById("grant-plan-select").value : null;
                if (!planId) {
                    alert("Please select a plan to grant.");
                    return;
                }
                await apiFetch("/api/v1/admin/customers/" + targetId + "/subscriptions/grant", {
                    method: "POST",
                    body: JSON.stringify({ planId, reason }),
                });
                showAlert("Subscription granted successfully according to authoritative plan duration.");
            }

            closeModal("modal-reason-action");
            closeModal("modal-customer");
            loadCurrentTab();
        } catch (e) {
            alert("Action failed: " + e.message);
        }
    }

    function showNewPlanModal() {
        document.getElementById("plan-form-id").value = "";
        document.getElementById("plan-modal-title").textContent = "Create Subscription Plan";
        document.getElementById("plan-name").value = "";
        document.getElementById("plan-price").value = "";
        document.getElementById("plan-currency").value = "TZS";
        document.getElementById("plan-duration").value = "30";
        document.getElementById("plan-description").value = "";
        document.getElementById("plan-status").value = "ACTIVE";
        openModal("modal-plan");
    }

    function showEditPlanModal(id, name, price, currency, durationDays, description, status) {
        document.getElementById("plan-form-id").value = id;
        document.getElementById("plan-modal-title").textContent = "Edit Subscription Plan";
        document.getElementById("plan-name").value = name;
        document.getElementById("plan-price").value = price;
        document.getElementById("plan-currency").value = currency;
        document.getElementById("plan-duration").value = durationDays;
        document.getElementById("plan-description").value = description;
        document.getElementById("plan-status").value = status;
        openModal("modal-plan");
    }

    async function savePlan() {
        const id = document.getElementById("plan-form-id").value;
        const name = document.getElementById("plan-name").value.trim();
        const price = parseFloat(document.getElementById("plan-price").value);
        const currency = document.getElementById("plan-currency").value.trim();
        const durationDays = parseInt(document.getElementById("plan-duration").value, 10);
        const description = document.getElementById("plan-description").value.trim();
        const status = document.getElementById("plan-status").value;

        if (!name || isNaN(price) || price < 0 || isNaN(durationDays) || durationDays <= 0) {
            alert("Please enter valid plan name, non-negative price, and positive duration.");
            return;
        }

        try {
            if (id) {
                await apiFetch("/api/v1/admin/plans/" + id, {
                    method: "PUT",
                    body: JSON.stringify({ name, price, currency, durationDays, description, status }),
                });
                showAlert("Plan updated successfully.");
            } else {
                await apiFetch("/api/v1/admin/plans", {
                    method: "POST",
                    body: JSON.stringify({ name, price, currency, durationDays, description, status }),
                });
                showAlert("Plan created successfully.");
            }
            closeModal("modal-plan");
            loadPlans();
        } catch (e) {
            alert("Failed to save plan: " + e.message);
        }
    }

    async function togglePlanStatus(id, newStatus) {
        try {
            await apiFetch("/api/v1/admin/plans/" + id + "/status", {
                method: "PATCH",
                body: JSON.stringify({ status: newStatus }),
            });
            showAlert("Plan status updated to " + newStatus);
            loadPlans();
        } catch (e) {
            alert("Failed to update status: " + e.message);
        }
    }

    async function doLogin() {
        const identifier = document.getElementById("login-identifier").value.trim();
        const password = document.getElementById("login-password").value;
        const errBanner = document.getElementById("login-error-banner");

        errBanner.classList.add("hidden");

        if (!identifier || !password) {
            errBanner.textContent = "Identifier and password required.";
            errBanner.classList.remove("hidden");
            return;
        }

        try {
            const res = await fetch("/api/v1/auth/login", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ identifier, password }),
            });
            const data = await res.json();
            if (!res.ok) {
                throw new Error(data?.error?.message || "Login failed");
            }

            state.token = data.data.accessToken;
            localStorage.setItem("w7_admin_token", state.token);
            closeModal("modal-login");
            showAlert("Logged in as Admin.");
            initApp();
        } catch (e) {
            errBanner.textContent = e.message;
            errBanner.classList.remove("hidden");
        }
    }

    function doLogout() {
        state.token = null;
        localStorage.removeItem("w7_admin_token");
        showLoginModal();
    }

    function formatDate(dt) {
        if (!dt) return "-";
        return new Date(dt).toLocaleString();
    }

    function escapeHtml(str) {
        if (str === null || str === undefined) return "";
        return String(str)
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function initApp() {
        if (!state.token) {
            showLoginModal();
            return;
        }

        const hash = window.location.hash.replace("#", "") || "overview";
        switchTab(hash);
    }

    document.addEventListener("DOMContentLoaded", () => {
        document.querySelectorAll(".nav-item").forEach(el => {
            el.addEventListener("click", e => {
                e.preventDefault();
                switchTab(el.dataset.tab);
            });
        });

        document.getElementById("btn-refresh")?.addEventListener("click", () => loadCurrentTab());
        document.getElementById("btn-logout")?.addEventListener("click", doLogout);
        document.getElementById("btn-search-customers")?.addEventListener("click", () => loadCustomers());
        document.getElementById("customers-status-filter")?.addEventListener("change", () => loadCustomers());
        document.getElementById("subs-status-filter")?.addEventListener("change", () => loadSubscriptions());
        document.getElementById("payments-status-filter")?.addEventListener("change", () => loadPayments());
        document.getElementById("btn-search-groups")?.addEventListener("click", () => loadGroups());
        document.getElementById("btn-submit-reason-action")?.addEventListener("click", submitReasonAction);
        document.getElementById("btn-save-plan")?.addEventListener("click", savePlan);
        document.getElementById("btn-do-login")?.addEventListener("click", doLogin);

        initApp();
    });

    window.AdminApp = {
        navigate: switchTab,
        closeModal,
        viewCustomer,
        promptAction,
        promptExtendSubscription,
        promptGrantSubscription,
        showNewPlanModal,
        showEditPlanModal,
        togglePlanStatus,
    };
})();
