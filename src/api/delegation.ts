/**
 * /v1/delegation API.
 * spec/delegation.md §5.
 */

import { Hono } from "hono";
import { z } from "zod";
import type { TaskMdStore } from "../taskflow/md-store.js";
import { injectDecompositionWhenMissing } from "../taskflow/decompose-inject.js";
import type { PendingQuestionProbe } from "../control/pending-question-blocker.js";
import { randomUUID } from "node:crypto";
import {
  DELEGATION_PROVIDERS,
  DELEGATION_CATEGORIES,
  PARTIAL_REQUEUE_CLAIM_ERROR,
  type DelegationRepo,
  type DelegationRunRow,
  type DelegationProvider,
  type DelegationCategory,
  type DelegationTemplateOverrideRow,
  type DelegationTemplateOverrideScopeKind,
  parseRuntimeOptions,
} from "../db/delegation-repo.js";
import { TEMPLATE_OVERRIDE_PATCH_KEYS } from "../delegation/template-overrides.js";
import type { SessionsRepo } from "../db/sessions-repo.js";
import type { SessionRow } from "../shared/types.js";
import type { DelegationService } from "../delegation/service.js";
import { parsePortable, templateToPortable } from "../delegation/portable.js";
import { delegationOptionSuggestions } from "../control/provider-preset.js";
import { eventBus } from "../events.js";
import { invalidateDelegationTemplateCache } from "../discord/delegation-template-cache.js";
import { validateForumTemplateTags, type ForumTemplateTagSource } from "../discord/forum-template-tags.js";
import {
  buildDelegationInjectText,
  buildDelegationStatusNotification,
  normalizeDelegationStatus,
} from "../delegation/coordination.js";
import { requeuePartialRun } from "../delegation/partial-requeue.js";
import { parseContractMetadata } from "../contract/schema.js";
import { emitDelegationRunChanged } from "../delegation/run-events.js";
import { commitForRun, commitFromRequestFile } from "../delegation/commit-broker.js";
import { COMMIT_REQUEST_SHAPE_HINT, parseCommitRequest } from "../delegation/commit-request.js";
import { createChildLogger } from "../shared/logger.js";
import { DelegationRunSessionReadModel } from "../delegation/run-session-read-model.js";
import { verifyCompletionEvidence } from "../delegation/completion-evidence.js";

const commitLogger = createChildLogger("delegation-commit");

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
  forum_tag: z.boolean().optional(),
  category: z.enum(DELEGATION_CATEGORIES as unknown as [DelegationCategory, ...DelegationCategory[]]).optional(),
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
  forum_tag: z.boolean().optional(),
  category: z.enum(DELEGATION_CATEGORIES as unknown as [DelegationCategory, ...DelegationCategory[]]).optional(),
  sort_order: z.number().int().optional(),
});

const RuntimeOptionsJsonSchema = z.string().max(20000).refine((raw) => {
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}, "runtime_options_json must be a JSON object");

const TemplateOverrideSchema = z.object({
  scope_kind: z.enum(["platform", "site"] as [DelegationTemplateOverrideScopeKind, DelegationTemplateOverrideScopeKind]),
  scope_key: z.string().min(1).max(128),
  patch: z.object({
    target_provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]).optional(),
    model: z.string().max(120).nullable().optional(),
    default_cwd: z.string().nullable().optional(),
    runtime_options_json: RuntimeOptionsJsonSchema.optional(),
    is_active: z.union([z.boolean(), z.number().int().min(0).max(1)]).transform((value) => value === true || value === 1 ? 1 : 0).optional(),
  }).strict(),
  is_active: z.boolean().optional(),
});

