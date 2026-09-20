const settings = require('../settings');

async function ownerCommand(sock, chatId) {
    if (!settings.ownerNumber) {
        await sock.sendMessage(chatId, { text: '⚠️ Bot owner number is not configured in environment variables.' });
        return;
    }

    const vcard = `
BEGIN:VCARD
VERSION:3.0
FN:${settings.botOwner || 'Windowseven Admin'}
TEL;waid=${settings.ownerNumber}:${settings.ownerNumber}
END:VCARD
`;

    await sock.sendMessage(chatId, {
        contacts: { displayName: settings.botOwner || 'Windowseven Admin', contacts: [{ vcard }] },
    });
}

module.exports = ownerCommand;
