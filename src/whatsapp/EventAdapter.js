const EventEmitter = require('events');

class EventAdapter extends EventEmitter {
    /**
     * @param {object} ctx - Immutable ExecutionContext { tenantId, connectionId, sock, db }
     */
    constructor(ctx) {
        super();
        if (!ctx || !ctx.tenantId || !ctx.connectionId || !ctx.sock) {
            throw new Error('[EventAdapter] Valid ExecutionContext with tenantId, connectionId, and sock is required');
        }
        this.ctx = ctx;
        this.socket = ctx.sock;
        this._bindRawEvents();
    }

    /**
     * Subscribes to raw Baileys events and routes them through defensive parsers.
     */
    _bindRawEvents() {
        const ev = this.socket.ev;

        ev.on('messages.upsert', (chatUpdate) => {
            try {
                this._handleMessagesUpsert(chatUpdate);
            } catch (err) {
                this._logError('messages.upsert', err);
            }
        });

        ev.on('group-participants.update', (update) => {
            try {
                this._handleGroupParticipantsUpdate(update);
            } catch (err) {
                this._logError('group-participants.update', err);
            }
        });

        ev.on('groups.upsert', (groups) => {
            try {
                this._handleGroupsUpsert(groups);
            } catch (err) {
                this._logError('groups.upsert', err);
            }
        });

        ev.on('groups.update', (updates) => {
            try {
                this._handleGroupsUpdate(updates);
            } catch (err) {
                this._logError('groups.update', err);
            }
        });

        ev.on('connection.update', (update) => {
            try {
                this._handleConnectionUpdate(update);
            } catch (err) {
                this._logError('connection.update', err);
            }
        });

        ev.on('messages.reaction', (reactions) => {
            try {
                this._handleMessagesReaction(reactions);
            } catch (err) {
                this._logError('messages.reaction', err);
            }
        });

        ev.on('call', (calls) => {
            try {
                this._handleCall(calls);
            } catch (err) {
                this._logError('call', err);
            }
        });

        ev.on('contacts.update', (contacts) => {
            try {
                this._handleContactsUpdate(contacts);
            } catch (err) {
                this._logError('contacts.update', err);
            }
        });

        ev.on('chats.set', (chats) => {
            try {
                this._handleChatsSet(chats);
            } catch (err) {
                this._logError('chats.set', err);
            }
        });
    }

    _handleMessagesUpsert(chatUpdate) {
        if (!chatUpdate || !Array.isArray(chatUpdate.messages) || chatUpdate.messages.length === 0) {
            return;
        }

        for (const mek of chatUpdate.messages) {
            if (!mek || !mek.key) continue;

            const remoteJid = mek.key.remoteJid;
            if (!remoteJid || typeof remoteJid !== 'string') continue;

            // Extract message text defensively
            let text = null;
            let messageType = null;
            if (mek.message) {
                const inner = (Object.keys(mek.message)[0] === 'ephemeralMessage')
                    ? mek.message.ephemeralMessage?.message
                    : mek.message;

                if (inner) {
                    messageType = Object.keys(inner)[0] || null;
                    text = inner.conversation?.trim() ||
                        inner.extendedTextMessage?.text?.trim() ||
                        inner.imageMessage?.caption?.trim() ||
                        inner.videoMessage?.caption?.trim() ||
                        inner.buttonsResponseMessage?.selectedButtonId?.trim() ||
                        null;
                }
            }

            const isGroup = remoteJid.endsWith('@g.us');
            const participant = mek.key.participant || (isGroup ? null : remoteJid);
            const fromMe = Boolean(mek.key.fromMe);
            const id = mek.key.id || null;
            const timestamp = mek.messageTimestamp
                ? (typeof mek.messageTimestamp === 'number' ? mek.messageTimestamp : Number(mek.messageTimestamp.low || mek.messageTimestamp))
                : Date.now();

            const normalizedEvent = {
                eventType: 'message.received',
                ctx: this.ctx,
                message: {
                    id,
                    remoteJid,
                    participant,
                    fromMe,
                    timestamp,
                    messageType,
                    text,
                    isGroup,
                },
                raw: mek,
            };

            this.emit('message.received', normalizedEvent);
        }
    }