/** @implements SPEC-DELEGATION-TEMPLATE-OVERRIDES */
function serializeTemplateOverride(row: DelegationTemplateOverrideRow) {
  const { patch_json, ...override } = row;
  return { ...override, patch: safeJsonParse(patch_json, {}), is_active: row.is_active === 1 };
}

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
  memory_links: z.array(z.string().max(500)).max(20).optional(),
  triggered_by: z.string().max(120).optional(),
  parent_session_id: z.string().max(128).optional(),
  /**
   * 子会社 (subsidiary) Bot 由来の invoke なら子会社 id。 spawn したセッションの
   * metadata.subsidiary_id へ焼き込まれ、 本社/子会社 Bot の可視範囲判定
   * (ownsSession) に使われる。 discord/commands/spawn.ts (/v1/admin/spawn-session
   * 経由) と同じ trust boundary (loopback 自己呼び出し) で運ぶ。
   */
  subsidiary_id: z.string().trim().min(1).max(120).optional().nullable(),
  project: z.string().max(120).optional().nullable(),
  requester_discord_user_id: z.string().regex(/^\d{5,32}$/).optional().nullable(),
  source_discord_guild_id: z.string().regex(/^\d{5,32}$/).optional().nullable(),
  source_discord_channel_id: z.string().regex(/^\d{5,32}$/).optional().nullable(),
  spawn: z.boolean().optional(),
  options: z.record(z.unknown()).optional(),
  overrides: z.object({
    model: z.string().max(120).nullable().optional(),
    provider: z.enum(DELEGATION_PROVIDERS as unknown as [DelegationProvider, ...DelegationProvider[]]).optional(),
    reasoning_effort: z.string().max(32).optional(),
  }).optional(),
});

const RemainingSchema = z.object({
  title: z.string().min(1).max(300),
  note: z.string().max(4000).optional(),
  scope_dirs: z.array(z.string().min(1).max(1000)).max(100).optional(),
});
const AcceptanceReportSchema = z.object({
  criterion: z.string().min(1).max(1000),
  met: z.boolean(),
  note: z.string().max(4000).optional(),
});
const StatusSchema = z.object({
  status: z.enum(["running", "completed", "partial", "failed"]),
  detail: z.string().max(4000).optional(),
  result: z.string().max(4000).optional(),
  remaining: z.array(RemainingSchema).max(100).optional(),
  acceptance_report: z.array(AcceptanceReportSchema).max(200).optional(),
}).superRefine((value, ctx) => {
  if (value.status === "partial" && (!value.remaining || value.remaining.length === 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remaining"], message: "partial requires remaining[]" });
  }
  if (value.status === "completed" && value.remaining?.length) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["remaining"], message: "completed remaining must be empty" });
  }
});

const RunInjectSchema = z.object({
  text: z.string().min(1).max(4000),
});

