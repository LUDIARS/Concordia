import type { Hono, MiddlewareHandler } from "hono";
import {
  createFunctionMetricRuntime,
  type AnyFunction,
  type FunctionMetricRecord,
  type FunctionMetricSnapshot,
  type MetricStatus,
  type RestoreHandle,
  type SnapshotOptions,
} from "@ludiars/aop-metrics";
import { vgWrite, type VgLevel } from "./shared/vestigium.js";

const ENABLED = process.env.CONCORDIA_AOP_METRICS !== "0";
const SERVICE = "concordia";
const VG_MESSAGE = "lapilli.function_metric";
const VG_SUMMARY_MESSAGE = "lapilli.function_metric.summary";

/**
 * per-record ストリーム書き込みの制御。
 *
 * 既定は error のみ per-record で Vg へ流し、 ok レコードは in-memory 集計
 * (snapshot / /v1/instrumentation/functions) と 60 秒ごとの集約サマリ 1 行に
 * 畳む。 全レコード垂れ流し (旧挙動、 秒 10 行超で Excubitor のログ集積と
 * Defender スキャン圧を膨らませていた) は CONCORDIA_AOP_METRICS_STREAM=1 で
 * 明示的に戻せる (短期デバッグ用)。
 */
const STREAM_ALL = process.env.CONCORDIA_AOP_METRICS_STREAM === "1";
const SUMMARY_INTERVAL_MS = 60_000;
const SUMMARY_TOP_N = 20;

const metrics = createFunctionMetricRuntime({
  service: SERVICE,
  domain: "concordia",
  includeErrorMessage: false,
  report: (record) => {
    if (!STREAM_ALL && record.status !== "error") return;
    vgWrite(levelFor(record), VG_MESSAGE, {
      metric: {
        service: record.service,
        domain: record.domain,
        kind: record.kind,
        target: record.target,
        tags: record.tags,
        status: record.status,
        duration_ms: record.durationMs,
        error_name: record.errorName,
        ts: record.ts,
      },
    });
  },
});

/** 直近サマリ時点の累計 call 数。 無風区間の同一行の垂れ流しを止めるために持つ。 */
let lastSummaryCalls = 0;

if (ENABLED && !STREAM_ALL) startMetricSummaryTimer();

const DISCORD_TARGETS = {
  ready: "discord.client.ready",
  eventBusRoute: "discord.event_bus.route_event",
  messageCreate: "discord.gateway.message_create",
  threadCreate: "discord.gateway.thread_create",
  ingressMessage: "discord.ingress.handle_message",
  reactionAddEvent: "discord.gateway.reaction_add",
  reactionAdd: "discord.reactions.handle_add",
  reactionRemoveEvent: "discord.gateway.reaction_remove",
  reactionRemove: "discord.reactions.handle_remove",
  interactionCreate: "discord.gateway.interaction_create",
  dispatchInteraction: "discord.commands.dispatch_interaction",
  monitorRefresh: "discord.monitor.refresh",
  prQueueRefresh: "discord.pr_queue.refresh",
  statusReconcile: "discord.status.reconcile",
  sessionForumReconcile: "discord.session_forum.reconcile",
  testForumReconcile: "discord.test_forum.reconcile",
  staleChannelSweep: "discord.stale_channel.sweep",
} as const;

export type DiscordMetricTarget = keyof typeof DISCORD_TARGETS;

export function installApiInstrumentation(app: Hono): void {
  if (!ENABLED) return;
  app.use("*", apiInstrumentationMiddleware());
  app.get("/v1/instrumentation/functions", (c) => {
    return c.json(functionMetricSnapshot({
      service: c.req.query("service") || undefined,
      kind: c.req.query("kind") || undefined,
      domain: c.req.query("domain") || undefined,
      limit: parsePositiveInt(c.req.query("limit")),
      sortBy: parseSortBy(c.req.query("sort")),
    }));
  });
}

export function instrumentDiscord<Fn extends AnyFunction>(target: DiscordMetricTarget, fn: Fn): Fn {
  if (!ENABLED) return fn;
  return metrics.wrapFunction(DISCORD_TARGETS[target], fn, { kind: "discord" });
}

export function recordDiscordInteractionAck(result: {
  acknowledged: boolean;
  within_3s: boolean;
  duration_ms: number;
}): void {
  if (!ENABLED) return;
  metrics.record({
    kind: "discord",
    target: "discord.interaction.ack",
    tags: {
      process_mode: process.env.CONCORDIA_CHAT_PROCESS_ROLE ?? "embedded",
      acknowledged: result.acknowledged,
      within_3s: result.within_3s,
    },
    durationMs: result.duration_ms,
    status: result.within_3s ? "ok" : "error",
    errorName: result.within_3s ? undefined : "InteractionAckDeadline",
  });
}

/**
 * event loop が同期処理で塞がれた事象を記録する。
 *
 * これが出ている間は Discord interaction の 3 秒 ack に間に合わず
 * `10062 Unknown interaction` になる。 従来はログの空白から事後推測するしかなかった。
 */
export function recordEventLoopStall(stall: {
  lagMs: number;
  activeHandles: number;
  activeRequests: number;
}): void {
  if (!ENABLED) return;
  metrics.record({
    kind: "runtime",
    target: "runtime.event_loop.stall",
    tags: {
      process_mode: process.env.CONCORDIA_CHAT_PROCESS_ROLE ?? "embedded",
      active_handles: stall.activeHandles,
      active_requests: stall.activeRequests,
    },
    durationMs: stall.lagMs,
    status: "error",
    errorName: "EventLoopStall",
  });
}

