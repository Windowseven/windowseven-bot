const { initAuthCreds, proto } = require('@whiskeysockets/baileys');

/**
 * Creates a database-backed Baileys AuthenticationState scoped to (tenantId, connectionId).
 * Fails closed on database errors or corrupted stored data.
 *
 * @param {string} tenantId - The tenant's UUID
 * @param {string} connectionId - The WhatsApp connection's UUID
 * @param {object} repositories - { credsRepo, keysRepo }
 * @returns {Promise<{ state: { creds: any, keys: any }, saveCreds: () => Promise<any> }>}
 */
async function useDatabaseAuthState(tenantId, connectionId, { credsRepo, keysRepo, fence }) {
    if (!tenantId || !connectionId) {
        throw new Error('tenantId and connectionId are strictly required to load auth state');
    }
    if (!credsRepo || !keysRepo || !fence?.workerId || fence.leaseEpoch === undefined || fence.leaseEpoch === null) {
        throw new Error('credsRepo and keysRepo are required');
    }

    // Fail closed: getCredentials returns null ONLY if no row exists.
    // If a database error or corruption occurs, it throws immediately.
    let creds = await credsRepo.getCredentials(tenantId, connectionId);
    if (!creds) {
        // First-time provisioning: no row exists in DB, generate fresh initial credentials
        creds = initAuthCreds();
        await credsRepo.upsertCredentials(tenantId, connectionId, creds, fence);
    }

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = await keysRepo.getKeys(tenantId, connectionId, type, ids);
                    if (type === 'app-state-sync-key') {
                        for (const id of Object.keys(data)) {
                            if (data[id]) {
                                data[id] = proto.Message.AppStateSyncKeyData.fromObject(data[id]);
                            }
                        }
                    }
                    return data;
                },
                set: async (data) => {
                    await keysRepo.setKeys(tenantId, connectionId, data, fence);
                },
            },
        },
        saveCreds: async () => {
            return credsRepo.upsertCredentials(tenantId, connectionId, creds, fence);
        },
    };
}

module.exports = {
    useDatabaseAuthState,
};
