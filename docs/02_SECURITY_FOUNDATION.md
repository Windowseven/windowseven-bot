# 02 — Identity & Security Foundation
**Project**: Windowseven MD  
**Phase**: Phase 2 — Identity & Security Foundation  
**Date**: September 2026  
**Auditor / Engineer**: Senior Staff Backend Engineer, Software Architect & Security Engineer  
**Status**: COMPLETE — BASELINE VERIFIED

---

## 1. Identity Migration

The legacy branding ("Knight Bot", "XeonBot", "Mr Unique Hacker", "Professor") has been systematically replaced across all active surfaces:

| Target | Legacy State | Windowseven MD State | Action |
| :--- | :--- | :--- | :--- |
| `package.json` | `name: "knightbot"`, description: `"WhatsApp Bot"` | `name: "windowseven-md"`, `description: "Windowseven MD - Multi-tenant WhatsApp Bot & Management Platform"` | MIGRATE |
| `README.md` | Legacy banners, donation QR codes, RapidProxy ads | Modern technical overview, prerequisites, setup instructions, security notice | MIGRATE |
| `settings.js` | `botName: "Knight Bot"`, `packname: "Knight Bot"` | `botName: process.env.BOT_NAME \|\| "Windowseven MD"`, `packname: process.env.PACK_NAME \|\| "Windowseven MD"` | MIGRATE |
| `index.js` | ASCII promo banners, channel ads, `global.botname = "KNIGHT BOT"` | Clean structured logger, `global.botname = "WINDOWSEVEN MD"` | MIGRATE |
| `commands/help.js` | Author attribution, YouTube channel ads | Clean Windowseven MD header and version info | MIGRATE |
| `commands/alive.js` | "Knight Bot is Active!" with newsletter forwarding | "Windowseven MD is Active!" | MIGRATE |
| `commands/github.js` | Pointed to legacy author repo `mruniquehacker/Knightbot-md` | Dynamic `process.env.GITHUB_REPO \|\| "Windowseven/windowseven-bot"` | MIGRATE |
| `lib/exif.js` | Sticker pack URL pointed to legacy author repo | Pointed to `https://github.com/Windowseven/windowseven-bot` | MIGRATE |

---

## 2. Secrets Management & Externalization

All third-party credentials and keys have been removed from source code and routed through `process.env` using `dotenv`.

### Externalized Environment Variables
- `NEWS_API_KEY`: NewsAPI key (previously hardcoded in `commands/news.js`).
- `OPENWEATHER_API_KEY`: OpenWeatherMap key (previously hardcoded in `commands/weather.js`).
- `GIPHY_API_KEY`: Giphy search key (previously hardcoded in `settings.js`).
- `PRINCETECH_API_KEY`: Remini upscale service key (previously hardcoded in `commands/remini.js`).
- `LOLHUMAN_API_KEY`: LolHuman API key (previously hardcoded in `config.js`).
- `XTEAM_API_KEY`: XTeam API key (previously hardcoded in `config.js`).
- `SHIZO_API_KEY`: Shizo text generation API key (previously hardcoded in `commands/quote.js`, `truth.js`, etc.).
- `PAIR_CODE_SERVICE_URL`: Dynamic pair code generation service endpoint in `commands/pair.js`.

### Configuration Artifacts
- **`.env.example`**: Created containing all required and optional variable names with explanatory comments and placeholder syntax. Contains **zero real secrets**.
- **`.gitignore`**: Replaced legacy UTF-16 file with a comprehensive UTF-8 `.gitignore` ignoring `.env`, `.env.*` (while preserving `!.env.example`), `session/`, `auth/`, `credentials/`, `temp/`, and `baileys_store.json`.

---

## 3. Previously Exposed Credentials (COMPROMISED)

> [!WARNING]
> The following credential sets were committed in plain text in previous commits in git history. As a security requirement, removing them from active source files **does not** eliminate historical exposure. All listed credentials must be treated as **COMPROMISED** and rotated or revoked immediately by the key owner.

| Service | Location Found | Exposure Status | Action Required |
| :--- | :--- | :--- | :--- |
| **NewsAPI** | `commands/news.js` | Previously committed in plaintext | Revoke and rotate key at newsapi.org |
| **OpenWeatherMap** | `commands/weather.js` | Previously committed in plaintext | Revoke and rotate key at openweathermap.org |
| **PrinceTech API** | `commands/remini.js` | Previously committed in plaintext | Revoke key at api.princetechn.com |
| **Giphy API** | `settings.js` | Previously committed in plaintext | Revoke app key at developers.giphy.com |
| **LolHuman API** | `config.js` | Previously committed in plaintext | Revoke key at lolhuman.xyz |
| **XTeam API** | `config.js` | Previously committed in plaintext | Revoke key at xteam.xyz |

*Active source code no longer contains any of these keys.*

---

## 4. Personal Identifiable Information (PII)

- **Owner Phone Numbers**:
  - `data/owner.json`: Previously contained real phone numbers. Sanitized to `[]`.
  - `data/premium.json`: Previously contained real phone numbers. Sanitized to `[]`.
  - `settings.js`: `ownerNumber` previously hardcoded to `'919876543210'`. Now defaults to `process.env.OWNER_NUMBER || ''`.
  - `index.js`: `phoneNumber` previously hardcoded to `'911234567890'`. Now defaults to `process.env.BOT_PHONE_NUMBER || ''`.
