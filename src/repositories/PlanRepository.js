class PlanRepository {
    constructor(pool) {
        this.pool = pool;
    }

    async create({ name, price, currency = "TZS", durationDays, description = null, status = "ACTIVE" }, client = null) {
        if (!name || typeof name !== "string") {
            throw new Error("Valid plan name is required");
        }
        if (price === undefined || price === null || isNaN(Number(price)) || Number(price) < 0) {
            throw new Error("Valid non-negative price is required");
        }
        if (!durationDays || isNaN(Number(durationDays)) || Number(durationDays) <= 0) {
            throw new Error("Valid durationDays greater than 0 is required");
        }

        const executor = client || this.pool;
        const sql = `
            INSERT INTO plans (name, price, currency, duration_days, description, status)
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING id, name, price, currency, duration_days, description, status, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, [
            name.trim(),
            Number(price),
            currency.trim().toUpperCase(),
            parseInt(durationDays, 10),
            description ? description.trim() : null,
            status.toUpperCase()
        ]);
        return rows[0];
    }

    async findById(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const sql = `
            SELECT id, name, price, currency, duration_days, description, status, created_at, updated_at
            FROM plans
            WHERE id = $1;
        `;
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }

    async findAll({ status = null } = {}, client = null) {
        const executor = client || this.pool;
        let sql = `
            SELECT id, name, price, currency, duration_days, description, status, created_at, updated_at
            FROM plans
        `;
        const params = [];
        if (status) {
            sql += ` WHERE status = $1`;
            params.push(status.toUpperCase());
        }
        sql += ` ORDER BY price ASC, created_at ASC;`;
        const { rows } = await executor.query(sql, params);
        return rows;
    }

    async update(id, updates = {}, client = null) {
        if (!id) throw new Error("Plan id is required");
        const executor = client || this.pool;

        const allowed = ["name", "price", "currency", "duration_days", "description", "status"];
        const setClauses = [];
        const values = [id];

        if (updates.name !== undefined) {
            values.push(updates.name.trim());
            setClauses.push(`name = $${values.length}`);
        }
        if (updates.price !== undefined) {
            if (isNaN(Number(updates.price)) || Number(updates.price) < 0) {
                throw new Error("Invalid price");
            }
            values.push(Number(updates.price));
            setClauses.push(`price = $${values.length}`);
        }
        if (updates.currency !== undefined) {
            values.push(updates.currency.trim().toUpperCase());
            setClauses.push(`currency = $${values.length}`);
        }
        if (updates.durationDays !== undefined) {
            const days = parseInt(updates.durationDays, 10);
            if (isNaN(days) || days <= 0) throw new Error("Invalid durationDays");
            values.push(days);
            setClauses.push(`duration_days = $${values.length}`);
        }
        if (updates.description !== undefined) {
            values.push(updates.description ? updates.description.trim() : null);
            setClauses.push(`description = $${values.length}`);
        }
        if (updates.status !== undefined) {
            const st = updates.status.toUpperCase();
            if (!["ACTIVE", "INACTIVE"].includes(st)) throw new Error("Invalid plan status");
            values.push(st);
            setClauses.push(`status = $${values.length}`);
        }

        if (setClauses.length === 0) {
            return this.findById(id, client);
        }

        setClauses.push(`updated_at = NOW()`);
        const sql = `
            UPDATE plans
            SET ${setClauses.join(", ")}
            WHERE id = $1
            RETURNING id, name, price, currency, duration_days, description, status, created_at, updated_at;
        `;
        const { rows } = await executor.query(sql, values);
        return rows[0] || null;
    }

    async isReferenced(id, client = null) {
        const executor = client || this.pool;
        const sql = `
            SELECT (
                EXISTS(SELECT 1 FROM customer_subscriptions WHERE plan_id = $1)
                OR
                EXISTS(SELECT 1 FROM payments WHERE plan_id = $1)
            ) AS referenced;
        `;
        const { rows } = await executor.query(sql, [id]);
        return Boolean(rows[0] && rows[0].referenced);
    }

    async delete(id, client = null) {
        if (!id) return null;
        const executor = client || this.pool;
        const referenced = await this.isReferenced(id, executor);
        if (referenced) {
            const err = new Error("Cannot delete plan: referenced by existing subscriptions or payments. Deactivate instead.");
            err.code = "PLAN_IN_USE";
            throw err;
        }
        const sql = "DELETE FROM plans WHERE id = $1 RETURNING id;";
        const { rows } = await executor.query(sql, [id]);
        return rows[0] || null;
    }
}

module.exports = PlanRepository;
