/**
 * Factory for creating an immutable execution context for Windowseven MD runtime events.
 *
 * Rules:
 * - tenantId and connectionId are mandatory and immutable.
 * - Never derived from untrusted WhatsApp payloads, phone numbers, or group JIDs.
 * - Scoped to exactly one connection.
 * - sock is provided for infrastructure and transitional legacy bridge compatibility only.
 *
 * @param {object} params
 * @param {string} params.tenantId - The tenant UUID
 * @param {string} params.connectionId - The connection UUID
 * @param {object} params.socket - The managed Baileys WASocket
 * @param {import('pg').Pool} [params.pool] - The PostgreSQL pool
 * @param {object} [params.repositories] - Optional domain repositories
 * @returns {Readonly<{ tenantId: string, connectionId: string, sock: object, db: import('pg').Pool, repositories: object }>}
 */
function createExecutionContext({ tenantId, connectionId, socket, sock, pool, db, repositories = {} }) {
    if (!tenantId || typeof tenantId !== 'string') {
        throw new Error('[ExecutionContext] Valid tenantId is required');
    }
    if (!connectionId || typeof connectionId !== 'string') {
        throw new Error('[ExecutionContext] Valid connectionId is required');
    }

    const resolvedSocket = socket || sock || null;
    const resolvedPool = pool || db || null;

    return Object.freeze({
        tenantId,
        connectionId,
        sock: resolvedSocket,
        db: resolvedPool,
        repositories: Object.freeze({ ...repositories }),
    });
}

module.exports = {
    createExecutionContext,
};
