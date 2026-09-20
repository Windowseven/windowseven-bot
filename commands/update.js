/**
 * Windowseven MD - Deprecated Legacy Update Command
 * 
 * SECURITY NOTICE:
 * This command previously allowed arbitrary `git reset --hard` and runtime
 * remote ZIP downloads over chat. This capability has been permanently disabled
 * in Windowseven MD to prevent remote code execution and host compromise.
 */

async function updateCommand(sock, chatId, message) {
    await sock.sendMessage(chatId, { 
        text: '❌ The .update command has been permanently disabled for security reasons in Windowseven MD. System updates must be applied via controlled deployment pipelines.' 
    }, { quoted: message });
}

module.exports = updateCommand;
