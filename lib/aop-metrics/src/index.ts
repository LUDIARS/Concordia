export type MetricStatus = "ok" | "error";
export type MetricTagValue = string | number | boolean | null | undefined;
export type MetricTags = Record<string, MetricTagValue>;

export interface FunctionMetricIdentity {
  service: string;
  target: string;
  kind?: string;
  domain?: string;
  tags?: MetricTags;
}

export interface FunctionMetricRecord extends FunctionMetricIdentity {
  ts: number;
  durationMs: number;
  status: MetricStatus;
  errorName?: string;
  errorMessage?: string;
}

export interface FunctionMetricAggregate extends FunctionMetricIdentity {
  key: string;
  calls: number;
  ok: number;
  errors: number;
  totalMs: number;
  avgMs: number;
  minMs: number;
  maxMs: number;
  lastMs: number;
  lastStatus: MetricStatus;
  lastAt: number;
  errorNames: Record<string, number>;
}

export interface FunctionMetricTotals {
  calls: number;
  ok: number;
  errors: number;
  totalMs: number;
  avgMs: number;
}

export interface FunctionMetricSnapshot {
  generatedAt: number;
  totals: FunctionMetricTotals;
  rows: FunctionMetricAggregate[];
}

export type FunctionMetricReporter = (record: FunctionMetricRecord) => void;
export type AnyFunction = (this: unknown, ...args: any[]) => any;

export interface WrapFunctionOptions extends FunctionMetricIdentity {
  report: FunctionMetricReporter;
  now?: () => number;
  includeErrorMessage?: boolean;
}

export interface WrapMethodOptions extends Omit<WrapFunctionOptions, "target"> {
  target?: string;
}

export interface RestoreHandle {
  restore(): void;
}

export interface SnapshotOptions {
  service?: string;
  kind?: string;
  domain?: string;
  limit?: number;
  sortBy?: "calls" | "totalMs" | "avgMs" | "maxMs" | "lastAt";
}

interface MutableAggregate extends FunctionMetricAggregate {
  totalMs: number;
}

export class FunctionMetricAggregator {
  private readonly rows = new Map<string, MutableAggregate>();
  private readonly clock: () => number;

  constructor(opts: { now?: () => number } = {}) {
    this.clock = opts.now ?? Date.now;
  }

  record(record: FunctionMetricRecord): void {
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
    if (safe.status === "ok") current.ok += 1;
    else current.errors += 1;
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

  snapshot(opts: SnapshotOptions = {}): FunctionMetricSnapshot {
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
    if (opts.limit !== undefined) rows = rows.slice(0, Math.max(0, Math.floor(opts.limit)));

    const totals = rows.reduce<FunctionMetricTotals>(
      (acc, row) => {
        acc.calls += row.calls;
        acc.ok += row.ok;
        acc.errors += row.errors;
        acc.totalMs += row.totalMs;
        return acc;
      },
      { calls: 0, ok: 0, errors: 0, totalMs: 0, avgMs: 0 },
    );
    totals.avgMs = totals.calls > 0 ? totals.totalMs / totals.calls : 0;
    return { generatedAt: this.clock(), totals, rows };
  }

  reset(): void {
    this.rows.clear();
  }
}

export interface FunctionMetricRuntimeOptions {
  service: string;
  domain?: string;
  report?: FunctionMetricReporter;
  now?: () => number;
  includeErrorMessage?: boolean;
  aggregator?: FunctionMetricAggregator | false;
}

export class FunctionMetricRuntime {
  readonly service: string;
  readonly domain?: string;
  readonly aggregator: FunctionMetricAggregator | null;
  private readonly report?: FunctionMetricReporter;
  private readonly now: () => number;
  private readonly includeErrorMessage: boolean;

  constructor(opts: FunctionMetricRuntimeOptions) {
    this.service = opts.service;
    this.domain = opts.domain;
    this.report = opts.report;
    this.now = opts.now ?? Date.now;
    this.includeErrorMessage = opts.includeErrorMessage ?? false;
    this.aggregator = opts.aggregator === false
      ? null
      : opts.aggregator ?? new FunctionMetricAggregator({ now: this.now });
  }

  record(input: Omit<FunctionMetricRecord, "service" | "ts"> & Partial<Pick<FunctionMetricRecord, "service" | "ts">>): void {
    const record: FunctionMetricRecord = sanitizeRecord({
      ...input,
      service: input.service ?? this.service,
      domain: input.domain ?? this.domain,
      ts: input.ts ?? this.now(),
    });
    this.aggregator?.record(record);
    if (this.report) reportSafely(this.report, record);
  }

