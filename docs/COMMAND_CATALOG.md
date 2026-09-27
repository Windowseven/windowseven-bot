# Windowseven MD — Canonical Command Product Catalog

## 1. Overview & Architectural Grounding

Windowseven MD operates a dual command execution model:
1. **Authoritative Migrated Engine (`src/application/commands/`)**:
   * 9 core group moderation commands (`kick`, `mute`, `unmute`, `promote`, `demote`, `warn`, `warnings`, `resetwarn`, `antilink`) are registered in `CommandRegistry.js`.
   * Dispatched strictly via `ApplicationPipeline.js` against PostgreSQL storage (`tenants`, `groups`, `group_policies`, `group_warnings`, `customer_subscriptions`, `connection_commands`, and `scheduled_moderation_tasks`).
   * Enforces contextual WhatsApp group privileges (`isSenderAdmin`, `isBotAdmin`), active customer subscription checks, and tenant lifecycle fencing (`ACTIVE` vs `SUSPENDED` vs `DEACTIVATED`).
2. **Legacy Bridge Engine (`commands/` & `main.js`)**:
   * Remaining 92 command files dispatched via a 168-case `switch (true)` statement in `main.js` connected to `EventAdapter` via `legacyBridge.js`.
   * Unmigrated commands currently fall through `ApplicationPipeline` only if the group is `MANAGED` and the tenant is `ACTIVE`.

### Canonical Counting & Alias Policy
* **Aliases are NOT counted as separate commands or features.** Aliases (e.g. `.del` for `.delete`, `.s` for `.sticker`, `.menu` for `.help`, `.remove` for `.kick`) map directly to their canonical parent command.
* **101 physical files** in `commands/` represent **83 canonical commands**.

---

## 2. Canonical Command Inventory

