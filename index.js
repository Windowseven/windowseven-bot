/**
 * Windowseven MD - WhatsApp Bot & Management Platform
 * Runtime Entrypoint (Phase 3B: ConnectionManager Architecture)
 */
require('dotenv').config();
require('./settings');
const chalk = require('chalk');
const readline = require('readline');
const PhoneNumber = require('awesome-phonenumber');
const settings = require('./settings');
const store = require('./lib/lightweight_store');
const { getPool, closePool } = require('./src/database/client');
const { verifyRequiredSchema } = require('./src/database/schemaCheck');
const { bootstrapTransitionalConnection } = require('./src/whatsapp/bootstrap');
const ConnectionManager = require('./src/whatsapp/ConnectionManager');
const { attachLegacyBridge } = require('./src/whatsapp/legacyBridge');

// Initialize lightweight store
store.readFromFile();
setInterval(() => store.writeToFile(), settings.storeWriteInterval || 10000).unref();

// Memory optimization - Force garbage collection if available
setInterval(() => {
    if (global.gc) {
        global.gc();
        console.log('🧹 Garbage collection completed');
    }
}, 60_000).unref();

// Memory monitoring - Restart if RAM gets too high
setInterval(() => {
    const used = process.memoryUsage().rss / 1024 / 1024;
    if (used > 400) {
        console.log('⚠️ RAM too high (>400MB), restarting bot...');
        process.exit(1);
    }
}, 30_000).unref();

global.botname = 'WINDOWSEVEN MD';
global.themeemoji = '•';

const rawPhone = process.env.BOT_PHONE_NUMBER || '';
const pairingCode = !!rawPhone || process.argv.includes('--pairing-code');

const rl = process.stdin.isTTY ? readline.createInterface({ input: process.stdin, output: process.stdout }) : null;
const question = (text) => {
    if (rl) {
        return new Promise((resolve) => rl.question(text, resolve));
    }
    return Promise.resolve(settings.ownerNumber || rawPhone);
};

let connectionManager = null;

async function startRuntime() {
    const pool = getPool();

    // 1. Verify schema existence (Fails closed without silently running migrations)
    await verifyRequiredSchema(pool);

    // 2. Resolve or provision transitional Tenant and WhatsAppConnection idempotently
    const { tenant, connection } = await bootstrapTransitionalConnection(pool, {
        phoneNumber: rawPhone || null,
        botName: global.botname,
    });

    console.log(chalk.cyan(`[Windowseven MD] Resolved Runtime Identity:`));
    console.log(chalk.cyan(`  Tenant:     ${tenant.name} (${tenant.id})`));
    console.log(chalk.cyan(`  Connection: ${connection.display_name} (${connection.id})`));

    // 3. Initialize ConnectionManager
    connectionManager = new ConnectionManager(pool);

    // 4. Start managed connection via ConnectionManager
    const runtimeConn = await connectionManager.createConnection(tenant.id, connection.id, {
        attachBridge: (adapter, context) => attachLegacyBridge(adapter, context),
        pairingCode,
        onQR: (qr) => {
            console.log(chalk.yellow('📱 QR Code generated. Please scan with WhatsApp.'));
        },
        onConnect: async (socket) => {
            console.log(chalk.magenta(` `));
            console.log(chalk.yellow(`🌿 Connected to => ` + JSON.stringify(socket.user, null, 2)));
            try {
                const botNumber = socket.user.id.split(':')[0] + '@s.whatsapp.net';
                await socket.sendMessage(botNumber, {
                    text: `🤖 Windowseven MD Connected Successfully!\n\n⏰ Time: ${new Date().toLocaleString()}\n✅ Status: Online via ConnectionManager!`,
                });
            } catch (_) {}

            console.log(chalk.cyan(`\n< ================================================== >`));
            console.log(chalk.bold.blue(`           [ ${global.botname || 'WINDOWSEVEN MD'} ]`));
            console.log(chalk.green(`• Status: Connected Successfully`));
            console.log(chalk.blue(`• Architecture: ConnectionManager + DB Auth`));
            console.log(chalk.cyan(`< ================================================== >\n`));
        },
    });

    // 5. Handle pairing code if requested
    const socket = runtimeConn.socket;
    if (pairingCode && !runtimeConn.state.creds.registered) {
        let phoneInput = rawPhone;
        if (!phoneInput) {
            phoneInput = await question(chalk.bgBlack(chalk.greenBright(`Please type your WhatsApp number 😍\nFormat: 255712345678 (without + or spaces) : `)));
        }
        phoneInput = phoneInput.replace(/[^0-9]/g, '');

        if (!PhoneNumber('+' + phoneInput).isValid()) {
            console.log(chalk.red('Invalid phone number format. Please check and restart.'));
            process.exit(1);
        }

        setTimeout(async () => {
            try {
                let code = await socket.requestPairingCode(phoneInput);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(chalk.black(chalk.bgGreen(`Your Pairing Code : `)), chalk.black(chalk.white(code)));
                console.log(chalk.yellow(`\nPlease enter this code in WhatsApp:\n1. Settings > Linked Devices\n2. Link with phone number\n3. Enter the code shown above`));
            } catch (error) {
                console.error('Error requesting pairing code:', error.message);
            }
        }, 3000);
    }
}

// Graceful Shutdown
async function handleShutdown(signal) {
    console.log(`\n[Windowseven MD] Received ${signal}. Shutting down gracefully...`);
    if (connectionManager) {
        await connectionManager.shutdown().catch(() => {});
    }
    await closePool().catch(() => {});
    process.exit(0);
}

process.on('SIGINT', () => handleShutdown('SIGINT'));
process.on('SIGTERM', () => handleShutdown('SIGTERM'));

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err.message);
});

process.on('unhandledRejection', (err) => {
    console.error('Unhandled Rejection:', err.message);
});

// Start the runtime
if (require.main === module) {
    startRuntime().catch((err) => {
        console.error(chalk.red('[Windowseven MD] Fatal Startup Error:'), err.message);
        process.exit(1);
    });
}

module.exports = {
    startRuntime,
    getConnectionManager: () => connectionManager,
};