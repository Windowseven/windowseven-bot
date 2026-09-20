const PhoneNumber = require('awesome-phonenumber');
const { jidDecode } = require('@whiskeysockets/baileys');
const { smsg } = require('../../lib/myfunc');
const { handleMessages, handleGroupParticipantUpdate, handleStatus } = require('../../main');

// Lightweight store
const store = require('../../lib/lightweight_store');

/**
 * Compatibility adapter connecting normalized EventAdapter events to legacy main.js handlers.
 * Maintains explicit tenantId and connectionId context.
 *
 * @param {import('./EventAdapter')} adapter - The EventAdapter instance
 * @param {object} context - { tenantId, connectionId, pipeline }
 */
function attachLegacyBridge(adapter, { tenantId, connectionId, pipeline = null }) {
    if (!adapter || !tenantId || !connectionId) {
        throw new Error('adapter, tenantId, and connectionId are required for legacy bridge');
    }

    const socket = adapter.socket;

    // Context metadata on socket for transitional compatibility
    socket.tenantContext = Object.freeze({ tenantId, connectionId });

    // Store bindings fed via normalized EventAdapter events
    adapter.on('contacts.updated', (event) => {
        if (event?.contacts) {
            event.contacts.forEach((contact) => {
                if (contact.id) {
                    store.contacts[contact.id] = {
                        id: contact.id,
                        name: contact.name || '',
                    };
                }
            });
        }
    });

    adapter.on('chats.set', (event) => {
        if (event?.chats) {
            store.chats = {};
            event.chats.forEach((chat) => {
                if (chat.id) {
                    store.chats[chat.id] = { id: chat.id, subject: chat.subject || '' };
                }
            });
        }
    });

    // Helper functions expected by legacy main.js / commands
    socket.decodeJid = (jid) => {
        if (!jid) return jid;
        if (/:\d+@/gi.test(jid)) {
            const decode = jidDecode(jid) || {};
            return (decode.user && decode.server && `${decode.user}@${decode.server}`) || jid;
        }
        return jid;
    };

    socket.getName = (jid, withoutContact = false) => {
        const id = socket.decodeJid(jid);
        if (id.endsWith('@g.us')) {
            return new Promise(async (resolve) => {
                const v = store.contacts[id] || {};
                if (!(v.name || v.subject)) {
                    try {
                        const meta = await socket.groupMetadata(id);
                        return resolve(meta?.subject || id);
                    } catch (_) {}
                }
                resolve(v.name || v.subject || id);
            });
        }
        const v = id === '0@s.whatsapp.net'
            ? { id, name: 'WhatsApp' }
            : id === socket.decodeJid(socket.user?.id)
            ? socket.user
            : (store.contacts[id] || {});
        return (withoutContact ? '' : v.name) || v.subject || v.verifiedName || id;
    };

    socket.public = true;
    socket.serializeM = (m) => smsg(socket, m, store);

    // 1. Normalized Message Ingestion
    adapter.on('message.received', async (event) => {
        try {
            const { message, raw } = event;
            if (!raw || !raw.message) return;

            // Maintain recent messages in lightweight store for quoted message resolution
            if (raw.key?.remoteJid) {
                const jid = raw.key.remoteJid;
                store.messages[jid] = store.messages[jid] || [];
                store.messages[jid].push(raw);
                if (store.messages[jid].length > (store.MAX_MESSAGES || 20)) {
                    store.messages[jid] = store.messages[jid].slice(-(store.MAX_MESSAGES || 20));
                }
            }

            // Phase 3D/3E: Application Pipeline processing
            if (pipeline) {
                const pipelineRes = await pipeline.processMessage(event);
                if (pipelineRes && pipelineRes.handled) {
                    // Migrated capability handled authoritatively by Application Pipeline.
                    // Short-circuit to avoid duplicate execution in legacy main.js!
                    return;
                }

                // If group is not managed, enforce SaaS security boundaries:
                // 1. Migrated commands must NEVER execute on unmanaged groups
                // 2. Automatic policies must NEVER run on unmanaged groups
                if (pipelineRes && (pipelineRes.reason === 'group_not_managed' || pipelineRes.reason === 'unresolved_or_mismatched_group')) {
                    const text = (message.text || '').trim();
                    if (text.startsWith('.')) {
                        const cmd = text.slice(1).split(/\s+/)[0]?.toLowerCase();
                        if (pipeline.commandRegistry && pipeline.commandRegistry.isMigrated(cmd)) {
                            // Migrated command on unmanaged group: drop without legacy execution
                            return;
                        }
                    } else {
                        // Non-command in unmanaged group: drop to prevent legacy automatic policy execution
                        return;
                    }
                }
            }

            if (message.remoteJid === 'status@broadcast') {
                await handleStatus(socket, { messages: [raw], type: 'notify' });
                return;
            }

            if (!socket.public && !message.fromMe && !message.isGroup) {
                return;
            }

            if (message.id && message.id.startsWith('BAE5') && message.id.length === 16) {
                return;
            }

            if (socket.msgRetryCounterCache) {
                socket.msgRetryCounterCache.clear();
            }

            const chatUpdate = {
                messages: [raw],
                type: 'notify',
            };

            try {
                await handleMessages(socket, chatUpdate, true);
            } catch (err) {
                console.error(`[LegacyBridge ${tenantId}:${connectionId}] Error in handleMessages:`, err.message);
                if (message.remoteJid) {
                    await socket.sendMessage(message.remoteJid, {
                        text: '❌ An error occurred while processing your message.'
                    }).catch(() => {});
                }
            }
        } catch (err) {
            console.error(`[LegacyBridge ${tenantId}:${connectionId}] Error processing normalized message:`, err.message);
        }
    });

    // 2. Normalized Group Participants Changed Ingestion
    adapter.on('group.participants.changed', async (event) => {
        try {
            await handleGroupParticipantUpdate(socket, event.raw);
        } catch (err) {
            console.error(`[LegacyBridge ${tenantId}:${connectionId}] Error in group participants update:`, err.message);
        }
    });

    // 3. Normalized Reaction Ingestion
    adapter.on('message.reaction', async (event) => {
        try {
            await handleStatus(socket, event.raw);
        } catch (_) {}
    });

    // 4. Normalized Call Ingestion
    const antiCallNotified = new Set();
    adapter.on('call.received', async (event) => {
        try {
            const { readState: readAnticallState } = require('../../commands/anticall');
            const state = readAnticallState();
            if (!state.enabled) return;

            for (const call of event.calls) {
                const callerJid = call.from;
                if (!callerJid) continue;

                try {
                    if (typeof socket.rejectCall === 'function' && call.id) {
                        await socket.rejectCall(call.id, callerJid);
                    } else if (typeof socket.sendCallOfferAck === 'function' && call.id) {
                        await socket.sendCallOfferAck(call.id, callerJid, 'reject');
                    }
                } catch (_) {}

                if (!antiCallNotified.has(callerJid)) {
                    antiCallNotified.add(callerJid);
                    setTimeout(() => antiCallNotified.delete(callerJid), 60000);
                    await socket.sendMessage(callerJid, {
                        text: '📵 Anticall is enabled. Your call was rejected and you will be blocked.'
                    }).catch(() => {});
                }

                setTimeout(async () => {
                    try {
                        await socket.updateBlockStatus(callerJid, 'block');
                    } catch (_) {}
                }, 800);
            }
        } catch (_) {}
    });
}

module.exports = {
    attachLegacyBridge,
};
