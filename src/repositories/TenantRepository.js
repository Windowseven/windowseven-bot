/**
 * Windowseven MD Tenant Repository
 * Manages tenant entities with support for standalone pooling and transactional clients.
 */
class TenantRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ name }, client = null) {
        if (!name || typeof name !== 'string' || !name.trim()) {
            throw new Error('Tenant name is required');
        }
        const executor = client || this.pool;
        const sql = `
            INSERT INTO tenants (name)
            VALUES ($1)
            RETURNING id, name, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [name.trim()]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, name, created_at, updated_at
            FROM tenants
            WHERE id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async update(id, { name }, client = null) {
        if (!id || !name || !name.trim()) {
            throw new Error('Tenant id and updated name are required');
        }
        const executor = client || this.pool;
        const sql = `
            UPDATE tenants
            SET name = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, name, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [name.trim(), id]);
        return rows[0] || null;
    }

    async delete(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = 'DELETE FROM tenants WHERE id = $1 RETURNING id;';
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }
}

module.exports = TenantRepository;
