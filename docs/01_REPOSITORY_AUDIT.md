# 01 — Repository Audit & Architectural Assessment
**Project**: Windowseven MD (Transforming legacy single-tenant bot into a multi-tenant SaaS platform)  
**Date**: September 2026  
**Auditor**: Senior Staff Backend Engineer, Software Architect & Security Engineer  
**Status**: AUDIT COMPLETE — BASELINE ESTABLISHED

---

## 1. Executive Summary & Current Architecture

The inspected repository is currently a **single-tenant, monolithic Node.js WhatsApp bot** derived from the *Knight Bot / XeonBot* open-source distribution. The codebase is designed exclusively for a single user running on a local terminal or a low-cost game/bot hosting panel (e.g. Katabump, Bot-hosting.net, VPS).

```text
[ Incoming WhatsApp Event ]
           │
           ▼
     [ index.js ]  (Single Baileys Socket: startXeonBotInc)
           │
           ▼
     [ main.js ]   (1269-line monolithic router & switch-case)
      ┌────┴──────────────────────────┬────────────────────────┐
      ▼                               ▼                        ▼
[ Moderation ]                [ 101 Commands ]         [ Flat JSON Files ]
(antilink, antibadword)    (commands/*.js, tightly     (./data/*.json,
                            coupled to single socket)   baileys_store.json)
```

The system relies entirely on:
- A single global Baileys socket instance (`XeonBotInc`).
- In-memory and local disk JSON persistence (`data/*.json`, `./session`, `./baileys_store.json`).
- Hardcoded personal credentials, telephone numbers, and third-party API keys.
- Ad-hoc authorization checking matching sender strings against a static `settings.ownerNumber` and `data/owner.json`.

---

## 2. Runtime Entry Points & Process Lifecycle

### Entry Points
- **`index.js`**: The primary execution entry point. Initializes global configuration, launches memory checks, binds store listeners, initializes the Baileys connection via `startXeonBotInc()`, and handles top-level process exceptions (`uncaughtException`, `unhandledRejection`).
- **`package.json` Scripts**:
  - `start`: `node index.js`
  - `start:optimized`: `node --max-old-space-size=512 --optimize-for-size --gc-interval=100 index.js`
  - `cleanup`: `node cleanup.js` (*Broken: `cleanup.js` does NOT exist in the repository*)
  - `reset-session`: `node reset-session.js` (*Broken: `reset-session.js` does NOT exist in the repository*)
  - `start:clean` / `start:fresh`: References broken cleanup scripts.
  - `docker:build`: Syntactically invalid docker build command string (`docker build -t docker run -e SESSION_ID=$SESSION_ID knightbot`).
  - `test`: `"echo \"Error: no test specified\" && exit 1"` (Zero test coverage).

### Process Management & Watchers
- `index.js` contains a file watcher (`fs.watchFile(__filename)`) that deletes `require.cache` and re-requires itself on file change—an anti-pattern in production environments that causes memory leaks and socket disconnect loops.
- Aggressive memory exit: An interval checks `process.memoryUsage().rss / 1024 / 1024 > 400`. If exceeded, it abruptly invokes `process.exit(1)`, assuming an external panel (like Pterodactyl) will restart it.

---

## 3. WhatsApp Lifecycle & Connection Management

The connection lifecycle is handled in a single async function `startXeonBotInc()` inside `index.js`:
1. **Version Fetching**: `fetchLatestBaileysVersion()` queries WhatsApp's web client version dynamically.
2. **Auth State Loading**: Uses Baileys `useMultiFileAuthState('./session')`.
3. **Socket Instantiation**: Calls `makeWASocket({...})` with hardcoded options (`Ubuntu / Chrome / 20.0.04`).
4. **Lifecycle Events**:
   - `connection.update`:
     - If `qr`: Logs to console (cannot be consumed by an API/web dashboard).
     - If `connecting`: Logs connecting state.
     - If `open`: Sends an automated broadcast message to the bot's own number including promotional channel metadata (`newsletterJid: 120363161513685998@newsletter`).
     - If `close`: Inspects `DisconnectReason`. If logged out (`401`), it invokes `rmSync('./session', { recursive: true, force: true })` and halts. If temporary error, delays 5000ms and calls `startXeonBotInc()` recursively.
   - `call`: Automatically rejects incoming calls and calls `updateBlockStatus(callerJid, 'block')` if `.anticall` is active.
   - `group-participants.update`: Delegated directly to `handleGroupParticipantUpdate()`.
   - `messages.upsert`: Delegated directly to `handleMessages()`.

