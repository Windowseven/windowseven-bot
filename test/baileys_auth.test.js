const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { Pool } = require('pg');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');
const { migrateUp } = require('../src/database/migrator');
const {
    TenantRepository,
    WhatsAppConnectionRepository,
    WhatsAppAuthCredentialsRepository,
    WhatsAppAuthKeysRepository,
} = require('../src/repositories');
const { useDatabaseAuthState } = require('../src/whatsapp/DatabaseAuthState');

const TEST_DB_URL = process.env.TEST_DATABASE_URL || 'postgresql://testuser@127.0.0.1:5433/windowseven_test';

describe('Database-Backed Baileys Authentication State', () => {
    let pool;
    let tenantRepo;
    let connRepo;
    let credsRepo;
    let keysRepo;

    let tenantA, tenantB;
    let connA, connB;

    before(async () => {
        pool = new Pool({ connectionString: TEST_DB_URL });
        tenantRepo = new TenantRepository(pool);
        connRepo = new WhatsAppConnectionRepository(pool);
        credsRepo = new WhatsAppAuthCredentialsRepository(pool);
        keysRepo = new WhatsAppAuthKeysRepository(pool);

        await migrateUp(pool);
        await pool.query('DELETE FROM tenants CASCADE;');

        // Provision Tenant A and Connection A
        tenantA = await tenantRepo.create({ name: 'Auth Test Tenant A' });
        connA = await connRepo.createForTenant(tenantA.id, {
            phoneNumber: '255700000010',
            displayName: 'Auth Bot A',
        });

        // Provision Tenant B and Connection B
        tenantB = await tenantRepo.create({ name: 'Auth Test Tenant B' });
        connB = await connRepo.createForTenant(tenantB.id, {
            phoneNumber: '255700000020',
            displayName: 'Auth Bot B',
        });
    });

    after(async () => {
        await pool.end();
    });

    it('should initialize fresh credentials when no auth row exists', async () => {
        const authState = await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo, keysRepo });
        assert.ok(authState.state.creds);
        assert.ok(authState.state.creds.noiseKey);
        assert.ok(Buffer.isBuffer(authState.state.creds.noiseKey.private));

        // Verify credentials persisted in database
        const loadedCreds = await credsRepo.getCredentials(tenantA.id, connA.id);
        assert.ok(loadedCreds);
        assert.strictEqual(loadedCreds.registrationId, authState.state.creds.registrationId);
        assert.deepStrictEqual(loadedCreds.noiseKey.private, authState.state.creds.noiseKey.private);
    });

    it('should preserve binary Buffers across save and reload (BufferJSON fidelity)', async () => {
        const authState = await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo, keysRepo });

        // Mutate creds with custom buffer data
        const testBuffer = Buffer.from('windowseven_test_secret_payload_12345', 'utf8');
        authState.state.creds.testBuffer = testBuffer;
        authState.state.creds.registered = true;

        await authState.saveCreds();

        // Reload directly from repository
        const reloaded = await credsRepo.getCredentials(tenantA.id, connA.id);
        assert.ok(Buffer.isBuffer(reloaded.testBuffer), 'testBuffer must be revived as a Buffer');
        assert.strictEqual(reloaded.testBuffer.toString('utf8'), 'windowseven_test_secret_payload_12345');
        assert.strictEqual(reloaded.registered, true);
    });

    it('should batch get and set Signal keys and handle key deletion', async () => {
        const authState = await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo, keysRepo });

        const preKey1 = {
            keyPair: {
                public: Buffer.from('public_key_1'),
                private: Buffer.from('private_key_1'),
            },
            keyId: 1,
        };
        const preKey2 = {
            keyPair: {
                public: Buffer.from('public_key_2'),
                private: Buffer.from('private_key_2'),
            },
            keyId: 2,
        };

        // 1. Batch set keys
        await authState.state.keys.set({
            'pre-key': {
                '1': preKey1,
                '2': preKey2,
            },
            'session': {
                'user-session-1': { sessionData: Buffer.from('session_bytes') },
            },
        });

        // 2. Batch get keys
        const retrieved = await authState.state.keys.get('pre-key', ['1', '2', 'non-existent']);
        assert.ok(retrieved['1']);
        assert.ok(retrieved['2']);
        assert.strictEqual(retrieved['non-existent'], undefined);
        assert.strictEqual(retrieved['1'].keyPair.public.toString(), 'public_key_1');
        assert.strictEqual(retrieved['2'].keyPair.private.toString(), 'private_key_2');

        // 3. Key deletion: setting value to null deletes the key
        await authState.state.keys.set({
            'pre-key': {
                '1': null,
            },
        });

        const afterDelete = await authState.state.keys.get('pre-key', ['1', '2']);
        assert.strictEqual(afterDelete['1'], undefined, 'Key 1 must be deleted');
        assert.ok(afterDelete['2'], 'Key 2 must remain');
    });

    it('should isolate auth state between different connections and tenants', async () => {
        const authStateB = await useDatabaseAuthState(tenantB.id, connB.id, { credsRepo, keysRepo });

        // Set key on Connection B
        await authStateB.state.keys.set({
            'session': {
                'tenantB-session': { data: Buffer.from('beta_secret') },
            },
        });

        // Connection A querying Connection B's session key
        const keysForA = await keysRepo.getKeys(tenantA.id, connA.id, 'session', ['tenantB-session']);
        assert.strictEqual(Object.keys(keysForA).length, 0, 'Connection A must not retrieve Connection B keys');

        // Cross-tenant attempt: Tenant A attempting to access Connection B credentials
        const credsAttempt = await credsRepo.getCredentials(tenantA.id, connB.id);
        assert.strictEqual(credsAttempt, null, 'Tenant A cannot retrieve Connection B credentials');

        // Composite foreign key: Attempting to insert credentials for Connection B under Tenant A
        await assert.rejects(
            async () => {
                await credsRepo.upsertCredentials(tenantA.id, connB.id, initAuthCreds());
            },
            (err) => err.code === '23503' || err.message.includes('foreign key'),
            'PostgreSQL composite foreign key must reject mismatched tenant for credentials'
        );
    });

    it('should survive process restart simulation and restore exact credentials and keys', async () => {
        // Destroy existing runtime references
        let authInstance = null;

        // Recreate brand new auth state instance from DB
        authInstance = await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo, keysRepo });
        assert.ok(authInstance.state.creds);
        assert.strictEqual(authInstance.state.creds.registered, true);
        assert.strictEqual(authInstance.state.creds.testBuffer.toString('utf8'), 'windowseven_test_secret_payload_12345');

        // Verify keys restored
        const keys = await authInstance.state.keys.get('pre-key', ['2']);
        assert.ok(keys['2']);
        assert.strictEqual(keys['2'].keyPair.public.toString(), 'public_key_2');
    });

    it('should fail closed when stored credentials exist but are corrupted (no silent fresh init)', async () => {
        // Deliberately corrupt the credentials column with invalid non-JSON data
        await pool.query(
            `UPDATE whatsapp_auth_credentials
             SET credentials = 'CORRUPTED_NON_JSON_DATA_!!!'
             WHERE connection_id = $1;`,
            [connA.id]
        );

        // Attempting to load auth state must throw corruption error and MUST NOT call initAuthCreds
        await assert.rejects(
            async () => {
                await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo, keysRepo });
            },
            (err) => {
                return err.isCorrupted === true || err.message.includes('cannot deserialize');
            },
            'Corrupted stored credentials must fail closed without generating fresh credentials'
        );

        // Restore valid credentials for subsequent tests
        const validCreds = initAuthCreds();
        validCreds.registered = true;
        await credsRepo.upsertCredentials(tenantA.id, connA.id, validCreds);
    });

    it('should fail closed when database query fails (no silent fresh init on DB error)', async () => {
        // Mock a broken repository that throws a DB connection error
        const brokenCredsRepo = {
            getCredentials: async () => {
                throw new Error('connection to server at "127.0.0.1", port 5433 failed: Connection refused');
            },
            upsertCredentials: async () => {},
        };

        await assert.rejects(
            async () => {
                await useDatabaseAuthState(tenantA.id, connA.id, { credsRepo: brokenCredsRepo, keysRepo });
            },
            /Connection refused/,
            'Database error must throw and fail closed, never silently generating new credentials'
        );
    });
});
