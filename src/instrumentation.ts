import type { Hono, MiddlewareHandler } from "hono";
import {
  createFunctionMetricRuntime,
  type AnyFunction,
  type FunctionMetricRecord,
  type MetricStatus,
  type RestoreHandle,
  type SnapshotOptions,
} from "@ludiars/aop-metrics";
import { vgWrite, type VgLevel } from "./shared/vestigium.js";

const ENABLED = process.env.CONCORDIA_AOP_METRICS !== "0";
const SERVICE = "concordia";
const VG_MESSAGE = "lapilli.function_metric";

const metrics = createFunctionMetricRuntime({
  service: SERVICE,
  domain: "concordia",
  includeErrorMessage: false,
  report: (record) => {
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