export function instrumentConcordiaFunction<Fn extends AnyFunction>(
  target: string,
  fn: Fn,
  opts: { kind?: string; domain?: string; tags?: Record<string, string | number | boolean | null | undefined> } = {},
): Fn {
  if (!ENABLED) return fn;
  return metrics.wrapFunction(target, fn, {
    kind: opts.kind ?? "function",
    domain: opts.domain,
    tags: opts.tags,
  });
}

export function instrumentConcordiaMethod<T extends object, K extends keyof T & string>(
  owner: T,
  methodName: K,
  target: string,
  opts: { kind?: string; domain?: string; tags?: Record<string, string | number | boolean | null | undefined> } = {},
): RestoreHandle {
  if (!ENABLED) return { restore() { /* no-op */ } };
  return metrics.wrapMethod(owner, methodName, {
    target,
    kind: opts.kind ?? "method",
    domain: opts.domain,
    tags: opts.tags,
  });
}

export function functionMetricSnapshot(opts: SnapshotOptions = {}) {
  return metrics.snapshot(opts);
}

export function resetFunctionMetrics(): void {
  metrics.reset();
  lastSummaryCalls = 0;
}

/**
 * 集約サマリ timer を張る。 呼び出し回数上位 N target を 60 秒ごとに 1 行で Vg へ流し、
 * per-record を error のみに絞っても「どの関数がどれだけ呼ばれているか」の横断観測を残す。
 * timer は unref 済なので process の終了を妨げない。
 *
 * @implements spec/feature/runtime-function-metrics.md — Vestigium 出力
 */
function startMetricSummaryTimer(): void {
  const timer = setInterval(() => {
    try {
      emitMetricSummary();
    } catch {
      /* metrics summary must never break the host */
    }
  }, SUMMARY_INTERVAL_MS);
  timer.unref();
}

/**
 * 集約サマリ 1 行を Vg へ。 前回サマリから新規 call が無ければ何も出さない
 * (aggregate は累計なので、 無風区間では同一内容が 60 秒ごとに積もるだけになる)。
 *
 * @implements spec/feature/runtime-function-metrics.md — Vestigium 出力
 */
export function emitMetricSummary(): void {
  // limit を掛けずに取る。 snapshot の totals は filter / limit 適用後 rows の合計なので、
  // limit 付きだと「上位 N の合計」になり process 全体の観測値として読めなくなる。
  const snapshot = metrics.snapshot({ sortBy: "calls" });
  if (snapshot.totals.calls <= lastSummaryCalls) return;
  const sinceLastCalls = snapshot.totals.calls - lastSummaryCalls;
  lastSummaryCalls = snapshot.totals.calls;
  vgWrite("info", VG_SUMMARY_MESSAGE, buildMetricSummaryCtx(snapshot, sinceLastCalls));
}

function apiInstrumentationMiddleware(): MiddlewareHandler {
  return async (c, next) => {
    const started = Date.now();
    let status: MetricStatus = "ok";
    let errorName: string | undefined;
    try {
      await next();
      if (c.res.status >= 500) {
        status = "error";
        errorName = `HTTP${c.res.status}`;
      }
    } catch (error) {
      status = "error";
      errorName = error instanceof Error ? error.name : typeof error;
      throw error;
    } finally {
      const durationMs = Date.now() - started;
      const target = apiTarget(c.req.method, c.req.path);
      metrics.record({
        service: SERVICE,
        domain: "concordia",
        kind: "api",
        target,
        tags: {
          method: c.req.method,
        },
        durationMs,
        status,
        errorName,
      });
    }
  };
}

function apiTarget(method: string, path: string): string {
  return `api.${method.toUpperCase()} ${normalizeApiPath(path)}`;
}

function normalizeApiPath(path: string): string {
  if (!path || path === "/") return "/";
  return path
    .split("/")
    .map((segment) => {
      if (!segment) return segment;
      if (/^\d+$/.test(segment)) return ":id";
      if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment)) return ":id";
      if (/^[0-9a-f]{24,}$/i.test(segment)) return ":hex";
      return segment;
    })
    .join("/");
}

function levelFor(record: FunctionMetricRecord): VgLevel {
  return record.status === "error" ? "warn" : "info";
}

/**
 * 集約サマリの Vg ctx。 vgWrite の ctx は Record<string, unknown> なので、
 * 型付き snapshot をそのまま渡さずここで plain object に落とす。
 * totals は process 起動からの累計、 `since_last_calls` が当該 interval の増分。
 */
function buildMetricSummaryCtx(
  snapshot: FunctionMetricSnapshot,
  sinceLastCalls: number,
): Record<string, unknown> {
  return {
    interval_ms: SUMMARY_INTERVAL_MS,
    since_last_calls: sinceLastCalls,
    totals: snapshot.totals,
    top: snapshot.rows.slice(0, SUMMARY_TOP_N),
  };
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : undefined;
}

function parseSortBy(raw: string | undefined): SnapshotOptions["sortBy"] {
  if (raw === "calls" || raw === "totalMs" || raw === "avgMs" || raw === "maxMs" || raw === "lastAt") {
    return raw;
  }
  return undefined;
}
