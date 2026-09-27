# Windowseven MD — Customer Product Rules

This document establishes the authoritative product rules and architectural boundaries for the Windowseven Customer Product Layer.

---

## 1. Customer Account & Authentication Model

### Registration Contract
* **Required Inputs**:
  * `phone_number` (Format: E.164 or valid national phone, e.g., `0766183998` / `+255766183998`)
  * `email` (Standard valid RFC 5322 email syntax)
  * `password` (Argon2id compliant with password security policy)
* **Identity Roles**:
  * **Email**: The primary authentication identifier for logins, security notices, and password resets.
  * **Phone Number**: The customer contact identifier and Windowseven / WhatsApp operating context.
  * **Account / Tenant**: The authoritative authorization and ownership boundary.

### Login Contract
* **Credentials**: Strictly **Email + Password**.
* **Prohibition**: **Phone-number login is strictly prohibited.** Phone numbers must never be used as authentication passwords or credentials.

### Atomicity & Tenant Provisioning
* Registration must atomically execute within a single PostgreSQL transaction:
  1. Create `users` entity (`email`, `phone_number`, `password_hash`).
  2. Create `tenants` entity representing the customer account.
     * **Tenant Naming Strategy**: The tenant name is derived cleanly as `Customer <phone_number>` or `<user_name>` (e.g. `Customer 0766183998`). It is **never** stored as a raw unadorned phone number.
  3. Create `tenant_memberships` entity assigning the user as `OWNER`.
* **Zero Duplicate Accounts**: Both `email` (case-insensitive) and `phone_number` must be unique across the platform.

---

## 2. One WhatsApp Connection Invariant

* **The Business Rule**:
  ```text
  ONE CUSTOMER ACCOUNT (TENANT)
             =
  EXACTLY ONE WHATSAPP CONNECTION
  ```
* **Application Layer**:
  * `ConnectionService.createConnection({ tenantId })` checks if an existing connection already exists for the customer tenant.
  * If a connection exists (regardless of its state), `createConnection` returns the existing connection rather than allocating a new connection record.
* **Database Layer Invariant**:
  * To prevent concurrent race conditions (`check → insert`), the database schema should enforce a unique constraint on `tenant_id` in `whatsapp_connections`:
    ```sql
    CREATE UNIQUE INDEX IF NOT EXISTS uq_whatsapp_connections_tenant_unique
    ON whatsapp_connections (tenant_id);
    ```
  * This guarantees that even concurrent API requests cannot allocate multiple active WhatsApp connections to the same customer account.

---

## 3. Contextual Group Permissions & Role Separation

A Windowseven customer who connects their WhatsApp identity may participate across dozens of private chats and WhatsApp groups.

### Core Principle
```text
Customer Account Owner ≠ WhatsApp Group Admin
```

* **Contextual Evaluation**: Permissions are evaluated dynamically per-chat and per-message:
  ```text
  Customer Subscription Active
  +
  WhatsApp Connection Healthy
  +
  Current Chat Context (Group JID vs DM JID)
  +
  Sender's Role in that Group (Member vs Group Admin)
  +
  Bot's Role in that Group (Participant vs Group Admin)
  +
  Command Capability (Moderation vs Personal Utility)
  +
  Group Policy (Managed vs Unmanaged)
  ───────────
  → ALLOW or DENY
  ```
* **Personal Utilities (`.vv`, `.ping`, `.sticker`, etc.)**:
  * Do **NOT** require group-admin or bot-admin privileges.
  * Usable by any group participant or direct-message participant as long as the customer's subscription is `ACTIVE`.
* **Group Management Commands (`.kick`, `.mute`, `.tagall`, etc.)**:
  * Require the sender to be an authenticated admin in that specific group.
  * Moderation commands modifying participants (`.kick`, `.mute`, `.promote`) strictly require the connected bot to have WhatsApp group-admin status.

---

## 4. Subscriptions & Authoritative Pricing

### Subscription Ownership
* The subscription belongs to the **Customer Account (Tenant)**, NOT to individual WhatsApp groups or individual phone numbers.
* A single customer subscription empowers the connected bot to operate across all groups where it participates.

### Authoritative Server-Side Pricing
* The frontend/client is **never** authoritative for:
  * `price`
  * `currency`
  * `duration_days`
* The client submits only:
  ```json
  {
    "planId": "uuid-here"
  }
  ```
* The backend resolves the plan from the database (`PlanRepository`), loads the authoritative price, currency, and duration, and calculates payment requirements. Any client-submitted amounts are discarded.

---

## 5. Subscription Renewal Semantics

### Deterministic Remaining-Time Preservation
* If a customer renews an already-active subscription with time remaining:
  $$\text{New Expiry} = \text{Current Expiry} + \text{Plan Duration}$$
* The system **never** truncates remaining time by setting $\text{New Expiry} = \text{NOW} + \text{Plan Duration}$.
* *Example*: If a customer has 18 days remaining on a 30-day plan and purchases another 7-day plan, their new expiration is $18 + 7 = 25\text{ days}$ remaining.
* If the subscription is already `EXPIRED`:
  $$\text{New Expiry} = \text{NOW} + \text{Plan Duration}$$

### Immutable Purchase History
* Every subscription activation must snapshot:
  * `plan_id`
  * `price_paid`
  * `currency`
  * `duration_days`
  * `started_at`
  * `expires_at`
* Future price or duration changes made by the Admin to a plan never alter previously activated customer subscriptions.

---

## 6. Subscription Expiry Lifecycle

### At Expiry
* `customer_subscriptions.status` transitions to `EXPIRED`.
* **Critical Invariant**: The WhatsApp socket **remains connected**. Windowseven does **NOT** disconnect or terminate the customer's WhatsApp socket merely because the subscription expired.
* Inbound bot commands are blocked fail-closed by `ApplicationPipeline.js`.
* When a command is triggered on an expired account, the bot replies politely:
  `"⚠️ Your Windowseven subscription has expired. Please renew your subscription to continue using bot commands."`

### Upon Renewal
* Successful payment verification transitions subscription to `ACTIVE`.
* Bot commands **immediately resume working**.
* The customer does **NOT** need to scan a QR code, enter a pairing code, or reconnect WhatsApp.

### Expiry Notifications
* Customers receive automated reminders:
  1. **3 Days Before Expiry**: Early renewal notice.
  2. **24 Hours Before Expiry**: Urgent renewal reminder.
  3. **At Expiry**: Expiry notification with renewal instructions.
* Notifications must be recorded in `subscription_notifications` to ensure **strict idempotency** (zero duplicate alerts).
* Notifications are delivered privately to the customer account owner, avoiding unsolicited group spam.

---

## 7. Platform Role Model

* The platform operational model consists strictly of two roles:
  ```text
  WINDOWSEVEN
  ├── CUSTOMER
  └── ADMIN
  ```
* There is **no** `SUPER_ADMIN` or `PLATFORM_ADMIN` in the operational business layer.
* The Admin is the sole operational authority.
* **Terminal Deactivation**:
  * `DEACTIVATED` is terminal.
  * Any request attempting `DEACTIVATED → ACTIVE` must be rejected with `400 TENANT_DEACTIVATED`.
  * Administrative reactivation is permitted exclusively for `SUSPENDED → ACTIVE`.

---

## 8. Zero Refund Surface

* In Windowseven V1, refunds are strictly **out of scope**.
* The system must contain:
  * Zero refund API routes
  * Zero refund buttons in UI
  * Zero refund database schemas
  * Zero refund background tasks
  * Zero refund chat commands
