export class FunctionMetricAggregator {
    rows = new Map();
    clock;
    constructor(opts = {}) {
        this.clock = opts.now ?? Date.now;
    }
    record(record) {
        const safe = sanitizeRecord(record);
        const key = metricKey(safe);
        const current = this.rows.get(key);
        if (!current) {
            this.rows.set(key, {
                key,
                service: safe.service,
                target: safe.target,
                kind: safe.kind,
                domain: safe.domain,
                tags: normalizeTags(safe.tags),
                calls: 1,
                ok: safe.status === "ok" ? 1 : 0,
                errors: safe.status === "error" ? 1 : 0,
                totalMs: safe.durationMs,
                avgMs: safe.durationMs,
                minMs: safe.durationMs,
                maxMs: safe.durationMs,
                lastMs: safe.durationMs,
                lastStatus: safe.status,
                lastAt: safe.ts,
                errorNames: safe.errorName ? { [safe.errorName]: 1 } : {},
            });
            return;
        }
        current.calls += 1;
        if (safe.status === "ok")
            current.ok += 1;
        else
            current.errors += 1;
        current.totalMs += safe.durationMs;
        current.avgMs = current.totalMs / current.calls;
        current.minMs = Math.min(current.minMs, safe.durationMs);
        current.maxMs = Math.max(current.maxMs, safe.durationMs);
        current.lastMs = safe.durationMs;
        current.lastStatus = safe.status;
        current.lastAt = safe.ts;
        if (safe.errorName) {
            current.errorNames[safe.errorName] = (current.errorNames[safe.errorName] ?? 0) + 1;
        }
    }
    snapshot(opts = {}) {
        const sortBy = opts.sortBy ?? "totalMs";
        let rows = Array.from(this.rows.values())
            .filter((row) => !opts.service || row.service === opts.service)
            .filter((row) => !opts.kind || row.kind === opts.kind)
            .filter((row) => !opts.domain || row.domain === opts.domain)
            .map(cloneAggregate);
        rows = rows.sort((a, b) => {
            const diff = b[sortBy] - a[sortBy];
            return diff !== 0 ? diff : a.key.localeCompare(b.key);
        });
        if (opts.limit !== undefined)
            rows = rows.slice(0, Math.max(0, Math.floor(opts.limit)));
        const totals = rows.reduce((acc, row) => {
            acc.calls += row.calls;
            acc.ok += row.ok;
            acc.errors += row.errors;
            acc.totalMs += row.totalMs;
            return acc;
        }, { calls: 0, ok: 0, errors: 0, totalMs: 0, avgMs: 0 });
        totals.avgMs = totals.calls > 0 ? totals.totalMs / totals.calls : 0;
        return { generatedAt: this.clock(), totals, rows };
    }
    reset() {
        this.rows.clear();
    }
}
export class FunctionMetricRuntime {
    service;
    domain;
    aggregator;
    report;
    now;
    includeErrorMessage;
    constructor(opts) {
        this.service = opts.service;
        this.domain = opts.domain;
        this.report = opts.report;
        this.now = opts.now ?? Date.now;
        this.includeErrorMessage = opts.includeErrorMessage ?? false;
        this.aggregator = opts.aggregator === false
            ? null
            : opts.aggregator ?? new FunctionMetricAggregator({ now: this.now });
    }
    record(input) {
        const record = sanitizeRecord({
            ...input,
            service: input.service ?? this.service,
            domain: input.domain ?? this.domain,
            ts: input.ts ?? this.now(),
        });
        this.aggregator?.record(record);
        if (this.report)
            reportSafely(this.report, record);
    }
    wrapFunction(target, fn, opts = {}) {
        return wrapFunction(fn, {
            service: this.service,
            target,
            domain: opts.domain ?? this.domain,
            kind: opts.kind,
            tags: opts.tags,
            now: this.now,
            includeErrorMessage: this.includeErrorMessage,
            report: (record) => this.record(record),
        });
    }
    wrapMethod(owner, methodName, opts = {}) {
        return wrapMethod(owner, methodName, {
            service: this.service,
            target: opts.target ?? String(methodName),
            domain: opts.domain ?? this.domain,
            kind: opts.kind,
            tags: opts.tags,
            now: this.now,
            includeErrorMessage: this.includeErrorMessage,
            report: (record) => this.record(record),
        });
    }
    snapshot(opts = {}) {
        return this.aggregator?.snapshot(opts) ?? {
            generatedAt: this.now(),
            totals: { calls: 0, ok: 0, errors: 0, totalMs: 0, avgMs: 0 },
            rows: [],
        };
    }
    reset() {
        this.aggregator?.reset();
    }
}
export function createFunctionMetricRuntime(opts) {
    return new FunctionMetricRuntime(opts);
}
export function wrapFunction(fn, opts) {
    const now = opts.now ?? Date.now;
    const wrapped = function wrappedFunction(...args) {
        const started = now();
        let result;
        try {
            result = fn.apply(this, args);
        }
        catch (error) {
            reportCompletion(opts, now, started, "error", error);
            throw error;
        }
        if (isPromiseLike(result)) {
            return result.then((value) => {
                reportCompletion(opts, now, started, "ok");
                return value;
            }, (error) => {
                reportCompletion(opts, now, started, "error", error);
                throw error;
            });
        }
        reportCompletion(opts, now, started, "ok");
        return result;
    };
    try {
        Object.defineProperty(wrapped, "name", { value: `${fn.name || opts.target}$measured`, configurable: true });
    }
    catch {
        // Some runtimes do not allow redefining function names.
    }
    return wrapped;
}
export function wrapMethod(owner, methodName, opts) {
    const original = owner[methodName];
    if (typeof original !== "function") {
        throw new TypeError(`Cannot wrap ${String(methodName)}: property is not a function`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
    const target = opts.target ?? String(methodName);
    const wrapped = wrapFunction(original, { ...opts, target });
    Object.defineProperty(owner, methodName, {
        configurable: true,
        writable: true,
        value: wrapped,
    });
    let restored = false;
    return {
        restore() {
            if (restored)
                return;
            restored = true;
            if (descriptor)
                Object.defineProperty(owner, methodName, descriptor);
            else
                Object.defineProperty(owner, methodName, {
                    configurable: true,
                    writable: true,
                    value: original,
                });
        },
    };
}
export function summarizeFunctionMetrics(records, opts = {}) {
    const aggregator = new FunctionMetricAggregator({ now: opts.now });
    for (const record of records)
        aggregator.record(record);
    return aggregator.snapshot(opts);
}
export function metricKey(identity) {
    return [
        identity.service,
        identity.domain ?? "",
        identity.kind ?? "",
        identity.target,
        stableTagKey(identity.tags),
    ].join("\u001f");
}
function reportCompletion(opts, now, started, status, error) {
    const ended = now();
    const errorInfo = status === "error" ? errorDetails(error, opts.includeErrorMessage ?? false) : {};
    reportSafely(opts.report, sanitizeRecord({
        service: opts.service,
        target: opts.target,
        kind: opts.kind,
        domain: opts.domain,
        tags: opts.tags,
        ts: ended,
        durationMs: Math.max(0, ended - started),
        status,
        ...errorInfo,
    }));
}
function reportSafely(report, record) {
    try {
        report(record);
    }
    catch {
        // Instrumentation must never change application behavior.
    }
}
function isPromiseLike(value) {
    return !!value && (typeof value === "object" || typeof value === "function") &&
        typeof value.then === "function";
}
function errorDetails(error, includeMessage) {
    if (!error || typeof error !== "object")
        return { errorName: typeof error };
    const err = error;
    const errorName = typeof err.name === "string" && err.name
        ? err.name
        : err.constructor?.name || "Error";
    return {
        errorName,
        ...(includeMessage && typeof err.message === "string" ? { errorMessage: err.message } : {}),
    };
}
function sanitizeRecord(record) {
    const errorName = cleanText(record.errorName, undefined);
    const errorMessage = cleanText(record.errorMessage, undefined);
    return {
        service: cleanText(record.service, "unknown"),
        target: cleanText(record.target, "unknown"),
        kind: cleanText(record.kind, undefined),
        domain: cleanText(record.domain, undefined),
        tags: normalizeTags(record.tags),
        ts: finiteNumber(record.ts, Date.now()),
        durationMs: Math.max(0, finiteNumber(record.durationMs, 0)),
        status: record.status === "error" ? "error" : "ok",
        ...(errorName ? { errorName } : {}),
        ...(errorMessage ? { errorMessage } : {}),
    };
}
function cloneAggregate(row) {
    return {
        ...row,
        tags: row.tags ? { ...row.tags } : undefined,
        errorNames: { ...row.errorNames },
    };
}
function stableTagKey(tags) {
    const normalized = normalizeTags(tags);
    if (!normalized)
        return "";
    return Object.keys(normalized)
        .sort()
        .map((key) => `${key}=${String(normalized[key])}`)
        .join("&");
}
function normalizeTags(tags) {
    if (!tags)
        return undefined;
    const entries = Object.entries(tags)
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b));
    if (entries.length === 0)
        return undefined;
    return Object.fromEntries(entries);
}
function cleanText(value, fallback) {
    if (typeof value !== "string")
        return fallback;
    const trimmed = value.trim();
    return trimmed ? trimmed : fallback;
}
function finiteNumber(value, fallback) {
    return Number.isFinite(value) ? value : fallback;
}
//# sourceMappingURL=index.js.map