    _handleGroupParticipantsUpdate(update) {
        if (!update || !update.id || typeof update.id !== 'string' || !update.id.endsWith('@g.us')) {
            return;
        }

        const validActions = ['add', 'remove', 'promote', 'demote'];
        const action = validActions.includes(update.action) ? update.action : 'unknown';

        let participantList = [];
        if (Array.isArray(update.participants)) {
            participantList = update.participants.map((p) => {
                const jid = typeof p === 'string' ? p : p?.id || p?.jid || null;
                return { jid, action };
            }).filter((p) => p.jid !== null);
        }

        const normalizedEvent = {
            eventType: 'group.participants.changed',
            ctx: this.ctx,
            group: {
                jid: update.id,
            },
            action,
            author: update.author || null,
            participants: participantList,
            raw: update,
        };

        this.emit('group.participants.changed', normalizedEvent);
    }

    _handleGroupsUpsert(groups) {
        if (!Array.isArray(groups)) return;

        for (const meta of groups) {
            if (!meta || !meta.id || typeof meta.id !== 'string') continue;

            const normalizedEvent = {
                eventType: 'group.discovered',
                ctx: this.ctx,
                group: {
                    jid: meta.id,
                    name: meta.subject || null,
                    owner: meta.owner || null,
                    creation: meta.creation || null,
                },
                raw: meta,
            };

            this.emit('group.discovered', normalizedEvent);
        }
    }

    _handleGroupsUpdate(updates) {
        if (!Array.isArray(updates)) return;

        for (const meta of updates) {
            if (!meta || !meta.id || typeof meta.id !== 'string') continue;

            const normalizedEvent = {
                eventType: 'group.updated',
                ctx: this.ctx,
                group: {
                    jid: meta.id,
                    name: meta.subject || null,
                },
                raw: meta,
            };

            this.emit('group.updated', normalizedEvent);
        }
    }

    _handleConnectionUpdate(update) {
        if (!update || typeof update !== 'object') return;

        let status = null;
        if (update.connection === 'connecting') status = 'CONNECTING';
        else if (update.connection === 'open') status = 'CONNECTED';
        else if (update.connection === 'close') status = 'DISCONNECTED';

        if (status) {
            const normalizedEvent = {
                eventType: 'connection.status.changed',
                ctx: this.ctx,
                status,
                qr: update.qr || null,
                raw: update,
            };

            this.emit('connection.status.changed', normalizedEvent);
        }
    }

    _handleMessagesReaction(reactions) {
        if (!Array.isArray(reactions)) return;

        for (const reaction of reactions) {
            if (!reaction || !reaction.key) continue;

            const normalizedEvent = {
                eventType: 'message.reaction',
                ctx: this.ctx,
                reaction: {
                    key: reaction.key,
                    text: reaction.text || null,
                    sender: reaction.sender || reaction.key.participant || null,
                },
                raw: reaction,
            };

            this.emit('message.reaction', normalizedEvent);
        }
    }

    _handleCall(calls) {
        if (!Array.isArray(calls) || calls.length === 0) return;

        const normalizedCalls = calls.map((call) => ({
            id: call.id || null,
            from: call.from || call.peerJid || call.chatId || null,
            status: call.status || null,
            isVideo: Boolean(call.isVideo),
        })).filter((c) => c.from !== null);

        if (normalizedCalls.length > 0) {
            const normalizedEvent = {
                eventType: 'call.received',
                ctx: this.ctx,
                calls: normalizedCalls,
                raw: calls,
            };

            this.emit('call.received', normalizedEvent);
        }
    }

    _handleContactsUpdate(contacts) {
        if (!Array.isArray(contacts) || contacts.length === 0) return;
        const normalized = contacts.filter((c) => c && c.id).map((c) => ({
            id: c.id,
            name: c.notify || c.name || '',
        }));
        if (normalized.length > 0) {
            this.emit('contacts.updated', {
                eventType: 'contacts.updated',
                ctx: this.ctx,
                contacts: normalized,
                raw: contacts,
            });
        }
    }

    _handleChatsSet(chatsPayload) {
        const chats = Array.isArray(chatsPayload?.chats)
            ? chatsPayload.chats
            : (Array.isArray(chatsPayload) ? chatsPayload : []);
        const normalized = chats.filter((c) => c && c.id).map((c) => ({
            id: c.id,
            subject: c.subject || '',
        }));
        this.emit('chats.set', {
            eventType: 'chats.set',
            ctx: this.ctx,
            chats: normalized,
            raw: chatsPayload,
        });
    }

    _logError(eventName, error) {
        console.error(
            `[EventAdapter ${this.ctx.tenantId}:${this.ctx.connectionId}] Error normalizing event '${eventName}':`,
            error.message
        );
    }
}

module.exports = EventAdapter;