---

## 4. Authentication & Session Mechanism

- **Storage Location**: Local directory `./session/`.
- **Implementation**: Baileys `useMultiFileAuthState()`.
- **Credentials & Keys**: Writes keys (`pre-key-*.json`, `session-*.json`, `creds.json`, `app-state-sync-*.json`) directly as loose files in the filesystem.
- **Pairing Code / Linking**:
  - Checks `pairingCode = !!phoneNumber || process.argv.includes("--pairing-code")`.
  - In an interactive TTY, creates a `readline.createInterface` and prompts via CLI: `Please type your WhatsApp number 😍`.
  - In a non-interactive environment, falls back to `settings.ownerNumber || phoneNumber` (`911234567890`).
  - Calls `XeonBotInc.requestPairingCode(phoneNumber)` and outputs the formatted code to stdout.
- **Multi-Tenant Flaw**: This model can only support **one single WhatsApp account** per running OS process. There is no isolation, no database backing, and no mechanism for an external web user to trigger or receive a pairing code over HTTP/SSE.

---

## 5. Command Architecture

- **Dispatcher**: `main.js` contains a single 1,269-line function `handleMessages(sock, messageUpdate, printLog)` containing a gigantic `switch (true)` statement.
- **Quantity**: 101 distinct command files in `commands/*.js`.
- **Interface & Coupling**:
  - Commands do not share a common interface or DTO structure.
  - Arguments are passed haphazardly: e.g., `simageCommand(sock, quotedMessage, chatId)`, `kickCommand(sock, chatId, senderId, mentionedJidListKick, message)`, `muteCommand(sock, chatId, senderId, message, muteDuration)`.
  - Commands directly interact with the raw Baileys `sock` to send messages, react, upload files, and modify group metadata.
  - Many commands directly import `settings.js` (`const settings = require('../settings')`) or read `./data/` JSON files.
  - No return values: commands execute side-effects directly on the socket, making unit testing impossible without mocking all of Baileys and the WhatsApp network.

---

## 6. Event Architecture

Events are listened to directly on `XeonBotInc.ev` in `index.js`:
- `creds.update` -> `saveCreds`
- `messages.upsert` -> `handleMessages`
- `contacts.update` -> `store.contacts`
- `connection.update` -> connection logging and restart loop
- `call` -> anticall block handler
- `group-participants.update` -> `handleGroupParticipantUpdate`
- `status.update` -> `handleStatus`
- `messages.reaction` -> `handleStatus`

There is **no event abstraction**, no domain events, no queueing, and no normalization. An incoming Baileys raw proto message is parsed on the fly inside `main.js`.

---

## 7. Persistence & State Storage

The repository uses **zero database engines**. All persistence is accomplished via loose JSON files:

| File Path | Purpose | Concurrency / Safety Issues |
| :--- | :--- | :--- |
| `data/userGroupData.json` | Toggles for antilink, antibadword, welcome, goodbye, chatbot, warnings, sudo | Synchronous `readFileSync`/`writeFileSync`; race conditions corrupt JSON on rapid concurrent messages |
| `data/warnings.json` | User warning counts per group | Direct file write on every `.warn` invocation |
| `data/banned.json` | List of banned user JIDs | Loaded and parsed synchronously |
| `data/messageCount.json` | Bot public/private mode and message stats | Written to synchronously on every `.mode` toggle |
| `data/owner.json` | Array of owner phone numbers | Hardcoded numbers committed in git |
| `data/premium.json` | List of premium users | Hardcoded numbers committed in git |
| `data/antidelete.json` | Antidelete toggle status | Flat file configuration |
| `data/autoStatus.json` | Auto-status read/reaction toggles | Flat file configuration |
| `data/autoread.json` | Auto-read incoming message toggles | Flat file configuration |
| `data/autotyping.json` | Auto-typing presence simulation | Flat file configuration |
| `./baileys_store.json` | Lightweight message cache (last 20 msgs per chat) | Flushed every 10s via `setInterval` |

