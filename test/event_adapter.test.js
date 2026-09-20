const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const EventEmitter = require('events');
const { createExecutionContext } = require('../src/whatsapp/ExecutionContext');
const EventAdapter = require('../src/whatsapp/EventAdapter');

function createMockSocket() {
    return {
        ev: new EventEmitter(),
        user: { id: '255700000001:1@s.whatsapp.net' },
    };
}

describe('EventAdapter Normalization, ExecutionContext & Boundary Validation', () => {
    const tenantA = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const connA = '11111111-1111-1111-1111-111111111111';

    const tenantB = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
    const connB = '22222222-2222-2222-2222-222222222222';

    it('should create immutable ExecutionContext scoped to tenant and connection', () => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({
            tenantId: tenantA,
            connectionId: connA,
            socket,
        });

        assert.strictEqual(ctx.tenantId, tenantA);
        assert.strictEqual(ctx.connectionId, connA);
        assert.strictEqual(ctx.sock, socket);
        assert.strictEqual(Object.isFrozen(ctx), true, 'Context must be frozen/immutable');

        // Attempting to mutate throws or is ignored
        assert.throws(() => {
            'use strict';
            ctx.tenantId = tenantB;
        }, TypeError);
    });

    it('should normalize standard text messages into message.received event', (t, done) => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        adapter.on('message.received', (event) => {
            assert.strictEqual(event.eventType, 'message.received');
            assert.strictEqual(event.ctx.tenantId, tenantA);
            assert.strictEqual(event.ctx.connectionId, connA);
            assert.strictEqual(event.message.id, 'MSG_12345');
            assert.strictEqual(event.message.remoteJid, '255711111111@s.whatsapp.net');
            assert.strictEqual(event.message.fromMe, false);
            assert.strictEqual(event.message.isGroup, false);
            assert.strictEqual(event.message.text, 'Hello Windowseven');
            assert.strictEqual(event.message.messageType, 'conversation');
            done();
        });

        // Emit raw Baileys messages.upsert
        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [
                {
                    key: {
                        remoteJid: '255711111111@s.whatsapp.net',
                        fromMe: false,
                        id: 'MSG_12345',
                    },
                    message: {
                        conversation: 'Hello Windowseven',
                    },
                    messageTimestamp: 1710000000,
                },
            ],
        });
    });

    it('should normalize group messages and media captions properly', (t, done) => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        adapter.on('message.received', (event) => {
            assert.strictEqual(event.message.isGroup, true);
            assert.strictEqual(event.message.remoteJid, '120363000000000001@g.us');
            assert.strictEqual(event.message.participant, '255799999999@s.whatsapp.net');
            assert.strictEqual(event.message.text, 'Check out this photo caption');
            assert.strictEqual(event.message.messageType, 'imageMessage');
            done();
        });

        socket.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [
                {
                    key: {
                        remoteJid: '120363000000000001@g.us',
                        participant: '255799999999@s.whatsapp.net',
                        fromMe: false,
                        id: 'IMG_99999',
                    },
                    message: {
                        imageMessage: {
                            caption: 'Check out this photo caption',
                            mimetype: 'image/jpeg',
                        },
                    },
                },
            ],
        });
    });

    it('should safely discard malformed message events without throwing or crashing', () => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        let receivedCount = 0;
        adapter.on('message.received', () => {
            receivedCount++;
        });

        // 1. null payload
        socket.ev.emit('messages.upsert', null);
        // 2. empty messages array
        socket.ev.emit('messages.upsert', { messages: [] });
        // 3. message with missing key
        socket.ev.emit('messages.upsert', { messages: [{}] });
        // 4. message with missing remoteJid
        socket.ev.emit('messages.upsert', { messages: [{ key: {} }] });
        // 5. non-string remoteJid
        socket.ev.emit('messages.upsert', { messages: [{ key: { remoteJid: 12345 } }] });

        assert.strictEqual(receivedCount, 0, 'No malformed events should be emitted');
    });

    it('should normalize group-participants.update into group.participants.changed', (t, done) => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        adapter.on('group.participants.changed', (event) => {
            assert.strictEqual(event.eventType, 'group.participants.changed');
            assert.strictEqual(event.group.jid, '120363000000000001@g.us');
            assert.strictEqual(event.action, 'add');
            assert.strictEqual(event.author, '255700000001@s.whatsapp.net');
            assert.strictEqual(event.participants.length, 2);
            assert.strictEqual(event.participants[0].jid, '255711111111@s.whatsapp.net');
            assert.strictEqual(event.participants[0].action, 'add');
            done();
        });

        socket.ev.emit('group-participants.update', {
            id: '120363000000000001@g.us',
            author: '255700000001@s.whatsapp.net',
            action: 'add',
            participants: ['255711111111@s.whatsapp.net', '255722222222@s.whatsapp.net'],
        });
    });

    it('should map unknown participant action to unknown and reject non-group JID update', () => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        let emitted = null;
        adapter.on('group.participants.changed', (ev) => {
            emitted = ev;
        });

        // 1. Non-group JID must be discarded
        socket.ev.emit('group-participants.update', {
            id: '255711111111@s.whatsapp.net', // not a group JID!
            action: 'add',
            participants: ['foo'],
        });
        assert.strictEqual(emitted, null);

        // 2. Unknown action mapped to 'unknown'
        socket.ev.emit('group-participants.update', {
            id: '120363000000000001@g.us',
            action: 'speculative_future_action',
            participants: ['255733333333@s.whatsapp.net'],
        });
        assert.ok(emitted);
        assert.strictEqual(emitted.action, 'unknown');
    });

    it('should normalize groups.upsert and groups.update events', () => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        let discovered = null;
        let updated = null;

        adapter.on('group.discovered', (ev) => { discovered = ev; });
        adapter.on('group.updated', (ev) => { updated = ev; });

        socket.ev.emit('groups.upsert', [
            {
                id: '120363111111111111@g.us',
                subject: 'New Discovered Group',
                owner: '255700000001@s.whatsapp.net',
            },
        ]);

        socket.ev.emit('groups.update', [
            {
                id: '120363111111111111@g.us',
                subject: 'Renamed Discovered Group',
            },
        ]);

        assert.ok(discovered);
        assert.strictEqual(discovered.group.jid, '120363111111111111@g.us');
        assert.strictEqual(discovered.group.name, 'New Discovered Group');

        assert.ok(updated);
        assert.strictEqual(updated.group.jid, '120363111111111111@g.us');
        assert.strictEqual(updated.group.name, 'Renamed Discovered Group');
    });

    it('should normalize connection.update into connection.status.changed', () => {
        const socket = createMockSocket();
        const ctx = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket });
        const adapter = new EventAdapter(ctx);

        const statuses = [];
        adapter.on('connection.status.changed', (ev) => {
            statuses.push(ev.status);
        });

        socket.ev.emit('connection.update', { connection: 'connecting' });
        socket.ev.emit('connection.update', { connection: 'open' });
        socket.ev.emit('connection.update', { connection: 'close' });

        assert.deepStrictEqual(statuses, ['CONNECTING', 'CONNECTED', 'DISCONNECTED']);
    });

    it('should isolate events and contexts across multiple connections', () => {
        const socketA = createMockSocket();
        const socketB = createMockSocket();

        const ctxA = createExecutionContext({ tenantId: tenantA, connectionId: connA, socket: socketA });
        const ctxB = createExecutionContext({ tenantId: tenantB, connectionId: connB, socket: socketB });

        const adapterA = new EventAdapter(ctxA);
        const adapterB = new EventAdapter(ctxB);

        const eventsA = [];
        const eventsB = [];

        adapterA.on('message.received', (ev) => eventsA.push(ev));
        adapterB.on('message.received', (ev) => eventsB.push(ev));

        // Emit on socket A only
        socketA.ev.emit('messages.upsert', {
            type: 'notify',
            messages: [{ key: { remoteJid: '255711111111@s.whatsapp.net', id: 'A_MSG' }, message: { conversation: 'Msg for A' } }],
        });

        assert.strictEqual(eventsA.length, 1);
        assert.strictEqual(eventsB.length, 0);
        assert.strictEqual(eventsA[0].ctx.tenantId, tenantA);
        assert.strictEqual(eventsA[0].ctx.connectionId, connA);
    });
});
