# 🤖 Windowseven MD

**Windowseven MD** is a WhatsApp Bot and Group Management Platform built using the [Baileys](https://github.com/WhiskeySockets/Baileys) library. It is engineered for robust group automation, moderation, media tooling, and is undergoing transformation into a multi-tenant SaaS backend.

---

## 🚀 Overview

Windowseven MD provides tools for group administration, automated moderation, multimedia conversion, and utility commands.

### Core Features

- **Group Moderation**: Anti-link detection, anti-badword filtering, warnings system with automatic threshold enforcement, muting/unmuting, and participant control (promote/demote/kick).
- **Media Processing**: High-performance sticker generation, WebP Exif metadata injection, image resizing, and background manipulation.
- **Automation**: Welcome and departure messages, auto-read options, and presence indicators.
- **Interactive Tools**: Text-to-speech, translation, games, and status utilities.

---

## 🛠️ Setup & Installation

### Prerequisites

- **Node.js**: version `>= 18.0.0`
- **npm**: version `>= 9.0.0`

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Windowseven/windowseven-bot.git
   cd windowseven-bot
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment:
   Copy the example environment file:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` to configure your parameters (e.g., `OWNER_NUMBER`, optional third-party API keys).

4. Run Tests:
   ```bash
   npm test
   ```

5. Start the Bot:
   ```bash
   npm start
   # Or with optimized memory footprint:
   npm run start:optimized
   ```

---

## 🔒 Security & Architecture Notice

- **No Hardcoded Secrets**: All third-party API keys and configuration must be managed through environment variables (`.env`).
- **Dangerous Commands Disabled**: Administrative commands that previously executed arbitrary shell or filesystem updates (`.update`, `.clearsession`) have been disabled for security.
- **Roadmap**: Windowseven MD is being systematically migrated towards a multi-tenant SaaS architecture with PostgreSQL persistence and a dedicated ConnectionManager. See `docs/` for architectural records.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