---

## 8. Current Authorization Logic

Authorization is completely ad-hoc and split across two uncoordinated mechanisms:

### A. Bot Owner / Sudo Authorization ([`lib/isOwner.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/isOwner.js) & [`lib/index.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/index.js))
- Compares sender string against `settings.ownerNumber` (`919876543210@s.whatsapp.net`).
- Compares against entries in `data/owner.json`.
- Compares sender LID against bot's LID in `sock.user.lid`.
- Checks `data.sudo` array in `data/userGroupData.json`.
- **Flaw**: Identity is derived purely from WhatsApp JID/phone number. There is no concept of a SaaS User, API Token, Tenant, or Role-Based Access Control (RBAC).

### B. WhatsApp Group Admin Authorization ([`lib/isAdmin.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/isAdmin.js))
- Calls `sock.groupMetadata(chatId)`.
- Scans `participants` to determine if sender has `admin === 'admin' || 'superadmin'` and if the bot itself is admin.
- **Flaws & Inconsistencies**:
  - In `commands/kick.js`: Line 4: `const isOwner = message.key.fromMe; if (!isOwner) { ... }` — bypasses admin check if message is from the bot's own number, even if the bot is NOT an admin in the group, causing unhandled Baileys API rejections.
  - In `commands/promote.js`: Line 1 imports `const { isAdmin } = require('../lib/isAdmin');`, but `lib/isAdmin.js` exports the function directly (`module.exports = isAdmin`). The destructuring yields `undefined`. It only works because `main.js` performed a separate check beforehand.

---

## 9. Global Mutable State

Global pollution is widespread throughout the application:
```javascript
// Found in index.js, main.js, config.js:
global.botname = "KNIGHT BOT"
global.themeemoji = "•"
global.phoneNumber = ...
global.packname = settings.packname
global.author = settings.author
global.channelLink = "https://whatsapp.com/channel/..."
global.ytch = "Mr Unique Hacker"
global.APIs = { ... }
global.APIKeys = { ... }
```
- In-memory singletons: `store` in `lib/lightweight_store.js`, module-level `antiCallNotified` Set in `index.js`, module-level `customTemp` in `main.js`.
- If two WhatsApp connections were instantiated in this process, they would collide and overwrite each other's global settings, store messages, and API configurations.

---

## 10. Security Findings & Vulnerabilities

| Severity | Issue | Detail / Location |
| :--- | :--- | :--- |
| **CRITICAL** | Exposed API Keys in Source Code | OpenWeather API key (`4902c0f2550f58298ad4146a92b65e10`), NewsAPI key (`dcd720a6f1914e2d9dba9790c188c08c`), PrinceTech key (`prince_tech_api_azfsbshfb`), Giphy key (`qnl7ssQChTdPjsKta2Ax2LMaGXz303tq`), and XTeam/LolHuman keys hardcoded in `settings.js`, `config.js`, and `commands/*.js`. |
| **CRITICAL** | Arbitrary Shell Execution & Remote Overwrites | `commands/update.js` executes `git reset --hard`, `git clean -fd`, and downloads remote `.zip` archives from GitHub to overwrite local files at runtime. |
| **CRITICAL** | Destructive Session Wipe | `commands/clearsession.js` directly deletes session files from `./session` on disk via chat command. In multi-tenant, this would destroy active user sessions. |
| **HIGH** | Committed Personal Phone Numbers | Real phone numbers hardcoded in `data/owner.json`, `data/premium.json`, `settings.js`, and `index.js`. Visible in git history. |
| **HIGH** | Unsanitized File Paths & Temp Overflow | `main.js` redirects temp storage to `./temp` and unlinks files based on age, but multiple commands download media to `./tmp` without unique prefixes or sanitization. |
| **HIGH** | Mandatory Channel / Newsletter Spoofing | Outgoing messages inject forced newsletter forward headers (`newsletterJid: '120363161513685998@newsletter'`), spamming users with the legacy author's WhatsApp channel. |
| **MEDIUM** | In-Memory Timers for Timed Actions | `.mute <minutes>` relies on Node.js `setTimeout()`. If process restarts, the group remains permanently muted. |
| **MEDIUM** | Denial of Service via RegExp | Several regexes in `lib/antilink.js` and `commands/` lack length boundaries and are susceptible to ReDoS. |

