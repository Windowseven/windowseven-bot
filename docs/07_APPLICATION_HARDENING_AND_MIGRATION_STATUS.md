# Windowseven MD — Phase 3E: Application Hardening, Command Migration & Runtime Stabilization

## 1. Executive Summary & Readiness Statement

Phase 3E hardens the application runtime, solidifies command authorization boundaries, prevents policy and command leakage across group boundaries, and inventories all 101 legacy commands in preparation for Phase 4.

> **Readiness Statement**: The backend foundation is structurally ready to begin Phase 4 API work, with documented legacy functionality and known runtime limitations.

Key achievements in Phase 3E:
- **Verified Single Socket Ownership**: Re-verified that `src/whatsapp/ConnectionManager.js` is the sole owner of Baileys socket creation (`makeWASocket()`).
- **Verified Raw Baileys Boundaries**: Re-verified that only `src/whatsapp/EventAdapter.js` listens to raw Baileys data events.
- **Message Classification**: Extended `NormalizedMessage` with explicit `messageKind` (`'COMMAND'`, `'MEDIA'`, `'SYSTEM'`, `'TEXT'`).
- **Authorization Granularity**: Enhanced `CommandHandler` with explicit categories: `READ`, `CONFIGURE`, `MODERATE`, `ADMIN_ACTION`.
- **Application Pipeline Hardening & Managed Group Gating**:
  - Gated to `status === 'MANAGED'` in PostgreSQL.
  - Directs `COMMAND` messages exclusively to command handlers; unmigrated commands exit cleanly without triggering automatic content policies.
  - Safely ignores `SYSTEM` messages (e.g. stub events, protocol receipts).
  - Limits automatic policy evaluation exclusively to member content messages (`TEXT`, `MEDIA`).
  - Separates bot WhatsApp admin requirements: database-only commands (`.antilink`, `.resetwarn`) do NOT require the bot to be a WhatsApp group admin, while WhatsApp-mutating actions (`.mute`, `.kick`, `.promote`) strictly enforce dual authorization.
- **Dangerous Capability Audit**: Audited `child_process`, `eval`, filesystem access, and verified neutralization of dangerous commands (`.update`, `.clearsession`).
- **100% Comprehensive Legacy Inventory**: Audited and classified all 101 legacy command files into 7 structural domains with clear migration targets.

---

## 2. LegacyBridge vs Managed-Group Behavior Matrix

### Resolution of Architectural Scope
- **Multi-Tenant SaaS Boundary**: In the modern architecture, the `ApplicationPipeline`, `PolicyEngine`, and migrated SaaS moderation commands (`.warn`, `.warnings`, `.antilink`, `.mute`, `.unmute`, `.kick`, `.promote`, `.demote`) require a group to be explicitly resolved and marked as `MANAGED`. Non-managed groups (`UNMANAGED`, `DISCOVERED`, or unresolved) are strictly barred from executing SaaS policies or SaaS commands.
- **Transitional Legacy Fallback**: Non-migrated utility commands (e.g., `.ping`, `.alive`, `.help`, `.menu`) were not migrated to PostgreSQL in Phase 3D/3E. To preserve basic utility operation for groups during the transitional migration before complete legacy decommissioning, unmigrated utility commands are allowed to flow through `LegacyBridge` to `main.js`.
- **Leakage Prevention**: Non-command messages (plain text, links, media) in unmanaged groups are discarded at `legacyBridge.js` before reaching `main.js`, and legacy automatic policies in `main.js` (`handleBadwordDetection`, `Antilink`) are guarded by `if (!sock.tenantContext)` to prevent duplicate or unauthorized legacy policy execution.

### Runtime Behavior Matrix