- **Transitional Compatibility**: `process.env.OWNER_NUMBER` is maintained strictly as a temporary compatibility mechanism for transitional single-instance testing. It is **not** the future SaaS authorization model.

---

## 5. Dangerous Runtime Capabilities Neutralized

### A. `.update` Command (`commands/update.js`)
- **Vulnerability**: Invoked `exec('git reset --hard ...')`, `exec('git clean -fd')`, and downloaded remote `.zip` files from GitHub over an unauthenticated HTTP connection, extracting them directly into the runtime filesystem.
- **Resolution**:
  - Completely removed from active execution in `main.js`.
  - Neutralized in `commands/update.js` to return: `❌ The .update command has been permanently disabled for security reasons in Windowseven MD. System updates must be applied via controlled deployment pipelines.`

### B. `.clearsession` Command (`commands/clearsession.js`)
- **Vulnerability**: Unlinked pre-keys, session files, and sync files from `./session` via chat commands. In a multi-tenant platform, this would allow arbitrary deletion of user connection tokens.
- **Resolution**:
  - Removed from `ownerCommands` and active execution in `main.js`.
  - Neutralized in `commands/clearsession.js` to return: `❌ The .clearsession command has been permanently disabled for security reasons in Windowseven MD. Session lifecycle is securely managed by the platform.`

### C. Newsletter Spoofing (`newsletterJid`)
- **Vulnerability**: Injected `forwardedNewsletterMessageInfo: { newsletterJid: '120363161513685998@newsletter', newsletterName: 'KnightBot MD' }` into message forwarding contexts across dozens of commands, spoofing metadata and advertising the legacy author's channel.
- **Resolution**:
  - Neutralized `channelInfo` in `lib/messageConfig.js` and `main.js`.
  - Completely purged `newsletterJid` and `forwardedNewsletterMessageInfo` from all active command responses (`index.js`, `help.js`, `alive.js`, `autotyping.js`, `autoread.js`, `autostatus.js`, `sticker.js`, `stickercrop.js`, `img-blur.js`, `simp.js`, `textmaker.js`, `pair.js`).

---

## 6. Configuration Architecture

Configuration has been centralized around environment variables:
- **`settings.js`**: Application-level defaults (bot name, version, store intervals, pack metadata).
- **`config.js`**: Third-party API registries and external endpoints.
- **`.env`** (local, ignored by git): Environment-specific secrets and tuning parameters.

---

## 7. Legacy Authorization Remaining (Transitional)

The following legacy authorization helpers remain temporarily for runtime compatibility and will be replaced in Phases 3–5:
- `lib/isOwner.js`: Evaluates `process.env.OWNER_NUMBER`, bot's own LID, and `isSudo`.
- `lib/isAdmin.js`: Inspects group metadata via Baileys to check if sender/bot has group admin rights.
- `lib/index.js` (`isSudo`): Checks `data/userGroupData.json` sudo array.

> [!NOTE]
> None of these functions represent the target Windowseven MD SaaS authorization model. They are strictly temporary bridges until PostgreSQL multi-tenant RBAC (User, Tenant, TenantMembership) is implemented.

---

## 8. Test Verification

Automated test suite implemented using Node.js native test runner (`node:test` and `node:assert`):

```text
> windowseven-md@1.0.0 test
> node --test test/**/*.test.js

▶ Command Graceful Fallback & Credentials Handling
  ✔ commands/news.js handles missing API key gracefully without crashing
  ✔ commands/weather.js handles missing API key gracefully without crashing
  ✔ commands/gif.js handles missing API key gracefully without crashing
  ✔ commands/owner.js handles missing owner number gracefully without crashing
✔ Command Graceful Fallback & Credentials Handling (575ms)

▶ Configuration & Identity Baseline
  ✔ should load default Windowseven MD settings without hardcoded PII
  ✔ should load config.js APIs without hardcoded API keys
  ✔ should handle optional API keys gracefully when unset in environment
✔ Configuration & Identity Baseline (51ms)

▶ Security & Environment Hygiene
  ✔ should ignore .env and sensitive directories in .gitignore
  ✔ should have .env.example with placeholders and no real secrets
  ✔ should sanitize data/owner.json and data/premium.json from hardcoded PII
  ✔ should have neutralized dangerous .update command
  ✔ should have neutralized dangerous .clearsession command
  ✔ should have neutralized channel forwarding / newsletter spoofing in lib/messageConfig.js
✔ Security & Environment Hygiene (49ms)

ℹ tests 13
ℹ suites 3
ℹ pass 13
ℹ fail 0
```

---

## 9. Remaining Risks & Technical Debt

1. **Compromised Git History**: While working-tree files are clean, past commits in git history contain the previously exposed API keys and phone numbers. External key rotation must be performed immediately.
2. **Synchronous File Persistence**: `data/*.json` is still read/written synchronously in legacy command paths; this will be eliminated in Phase 3 with PostgreSQL.
3. **Single Session Storage**: `./session/` remains the current Baileys auth directory; this will be replaced with database-backed auth state in Phase 4.
4. **Third-party Scrapers**: Scraper utilities (e.g. `ruhend-scraper`, `mumaker`) rely on undocumented third-party web endpoints that could change or break without notice.
