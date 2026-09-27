/**
 * Windowseven MD Lightweight Zero-Dependency Prometheus Metrics Registry
 *
 * Implements standard Prometheus text exposition format (text/plain; version=0.0.4).
 * Enforces strict per-metric label allowlists (Correction 3) to prevent high-cardinality
 * leaks or sensitive data exposure.
 */

const FORBIDDEN_LABEL_KEYS = new Set([
    'tenant_id',
    'tenantid',
    'user_id',
    'userid',
    'connection_id',
    'connectionid',
    'worker_id',
    'workerid',
    'phone_number',
    'phonenumber',
    'phone',
    'jid',
    'message_id',
    'messageid',
    'message_content',
    'message',
    'email',
    'token',
    'secret',
    'password',
]);

const METRIC_ALLOWLISTS = {
    http_requests_total: new Set(['method', 'route', 'status']),
    http_request_duration_seconds: new Set(['method', 'route']),
    whatsapp_connections_total: new Set(['state']),
    worker_active_leases: new Set([]),
    worker_capacity: new Set([]),
    pg_pool_connections: new Set(['state']),
    durable_commands_processed_total: new Set(['command', 'status']),
    scheduled_tasks_processed_total: new Set(['type', 'status']),
    recovery_operations_total: new Set(['type', 'outcome']),
};

const DEFAULT_DURATION_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function sanitizeMetricName(name) {
    return String(name).replace(/[^a-zA-Z0-9_:]/g, '_');
}

function escapeLabelValue(val) {
    return String(val)
        .replace(/\\/g, '\\\\')
        .replace(/\n/g, '\\n')
        .replace(/"/g, '\\"');
}

function filterLabels(metricName, rawLabels = {}) {
    const allowlist = METRIC_ALLOWLISTS[metricName];
    const filtered = {};

    if (!rawLabels || typeof rawLabels !== 'object') {
        return filtered;
    }

    for (const [key, val] of Object.entries(rawLabels)) {
        const lowerKey = key.toLowerCase();
        if (FORBIDDEN_LABEL_KEYS.has(lowerKey)) {
            continue; // Strictly reject forbidden keys
        }
        if (allowlist && !allowlist.has(key)) {
            continue; // Strictly reject keys not in the explicit allowlist
        }
        filtered[key] = String(val);
    }

    return filtered;
}

function labelsToKey(labels) {
    const keys = Object.keys(labels).sort();
    if (keys.length === 0) return '';
    return keys.map((k) => `${k}="${escapeLabelValue(labels[k])}"`).join(',');
}

class Counter {
    constructor(name, help) {
        this.name = sanitizeMetricName(name);
        this.help = help;
        this.values = new Map();
    }

    inc(rawLabels = {}, value = 1) {
        if (typeof value !== 'number' || isNaN(value) || value < 0) return;
        const labels = filterLabels(this.name, rawLabels);
        const key = labelsToKey(labels);
        const current = this.values.get(key) || { labels, val: 0 };
        current.val += value;
        this.values.set(key, current);
    }

    toPrometheusFormat() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} counter`,
        ];
        if (this.values.size === 0) {
            lines.push(`${this.name} 0`);
        } else {
            for (const { labels, val } of this.values.values()) {
                const labelStr = labelsToKey(labels);
                lines.push(labelStr ? `${this.name}{${labelStr}} ${val}` : `${this.name} ${val}`);
            }
        }
        return lines.join('\n');
    }
}

class Gauge {
    constructor(name, help) {
        this.name = sanitizeMetricName(name);
        this.help = help;
        this.values = new Map();
    }

    set(rawLabels = {}, value = 0) {
        if (typeof rawLabels === 'number') {
            value = rawLabels;
            rawLabels = {};
        }
        if (typeof value !== 'number' || isNaN(value)) return;
        const labels = filterLabels(this.name, rawLabels);
        const key = labelsToKey(labels);
        this.values.set(key, { labels, val: value });
    }

    inc(rawLabels = {}, value = 1) {
        if (typeof rawLabels === 'number') {
            value = rawLabels;
            rawLabels = {};
        }
        const labels = filterLabels(this.name, rawLabels);
        const key = labelsToKey(labels);
        const current = this.values.get(key) || { labels, val: 0 };
        current.val += value;
        this.values.set(key, current);
    }

    dec(rawLabels = {}, value = 1) {
        this.inc(rawLabels, -value);
    }

    toPrometheusFormat() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} gauge`,
        ];
        if (this.values.size === 0) {
            lines.push(`${this.name} 0`);
        } else {
            for (const { labels, val } of this.values.values()) {
                const labelStr = labelsToKey(labels);
                lines.push(labelStr ? `${this.name}{${labelStr}} ${val}` : `${this.name} ${val}`);
            }
        }
        return lines.join('\n');
    }
}

class Histogram {
    constructor(name, help, buckets = DEFAULT_DURATION_BUCKETS) {
        this.name = sanitizeMetricName(name);
        this.help = help;
        this.buckets = [...buckets].sort((a, b) => a - b);
        this.series = new Map(); // key -> { labels, sum, count, bucketCounts: Map(le -> count) }
    }