| Group State | Message Type | Migrated Command (`.warn`, `.mute`, etc.) | Unmigrated Command (`.ping`, `.alive`, etc.) | Automatic Policy (antilink, badword) | Plain Text / Media Content |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **MANAGED** | Command (`.warn`, `.mute`, `.antilink`) | **Executed** authoritatively via `ApplicationPipeline` (audited, PostgreSQL-backed). Never reaches legacy. | **Bypassed** at Pipeline (`handled: false, reason: 'unmigrated_command'`); executed via LegacyBridge in `main.js`. | **N/A** (Commands never trigger content policies). | **N/A** (Processed as command). |
| **MANAGED** | Non-Command (Text with link, text with badword) | **N/A** | **N/A** | **Evaluated & Executed** authoritatively via `PolicyEngine` (DELETE / WARN / KICK). If action taken, legacy is blocked (`handled: true`). | If allowed by policies (`action: 'ALLOW'`), passes through to legacy handlers (e.g., autotyping, mentions). |
| **UNMANAGED** | Command (`.warn`, `.mute`, etc.) | **Blocked & Dropped**. Pipeline returns `group_not_managed`; `legacyBridge` drops migrated command. Zero legacy fallback. | **Bypassed** at Pipeline; permitted to execute via LegacyBridge in `main.js` during transition. | **N/A** (Commands never trigger content policies). | **N/A** (Processed as command). |
| **UNMANAGED** | Non-Command (Text / Media) | **N/A** | **N/A** | **Blocked & Dropped**. Pipeline returns `group_not_managed`; `legacyBridge` drops non-command. Legacy JSON policies suppressed (`sock.tenantContext`). | **Dropped** at `legacyBridge` to prevent legacy automatic policy leakage. |
| **DISCOVERED** | Command (`.warn`, `.mute`, etc.) | **Blocked & Dropped**. Pipeline returns `group_not_managed`; `legacyBridge` drops migrated command. Zero legacy fallback. | **Bypassed** at Pipeline; permitted to execute via LegacyBridge in `main.js` during transition. | **N/A** (Commands never trigger content policies). | **N/A** (Processed as command). |
| **DISCOVERED** | Non-Command (Text / Media) | **N/A** | **N/A** | **Blocked & Dropped**. Pipeline returns `group_not_managed`; `legacyBridge` drops non-command. Legacy JSON policies suppressed (`sock.tenantContext`). | **Dropped** at `legacyBridge` to prevent legacy automatic policy leakage. |

---

## 3. `.warnings` Exact Authorization Semantics

Inspection of `src/application/commands/moderation/WarningsCommand.js` establishes the following rules:

1. **Target Identification**:
   - Explicit target resolution: `message.mentionedJids[0] || message.quotedSender`.
   - Fallback target: `actor.senderJid` (the sender themselves).
2. **Self-Inspection (`.warnings`)**:
   - When a member sends `.warnings` without mentioning or quoting anyone, or mentions themselves (`targetJid === actor.senderJid`), `isSelf === true`.
   - **Allowed for all group members** (regular members and admins alike). Does not require sender admin privileges.
3. **Third-Party Inspection (`.warnings @user` or `.warnings <reply>`)**:
   - When a user specifies a different target (`targetJid !== actor.senderJid`), `isSelf === false`.
   - **Requires sender to be a WhatsApp group admin** (`actor.isSenderAdmin === true`).
   - If a non-admin attempts to inspect another member: rejected with `'❌ Error: Only group admins can check warnings for other members!'` and `{ success: false, error: 'Unauthorized: Admin required to inspect other members' }`.
4. **Comparison to Legacy**:
   - Legacy `commands/warnings.js` unconditionally required a mention, had no self-check, had no admin verification, and read un-isolated counts globally from `warnings.json`.
   - The modern implementation follows standard SaaS privacy/security conventions: users can check their own standing freely; only administrators can inspect or moderate other participants; all queries are strictly scoped to `(tenant_id, group_id)`.

---

## 4. `.mute` / `.unmute` Scheduling Boundary

Inspection of `MuteCommand.js`, `UnmuteCommand.js`, and `ModerationService.js` confirms:

1. **WhatsApp Protocol Mechanism**:
   - Mute activates WhatsApp announcement mode (`groupSettingUpdate(jid, 'announcement')`). Only group admins can send messages.
   - Unmute deactivates announcement mode (`groupSettingUpdate(jid, 'not_announcement')`). All members can send messages.
2. **Duration Parsing & Strict Validation**:
   - `.mute`: Untimed indefinite mute. No timer is scheduled.
   - `.mute <minutes>`: Validates that duration is a positive integer (`parseInt(val, 10)`).
   - **Invalid Arguments** (e.g. `.mute abc`): Rejected with `'❌ Error: Invalid duration. Please specify a positive number of minutes (e.g. .mute 10)'`.
   - **Zero or Negative** (e.g. `.mute 0`, `.mute -5`): Rejected as invalid duration.
   - **Excessive Limit** (e.g. `.mute 10081`): Rejected if exceeding 10080 minutes (7 days) with `'❌ Error: Duration exceeds maximum limit of 10080 minutes (7 days).'`.
3. **In-Memory Ephemeral Scheduling**:
   - If duration is valid, schedules `setTimeout(..., duration * 60 * 1000)` to automatically call `unmuteGroup` and notify the chat.
   - Scheduled timers call `timerId.unref()` so Node's event loop is not held open by long-running background timers.
   - Tracked in `activeMuteTimers = new Map()` keyed by `groupJid`.
4. **Manual Unmute & Replacement Cleanup**:
   - Invoking `.unmute` cancels and deletes any pending timer for that group from memory.
   - Invoking a new `.mute <minutes>` on a group that already has a pending timer cancels the prior timer before scheduling the new one.
5. **Timer Error Isolation**:
   - If the WhatsApp network fails during scheduled unmute, the error is caught and logged without crashing the process.
6. **Explicit Known Limitation**:
   - **Process Restart Limitation**: Ephemeral in-memory timers **do not persist across process restarts or crashes**. If the bot restarts while a group is muted for 30 minutes, the group remains muted on WhatsApp until manually unmuted or scheduled via Phase 4 persistent job scheduling (BullMQ/PostgreSQL).

---

## 5. Dangerous Capabilities & Security Audit

| Finding / Capability | Locations | Status in Phase 3E |
| :--- | :--- | :--- |
| `child_process.exec / spawn` | `commands/sticker.js`, `lib/converter.js`, `commands/attp.js` | Sandboxed to standard media manipulation tools (`ffmpeg`, `cwebp`). No shell string interpolation of unsanitized remote user input. |
| `git pull / execSync` | `commands/update.js` | **NEUTRALIZED**. Script returns informative security notice without executing shell code or pulling from unverified remotes. |
| Directory deletion (`fs.rmdirSync`, `unlinkSync`) | `commands/clearsession.js` | **NEUTRALIZED**. Prevents arbitrary deletion of Baileys session folders or database state. |
| Un-unref'd Background Timers | `main.js`, `commands/cleartmp.js`, `commands/antidelete.js`, `lib/tempCleanup.js` | **FIXED**: All background maintenance timers now invoke `.unref()`, allowing clean Node process shutdown and eliminating test hangs. |
| File Watchers | `lib/myfunc.js` | **FIXED**: `fs.watchFile` is disabled in `NODE_ENV === 'test'` to prevent hanging event loops. |
| Hardcoded Owner Credentials | `data/owner.json`, `data/premium.json` | Replaced with environment-configured or database-backed identities. |
| Newsletter / Channel Spoofing | `lib/messageConfig.js` | Neutered in Phase 2; verified no hardcoded channel IDs injected into outgoing context. |

---

## 6. Legacy Command Audit & Inventory (101 Files)

