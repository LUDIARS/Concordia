/**
 * /v1/delegation API.
 * spec/delegation.md §5.
 */

import { Hono } from "hono";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import {
  DELEGATION_PROVIDERS,
  type DelegationRepo,
  type DelegationRunRow,
  type DelegationProvider,
  parseRuntimeOptions,
} from "../db/delegation-repo.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { DelegationService } from "../delegation/service.js";
import { parsePortable, templateToPortable } from "../delegation/portable.js";
import { delegationOptionSuggestions } from "../control/provider-preset.js";
import { eventBus } from "../events.js";
import { invalidateDelegationTemplateCache } from "../discord/delegation-template-cache.js";
import {
  buildDelegationInjectText,
  buildDelegationStatusNotification,
  normalizeDelegationStatus,
} from "../delegation/coordination.js";

const CALL_NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

const InputSchemaItemSchema = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  type: z.enum(["string", "number", "boolean"]),
  required: z.boolean(),
  description: z.string().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

// 作成時は call_name / title / prompt_template を空欄でも受け付ける (下書き許容)。
//   - call_name 空/不正 → title からスラッグ化、 無理なら `tpl-<random>` を自動採番。
//   - title 空 → call_name で埋める。
//   - prompt_template 空 → 空文字のまま保存可 (invoke 時に context だけ載る)。
const CreateTemplateSchema = z.object({
  call_name: z.string().max(64).optional(),
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  target_provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]),
  model: z.string().max(120).nullable().optional(),
  runtime_options: z.record(z.unknown()).optional(),
  prompt_template: z.string().max(20000).optional(),
  input_schema: z.array(InputSchemaItemSchema).optional(),
  default_cwd: z.string().nullable().optional(),
  project: z.string().max(200).nullable().optional(),
  is_active: z.boolean().optional(),
  emoji: z.string().max(8).optional(),
  call_only: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

const PatchTemplateSchema = z.object({
  title: z.string().max(200).optional(),
  description: z.string().max(2000).optional(),
  target_provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]).optional(),
  model: z.string().max(120).nullable().optional(),
  runtime_options: z.record(z.unknown()).optional(),
  prompt_template: z.string().max(20000).optional(),
  input_schema: z.array(InputSchemaItemSchema).optional(),
  default_cwd: z.string().nullable().optional(),
  project: z.string().max(200).nullable().optional(),
  is_active: z.boolean().optional(),
  emoji: z.string().max(8).optional(),
  call_only: z.boolean().optional(),
  sort_order: z.number().int().optional(),
});

/** title 等を call_name スラッグへ。 [a-z][a-z0-9_-]{0,63} に収まらなければ空文字を返す。 */
function slugifyCallName(raw: string): string {
  const s = raw.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return CALL_NAME_RE.test(s) ? s : "";
}

/** 空/不正な call_name を、 title スラッグ → ランダムの順で一意に解決する。 */
function resolveCallName(repo: DelegationRepo, raw: string | undefined, title: string | undefined): string {
  const trimmed = (raw ?? "").trim();
  let base = CALL_NAME_RE.test(trimmed) ? trimmed : slugifyCallName(title ?? "");
  if (!base) base = `tpl-${randomUUID().slice(0, 8)}`;
  if (!repo.findTemplateByCallName(base)) return base;
  // 衝突時は -2, -3, … を足す (それでも埋まればランダム)。
  for (let i = 2; i <= 50; i++) {
    const cand = `${base}-${i}`.slice(0, 64);
    if (!repo.findTemplateByCallName(cand)) return cand;
  }
  return `tpl-${randomUUID().slice(0, 8)}`;
}

