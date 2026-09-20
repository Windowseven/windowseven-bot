/**
 * Windowseven MD - Deprecated Legacy ClearSession Command
 * 
 * SECURITY NOTICE:
 * This command previously allowed arbitrary unlinking of session files in `./session`.
 * In Windowseven MD's multi-tenant architecture, session lifecycle is managed strictly
 * by the ConnectionManager and database-backed authentication adapters.
 */

async function clearSessionCommand(sock, chatId, msg) {
    await sock.sendMessage(chatId, { 
        text: '❌ The .clearsession command has been permanently disabled for security reasons in Windowseven MD. Session lifecycle is securely managed by the platform.' 
    }, { quoted: msg });
}

module.exports = clearSessionCommand;