| Category | Count | Command Files | Description / Migration Strategy |
| :--- | :--- | :--- | :--- |
| **Moderation & Admin** | 9 | `warn.js`, `warnings.js`, `resetwarn.js`, `antilink.js`, `mute.js`, `unmute.js`, `kick.js`, `promote.js`, `demote.js` | **Fully Migrated** to `src/application/commands/moderation/` backed by PostgreSQL repositories and `WhatsAppModerationGateway`. |
| **System & Owner** | 10 | `alive.js`, `ping.js`, `owner.js`, `clearsession.js`, `update.js`, `restart.js`, `shutdown.js`, `broadcast.js`, `block.js`, `unblock.js` | Operational utilities. Dangerous commands (`update.js`, `clearsession.js`) are neutralized. Owner commands to be migrated to Multi-Tenant Admin API in Phase 4. |
| **Media & Converter** | 18 | `sticker.js`, `stickercrop.js`, `take.js`, `attp.js`, `ttp.js`, `toimg.js`, `tovideo.js`, `tomp3.js`, `tourl.js`, `blur.js`, `circle.js`, `crop.js`, `flip.js`, `invert.js`, `remini.js`, `removebg.js`, `rotate.js`, `grayscale.js` | Media conversion using ffmpeg/cwebp/canvas. Target for stateless media service in future phases. |
| **Downloaders** | 16 | `play.js`, `song.js`, `video.js`, `ytmp3.js`, `ytmp4.js`, `yts.js`, `tiktok.js`, `facebook.js`, `instagram.js`, `twitter.js`, `mediafire.js`, `gdrive.js`, `gitclone.js`, `apk.js`, `pinterest.js`, `spotify.js` | External scrapers and media downloaders. Kept isolated in legacy bridge. |
| **AI & Utilities** | 16 | `ai.js`, `gpt.js`, `gemini.js`, `dalle.js`, `imagine.js`, `translate.js`, `weather.js`, `calc.js`, `shorturl.js`, `qr.js`, `readqr.js`, `whois.js`, `define.js`, `wiki.js`, `github.js`, `paste.js` | AI models and external informational APIs. Low priority for group moderation; candidate for optional plugins. |
| **Fun & Games** | 22 | `joke.js`, `quote.js`, `fact.js`, `meme.js`, `flirt.js`, `truth.js`, `dare.js`, `tictactoe.js`, `math.js`, `riddle.js`, `trivia.js`, `ship.js`, `simp.js`, `compliment.js`, `insult.js`, `roll.js`, `flipcoin.js`, `8ball.js`, `lyrics.js`, `fancy.js`, `emojimix.js`, `aesthetic.js` | Conversational entertainment commands. Kept in legacy bridge or deprecated. |
| **Search & Information** | 10 | `google.js`, `news.js`, `imdb.js`, `lyrics2.js`, `wallpaper.js`, `ringtone.js`, `urban.js`, `crypto.js`, `currency.js`, `time.js` | Web search and lookup scripts. Non-critical to group management. |

---

## 7. Verification & Automated Test Results

### Full Automated Test Suite
```bash
NODE_ENV=test TEST_DATABASE_URL=postgresql://testuser@127.0.0.1:5433/windowseven_test npm test
```

- **Suites**: 16
- **Total Tests**: 109
- **Passed**: 109 (100%)
- **Failed**: 0
- **Skipped**: 0
- **Cancelled**: 0
- **Total Duration**: ~27.6s

### Static Syntax Check
```bash
node --check src/whatsapp/legacyBridge.js \
             src/application/pipeline/ApplicationPipeline.js \
             src/application/commands/moderation/WarningsCommand.js \
             src/application/commands/moderation/MuteCommand.js \
             src/application/commands/moderation/UnmuteCommand.js \
             src/application/services/ModerationService.js \
             main.js \
             commands/cleartmp.js \
             commands/antidelete.js \
             lib/tempCleanup.js \
             lib/myfunc.js \
             test/phase_3e_hardening.test.js
```
- **Exit Code**: 0 (all files syntactically clean).