    observe(rawLabels = {}, value = 0) {
        if (typeof rawLabels === 'number') {
            value = rawLabels;
            rawLabels = {};
        }
        if (typeof value !== 'number' || isNaN(value)) return;

        const labels = filterLabels(this.name, rawLabels);
        const key = labelsToKey(labels);

        let item = this.series.get(key);
        if (!item) {
            const bucketCounts = new Map();
            for (const b of this.buckets) {
                bucketCounts.set(b, 0);
            }
            item = { labels, sum: 0, count: 0, bucketCounts };
            this.series.set(key, item);
        }

        item.sum += value;
        item.count += 1;

        for (const b of this.buckets) {
            if (value <= b) {
                item.bucketCounts.set(b, item.bucketCounts.get(b) + 1);
            }
        }
    }

    toPrometheusFormat() {
        const lines = [
            `# HELP ${this.name} ${this.help}`,
            `# TYPE ${this.name} histogram`,
        ];

        if (this.series.size === 0) {
            lines.push(`${this.name}_count 0`);
            lines.push(`${this.name}_sum 0`);
        } else {
            for (const { labels, sum, count, bucketCounts } of this.series.values()) {
                const baseLabelStr = labelsToKey(labels);

                for (const b of this.buckets) {
                    const bCount = bucketCounts.get(b);
                    const bLabels = baseLabelStr ? `${baseLabelStr},le="${b}"` : `le="${b}"`;
                    lines.push(`${this.name}_bucket{${bLabels}} ${bCount}`);
                }

                const infLabels = baseLabelStr ? `${baseLabelStr},le="+Inf"` : `le="+Inf"`;
                lines.push(`${this.name}_bucket{${infLabels}} ${count}`);

                lines.push(baseLabelStr ? `${this.name}_sum{${baseLabelStr}} ${sum}` : `${this.name}_sum ${sum}`);
                lines.push(baseLabelStr ? `${this.name}_count{${baseLabelStr}} ${count}` : `${this.name}_count ${count}`);
            }
        }
        return lines.join('\n');
    }
}

class MetricsRegistry {
    constructor() {
        this.collectors = new Set();

        // 1. Process & System Metrics
        this.processCpuSeconds = new Counter('process_cpu_seconds_total', 'Total user and system CPU time spent in seconds.');
        this.processMemoryBytes = new Gauge('process_resident_memory_bytes', 'Resident memory size in bytes.');

        // 2. HTTP Metrics
        this.httpRequestsTotal = new Counter('http_requests_total', 'Total number of HTTP requests processed.');
        this.httpRequestDuration = new Histogram('http_request_duration_seconds', 'HTTP request latencies in seconds.');

        // 3. WhatsApp Connections & Worker
        this.whatsappConnectionsTotal = new Gauge('whatsapp_connections_total', 'Number of connections by actual state.');
        this.workerActiveLeases = new Gauge('worker_active_leases', 'Number of active connection leases held by this worker.');
        this.workerCapacity = new Gauge('worker_capacity', 'Maximum connection capacity configured for this worker.');

        // 4. PostgreSQL Pool
        this.pgPoolConnections = new Gauge('pg_pool_connections', 'Current PostgreSQL pool connection count by state.');

        // 5. Durable Commands & Tasks
        this.durableCommandsTotal = new Counter('durable_commands_processed_total', 'Total durable commands executed.');
        this.scheduledTasksTotal = new Counter('scheduled_tasks_processed_total', 'Total scheduled moderation tasks executed.');
        this.recoveryOperationsTotal = new Counter('recovery_operations_total', 'Total durable recovery and verification operations by type and outcome.');
    }

    addCollector(fn) {
        if (typeof fn === 'function') {
            this.collectors.add(fn);
        }
    }

    removeCollector(fn) {
        this.collectors.delete(fn);
    }

    async collectDynamic() {
        // Collect process memory
        try {
            const mem = process.memoryUsage();
            this.processMemoryBytes.set({}, mem.rss);
        } catch {}

        // Run registered dynamic collectors (e.g. pg.Pool, DB connection count)
        for (const collector of this.collectors) {
            try {
                await collector(this);
            } catch (err) {
                // Ignore collector failures to preserve exposition
            }
        }
    }

    async toPrometheusFormat() {
        await this.collectDynamic();

        const metrics = [
            this.processMemoryBytes,
            this.httpRequestsTotal,
            this.httpRequestDuration,
            this.whatsappConnectionsTotal,
            this.workerActiveLeases,
            this.workerCapacity,
            this.pgPoolConnections,
            this.durableCommandsTotal,
            this.scheduledTasksTotal,
            this.recoveryOperationsTotal,
        ];

        return metrics.map((m) => m.toPrometheusFormat()).join('\n\n') + '\n';
    }
}

// Global default instance
const defaultMetricsRegistry = new MetricsRegistry();

module.exports = {
    MetricsRegistry,
    Counter,
    Gauge,
    Histogram,
    METRIC_ALLOWLISTS,
    FORBIDDEN_LABEL_KEYS,
    defaultMetricsRegistry,
};
