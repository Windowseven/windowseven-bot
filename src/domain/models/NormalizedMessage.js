const { jidNormalizedUser } = require('@whiskeysockets/baileys');

class NormalizedMessage {
    /**
     * @param {object} params
     * @param {string} params.messageId
     * @param {string} params.tenantId
     * @param {string} params.connectionId
     * @param {string} params.chatJid - remoteJid
     * @param {string} params.senderJid
     * @param {string} params.botJid
     * @param {string} params.text
     * @param {boolean} params.isGroup
     * @param {boolean} params.fromMe
     * @param {number} params.timestamp
     * @param {Array<string>} [params.mentionedJids]
     * @param {string|null} [params.quotedSender]
     * @param {object|null} [params.rawMessage]
     */
    constructor({
        messageId,
        tenantId,
        connectionId,
        chatJid,
        senderJid,
        botJid,
        text = '',
        isGroup = false,
        fromMe = false,
        timestamp = Date.now(),
        mentionedJids = [],
        quotedSender = null,
        rawMessage = null,
    }) {
        this.messageId = messageId;
        this.tenantId = tenantId;
        this.connectionId = connectionId;
        this.chatJid = chatJid;
        this.senderJid = senderJid ? jidNormalizedUser(senderJid) : null;
        this.botJid = botJid ? jidNormalizedUser(botJid) : null;
        this.text = typeof text === 'string' ? text.trim() : '';
        this.isGroup = Boolean(isGroup);
        this.fromMe = Boolean(fromMe);
        this.timestamp = timestamp;
        this.mentionedJids = Array.isArray(mentionedJids)
            ? mentionedJids.map((j) => jidNormalizedUser(j))
            : [];
        this.quotedSender = quotedSender ? jidNormalizedUser(quotedSender) : null;
        this.rawMessage = rawMessage;

        // Command parsing (standard prefix '.')
        const prefix = '.';
        if (this.text.startsWith(prefix)) {
            const withoutPrefix = this.text.slice(prefix.length).trim();
            const parts = withoutPrefix.split(/\s+/);
            this.command = parts[0] ? parts[0].toLowerCase() : '';
            this.args = parts.slice(1);
            this.rawArgs = withoutPrefix.slice(this.command.length).trim();
            this.isCommand = this.command.length > 0;
        } else {
            this.command = null;
            this.args = [];
            this.rawArgs = '';
            this.isCommand = false;
        }

        // Determine explicit message kind (COMMAND | MEDIA | SYSTEM | TEXT)
        if (this.isCommand) {
            this.messageKind = 'COMMAND';
        } else if (rawMessage?.messageStubType || rawMessage?.protocolMessage || rawMessage?.message?.protocolMessage) {
            this.messageKind = 'SYSTEM';
        } else if (rawMessage?.message) {
            const inner = rawMessage.message.ephemeralMessage?.message || rawMessage.message;
            const keys = Object.keys(inner || {});
            const hasMedia = keys.some((k) =>
                ['imageMessage', 'videoMessage', 'stickerMessage', 'documentMessage', 'audioMessage'].includes(k)
            );
            this.messageKind = hasMedia ? 'MEDIA' : 'TEXT';
        } else {
            this.messageKind = 'TEXT';
        }

        Object.freeze(this.mentionedJids);
        Object.freeze(this.args);
        Object.freeze(this);
    }
}

module.exports = NormalizedMessage;
