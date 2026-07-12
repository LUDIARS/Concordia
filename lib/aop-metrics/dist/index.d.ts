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
export declare class FunctionMetricAggregator {
    private readonly rows;
    private readonly clock;
    constructor(opts?: {
        now?: () => number;
    });
    record(record: FunctionMetricRecord): void;
    snapshot(opts?: SnapshotOptions): FunctionMetricSnapshot;
    reset(): void;
}
export interface FunctionMetricRuntimeOptions {
    service: string;
    domain?: string;
    report?: FunctionMetricReporter;
    now?: () => number;
    includeErrorMessage?: boolean;
    aggregator?: FunctionMetricAggregator | false;
}
export declare class FunctionMetricRuntime {
    readonly service: string;
    readonly domain?: string;
    readonly aggregator: FunctionMetricAggregator | null;
    private readonly report?;
    private readonly now;
    private readonly includeErrorMessage;
    constructor(opts: FunctionMetricRuntimeOptions);
    record(input: Omit<FunctionMetricRecord, "service" | "ts"> & Partial<Pick<FunctionMetricRecord, "service" | "ts">>): void;
    wrapFunction<Fn extends AnyFunction>(target: string, fn: Fn, opts?: Partial<Omit<FunctionMetricIdentity, "service" | "target">>): Fn;
    wrapMethod<T extends object, K extends keyof T & string>(owner: T, methodName: K, opts?: Partial<Omit<WrapMethodOptions, "service" | "report">>): RestoreHandle;
    snapshot(opts?: SnapshotOptions): FunctionMetricSnapshot;
    reset(): void;
}
export declare function createFunctionMetricRuntime(opts: FunctionMetricRuntimeOptions): FunctionMetricRuntime;
export declare function wrapFunction<Fn extends AnyFunction>(fn: Fn, opts: WrapFunctionOptions): Fn;
export declare function wrapMethod<T extends object, K extends keyof T & string>(owner: T, methodName: K, opts: WrapMethodOptions): RestoreHandle;
export declare function summarizeFunctionMetrics(records: Iterable<FunctionMetricRecord>, opts?: SnapshotOptions & {
    now?: () => number;
}): FunctionMetricSnapshot;
export declare function metricKey(identity: FunctionMetricIdentity): string;
//# sourceMappingURL=index.d.ts.map