const InvokeSchema = z.object({
  call_name: z.string().regex(CALL_NAME_RE),
  args: z.record(z.unknown()).default({}),
  cwd: z.string().optional(),
  branch: z.string().optional(),
  worktree: z.boolean().optional(),
  /** 初回プロンプト末尾に追記する任意の追加指示（render とは別経路）。 */
  extra_prompt: z.string().max(20000).optional(),
  triggered_by: z.string().max(120).optional(),
  parent_session_id: z.string().max(128).optional(),
  spawn: z.boolean().optional(),
  options: z.record(z.unknown()).optional(),
  overrides: z.object({
    model: z.string().max(120).nullable().optional(),
    provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]).optional(),
    reasoning_effort: z.string().max(32).optional(),
  }).optional(),
});

const StatusSchema = z.object({
  status: z.enum(["running", "completed", "failed"]),
  detail: z.string().max(4000).optional(),
  result: z.string().max(4000).optional(),
});

const RunInjectSchema = z.object({
  text: z.string().min(1).max(4000),
});

export interface DelegationApiDeps {
  repo: DelegationRepo;
  service: DelegationService;
  sessions?: SessionsRepo;
  /** 実行キュー (未注入ならキュー機能は生えない)。 */
  queue?: {
    maxConcurrency: () => number;
    activeCount: () => number;
    queuedCount: () => number;
    position: (runId: string) => number | null;
    drain: () => Promise<void>;
  };
  /** 同時実行上限の永続化先 (AdminState)。 */
  adminState?: {
    getDelegationMaxConcurrency: () => number;
    setDelegationMaxConcurrency: (value: number) => void;
  };
}

const QueueSettingsSchema = z.object({
  /** 0 = 無制限 (キュー無効)。 */
  max_concurrency: z.number().int().min(0).max(64),
});

