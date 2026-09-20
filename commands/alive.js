const settings = require("../settings");

async function aliveCommand(sock, chatId, message) {
    try {
        const messageText = `*🤖 ${settings.botName || 'Windowseven MD'} is Active!*\n\n` +
                       `*Version:* ${settings.version}\n` +
                       `*Status:* Online\n` +
                       `*Mode:* ${settings.commandMode || 'Public'}\n\n` +
                       `*🌟 Features:*\n` +
                       `• Multi-Tenant Ready Architecture\n` +
                       `• Group Moderation & Antilink\n` +
                       `• Media Tools & Utilities\n` +
                       `• Administrative Automation\n\n` +
                       `Type *.menu* for full command list`;

        await sock.sendMessage(chatId, {
            text: messageText
        }, { quoted: message });
    } catch (error) {
        console.error('Error in alive command:', error);
        await sock.sendMessage(chatId, { text: 'Bot is online and running!' }, { quoted: message });
    }
}

module.exports = aliveCommand;