const RunCommitSchema = z.object({
  message: z.string().min(1).max(8000),
  paths: z.array(z.string().min(1).max(1000)).max(200).optional(),
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
  taskStore?: TaskMdStore;
  /** 未回答の質問があるセッションには自動 inject を送らない (blocker)。 */
  hasPendingQuestion?: PendingQuestionProbe;
  /** 委託先へ配る協調 API のベース URL。 */
  concordiaUrl?: string;
  onTaskflowCompleted?: (run: DelegationRunRow) => Promise<void>;
  syncForumTags?: (templates: ReturnType<DelegationRepo["listTemplates"]>) => Promise<{ forum_id: string; tags: string[] }>;
}

const QueueSettingsSchema = z.object({
  /** 0 = 無制限 (キュー無効)。 */
  max_concurrency: z.number().int().min(0).max(64),
});

export function delegationRouter(deps: DelegationApiDeps): Hono {
  const app = new Hono();

  function invalidateTemplates(
    action: "create" | "import" | "duplicate" | "patch" | "delete",
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
      forum_tag: row.forum_tag === 1,
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

  function validateForumTagCandidate(candidate: ForumTemplateTagSource, replacingId?: string): string | null {
    const existing = deps.repo
      .listTemplates({ includeInactive: true })
      .filter((row) => row.id !== replacingId);
    const validation = validateForumTemplateTags([...existing, candidate]);
    return validation.ok ? null : validation.error ?? "invalid forum_tag template";
  }

  // ── GET endpoints (no auth) ───────────────────────────────
  // ?category=employee|freelancer|parttimer で雇用形態カテゴリを絞り込める (省略時は全件)。
  // 不正な値は無言で全件へフォールバックせず 400 を返す (設定不備の無言フォールバック禁止)。
  function categoryFilter(c: { req: { query: (k: string) => string | undefined } }):
    | { ok: true; category: DelegationCategory | null }
    | { ok: false } {
    const raw = (c.req.query("category") ?? "").trim();
    if (!raw) return { ok: true, category: null };
    if ((DELEGATION_CATEGORIES as readonly string[]).includes(raw)) {
      return { ok: true, category: raw as DelegationCategory };
    }
    return { ok: false };
  }

  app.get("/templates", (c) => {
    const filter = categoryFilter(c);
    if (!filter.ok) return c.json({ error: "invalid_category", allowed: DELEGATION_CATEGORIES }, 400);
    const rows = deps.repo.listTemplates({ includeInactive: false });
    const filtered = filter.category ? rows.filter((r) => r.category === filter.category) : rows;
    return c.json({ templates: filtered.map(serializeTemplate) });
  });

  app.get("/templates/all", (c) => {
    const filter = categoryFilter(c);
    if (!filter.ok) return c.json({ error: "invalid_category", allowed: DELEGATION_CATEGORIES }, 400);
    const rows = deps.repo.listTemplates({ includeInactive: true });
    const filtered = filter.category ? rows.filter((r) => r.category === filter.category) : rows;
    return c.json({ templates: filtered.map(serializeTemplate) });
  });

  app.get("/templates/:identifier", (c) => {
    const id = c.req.param("identifier");
    const row = deps.repo.findTemplate(id) ?? deps.repo.findTemplateByCallName(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ template: serializeTemplate(row) });
  });

  app.get("/templates/:identifier/overrides", (c) => {
    const row = deps.repo.findTemplate(c.req.param("identifier")) ?? deps.repo.findTemplateByCallName(c.req.param("identifier"));
    if (!row) return c.json({ error: "not_found" }, 404);
    return c.json({ overrides: deps.repo.listTemplateOverrides(row.id).map(serializeTemplateOverride) });
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
    const sessionReadModel = new DelegationRunSessionReadModel(sessions);
    return c.json({
      runs: rows.map((row) => {
        const args = safeJsonParse<Record<string, unknown>>(row.args_json, {});
        return serializeRun(row, sessionReadModel.linkedSessions(row, args));
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
    const sessions = deps.sessions?.listDelegationSessionsForRun({
      runId: row.id,
      childSessionId: row.child_session_id,
      callName: row.call_name,
      createdAtMs: row.created_at,
    }) ?? [];
    const sessionReadModel = new DelegationRunSessionReadModel(sessions);
    const args = safeJsonParse<Record<string, unknown>>(row.args_json, {});
    return c.json({ run: serializeRun(row, sessionReadModel.linkedSessions(row, args)) });
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
    const candidate = {
      id: "new",
      call_name,
      title,
      is_active: parsed.data.is_active === false ? 0 : 1,
      forum_tag: parsed.data.forum_tag === true ? 1 : 0,
      input_schema: parsed.data.input_schema ?? [],
    } satisfies ForumTemplateTagSource;
    const forumTagError = validateForumTagCandidate(candidate);
    if (forumTagError) return c.json({ error: "invalid_forum_tag", detail: forumTagError }, 400);
    const row = deps.repo.createTemplate({
      ...parsed.data,
      call_name,
      title,
      prompt_template: parsed.data.prompt_template ?? "",
    });
    invalidateTemplates("create", row);
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  app.put("/templates/:identifier/overrides", async (c) => {
    const template = deps.repo.findTemplate(c.req.param("identifier")) ?? deps.repo.findTemplateByCallName(c.req.param("identifier"));
    if (!template) return c.json({ error: "not_found" }, 404);
    const parsed = TemplateOverrideSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten(), allowed_patch_keys: TEMPLATE_OVERRIDE_PATCH_KEYS }, 400);
    try {
      const override = deps.repo.upsertTemplateOverride({ template_id: template.id, scope_kind: parsed.data.scope_kind, scope_key: parsed.data.scope_key, patch_json: JSON.stringify(parsed.data.patch), is_active: parsed.data.is_active });
      invalidateTemplates("patch", template);
      return c.json({ override: serializeTemplateOverride(override) });
    } catch (error) {
      return c.json({ error: "invalid_override", detail: (error as Error).message }, 400);
    }
  });

  app.delete("/templates/:identifier/overrides/:overrideId", (c) => {
    const template = deps.repo.findTemplate(c.req.param("identifier")) ?? deps.repo.findTemplateByCallName(c.req.param("identifier"));
    if (!template) return c.json({ error: "not_found" }, 404);
    const target = deps.repo.listTemplateOverrides(template.id).find((row) => row.id === c.req.param("overrideId"));
    if (!target) return c.json({ error: "not_found" }, 404);
    deps.repo.deleteTemplateOverride(target.id);
    invalidateTemplates("patch", template);
    return c.json({ ok: true });
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
    const candidate = {
      id: "new",
      call_name,
      title,
      is_active: 1,
      forum_tag: p.forum_tag === true ? 1 : 0,
      input_schema: p.input_schema ?? [],
    } satisfies ForumTemplateTagSource;
    const forumTagError = validateForumTagCandidate(candidate);
    if (forumTagError) return c.json({ error: "invalid_forum_tag", detail: forumTagError }, 400);
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
      forum_tag: p.forum_tag,
      category: p.category,
      sort_order: p.sort_order,
    });
    invalidateTemplates("import", row);
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  // 既存テンプレを複製して新規テンプレとして保存する (export→import のワンステップ版)。
  // call_name は元テンプレと衝突するため resolveCallName が自動で -2, -3, … を採番する。
  app.post("/templates/:id/duplicate", async (c) => {
    const id = c.req.param("id");
    const source = deps.repo.findTemplate(id);
    if (!source) return c.json({ error: "not_found" }, 404);
    const p = templateToPortable(source);
    const call_name = resolveCallName(deps.repo, p.call_name, p.title);
    const title = `${(p.title ?? "").trim() || call_name} copy`;
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
      forum_tag: false,
      category: p.category,
      sort_order: p.sort_order,
    });
    invalidateTemplates("duplicate", row);
    return c.json({ template: serializeTemplate(row) }, 201);
  });

  app.patch("/templates/:id", async (c) => {
    const id = c.req.param("id");
    const current = deps.repo.findTemplate(id);
    if (!current) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const parsed = PatchTemplateSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const candidate = {
      id,
      call_name: current.call_name,
      title: parsed.data.title ?? current.title,
      is_active: parsed.data.is_active === undefined ? current.is_active : (parsed.data.is_active ? 1 : 0),
      forum_tag: parsed.data.forum_tag === undefined ? current.forum_tag : (parsed.data.forum_tag ? 1 : 0),
      input_schema: parsed.data.input_schema ?? current.input_schema,
    } satisfies ForumTemplateTagSource;
    const forumTagError = validateForumTagCandidate(candidate, id);
    if (forumTagError) return c.json({ error: "invalid_forum_tag", detail: forumTagError }, 400);
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

  app.post("/forum-tags/sync", async (c) => {
    if (!deps.syncForumTags) return c.json({ error: "discord_forum_sync_unavailable" }, 503);
    try {
      const result = await deps.syncForumTags(deps.repo.listTemplates({ includeInactive: true }));
      return c.json({ ok: true, ...result });
    } catch (error) {
      return c.json({ error: "discord_forum_sync_failed", detail: (error as Error).message }, 400);
    }
  });

  app.post("/invoke", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = InvokeSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const parentSessionId = resolveParentSessionId(c.req, parsed.data.parent_session_id);
    const contract = parentSessionId && deps.sessions ? parseContractMetadata(deps.sessions.findSession(parentSessionId)?.metadata ?? null) : null;
    const result = await deps.service.invoke({
      call_name: parsed.data.call_name,
      args: parsed.data.args,
      cwd: contract?.work_location?.value === "repo-root" ? deps.sessions?.findSession(parentSessionId!)?.repo_path : parsed.data.cwd,
      branch: contract?.work_branch?.value ?? parsed.data.branch,
      worktree: contract ? contract.work_location?.value === "worktree" : parsed.data.worktree,
      extra_prompt: parsed.data.extra_prompt,
      memory_links: parsed.data.memory_links,
      triggered_by: parsed.data.triggered_by,
      spawn: parsed.data.spawn,
      options: parsed.data.options,
      overrides: contract ? {
        ...parsed.data.overrides,
        model: contract.model?.value ?? parsed.data.overrides?.model,
        reasoning_effort: contract.effort?.value ?? parsed.data.overrides?.reasoning_effort,
      } : parsed.data.overrides,
      parent_session_id: parentSessionId,
      subsidiary_id: parsed.data.subsidiary_id ?? null,
      project: parsed.data.project ?? null,
      requester_discord_user_id: parsed.data.requester_discord_user_id ?? null,
      source_discord_guild_id: parsed.data.source_discord_guild_id ?? null,
      source_discord_channel_id: parsed.data.source_discord_channel_id ?? null,
    });
    if (!result.ok) {
      const status = result.error.startsWith("unknown call_name") ? 404 : 400;
      return c.json({ error: result.error, detail: result.details }, status);
    }
    emitDelegationRunChanged(result.run);
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
    if (row.status === "completed" || row.status === "failed") {
      return c.json({ ok: true, run: serializeRun(row), requeued_run: null, duplicate: true });
    }
    if (status === "completed") {
      const evidence = await verifyCompletionEvidence(row);
      if (!evidence.ok) {
        const error = `completed rejected: no completion evidence (${evidence.reason})`;
        const rejected = deps.repo.updateRunStatus(id, "failed", error)!;
        emitDelegationRunChanged(rejected);
        deps.service.recordEffortOutcome(rejected, "failed");
        void sweepCommitRequest(rejected, deps);
        if (rejected.parent_session_id) {
          const text = buildDelegationStatusNotification(rejected, { ...parsed.data, status: "failed", detail: error });
          const ts = nowSec();
          const source = `delegation:${rejected.id}:status`;
          deps.sessions?.appendEvent({ session_id: rejected.parent_session_id, ts, kind: "inject", payload: { text, source } });
          eventBus.emit({ type: "session.inject", target_session_id: rejected.parent_session_id, text, source, ts });
          eventBus.emit({ type: "delegation.mirror", target_session_id: rejected.parent_session_id, run_id: rejected.id, child_session_id: rejected.child_session_id, text, ts });
        }
        void deps.queue?.drain();
        return c.json({ error: "completed_without_evidence" }, 409);
      }
    }
    const unmet = parsed.data.acceptance_report?.filter((item) => !item.met) ?? [];
    const effectiveRemaining = status === "completed" && unmet.length > 0
      ? unmet.map((item) => ({ title: `未達受け入れ条件: ${item.criterion}`, note: item.note }))
      : parsed.data.remaining ?? [];
    const isPartial = status === "partial" || effectiveRemaining.length > 0;
    const continuation = isPartial ? readRunContinuation(deps.sessions, row.child_session_id) : "requeue";
    let requeuedRun = null;
    let partialRequeueClaimed = false;
    if (isPartial) {
      if (continuation === "requeue") {
        const claimed = deps.repo.claimPartialRequeue(id);
        if (!claimed) {
          const current = deps.repo.findRun(id);
          if (current?.status === "completed" || current?.status === "failed") {
            return c.json({ ok: true, run: serializeRun(current), requeued_run: null, duplicate: true });
          }
          if (current?.status === "blocked" && current.error === PARTIAL_REQUEUE_CLAIM_ERROR) {
            return c.json({ error: PARTIAL_REQUEUE_CLAIM_ERROR }, 409);
          }
          return c.json({ error: "run_not_reportable", status: current?.status ?? null }, 409);
        }
        partialRequeueClaimed = true;
      }
      try {
        if (deps.taskStore && effectiveRemaining.length > 0) {
          const repoPath = row.spawn_worktree_path ?? row.spawn_cwd;
          if (!repoPath) {
            if (partialRequeueClaimed) deps.repo.releasePartialRequeueClaim(id, row.status, row.error);
            return c.json({ error: "partial_task_repo_unknown" }, 409);
          }
          await deps.taskStore.writeRemainingTasks({ repoPath, sourceRunId: row.id, project: row.call_name, remaining: effectiveRemaining });
        }
        if (continuation === "requeue") {
          const requeued = await requeuePartialRun({ run: row, remaining: effectiveRemaining, service: deps.service });
          if (!requeued.ok) {
            deps.repo.releasePartialRequeueClaim(id, row.status, row.error);
            return c.json({ error: "partial_requeue_failed", detail: requeued.error }, 500);
          }
          requeuedRun = requeued.run;
          emitDelegationRunChanged(requeued.run);
        } else if (row.child_session_id) {
          const text = `残作業を同一セッションで継続してください。\n${effectiveRemaining.map((item, index) => `${index + 1}. ${item.title}${item.note ? ` — ${item.note}` : ""}`).join("\n")}`;
          const ts = nowSec();
          const source = `delegation:${row.id}:continue`;
          deps.sessions?.appendEvent({
            session_id: row.child_session_id,
            ts,
            kind: "inject",
            payload: { text, source },
          });
          eventBus.emit({ type: "session.inject", target_session_id: row.child_session_id, text, source, ts });
        }
      } catch (error) {
        if (partialRequeueClaimed) deps.repo.releasePartialRequeueClaim(id, row.status, row.error);
        throw error;
      }
    }
    const persistedStatus: "running" | "completed" | "failed" = isPartial
      ? (continuation === "in-session" ? "running" : "completed")
      : parsed.data.status === "partial" ? "completed" : status;
    const updated = deps.repo.updateRunStatus(
      id,
      persistedStatus,
      persistedStatus === "failed" ? (parsed.data.detail ?? parsed.data.result ?? row.error) : row.error,
    )!;
    emitDelegationRunChanged(updated);
    if (!isPartial && (persistedStatus === "completed" || persistedStatus === "failed")) {
      deps.service.recordEffortOutcome(updated, persistedStatus);
      // 終了時に依頼ファイルを掃き出す。 サンドボックス下の委託先は `.git` に書けないので、
      // 「実装は済んだがコミットできないまま failed」 を最後に拾う経路がここ。
      void sweepCommitRequest(updated, deps);
    }
    if ((status === "completed" || status === "partial" || status === "failed") && updated.parent_session_id) {
      const text = buildDelegationStatusNotification(updated, { ...parsed.data, status: isPartial ? "partial" : status });
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
    if (updated.status === "completed" && !isPartial && deps.sessions && deps.taskStore) {
      void injectDecompositionWhenMissing({ run: updated, sessions: deps.sessions, store: deps.taskStore, hasPendingQuestion: deps.hasPendingQuestion });
    }
    if (updated.status === "completed" && !isPartial) void deps.onTaskflowCompleted?.(updated);
    return c.json({ ok: true, run: serializeRun(updated), requeued_run: requeuedRun ? serializeRun(requeuedRun) : null });
  });

  // 委託先の代わりにコミットする。 Codex は sandbox_mode=workspace-write で走るため
  // `.git` に書けず (index.lock が Permission denied)、 実装が済んでいてもコミットできない。
  // run が所有する worktree / ブランチに限定して Concordia が代行する。
  app.post("/runs/:id/commit", async (c) => {
    const id = c.req.param("id");
    const row = deps.repo.findRun(id);
    if (!row) return c.json({ error: "not_found" }, 404);

    const body = await c.req.json().catch(() => null);
    const parsed = RunCommitSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const request = parseCommitRequest(parsed.data);
    // zod を通っても paths の規則 (絶対パス / 親参照 / pathspec magic) で落ちうる。
    // 理由を返さないと委託先は直しようがない。
    if (!request) return c.json({ error: "invalid_request", detail: COMMIT_REQUEST_SHAPE_HINT }, 400);

    const outcome = await commitForRun(row, request);
    if (!outcome.ok) {
      // guard 拒否は依頼側の状態の問題 (409)、 git 自体の失敗は Concordia 側の
      // 失敗なので 500。 同じ 409 に混ぜると呼び出し側が再試行可否を判断できない。
      return c.json({ error: outcome.code, detail: outcome.detail }, outcome.code === "git_failed" ? 500 : 409);
    }
    return c.json({ ok: true, sha: outcome.sha, files: outcome.files });
  });

  /**
   * 子セッションが inject を受け取れる状態か。 eventBus 経由の session.inject は /ws に
   * 接続中の WS client (Lictor 側の pty 書き込み口) にしか届かない (api/ws.ts の
   * target_session_id フィルタ)。 session 行は在っても ws_clients===0 (再接続待ち/未接続)
   * の間は書き込み先が無く inject が静かに消えるため、 無条件に ok:true を返さない
   * (設定不備/未接続の無言フォールバック禁止 — coding-conventions §6)。
   */
  function checkChildInjectable(
    row: DelegationRunRow,
  ): { ok: true; childSessionId: string } | { ok: false; status: 404 | 409; error: string; detail?: string } {
    if (!row.child_session_id) return { ok: false, status: 409, error: "child_session_not_claimed" };
    if (deps.sessions) {
      const childSession = deps.sessions.findSession(row.child_session_id);
      if (!childSession) return { ok: false, status: 404, error: "child_session_not_found" };
      if (childSession.ws_clients <= 0) {
        return {
          ok: false,
          status: 409,
          error: "child_session_not_connected",
          detail: "no live pty/ws client is attached to this session; inject would be silently dropped",
        };
      }
    }
    return { ok: true, childSessionId: row.child_session_id };
  }

  /** 子セッションへ 1 通 inject し、 親セッションへ写す (parent / followup 共通)。 */
  function injectToChild(row: DelegationRunRow, childSessionId: string, rawText: string, source: string): number {
    const text = buildDelegationInjectText({ runId: row.id, text: rawText });
    const ts = nowSec();
    deps.sessions?.appendEvent({
      session_id: childSessionId,
      ts,
      kind: "inject",
      payload: { text, source: `delegation:${row.id}:${source}` },
    });
    eventBus.emit({
      type: "session.inject",
      target_session_id: childSessionId,
      text,
      source: `delegation:${row.id}:${source}`,
      ts,
    });
    if (row.parent_session_id) {
      eventBus.emit({
        type: "delegation.mirror",
        target_session_id: row.parent_session_id,
        run_id: row.id,
        child_session_id: childSessionId,
        text,
        ts,
      });
    }
    return ts;
  }

  app.post("/runs/:id/inject", async (c) => {
    const id = c.req.param("id");
    const row = deps.repo.findRun(id);
    if (!row) return c.json({ error: "not_found" }, 404);
    const target = checkChildInjectable(row);
    if (!target.ok) return c.json({ error: target.error, detail: target.detail }, target.status);
    const body = await c.req.json().catch(() => null);
    const parsed = RunInjectSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid_body", detail: parsed.error.flatten() }, 400);
    const ts = injectToChild(row, target.childSessionId, parsed.data.text, "parent");
    return c.json({ ok: true, target_session_id: target.childSessionId, ts });
  });

  return app;
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

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

function readRunContinuation(sessions: SessionsRepo | undefined, childSessionId: string | null): "requeue" | "in-session" {
  if (!sessions || !childSessionId) return "requeue";
  const contract = parseContractMetadata(sessions.findSession(childSessionId)?.metadata ?? null);
  return contract?.continuation?.value === "in-session" ? "in-session" : "requeue";
}

/**
 * run 終了時に `.concordia-commit.json` を拾ってコミットする。
 *
 * 委託元セッションに結果を返すのが目的の半分: 「コミットされたのか、 されなかったのか」 が
 * 分からないと、 委託元は毎回 worktree を見に行くことになる。
 */
async function sweepCommitRequest(run: DelegationRunRow, deps: DelegationApiDeps): Promise<void> {
  // sweep 全体が best-effort。 呼び出し側は `void` で投げっぱなしにするので、
  // ここで漏らした例外は unhandled rejection になる (通知側で throw しても同じ)。
  try {
    const outcome = await commitFromRequestFile(run);
    if (!outcome) return; // 依頼なし = 正常系
    const text = outcome.ok
      ? `[delegation ${run.id}] コミット代行: ${outcome.sha.slice(0, 8)} (${outcome.files} files)`
      : `[delegation ${run.id}] コミット代行に失敗: ${outcome.code} — ${outcome.detail}`;
    commitLogger.info({ runId: run.id, outcome }, "delegation commit sweep");
    if (!run.parent_session_id) return;
    deps.sessions?.appendEvent({
      session_id: run.parent_session_id,
      ts: nowSec(),
      kind: "inject",
      payload: { text, source: `delegation:${run.id}:commit` },
    });
    eventBus.emit({
      type: "session.inject",
      target_session_id: run.parent_session_id,
      text,
      source: `delegation:${run.id}:commit`,
      ts: nowSec(),
    });
  } catch (error) {
    commitLogger.warn({ runId: run.id, err: error }, "delegation commit sweep failed");
  }
}