| Canonical Command | Aliases | Product Category | Description | Syntax | Audience | Sub Req? | Chat Context | Bot Admin Req? | Side Effects | Implementation Location | Status | Rationale / Notes |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| **.vv** | None | UTILITY | Extracts view-once image or video and resends as standard media | `.vv` (as reply) | ANY_USER | Yes | Both | No | Downloads view-once buffer from Baileys stream; re-sends media | `commands/viewonce.js` | **KEEP** | **Verified Personal Utility**: Does NOT require group admin, bot admin, or group context. Works in DMs and groups for any participant. |
| **.help** | `.menu`, `.bot`, `.list` | GENERAL | Displays available bot commands and service status | `.help [category]` | ANY_USER | Yes | Both | No | Sends menu message | `commands/help.js` | **EDIT** | Currently a static hardcoded text template; must be refactored to dynamically read from `CommandRegistry`. |
| **.ping** | None | SYSTEM | Tests bot responsiveness and server latency | `.ping` | ANY_USER | Yes | Both | No | Outbound latency text | `commands/ping.js` | **KEEP** | Standard diagnostic tool. |
| **.alive** | None | SYSTEM | Confirms bot is operational and returns uptime | `.alive` | ANY_USER | Yes | Both | No | Outbound status card | `commands/alive.js` | **KEEP** | Operational diagnostic tool. |
| **.jid** | None | UTILITY | Returns current user or chat JID | `.jid` | ANY_USER | Yes | Both | No | Outbound text | `main.js` | **KEEP** | Diagnostic identifier tool. |
| **.tts** | None | UTILITY | Converts text input to speech audio note | `.tts <text>` | ANY_USER | Yes | Both | No | Calls Google TTS API; sends audio | `commands/tts.js` | **KEEP** | High utility voice synthesis. |
| **.trt** | `.translate` | UTILITY | Translates text into target language | `.trt <text> <lang>` | ANY_USER | Yes | Both | No | Calls Google Translate API; sends text | `commands/translate.js` | **KEEP** | High utility multi-language tool. |
| **.ss** | None | UTILITY | Renders full screenshot of requested web URL | `.ss <url>` | ANY_USER | Yes | Both | No | Fetches web screenshot API; sends image | `commands/ss.js` | **KEEP** | Web inspection tool. |
| **.url** | None | UTILITY | Uploads quoted media to temporary public URL | `.url` (as reply) | ANY_USER | Yes | Both | No | Uploads buffer to Catbox/Telegra.ph | `commands/url.js` | **KEEP** | Media hosting utility. |
| **.clear** | None | UTILITY | Clears visible chat screen via whitespace buffer | `.clear` | ANY_USER | Yes | Both | No | Sends newline whitespace padding | `commands/clear.js` | **KEEP** | Harmless visual utility. |
| **.weather** | None | INFORMATION | Fetches current weather and forecast for city | `.weather <city>` | ANY_USER | Yes | Both | No | Queries OpenWeather API; sends text | `commands/weather.js` | **KEEP** | Everyday utility. |
| **.news** | None | INFORMATION | Fetches latest national and world news headlines | `.news` | ANY_USER | Yes | Both | No | Queries news scraper API; sends text | `commands/news.js` | **KEEP** | Informational service. |
| **.lyrics** | None | INFORMATION | Searches and displays song lyrics | `.lyrics <title>` | ANY_USER | Yes | Both | No | Queries Genius/lyrics scraper; sends text | `commands/lyrics.js` | **KEEP** | Media reference utility. |
| **.github** | `.git`, `.sc`, `.repo` | INFORMATION | Retrieves public repository stats and metadata | `.github <user/repo>` | ANY_USER | Yes | Both | No | Queries GitHub REST API; sends card | `commands/github.js` | **EDIT** | Neutralize hardcoded upstream promotional repository links. |
| **.kick** | `.remove` | GROUP MODERATION | Removes target participant from WhatsApp group | `.kick @user` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Ejects WhatsApp participant; mutates group | `src/application/commands/moderation/KickCommand.js` | **KEEP** | Core moderation. Migrated to PostgreSQL engine. |
| **.mute** | None | GROUP MODERATION | Restricts group message sending to admins only | `.mute [minutes]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Sets group announce=true; schedules auto-unmute | `src/application/commands/moderation/MuteCommand.js` | **KEEP** | Core moderation. Uses durable auto-unmute tasks. |
| **.unmute** | None | GROUP MODERATION | Restores message sending permissions to all members | `.unmute` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Sets group announce=false; cancels pending unmutes | `src/application/commands/moderation/UnmuteCommand.js` | **KEEP** | Core moderation. Atomic replacement semantics. |
| **.promote** | None | GROUP MODERATION | Grants WhatsApp admin status to participant | `.promote @user` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | WhatsApp group role upgrade | `src/application/commands/moderation/PromoteCommand.js` | **KEEP** | Core moderation. |
| **.demote** | None | GROUP MODERATION | Revokes WhatsApp admin status from participant | `.demote @user` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | WhatsApp group role downgrade | `src/application/commands/moderation/DemoteCommand.js` | **KEEP** | Core moderation. |
| **.warn** | None | GROUP MODERATION | Issues official warning; auto-kicks at threshold (3) | `.warn @user` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Inserts warning in PostgreSQL; auto-kicks at 3 | `src/application/commands/moderation/WarnCommand.js` | **KEEP** | Core moderation. Migrated to `group_warnings`. |
| **.warnings** | `.warns`, `.checkwarn` | GROUP MODERATION | Displays current warning count for target member | `.warnings @user` | GROUP_ADMIN | Yes | Group | No | Read-only database query | `src/application/commands/moderation/WarningsCommand.js` | **KEEP** | Core moderation. |
| **.resetwarn** | `.clearwarn`, `.resetwarns` | GROUP MODERATION | Resets warning count for target member to zero | `.resetwarn @user` | GROUP_ADMIN | Yes | Group | No | Deletes records in `group_warnings` table | `src/application/commands/moderation/ResetWarnCommand.js` | **KEEP** | Core moderation. |
| **.antilink** | None | GROUP MODERATION | Configures group invite link auto-deletion / kick | `.antilink [on/off/action]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Updates `group_policies` table | `src/application/commands/moderation/AntilinkCommand.js` | **KEEP** | Core moderation. Migrated to PostgreSQL engine. |
| **.delete** | `.del` | GROUP MODERATION | Deletes inappropriate quoted message for everyone | `.delete` (as reply) | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Calls Baileys message revoke protocol | `commands/delete.js` | **KEEP** | Essential group moderation utility. |
| **.antibadword** | None | GROUP MODERATION | Automatically deletes messages matching profanity filter | `.antibadword [on/off]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Mutates configuration (currently JSON) | `commands/antibadword.js` | **EDIT** | Migrate policy settings from JSON to `group_policies`. |
| **.antitag** | None | GROUP MODERATION | Blocks unauthorized members from mass-tagging | `.antitag [on/off]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Mutates configuration (currently JSON) | `commands/antitag.js` | **EDIT** | Migrate policy settings from JSON to `group_policies`. |
| **.tagall** | None | GROUP MANAGEMENT | Mentions all group members in one announcement | `.tagall [message]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Mentions all participant JIDs | `commands/tagall.js` | **KEEP** | Essential community announcement tool. |
| **.tag** | `.hidetag` | GROUP MANAGEMENT | Sends announcement tagging members without visible text tags | `.tag <message>` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Appends participants to `mentionedJid` array | `commands/tag.js` & `commands/hidetag.js` | **MERGE** | **Merge `.hidetag` into `.tag`**: Both perform identical hidden participant tagging. |
| **.tagnotadmin**| None | GROUP MANAGEMENT | Mentions only non-admin members in group | `.tagnotadmin [msg]` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Mentions filtered participant JIDs | `commands/tagnotadmin.js` | **MERGE** | **Merge into `.tagall --members`**: Redundant separate command; cleaner as an option. |
| **.groupinfo** | `.ginfo` | GROUP MANAGEMENT | Displays group title, creation date, and member count | `.groupinfo` | ANY_USER | Yes | Group | No | Read-only group metadata query | `commands/groupinfo.js` | **KEEP** | Safe informational group tool. |
| **.staff** | `.admins` | GROUP MANAGEMENT | Lists all group administrators with @mentions | `.staff` | ANY_USER | Yes | Group | No | Read-only group metadata query | `commands/staff.js` | **KEEP** | Informational administrative roster. |
| **.setgname** | None | GROUP MANAGEMENT | Renames group title / subject | `.setgname <name>` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Updates WhatsApp group subject | `commands/groupmanage.js` | **KEEP** | Standard group management. |
| **.setgdesc** | None | GROUP MANAGEMENT | Updates group description text | `.setgdesc <text>` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Updates WhatsApp group description | `commands/groupmanage.js` | **KEEP** | Standard group management. |
| **.setgpp** | None | GROUP MANAGEMENT | Updates group profile display picture | `.setgpp` (as reply) | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Updates WhatsApp group icon | `commands/groupmanage.js` | **KEEP** | Standard group management. |
| **.resetlink** | `.revoke` | GROUP MANAGEMENT | Revokes group invite link and generates a new link | `.resetlink` | GROUP_ADMIN_AND_BOT_ADMIN | Yes | Group | **Yes** | Invalidates existing invite code | `commands/resetlink.js` | **KEEP** | Group security tool. |
| **.welcome** | None | GROUP MANAGEMENT | Configures automated greeting message for new joins | `.welcome [on/off]` | GROUP_ADMIN | Yes | Group | No | Writes to `./data/userGroupData.json` | `commands/welcome.js` | **EDIT** | Migrate storage from shared JSON file to PostgreSQL. |
| **.goodbye** | None | GROUP MANAGEMENT | Configures automated farewell message on member leave | `.goodbye [on/off]` | GROUP_ADMIN | Yes | Group | No | Writes to `./data/userGroupData.json` | `commands/goodbye.js` | **EDIT** | Migrate storage from shared JSON file to PostgreSQL. |
| **.topmembers**| None | GROUP MANAGEMENT | Displays ranked list of most active message senders | `.topmembers` | ANY_USER | Yes | Group | No | Reads `./data/messageCount.json` | `commands/topmembers.js` | **EDIT** | Migrate storage from shared JSON file to database. |
| **.chatbot** | None | AI | Enables automated AI conversational responses in group | `.chatbot [on/off]` | GROUP_ADMIN | Yes | Group | No | Writes to `./data/userGroupData.json` | `commands/chatbot.js` | **REVIEW** | Risk of group spam and external AI rate-limit exhaustion. |
| **.gpt** | `.ai`, `.gemini` | AI | Queries LLM conversational model | `.gpt <prompt>` | ANY_USER | Yes | Both | No | Outbound HTTP request to AI scraper | `commands/ai.js` | **KEEP** | High-demand conversational AI tool. |
| **.imagine** | `.flux` | AI / CREATIVE | Generates digital image from descriptive text prompt | `.imagine <prompt>` | ANY_USER | Yes | Both | No | Calls image generation endpoint; sends photo | `commands/imagine.js` | **KEEP** | Popular creative utility. |
| **.sora** | None | AI / CREATIVE | Generates AI video preview from text prompt | `.sora <prompt>` | ANY_USER | Yes | Both | No | Calls video generator scraper; sends video | `commands/sora.js` | **REVIEW** | External scraper endpoint has low stability. |
| **.character**| None | AI / FUN | Roleplays or details fictional character biography | `.character <name>` | ANY_USER | Yes | Both | No | Scrapes character API; sends text card | `commands/character.js` | **KEEP** | Entertainment utility. |
| **.sticker** | `.s` | CREATIVE | Converts replied image or video into WhatsApp sticker | `.sticker` (as reply) | ANY_USER | Yes | Both | No | Executes `ffmpeg` to produce webp sticker | `commands/sticker.js` | **KEEP** | Core sticker generation engine. |
| **.simage** | None | CREATIVE | Converts WhatsApp sticker back into normal photo | `.simage` (as reply) | ANY_USER | Yes | Both | No | Extracts webp buffer; sends normal image | `commands/simage.js` | **KEEP** | Core reverse-sticker engine. |
| **.crop** | `.stickercrop` | CREATIVE | Crops and converts replied image into 1:1 sticker | `.crop` (as reply) | ANY_USER | Yes | Both | No | Executes `ffmpeg` with square crop filter | `commands/stickercrop.js` | **MERGE** | **Merge into `.sticker crop`**: Redundant separate command file. |
| **.sticker-alt**| None | CREATIVE | Fallback sticker converter | `.sticker-alt` | ANY_USER | Yes | Both | No | Executes `ffmpeg` | `commands/sticker-alt.js` | **DEPRECATE** | **Duplicate**: Redundant copy of `sticker.js`. |
| **.tgsticker** | `.tg` | CREATIVE | Converts Telegram sticker pack URL into WhatsApp stickers| `.tgsticker <link>` | ANY_USER | Yes | Both | No | Fetches Telegram API; converts webp/tgs | `commands/stickertelegram.js` | **KEEP** | Useful cross-platform sticker importer. |
| **.take** | None | CREATIVE | Modifies sticker EXIF metadata (pack name and author) | `.take <pack\|author>`| ANY_USER | Yes | Both | No | Rewrites webp EXIF header with `node-webpmux` | `commands/take.js` | **KEEP** | Popular sticker authoring tool. |
| **.emojimix** | `.emix` | CREATIVE | Combines two emojis into a single blended sticker | `.emojimix 😭+😂` | ANY_USER | Yes | Both | No | Queries Google Kitchen API; sends sticker | `commands/emojimix.js` | **KEEP** | High-engagement creative tool. |
| **.attp** | None | CREATIVE | Generates animated colored text sticker | `.attp <text>` | ANY_USER | Yes | Both | No | Fetches animated text API; sends webp sticker | `commands/attp.js` | **KEEP** | Popular text sticker tool. |
| **.blur** | `.img-blur` | CREATIVE | Applies gaussian blur filter to replied image | `.blur` (as reply) | ANY_USER | Yes | Both | No | Processes image buffer via Jimp; sends photo | `commands/img-blur.js` | **KEEP** | Image filter tool. |
| **.removebg** | `.rmbg` | CREATIVE | Removes background from replied photo | `.removebg` (as reply)| ANY_USER | Yes | Both | No | Calls background removal API; sends transparent PNG | `commands/removebg.js` | **KEEP** | High utility photo editor. |
| **.remini** | None | CREATIVE | Enhances and upscales low-resolution photo | `.remini` (as reply) | ANY_USER | Yes | Both | No | Calls enhancement API; sends upscaled image | `commands/remini.js` | **KEEP** | High-demand photo enhancer. |
| **.textmaker**| `.metallic`, `.ice`, `.neon`, `.glitch` +14 | CREATIVE | Renders stylized graphic text banners across 18 themes | `.<theme> <text>` | ANY_USER | Yes | Both | No | Generates graphic banner; sends image | `commands/textmaker.js` | **KEEP** | Broad creative text options. |
| **.play** | `.song` | MEDIA / DOWNLOAD | Searches YouTube and downloads audio MP3 | `.play <title>` | ANY_USER | Yes | Both | No | Searches YT; downloads audio buffer | `commands/play.js` & `commands/song.js` | **MERGE** | **Merge `.song` into `.play`**: Completely identical functionality and user goal. |
| **.video** | `.ytmp4` | MEDIA / DOWNLOAD | Searches YouTube and downloads MP4 video | `.video <title>` | ANY_USER | Yes | Both | No | Searches YT; downloads MP4 video | `commands/video.js` | **KEEP** | High-demand media downloader. |
| **.spotify** | None | MEDIA / DOWNLOAD | Searches Spotify and downloads audio track | `.spotify <query>` | ANY_USER | Yes | Both | No | Queries Spotify scraper; sends audio track | `commands/spotify.js` | **KEEP** | Music downloader. |
| **.tiktok** | None | MEDIA / DOWNLOAD | Downloads TikTok video without watermark | `.tiktok <url>` | ANY_USER | Yes | Both | No | Uses `ruhend-scraper`; sends video | `commands/tiktok.js` | **KEEP** | Social media downloader. |
| **.instagram**| `.ig`, `.igs`, `.igsc` | MEDIA / DOWNLOAD | Downloads Instagram reels, posts, and stories | `.instagram <url>` | ANY_USER | Yes | Both | No | Uses `ruhend-scraper`; sends media | `commands/instagram.js` & `commands/igs.js` | **MERGE** | **Merge `.igs` into `.instagram`**: Unified downloader for posts, reels, and stories. |
| **.facebook** | `.fb` | MEDIA / DOWNLOAD | Downloads public Facebook video from URL | `.facebook <url>` | ANY_USER | Yes | Both | No | Uses `ruhend-scraper`; sends video | `commands/facebook.js` | **KEEP** | Social media downloader. |
| **.joke** | None | COMMUNITY / FUN | Tells a random family-safe joke | `.joke` | ANY_USER | Yes | Both | No | Outbound joke text | `commands/joke.js` | **KEEP** | Casual entertainment. |
| **.quote** | None | COMMUNITY / FUN | Sends inspiring or philosophical quote | `.quote` | ANY_USER | Yes | Both | No | Outbound quote text | `commands/quote.js` | **KEEP** | Casual entertainment. |
| **.fact** | None | COMMUNITY / FUN | Sends interesting random educational fact | `.fact` | ANY_USER | Yes | Both | No | Outbound fact text | `commands/fact.js` | **KEEP** | Casual entertainment. |
| **.meme** | None | COMMUNITY / FUN | Fetches random trending meme | `.meme` | ANY_USER | Yes | Both | No | Queries Reddit meme API; sends image | `commands/meme.js` | **KEEP** | Casual entertainment. |
| **.8ball** | None | COMMUNITY / FUN | Magic 8-ball answers yes/no question | `.8ball <question>` | ANY_USER | Yes | Both | No | Outbound random answer text | `commands/eightball.js` | **KEEP** | Casual entertainment. |
| **.truth** | None | COMMUNITY / FUN | Generates truth prompt for group social games | `.truth` | ANY_USER | Yes | Both | No | Outbound prompt text | `commands/truth.js` | **KEEP** | Group party game. |
| **.dare** | None | COMMUNITY / FUN | Generates dare challenge for group social games | `.dare` | ANY_USER | Yes | Both | No | Outbound prompt text | `commands/dare.js` | **KEEP** | Group party game. |
| **.compliment**| None | COMMUNITY / FUN | Generates friendly compliment for mentioned member | `.compliment @user` | ANY_USER | Yes | Both | No | Outbound friendly text | `commands/compliment.js` | **KEEP** | Social interaction. |
| **.insult** | None | COMMUNITY / FUN | Generates lighthearted roast for mentioned member | `.insult @user` | ANY_USER | Yes | Both | No | Outbound playful roast text | `commands/insult.js` | **KEEP** | Social interaction. |
| **.flirt** | None | COMMUNITY / FUN | Sends playful pickup line | `.flirt` | ANY_USER | Yes | Both | No | Outbound text | `commands/flirt.js` | **KEEP** | Social interaction. |
| **.shayari** | None | COMMUNITY / FUN | Sends poetic verse / shayari | `.shayari` | ANY_USER | Yes | Both | No | Outbound text | `commands/shayari.js` | **KEEP** | Cultural poetry. |
| **.goodnight**| None | COMMUNITY / FUN | Sends goodnight wish | `.goodnight` | ANY_USER | Yes | Both | No | Outbound text | `commands/goodnight.js` | **KEEP** | Social greeting. |
| **.roseday** | None | COMMUNITY / FUN | Sends romantic rose day greeting | `.roseday` | ANY_USER | Yes | Both | No | Outbound text | `commands/roseday.js` | **KEEP** | Social greeting. |
| **.ship** | None | COMMUNITY / FUN | Calculates fun love compatibility % between users | `.ship @u1 @u2` | ANY_USER | Yes | Group | No | Outbound graphic card text | `commands/ship.js` | **KEEP** | Casual group fun. |
| **.simp** | None | COMMUNITY / FUN | Generates mock simp rating card for mentioned user | `.simp @user` | ANY_USER | Yes | Both | No | Canvas rendering; sends graphic card | `commands/simp.js` | **KEEP** | Casual group fun. |
| **.stupid** | None | COMMUNITY / FUN | Generates humorous "stupid certificate" graphic | `.stupid @user` | ANY_USER | Yes | Both | No | Canvas rendering; sends graphic card | `commands/stupid.js` | **KEEP** | Casual group fun. |
| **.wasted** | None | COMMUNITY / FUN | Overlays GTA "Wasted" filter on user's profile picture | `.wasted @user` | ANY_USER | Yes | Both | No | Canvas rendering; sends edited photo | `commands/wasted.js` | **KEEP** | Popular meme generator. |
| **.anime** | `.nom`, `.pat`, `.hug`, `.kiss`, `.cry`, +5 | COMMUNITY / FUN | Sends anime reaction GIF / sticker | `.<action> [@user]` | ANY_USER | Yes | Both | No | Queries Nekos API; sends animated GIF | `commands/anime.js` | **KEEP** | Popular anime reactions. |
| **.tictactoe**| None | GAMES | Starts an interactive 2-player TicTacToe game | `.tictactoe @user` | ANY_USER | Yes | Both | No | Stores game state in memory; updates grid | `commands/tictactoe.js` | **KEEP** | Interactive group game. |
| **.hangman** | `.guess` | GAMES | Plays word guessing game with visual hangman scaffold | `.hangman` / `.guess`| ANY_USER | Yes | Both | No | Stores game state in memory; updates scaffold | `commands/hangman.js` | **KEEP** | Interactive group game. |
| **.trivia** | `.answer` | GAMES | Starts multiple-choice quiz question | `.trivia` / `.answer`| ANY_USER | Yes | Both | No | Queries OpenTDB API; evaluates answer | `commands/trivia.js` | **KEEP** | Interactive group quiz. |
| **.anticall** | None | BOT PRIVACY | Automatically declines incoming WhatsApp voice/video calls | `.anticall [on/off]` | CUSTOMER_OWNER | Yes | Both | No | Intercepts Baileys call events; updates config | `commands/anticall.js` | **KEEP** | High-demand privacy setting. Needs DB storage. |
| **.pmblocker** | None | BOT PRIVACY | Automatically blocks non-admin users messaging bot in DM | `.pmblocker [on/off]`| CUSTOMER_OWNER | Yes | DM | No | Updates config; blocks caller via Baileys | `commands/pmblocker.js` | **KEEP** | Anti-harassment tool. Needs DB storage. |
| **.autotyping**| None | BOT PRIVACY | Displays fake typing presence indicator | `.autotyping [on/off]`| CUSTOMER_OWNER | Yes | Both | No | Sends Baileys presence update; updates config | `commands/autotyping.js` | **KEEP** | Visual preference. Needs DB storage. |
| **.autoread** | None | BOT PRIVACY | Automatically sends blue-tick read receipts | `.autoread [on/off]` | CUSTOMER_OWNER | Yes | Both | No | Sends read receipts; updates config | `commands/autoread.js` | **KEEP** | Reading preference. Needs DB storage. |
| **.setpp** | None | BOT PRIVACY | Changes bot WhatsApp profile picture | `.setpp` (as reply) | CUSTOMER_OWNER | Yes | Both | No | Updates Baileys socket profile picture | `commands/setpp.js` | **EDIT** | Best exposed via Customer Dashboard. |
| **.pies** | `.china`, `.japan`, `.korea`, `.hijab`, +4 | REVIEW | Fetches model/cosplay photos from `shizo.top` scraper | `.pies [country]` | ANY_USER | Yes | Both | No | Scrapes external photos | `commands/pies.js` | **DEPRECATE** | **NSFW / Brand Safety Risk**: Unvetted external photos unsuitable for professional SaaS. |
| **.misc** | `.horny`, `.gay`, `.lolice`, `.jail`, +10 | REVIEW | Meme overlay filters (includes controversial themes) | `.<theme> @user` | ANY_USER | Yes | Both | No | Fetches external image generator | `commands/misc.js` | **REVIEW** | Filter inappropriate variants (`horny`, `lolice`); keep safe ones (`jail`, `passed`). |
| **.autostatus**| None | REVIEW | Automatically views and reacts to contact WhatsApp statuses | `.autostatus [on/off]`| CUSTOMER_OWNER | Yes | Both | No | Writes to `./data/userGroupData.json` | `commands/autostatus.js` | **REVIEW** | High risk of triggering WhatsApp anti-bot bans due to mass status scraping. |
| **.antidelete**| None | REVIEW | Forwards deleted messages back to chat | `.antidelete [on/off]`| CUSTOMER_OWNER | Yes | Both | No | Stores message history in memory buffer | `commands/antidelete.js` | **REVIEW** | Controversial feature; potential privacy violation under WhatsApp ToS. |
| **.ban** | None | SYSTEM / DISABLED | Adds target user to global JSON file `./data/banned.json`| `.ban @user` | SYSTEM/DISABLED | Yes | Both | No | Writes to global JSON file | `commands/ban.js` | **DEPRECATE** | **Breaks Multi-Tenancy**: Global ban blocks user across all customer accounts. |
| **.unban** | None | SYSTEM / DISABLED | Removes target user from global `./data/banned.json` | `.unban @user` | SYSTEM/DISABLED | Yes | Both | No | Modifies global JSON file | `commands/unban.js` | **DEPRECATE** | Belongs to legacy single-tenant ban system. |
| **.sudo** | None | SYSTEM / DISABLED | Adds/removes sudo numbers in `data/sudo.json` | `.sudo <add/del>` | SYSTEM/DISABLED | Yes | Both | No | Writes to global `sudo.json` | `commands/sudo.js` | **DEPRECATE** | **Breaks Multi-Tenancy**: Bot belongs to tenant, not shared hardcoded sudo list. |
| **.owner** | None | SYSTEM / DISABLED | Sends vCard containing developer's phone number | `.owner` | SYSTEM/DISABLED | Yes | Both | No | Sends developer contact card | `commands/owner.js` | **DEPRECATE** | **Information Leak**: Leaks upstream developer's personal number to SaaS customers. |
| **.mode** | None | SYSTEM / DISABLED | Toggles bot public/private in `data/messageCount.json` | `.mode <pub/priv>` | SYSTEM/DISABLED | Yes | Both | No | Writes to global JSON | `commands/settings.js` | **DEPRECATE** | Replaced by customer account controls in dashboard. |
| **.settings** | None | SYSTEM / DISABLED | Displays status of local JSON switches in chat | `.settings` | SYSTEM/DISABLED | Yes | Both | No | Reads local JSON files | `commands/settings.js` | **DEPRECATE** | Replaced by Customer Web Dashboard. |
| **.cleartmp** | None | SYSTEM / DISABLED | Empties `./tmp/` folder on host server | `.cleartmp` | SYSTEM/DISABLED | Yes | Both | No | Deletes local server files | `commands/cleartmp.js` | **DEPRECATE** | Infrastructure maintenance task; must not be exposed to chat users. |
| **.update** | None | SYSTEM / DISABLED | Previously ran `git reset --hard` | `.update` | SYSTEM/DISABLED | Yes | Both | No | Sends disabled warning | `commands/update.js` | **DEPRECATE** | Already disabled for security. Remove dead file. |
| **.clearsession**| `.clearsesi` | SYSTEM / DISABLED | Previously deleted `./session/` files | `.clearsession` | SYSTEM/DISABLED | Yes | Both | No | Sends disabled warning | `commands/clearsession.js` | **DEPRECATE** | Already disabled for security. Remove dead file. |

---

## 3. Product Overlap & Merge Recommendations

1. **YouTube Audio: `.play` and `.song`**
   * *Actual Difference:* `.play` searches YouTube and downloads audio buffer; `.song` downloads from an external scraper API.
   * *User Goal:* Both exist solely to download music MP3s.
   * *Recommendation:* **MERGE** into `.play`. Aliases: `.song`.
2. **Hidden Mention Announcements: `.tag` and `.hidetag`**
   * *Actual Difference:* Completely identical logic—both iterate over group metadata participants and attach all JIDs to `contextInfo.mentionedJid` without listing `@` symbols in visible text.
   * *Recommendation:* **MERGE** into `.tag`. Alias: `.hidetag`.
3. **Mass Mention: `.tagall` and `.tagnotadmin`**
   * *Actual Difference:* `.tagall` mentions everyone; `.tagnotadmin` loops over group metadata and excludes members with `admin === 'admin' || admin === 'superadmin'`.
   * *Recommendation:* **MERGE** into `.tagall --members`.
4. **Sticker Cropping: `.sticker` and `.stickercrop` (`.crop`)**
   * *Actual Difference:* `.sticker` converts media as-is; `.stickercrop` applies `ffmpeg -vf "crop=w:h"` before conversion.
   * *Recommendation:* **MERGE** into `.sticker crop`.
5. **Instagram Media: `.instagram` and `.igs`**
   * *Actual Difference:* Both use `ruhend-scraper`; `.instagram` targets posts/reels, `.igs` targets stories.
   * *Recommendation:* **MERGE** into unified `.instagram` with automatic story/reel detection.
6. **Sticker Duplication: `.sticker-alt`**
   * *Actual Difference:* Redundant secondary file doing the exact same `ffmpeg` conversion.
   * *Recommendation:* **DEPRECATE** `.sticker-alt`.

---

## 4. Multi-Tenant Architectural Blockers (Global JSON Files)

The following commands read/write un-isolated root JSON files (`./data/*.json`). In Windowseven's multi-tenant production runtime, this causes cross-tenant configuration clashing:
* `anticall` (`data/anticall.json`)
* `pmblocker` (`data/pmblocker.json`)
* `autotyping` (`data/autotyping.json`)
* `autoread` (`data/autoread.json`)
* `welcome` & `goodbye` (`data/userGroupData.json`)
* `topmembers` (`data/messageCount.json`)
* `antidelete` (`data/antidelete.json`)
* `banned` (`data/banned.json`)

**Contract Lock:**
* In V1, group-specific settings (`welcome`, `goodbye`, `antibadword`, `antitag`) must be migrated to the PostgreSQL `group_policies` table.
* Customer connection privacy settings (`anticall`, `pmblocker`, `autotyping`, `autoread`) must be isolated per tenant in memory or database.
* Legacy global files (`banned.json`, `sudo.json`) must be permanently deprecated.