export function delegationRouter(deps: DelegationApiDeps): Hono {
  const app = new Hono();

  function invalidateTemplates(
    action: "create" | "import" | "patch" | "delete",
    row: Awaited<ReturnType<DelegationRepo["findTemplate"]>> | null,
  ): void {
    invalidateDelegationTemplateCache();
    eventBus.emit({
      type: "delegation.templates_changed",
      action,
      template_id: row?.id ?? null,
      call_name: row?.call_name ?? null,
      ts: Math.floor(Date.now() / 1000),
    });
  }

  // mutating endpoint は bearer token を要求しない。 Concordia は loopback
  // (既定 127.0.0.1:11111) 限定で動き、 /v1/admin/* と同じ信頼境界に乗る。
  // 以前は spawn token を要求していたが、 同じ loopback サービス内で Monitor の
  // spawn は token-free・Delegation CRUD だけ token 必須という非対称が混乱の元
  // (token 未貼付で Save できない) だったため撤廃。

  function serializeTemplate(row: Awaited<ReturnType<DelegationRepo["findTemplate"]>>) {
    if (!row) return row;
    return {
      ...row,
      input_schema: safeJsonParse(row.input_schema, []),
      is_active: row.is_active === 1,
      call_only: row.call_only === 1,
      default_options: parseRuntimeOptions(row.runtime_options_json),
      runtime_options: delegationOptionSuggestions(row.target_provider, row.model),
    };
  }

  function serializeRun(row: Awaited<ReturnType<DelegationRepo["findRun"]>>, linkedSessions: SessionRow[] = []) {
    if (!row) return row;
    const args = safeJsonParse(row.args_json, {});
    return {
      ...row,
      args,
      spawn_command: row.spawn_command ? safeJsonParse(row.spawn_command, []) : null,
      // queued の待ち順 (1 始まり)。 それ以外は null。 起動入力 (payload) は内部専用なので返さない。
      queue_position: row.status === "queued" ? (deps.queue?.position(row.id) ?? null) : null,
      queue_payload_json: undefined,
      sessions: linkedSessions.map(serializeLinkedSession),
    };
  }

  // ── GET endpoints (no auth) ───────────────────────────────
  app.get("/templates", (c) => {
    const rows = deps.repo.listTemplates({ includeInactive: false });
    return c.json({ templates: rows.map(serializeTemplate) });
  });

  app.get("/templates/all", (c) => {
    const rows = deps.repo.listTemplates({ includeInactive: true });
    return c.json({ templates: rows.map(serializeTemplate) });
  });

  app.get("/templates/:identifier", (c) => {
    const id = c.req.param("identifier");
    const row = deps.repo.findTemplate(id) ?? deps.repo.findTemplateByCallName(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ template: serializeTemplate(row) });
  });

  // 1 つの delegation を可搬 JSON で書き出す (コピー用)。 id でも call_name でも引ける。
  app.get("/templates/:identifier/export", (c) => {
    const id = c.req.param("identifier");
    const row = deps.repo.findTemplate(id) ?? deps.repo.findTemplateByCallName(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ delegation: templateToPortable(row) });
  });

  app.get("/runs", (c) => {
    const limitRaw = Number(c.req.query("limit") ?? 100);
    const limit = Math.max(1, Math.min(500, isFinite(limitRaw) ? limitRaw : 100));
    const parentSession = (c.req.query("parent_session") ?? "").trim();
    const rows = parentSession
      ? deps.repo.listRunsByParentSession(parentSession, limit)
      : deps.repo.recentRuns(limit);
    const sessions = deps.sessions?.listDelegationSessions() ?? [];
    return c.json({
      runs: rows.map((row) => {
        const args = safeJsonParse<Record<string, unknown>>(row.args_json, {});
        return serializeRun(row, linkedSessionsForRun(row, args, sessions));
      }),
    });
  });

  // 実行キューの状態と同時実行上限。 上限は 0 で無制限 (キュー無効)。
  app.get("/queue", (c) => {
    if (!deps.queue) return c.json({ error: "queue_not_configured" }, 503);
    return c.json({
      max_concurrency: deps.queue.maxConcurrency(),
      active: deps.queue.activeCount(),
      queued: deps.queue.queuedCount(),
    });
  });

  app.patch("/queue", async (c) => {
    if (!deps.queue || !deps.adminState) return c.json({ error: "queue_not_configured" }, 503);
    const body = await c.req.json().catch(() => null);
    const parsed = QueueSettingsSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", details: parsed.error.issues }, 400);
    deps.adminState.setDelegationMaxConcurrency(parsed.data.max_concurrency);
    // 上限を引き上げた/外した直後に待ち行列が動くよう、 その場で払い出す。
    await deps.queue.drain();
    return c.json({
      max_concurrency: deps.queue.maxConcurrency(),
      active: deps.queue.activeCount(),
      queued: deps.queue.queuedCount(),
    });
  });

  app.get("/runs/:id", (c) => {
    const row = deps.repo.findRun(c.req.param("id"));
    if (!row) return c.json({ error: "not_found" }, 404);
    const sessions = deps.sessions?.listDelegationSessions() ?? [];
    const args = safeJsonParse<Record<string, unknown>>(row.args_json, {});
    return c.json({ run: serializeRun(row, linkedSessionsForRun(row, args, sessions)) });
  });

  app.get("/options", (c) => {
    const provider = c.req.query("provider") ?? "";
    const model = c.req.query("model") ?? null;
    return c.json({ provider, model, suggestions: delegationOptionSuggestions(provider, model) });
  });

  // ── Mutating endpoints (bearer auth) ─────────────────────
  app.post("/templates", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = CreateTemplateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    // 空欄許容: call_name は自動採番 (title スラッグ → ランダム)、 title 空は call_name で代替、
    // prompt_template 空はそのまま空文字で保存 (invoke 時に context だけ載る)。
    const call_name = resolveCallName(deps.repo, parsed.data.call_name, parsed.data.title);
    const title = (parsed.data.title ?? "").trim() || call_name;
    const row = deps.repo.createTemplate({
      ...parsed.data,
      call_name,
      title,
      prompt_template: parsed.data.prompt_template ?? "",
    });
    invalidateTemplates("create", row);
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  // 可搬 JSON を貼り付けて新規テンプレを作成する (コピー/貼付による複製・移植)。
  // call_name は衝突回避で自動採番 (resolveCallName) するため、 貼付で常に新規が立つ。
  app.post("/templates/import", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = parsePortable(body);
    if (!parsed.ok) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const p = parsed.data;
    const call_name = resolveCallName(deps.repo, p.call_name, p.title);
    const title = (p.title ?? "").trim() || call_name;
    const row = deps.repo.createTemplate({
      call_name,
      title,
      description: p.description,
      target_provider: p.target_provider,
      model: p.model ?? null,
      runtime_options: p.runtime_options,
      prompt_template: p.prompt_template ?? "",
      input_schema: p.input_schema,
      default_cwd: p.default_cwd ?? null,
      project: p.project ?? null,
      emoji: p.emoji,
      sort_order: p.sort_order,
    });
    invalidateTemplates("import", row);
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  app.patch("/templates/:id", async (c) => {
    const id = c.req.param("id");
    if (!deps.repo.findTemplate(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchTemplateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const row = deps.repo.updateTemplate(id, parsed.data);
    invalidateTemplates("patch", row);
    return c.json({ template: serializeTemplate(row) });
  });

  app.delete("/templates/:id", (c) => {
    const id = c.req.param("id");
    const row = deps.repo.findTemplate(id);
    const ok = deps.repo.deactivateTemplate(id);
    if (!ok) return c.json({ error: "not_found" }, 404);
    invalidateTemplates("delete", row);
    return c.json({ ok: true });
  });

  app.post("/invoke", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = InvokeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const result = await deps.service.invoke({
      call_name: parsed.data.call_name,
      args: parsed.data.args,
      cwd: parsed.data.cwd,
      branch: parsed.data.branch,
      worktree: parsed.data.worktree,
      extra_prompt: parsed.data.extra_prompt,
      triggered_by: parsed.data.triggered_by,
      spawn: parsed.data.spawn,
      options: parsed.data.options,
      overrides: parsed.data.overrides,
      parent_session_id: resolveParentSessionId(c.req, parsed.data.parent_session_id),
    });
    if (!result.ok) {
      const status = result.error.startsWith("unknown call_name") ? 404 : 400;
      return c.json({ error: result.error, detail: result.details }, status);
    }
    return c.json({
      ok: true,
      run: serializeRun(result.run),
      rendered_prompt: result.rendered_prompt,
      prompt_file_path: result.prompt_file_path,
      spawn_pid: result.spawn_pid,
      spawn_command: result.spawn_command,
      spawn_cwd: result.spawn_cwd,
      spawn_branch: result.spawn_branch,
      spawn_worktree_path: result.spawn_worktree_path,
      spawn_worktree_created: result.spawn_worktree_created,
    });
  });

  app.post("/runs/:id/status", async (c) => {
    const id = c.req.param("id");
    const row = deps.repo.findRun(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = StatusSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const status = normalizeDelegationStatus(parsed.data.status);
    if (!status) return c.json({ error: "invalid_status" }, 400);
    const updated = deps.repo.updateRunStatus(
      id,
      status,
      status === "failed" ? (parsed.data.detail ?? parsed.data.result ?? row.error) : row.error,
    )!;
    if ((status === "completed" || status === "failed") && updated.parent_session_id) {
      const text = buildDelegationStatusNotification(updated, parsed.data);
      deps.sessions?.appendEvent({
        session_id: updated.parent_session_id,
        ts: nowSec(),
        kind: "inject",
        payload: { text, source: `delegation:${updated.id}:status` },
      });
      eventBus.emit({
        type: "session.inject",
        target_session_id: updated.parent_session_id,
        text,
        source: `delegation:${updated.id}:status`,
        ts: nowSec(),
      });
      eventBus.emit({
        type: "delegation.mirror",
        target_session_id: updated.parent_session_id,
        run_id: updated.id,
        child_session_id: updated.child_session_id,
        text,
        ts: nowSec(),
      });
    }
    // 終了報告でスロットが 1 つ空く → 待たせている run を即起動する (定期 drain を待たない)。
    if (updated.status === "completed" || updated.status === "failed") {
      void deps.queue?.drain();
    }
    return c.json({ ok: true, run: serializeRun(updated) });
  });

  app.post("/runs/:id/inject", async (c) => {
    const id = c.req.param("id");
    const row = deps.repo.findRun(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    if (!row.child_session_id) return c.json({ error: "child_session_not_claimed" }, 409);
    if (deps.sessions && !deps.sessions.findSession(row.child_session_id)) {
      return c.json({ error: "child_session_not_found" }, 404);
    }
    const body = await c.req.json().catch(() => null);
    const parsed = RunInjectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const text = buildDelegationInjectText({ runId: row.id, text: parsed.data.text });
    const ts = nowSec();
    deps.sessions?.appendEvent({
      session_id: row.child_session_id,
      ts,
      kind: "inject",
      payload: { text, source: `delegation:${row.id}:parent` },
    });
    eventBus.emit({
      type: "session.inject",
      target_session_id: row.child_session_id,
      text,
      source: `delegation:${row.id}:parent`,
      ts,
    });
    if (row.parent_session_id) {
      eventBus.emit({
        type: "delegation.mirror",
        target_session_id: row.parent_session_id,
        run_id: row.id,
        child_session_id: row.child_session_id,
        text,
        ts,
      });
    }
    return c.json({ ok: true, target_session_id: row.child_session_id, ts });
  });

  return app;
}

function linkedSessionsForRun(
  row: DelegationRunRow,
  args: Record<string, unknown>,
  sessions: SessionRow[],
): SessionRow[] {
  const targetRepo = firstString(args, ["target_repo", "repo_path", "cwd"]);
  const normalizedTarget = targetRepo ? normalizePath(targetRepo) : null;
  const runCreatedAt = row.created_at;
  return sessions
    .filter((session) => {
      if (row.child_session_id && session.id === row.child_session_id) return true;
      const metadata = parseSessionMetadata(session);
      const runId = stringValue(metadata.delegation_run_id);
      if (runId) return runId === row.id;

      if (stringValue(metadata.delegation_call_name) !== row.call_name) return false;
      if (!normalizedTarget) return false;
      const sessionRepo = normalizePath(session.repo_path);
      if (sessionRepo !== normalizedTarget && !sessionRepo.startsWith(`${normalizedTarget}/`)) return false;
      return Math.abs(session.started_at * 1000 - runCreatedAt) <= 10 * 60 * 1000;
    })
    .sort((a, b) => b.started_at - a.started_at);
}

function serializeLinkedSession(s: SessionRow) {
  return {
    id: s.id,
    provider: s.provider,
    repo_path: s.repo_path,
    repo_origin: s.repo_origin,
    branch: s.branch,
    host: s.host,
    started_at: s.started_at,
    ended_at: s.ended_at,
    status: s.status,
    last_seen_at: s.last_seen_at,
    current_task: s.current_task,
    metadata: s.metadata ? safeJsonParse<Record<string, unknown> | null>(s.metadata, null) : null,
  };
}

function parseSessionMetadata(s: SessionRow): Record<string, unknown> {
  return s.metadata ? safeJsonParse<Record<string, unknown>>(s.metadata, {}) : {};
}

function firstString(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = stringValue(obj[key]);
    if (value) return value;
  }
  return null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function safeJsonParse<T>(s: string, fallback: T): T {
  try { return JSON.parse(s) as T; } catch { return fallback; }
}

function resolveParentSessionId(req: { header: (name: string) => string | undefined }, bodyValue: string | undefined): string | null {
  const candidates = [
    bodyValue,
    req.header("x-concordia-parent-session-id"),
    req.header("x-concordia-session-id"),
  ];
  for (const v of candidates) {
    const s = (v ?? "").trim();
    if (s) return s;
  }
  return null;
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}
