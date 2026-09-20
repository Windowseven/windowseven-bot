class UserRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ email, passwordHash = null }, client = null) {
        if (!email || typeof email !== 'string') {
            throw new Error('Valid email is required');
        }
        const executor = client || this.pool;
        const trimmedEmail = email.trim();
        const sql = `
            INSERT INTO users (email, password_hash)
            VALUES ($1, $2)
            RETURNING id, email, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [trimmedEmail, passwordHash]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, email, password_hash, created_at, updated_at
            FROM users
            WHERE id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async findByEmail(email, client = null) {
        if (!email) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, email, password_hash, created_at, updated_at
            FROM users
            WHERE LOWER(email) = LOWER($1);
        `;
        const { rows } = await executor.query(sql, [email.trim()]);
        return rows[0] || null;
    }

    async updatePassword(id, passwordHash, client = null) {
        if (!id || !passwordHash) return null;
        const executor = client || this.pool;
        const sql = `
            UPDATE users
            SET password_hash = $1, updated_at = NOW()
            WHERE id = $2
            RETURNING id, email, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [passwordHash, id]);
        return rows[0] || null;
    }

    async delete(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = 'DELETE FROM users WHERE id = $1 RETURNING id;';
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }
}

module.exports = UserRepository;