  wrapFunction<Fn extends AnyFunction>(
    target: string,
    fn: Fn,
    opts: Partial<Omit<FunctionMetricIdentity, "service" | "target">> = {},
  ): Fn {
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

  wrapMethod<T extends object, K extends keyof T & string>(
    owner: T,
    methodName: K,
    opts: Partial<Omit<WrapMethodOptions, "service" | "report">> = {},
  ): RestoreHandle {
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

  snapshot(opts: SnapshotOptions = {}): FunctionMetricSnapshot {
    return this.aggregator?.snapshot(opts) ?? {
      generatedAt: this.now(),
      totals: { calls: 0, ok: 0, errors: 0, totalMs: 0, avgMs: 0 },
      rows: [],
    };
  }

  reset(): void {
    this.aggregator?.reset();
  }
}

export function createFunctionMetricRuntime(opts: FunctionMetricRuntimeOptions): FunctionMetricRuntime {
  return new FunctionMetricRuntime(opts);
}

export function wrapFunction<Fn extends AnyFunction>(fn: Fn, opts: WrapFunctionOptions): Fn {
  const now = opts.now ?? Date.now;
  const wrapped = function wrappedFunction(this: unknown, ...args: Parameters<Fn>): ReturnType<Fn> {
    const started = now();
    let result: ReturnType<Fn>;
    try {
      result = fn.apply(this, args) as ReturnType<Fn>;
    } catch (error) {
      reportCompletion(opts, now, started, "error", error);
      throw error;
    }

    if (isPromiseLike(result)) {
      return result.then(
        (value: unknown) => {
          reportCompletion(opts, now, started, "ok");
          return value;
        },
        (error: unknown) => {
          reportCompletion(opts, now, started, "error", error);
          throw error;
        },
      ) as ReturnType<Fn>;
    }

    reportCompletion(opts, now, started, "ok");
    return result;
  };

  try {
    Object.defineProperty(wrapped, "name", { value: `${fn.name || opts.target}$measured`, configurable: true });
  } catch {
    // Some runtimes do not allow redefining function names.
  }
  return wrapped as Fn;
}

export function wrapMethod<T extends object, K extends keyof T & string>(
  owner: T,
  methodName: K,
  opts: WrapMethodOptions,
): RestoreHandle {
  const original = owner[methodName];
  if (typeof original !== "function") {
    throw new TypeError(`Cannot wrap ${String(methodName)}: property is not a function`);
  }
  const descriptor = Object.getOwnPropertyDescriptor(owner, methodName);
  const target = opts.target ?? String(methodName);
  const wrapped = wrapFunction(original as AnyFunction, { ...opts, target });
  Object.defineProperty(owner, methodName, {
    configurable: true,
    writable: true,
    value: wrapped,
  });
  let restored = false;
  return {
    restore() {
      if (restored) return;
      restored = true;
      if (descriptor) Object.defineProperty(owner, methodName, descriptor);
      else Object.defineProperty(owner, methodName, {
        configurable: true,
        writable: true,
        value: original,
      });
    },
  };
}

export function summarizeFunctionMetrics(
  records: Iterable<FunctionMetricRecord>,
  opts: SnapshotOptions & { now?: () => number } = {},
): FunctionMetricSnapshot {
  const aggregator = new FunctionMetricAggregator({ now: opts.now });
  for (const record of records) aggregator.record(record);
  return aggregator.snapshot(opts);
}

export function metricKey(identity: FunctionMetricIdentity): string {
  return [
    identity.service,
    identity.domain ?? "",
    identity.kind ?? "",
    identity.target,
    stableTagKey(identity.tags),
  ].join("\u001f");
}

function reportCompletion(
  opts: WrapFunctionOptions,
  now: () => number,
  started: number,
  status: MetricStatus,
  error?: unknown,
): void {
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

function reportSafely(report: FunctionMetricReporter, record: FunctionMetricRecord): void {
  try {
    report(record);
  } catch {
    // Instrumentation must never change application behavior.
  }
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return !!value && (typeof value === "object" || typeof value === "function") &&
    typeof (value as { then?: unknown }).then === "function";
}

function errorDetails(error: unknown, includeMessage: boolean): Pick<FunctionMetricRecord, "errorName" | "errorMessage"> {
  if (!error || typeof error !== "object") return { errorName: typeof error };
  const err = error as { name?: unknown; message?: unknown; constructor?: { name?: string } };
  const errorName =
    typeof err.name === "string" && err.name
      ? err.name
      : err.constructor?.name || "Error";
  return {
    errorName,
    ...(includeMessage && typeof err.message === "string" ? { errorMessage: err.message } : {}),
  };
}

function sanitizeRecord(record: FunctionMetricRecord): FunctionMetricRecord {
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

function cloneAggregate(row: MutableAggregate): FunctionMetricAggregate {
  return {
    ...row,
    tags: row.tags ? { ...row.tags } : undefined,
    errorNames: { ...row.errorNames },
  };
}

function stableTagKey(tags: MetricTags | undefined): string {
  const normalized = normalizeTags(tags);
  if (!normalized) return "";
  return Object.keys(normalized)
    .sort()
    .map((key) => `${key}=${String(normalized[key])}`)
    .join("&");
}

function normalizeTags(tags: MetricTags | undefined): MetricTags | undefined {
  if (!tags) return undefined;
  const entries = Object.entries(tags)
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return undefined;
  return Object.fromEntries(entries) as MetricTags;
}

function cleanText(value: string | undefined, fallback: string): string;
function cleanText(value: string | undefined, fallback: undefined): string | undefined;
function cleanText(value: string | undefined, fallback: string | undefined): string | undefined {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? trimmed : fallback;
}

function finiteNumber(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}