---

## 11. Existing Tests

- Automated test files: **0 found**.
- `npm test` script: Fails immediately with exit code 1 (`Error: no test specified`).
- Testing framework: None installed (no Jest, Mocha, Vitest, or Supertest in `package.json`).

---

## 12. Feature Inventory & Classification

| Feature / Command | Purpose | Quality / State | Classification |
| :--- | :--- | :--- | :--- |
| **warn / warnings** | Track strikes against group members, kick on limit | Working, but tied to `warnings.json` | **MIGRATE (Tier 1)** |
| **antilink** | Detect links, delete message, kick/warn offender | Working, but regex and config in JSON | **MIGRATE (Tier 1)** |
| **mute / unmute** | Silence group or timed silence | Working, but timer lost on restart | **MIGRATE (Tier 1)** |
| **kick / promote / demote** | Group membership administration | Working, but fragile admin checks | **MIGRATE (Tier 1)** |
| **welcome / goodbye** | Greet arriving and leaving group members | Working, reads config from JSON | **MIGRATE (Tier 1)** |
| **antibadword** | Filter prohibited terms | Working, reads from JSON | **REFACTOR** |
| **antidelete** | Forward deleted messages to owner DM | Hardcoded to forward to single owner | **REFACTOR** |
| **sticker / simage / crop** | Convert images/videos to WebP stickers | Solid ffmpeg/sharp pipeline in `lib/exif` | **KEEP / ISOLATE** |
| **downloaders (yt, ig, fb)** | Fetch audio/video from social media | High churn, external API dependent | **REFACTOR / ADAPTER** |
| **ai (gpt, gemini, imagine)** | Query AI endpoints | Uses third-party scraped APIs | **REFACTOR** |
| **games (tictactoe, trivia)** | Chat-based games | Working, in-memory state | **EVALUATE** |
| **update.js** | Self-updating bot via git/zip | Severe security vulnerability | **REMOVE** |
| **clearsession.js** | Deletes local auth keys | Dangerous file-system hack | **REMOVE** |

---

## 13. Legacy Assumptions

1. **Single WhatsApp Connection**: The runtime assumes exactly one WhatsApp session exists in `./session`.
2. **Global Identity**: All messages are attributed to a single bot name ("Knight Bot") owned by one phone number.
3. **Interactive Terminal Setup**: Assumes someone is sitting at a console terminal to answer `readline` prompts for pairing.
4. **Local File Persistence**: Assumes server filesystem is permanent and local JSON files can serve as a database.
5. **No Tenant Concept**: Groups belong to whoever adds the bot; the bot cannot distinguish whether a group belongs to Customer A or Customer B.

---

## 14. Multi-Tenancy Blockers

1. **Storage of Auth Credentials**: `useMultiFileAuthState('./session')` stores everything in one directory. Must be replaced with a database-backed or connection-scoped store (`whatsapp_auth_credentials` and `whatsapp_signal_keys` in PostgreSQL).
2. **Global Socket Reference**: Passing a single `sock` everywhere prevents managing multiple concurrent tenant connections.
3. **Hardcoded Settings Singleton**: Commands import `settings.js` directly instead of receiving a tenant/connection execution context.
4. **Unpartitioned Group Data**: In `data/userGroupData.json`, groups are keyed solely by their WhatsApp JID (`groupId`). If Tenant A and Tenant B both manage different groups (or even the same group), there is no `tenant_id` scope.
5. **Absence of HTTP API**: The current application is a standalone background daemon with no HTTP server, no authentication endpoints, and no SSE streams.

---

## 15. Recommended Migration Sequence

