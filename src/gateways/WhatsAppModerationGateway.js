const { jidNormalizedUser } = require('@whiskeysockets/baileys');
const isAdminHelper = require('../../lib/isAdmin');

class WhatsAppModerationGateway {
    /**
     * @param {object} socket - Raw Baileys socket
     */
    constructor(socket) {
        if (!socket) {
            throw new Error('[WhatsAppModerationGateway] Active Baileys socket is required');
        }
        this.socket = socket;
    }

    /**
     * Checks whether the actor and the bot are admins of the specified group.
     * @param {string} chatJid
     * @param {string} senderJid
     * @returns {Promise<{ isSenderAdmin: boolean, isBotAdmin: boolean }>}
     */
    async checkAdminStatus(chatJid, senderJid) {
        if (!chatJid.endsWith('@g.us')) {
            return { isSenderAdmin: false, isBotAdmin: false };
        }
        try {
            const res = await isAdminHelper(this.socket, chatJid, senderJid);
            return {
                isSenderAdmin: Boolean(res?.isSenderAdmin),
                isBotAdmin: Boolean(res?.isBotAdmin),
            };
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to check admin status for ${chatJid}:`, err.message);
            return { isSenderAdmin: false, isBotAdmin: false };
        }
    }

    /**
     * Sends a plain text message, optionally with mentions and quote.
     * @param {string} chatJid
     * @param {string} text
     * @param {object} [options]
     * @param {Array<string>} [options.mentions]
     * @param {object} [options.quoted]
     * @returns {Promise<object|null>}
     */
    async sendTextMessage(chatJid, text, { mentions = [], quoted = null } = {}) {
        try {
            const content = { text };
            if (Array.isArray(mentions) && mentions.length > 0) {
                content.mentions = mentions.map((m) => jidNormalizedUser(m));
            }
            const opts = quoted ? { quoted } : {};
            return await this.socket.sendMessage(chatJid, content, opts);
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to send message to ${chatJid}:`, err.message);
            return null;
        }
    }

    /**
     * Deletes a specific message.
     * @param {string} chatJid
     * @param {object} messageKey - { remoteJid, id, participant, fromMe }
     * @returns {Promise<boolean>}
     */
    async deleteMessage(chatJid, messageKey) {
        if (!messageKey || !messageKey.id) return false;
        try {
            await this.socket.sendMessage(chatJid, { delete: messageKey });
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to delete message in ${chatJid}:`, err.message);
            return false;
        }
    }

    /**
     * Removes/kicks a participant from a group.
     * @param {string} chatJid
     * @param {string} participantJid
     * @returns {Promise<boolean>}
     */
    async kickParticipant(chatJid, participantJid) {
        if (!chatJid.endsWith('@g.us') || !participantJid) return false;
        const normalized = jidNormalizedUser(participantJid);

        // Protection: Bot cannot kick itself
        const botJid = jidNormalizedUser(this.socket.user?.id);
        if (normalized === botJid) {
            console.warn(`[WhatsAppModerationGateway] Aborted self-kick attempt in ${chatJid}`);
            return false;
        }

        try {
            await this.socket.groupParticipantsUpdate(chatJid, [normalized], 'remove');
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to kick participant ${participantJid} in ${chatJid}:`, err.message);
            return false;
        }
    }

    /**
     * Mutes the group by setting announcement mode (only admins can send messages).
     * Preserves exact semantics from commands/mute.js.
     * @param {string} chatJid
     * @returns {Promise<boolean>}
     */
    async muteGroup(chatJid) {
        if (!chatJid.endsWith('@g.us')) return false;
        try {
            await this.socket.groupSettingUpdate(chatJid, 'announcement');
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to mute group ${chatJid}:`, err.message);
            return false;
        }
    }

    /**
     * Unmutes the group by setting not_announcement mode (all members can send messages).
     * Preserves exact semantics from commands/unmute.js.
     * @param {string} chatJid
     * @returns {Promise<boolean>}
     */
    async unmuteGroup(chatJid) {
        if (!chatJid.endsWith('@g.us')) return false;
        try {
            await this.socket.groupSettingUpdate(chatJid, 'not_announcement');
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to unmute group ${chatJid}:`, err.message);
            return false;
        }
    }

    /**
     * Promotes a participant to group admin.
     * @param {string} chatJid
     * @param {string} participantJid
     * @returns {Promise<boolean>}
     */
    async promoteParticipant(chatJid, participantJid) {
        if (!chatJid.endsWith('@g.us') || !participantJid) return false;
        const normalized = jidNormalizedUser(participantJid);
        try {
            await this.socket.groupParticipantsUpdate(chatJid, [normalized], 'promote');
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to promote participant ${participantJid} in ${chatJid}:`, err.message);
            return false;
        }
    }

    /**
     * Demotes a participant from group admin.
     * @param {string} chatJid
     * @param {string} participantJid
     * @returns {Promise<boolean>}
     */
    async demoteParticipant(chatJid, participantJid) {
        if (!chatJid.endsWith('@g.us') || !participantJid) return false;
        const normalized = jidNormalizedUser(participantJid);
        try {
            await this.socket.groupParticipantsUpdate(chatJid, [normalized], 'demote');
            return true;
        } catch (err) {
            console.error(`[WhatsAppModerationGateway] Failed to demote participant ${participantJid} in ${chatJid}:`, err.message);
            return false;
        }
    }
}

module.exports = WhatsAppModerationGateway;
