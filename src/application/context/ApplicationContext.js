class ApplicationContext {
    /**
     * @param {object} params
     * @param {string} params.tenantId
     * @param {string} params.connectionId
     * @param {object|null} params.group - { id, whatsappJid, name, status }
     * @param {object} params.actor - { senderJid, isSenderAdmin, isBotAdmin }
     * @param {import('../../domain/models/NormalizedMessage')} params.message
     */
    constructor({
        tenantId,
        connectionId,
        group = null,
        actor = {},
        message,
    }) {
        if (!tenantId || !connectionId) {
            throw new Error('[ApplicationContext] tenantId and connectionId are required');
        }
        if (!message) {
            throw new Error('[ApplicationContext] message is required');
        }

        this.tenantId = tenantId;
        this.connectionId = connectionId;
        this.group = group ? Object.freeze({
            ...group,
            whatsappJid: group.whatsappJid || group.whatsapp_jid,
            whatsapp_jid: group.whatsapp_jid || group.whatsappJid,
        }) : null;
        this.actor = Object.freeze({
            senderJid: actor.senderJid || null,
            isSenderAdmin: Boolean(actor.isSenderAdmin),
            isBotAdmin: Boolean(actor.isBotAdmin),
        });
        this.message = message;

        Object.freeze(this);
    }
}

module.exports = ApplicationContext;