```text
Phase 1: Repository Audit [COMPLETE]
   ↓
Phase 2: Identity & Security Foundation
   - Rebrand to Windowseven MD, sanitize package.json/README, purge hardcoded secrets to .env
   ↓
Phase 3: Multi-Tenant Data Foundation
   - Set up PostgreSQL schema (Prisma/Knex/Drizzle) for User, Tenant, Connection, Group, Policy, AuditLog
   - Implement tenant isolation repositories & unit tests
   ↓
Phase 4: ConnectionManager & DB-Backed Auth State
   - Create ConnectionManager to manage pool of Map<connectionId, BaileysSocket>
   - Implement PostgreSQL-backed Baileys auth state (replacing useMultiFileAuthState)
   - Implement restart recovery and SSE events for QR / Pairing
   ↓
Phase 5: Event Pipeline & Scoped Context
   - WhatsApp -> EventAdapter -> Connection -> Tenant -> Group -> Policy Engine
   ↓
Phase 6: Business Logic Migration (Tier 1)
   - Migrate WarningService, AntilinkService, ModerationService (kick, mute, promote, demote)
   - Commands become thin adapters over application services
   ↓
Phase 7: Windowseven REST API (/api/v1)
   - Express/Fastify API: /auth, /tenants, /connections, /groups, /policies, /moderation
   ↓
Phase 8: End-to-End Testing & Hardening
   - Multi-tenant isolation verification, dual authorization testing, rate limiting
   ↓
Phase 9: Frontend Integration
   - Connect existing frontend to stable /api/v1 endpoints
```

---

## 16. Files Requiring Major Changes or Replacement

- **[`index.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/index.js)**: Deprecate monolithic socket setup; transform into server bootstrap initializing DB, API server, and ConnectionManager.
- **[`main.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/main.js)**: Disassemble the 1,269-line switch into modular event handlers and command routers consuming scoped contexts.
- **[`settings.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/settings.js) & [`config.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/config.js)**: Move all credentials to `.env` / environment variables.
- **[`lib/isAdmin.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/isAdmin.js) & [`lib/isOwner.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/isOwner.js)**: Replace with Dual Authorization System (SaaS RBAC + WhatsApp group privileges).
- **[`lib/index.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/index.js)**: Completely eliminate JSON mock database; route through PostgreSQL repositories.
- **[`package.json`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/package.json)**: Clean invalid scripts, update branding, add test frameworks and DB dependencies.

---

## 17. Files to Preserve

- **[`lib/exif.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/exif.js)** & **[`lib/converter.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/converter.js)**: High-quality WebP sticker metadata writing and ffmpeg media conversion utilities.
- **[`lib/myfunc.js`](file:///Users/furahamogela/Desktop/WINDOWSEVEN/WHATSAPP-BOT/lib/myfunc.js)**: Buffer fetching, MIME type handling, size parsers, and Baileys message deserialization helpers.
- **Individual Command Algorithms** in `commands/`: Text generation, games logic, and regex pattern matchers can be salvaged and placed behind application services.

---

## 18. Technical Risks

1. **WhatsApp Multi-Device / Baileys Ban Risk**: Running multiple automated accounts on the same IP address without rate throttling or proxy distribution can lead to account bans. ConnectionManager must throttle socket actions and implement jitter.
2. **RAM & Socket Overhead**: Each Baileys socket holds active TLS connections and caches credentials (~30MB–60MB RSS per connection). Scaling to 50+ concurrent tenants on a single Node process requires strict cache limits and connection dormancy policies.
3. **Database Key-Value Volume for Signal Keys**: Baileys generates hundreds of pre-keys and session keys during message exchanges. The database schema for Signal keys must be indexed and optimized for rapid read/write throughput.

---

## 19. Unknowns to Address Before Phase 2 & 3

1. **Target Database**: PostgreSQL is specified in the requirements. ORM / query builder choice must be finalized (e.g. Prisma vs Drizzle vs Knex/pg).
2. **Existing Frontend API Contract**: We must confirm the exact shape and expectations of the existing frontend once backend endpoints are defined.
3. **Deployment Topology**: Single-server deployment (Docker / PM2) vs distributed microservice architecture.
