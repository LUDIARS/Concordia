/**
 * バグバウンティの管理面 API (spec/feature/bug-bounty.md §8.2)。 admin (loopback) の配下。
 *
 *   GET  /v1/bounty/reports                           一覧 (状態 / プロジェクト / 会社 / 企画で絞り込み・ページング・原文なし)
 *   GET  /v1/bounty/reports/:id                       詳細 (原文・仕分けの根拠・履歴・Actio タスク・PR・反映の証拠)
 *   POST /v1/admin/bounty/reports/:id/judgement       判定・深刻度・自己起因の変更
 *   POST /v1/admin/bounty/reports/:id/appeal-decision 再審の決定
 *   POST /v1/admin/bounty/reports/:id/retry-task      Actio タスク作成の再試行
 *   POST /v1/admin/bounty/reports/:id/close           手動クローズ (根拠必須)
 *   GET  /v1/admin/bounty/cocoiru-key                 Cocoiru の鍵が設定済みか
 *   PUT  /v1/admin/bounty/cocoiru-key                 Cocoiru の鍵を設定 / 消去 (暗号化して保存)
 *
 * 画面は状態を直接書かず、use case (判定・再審・修正・反映確認) を呼ぶ。 原文は運用担当の管理面だけに出す。
 *
 * @implements SPEC-BOUNTY-WEBUI
 */

import { Hono } from "hono";
import { z } from "zod";
import { toBountyAdminDetail, toBountyAdminSummary } from "../bounty/admin-view.js";
import type { BountyCloseService } from "../bounty/close-service.js";
import { MAX_CLOSE_EVIDENCE_CHARS } from "../bounty/close-service.js";
import type { BountyFixService } from "../bounty/fix-service.js";
import type { BountyJudgementService } from "../bounty/judgement-service.js";
import { MAX_APPEAL_REASON_CHARS } from "../bounty/judgement-service.js";
import { BOUNTY_REPORT_STATUSES, isBountyReportStatus } from "../bounty/report-state.js";
import type { BountyReportEventRow, BountyReportRow, BountyReportsRepo } from "../db/bounty-reports-repo.js";
import type { BountyReporterRow } from "../db/bounty-reporters-repo.js";

const MAX_PAGE = 100;
/** 管理面の操作者として履歴に残す名前。 */
const ADMIN_ACTOR = "webui-admin";

const JudgementSchema = z.object({
  verdict: z.enum(["accepted", "duplicate", "rejected", "needs_info"]).optional(),
  severity: z.enum(["s1", "s2", "s3", "s4"]).nullable().optional(),
  self_inflicted: z.boolean().optional(),
  duplicate_of: z.string().trim().min(1).max(200).nullable().optional(),
  reason: z.string().max(MAX_APPEAL_REASON_CHARS),
}).strict();

const AppealDecisionSchema = z.object({
  uphold: z.boolean(),
  verdict: z.enum(["accepted", "duplicate", "rejected"]).optional(),
  duplicate_of: z.string().trim().min(1).max(200).nullable().optional(),
  reason: z.string().max(MAX_APPEAL_REASON_CHARS),
}).strict();

const CloseSchema = z.object({ evidence: z.string().max(MAX_CLOSE_EVIDENCE_CHARS) }).strict();
const CocoiruKeySchema = z.object({ key: z.string().max(500).nullable() }).strict();

export interface BountyAdminApiDeps {
  reports: Pick<BountyReportsRepo, "list" | "find" | "events" | "listAcceptedForProject">;
  reporters: { find(id: string): BountyReporterRow | null };
  judgement: BountyJudgementService;
  fix: BountyFixService;
  close: BountyCloseService;
  cocoiruKey: { isSet(): boolean; set(key: string | null): void };
  /** 設定 `bounty.hotfix_daily_limit` の今の値 (画面の表示用)。 */
  hotfixDailyLimit(): number;
}

const STATUS: Readonly<Record<string, 400 | 404 | 409>> = {
  report_not_found: 404,
  not_closable: 409,
  not_accepted: 409,
  task_exists: 409,
  no_pending_appeal: 409,
  transition_not_allowed: 409,
  state_changed: 409,
};

function readEventFilter(event: string | undefined): string | null {
  if (event === undefined || event === "") return null;
  return event === "none" ? "" : event;
}

/** 一覧・詳細の読み出し (`/v1/bounty` の配下)。 */
export function bountyAdminReadRouter(deps: Pick<BountyAdminApiDeps, "reports" | "reporters" | "hotfixDailyLimit">): Hono {
  const app = new Hono();
  const find = (id: string) => deps.reporters.find(id);

  app.get("/reports", (c) => {
    const status = c.req.query("status") ?? "";
    if (status && !isBountyReportStatus(status)) return c.json({ error: "invalid_status", allowed: BOUNTY_REPORT_STATUSES }, 400);
    const limit = Math.min(MAX_PAGE, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const company = c.req.query("company");
    const page = deps.reports.list({
      status: status && isBountyReportStatus(status) ? status : null,
      project: c.req.query("project") || null,
      // 本社は "hq" で指定する (company が無い報告)。
      company: company === undefined || company === "" ? null : company === "hq" ? "" : company,
      // 企画外は "none" で指定する (event が無い報告)。
      event: readEventFilter(c.req.query("event")),
    }, limit, offset);
    return c.json({
      reports: page.rows.map((row) => toBountyAdminSummary(row, find)),
      total: page.total,
      limit,
      offset,
      hotfix_daily_limit: deps.hotfixDailyLimit(),
    });
  });

  app.get("/reports/:id", (c) => {
    const row: BountyReportRow | null = deps.reports.find(c.req.param("id"));
    if (!row) return c.json({ error: "report_not_found" }, 404);
    const events: BountyReportEventRow[] = deps.reports.events(row.id);
    return c.json({ report: toBountyAdminDetail(row, events, find) });
  });

  return app;
}

/** 権限者の操作 (`/v1/admin/bounty` の配下)。 */
export function bountyAdminActionsRouter(deps: BountyAdminApiDeps): Hono {
  const app = new Hono();
  const refuse = (error: string) => STATUS[error] ?? 400;

  app.post("/reports/:id/judgement", async (c) => {
    const parsed = JudgementSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_judgement" }, 400);
    const result = await deps.judgement.change({
      reportId: c.req.param("id"),
      authority: ADMIN_ACTOR,
      change: {
        ...(parsed.data.verdict ? { verdict: parsed.data.verdict } : {}),
        ...(parsed.data.severity !== undefined ? { severity: parsed.data.severity } : {}),
        ...(parsed.data.self_inflicted !== undefined ? { selfInflicted: parsed.data.self_inflicted } : {}),
        ...(parsed.data.duplicate_of !== undefined ? { duplicateOf: parsed.data.duplicate_of } : {}),
        reason: parsed.data.reason,
      },
    });
    if (!result.ok) return c.json({ error: result.error }, refuse(result.error));
    return c.json({ ok: true });
  });

  app.post("/reports/:id/appeal-decision", async (c) => {
    const parsed = AppealDecisionSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_appeal_decision" }, 400);
    const result = await deps.judgement.decideAppeal({
      reportId: c.req.param("id"),
      authority: ADMIN_ACTOR,
      uphold: parsed.data.uphold,
      ...(parsed.data.uphold && parsed.data.verdict
        ? { change: { verdict: parsed.data.verdict, duplicateOf: parsed.data.duplicate_of ?? null, reason: parsed.data.reason } }
        : {}),
      reason: parsed.data.reason,
    });
    if (!result.ok) return c.json({ error: result.error }, refuse(result.error));
    return c.json({ ok: true });
  });

  app.post("/reports/:id/retry-task", async (c) => {
    const result = await deps.fix.retryTask(c.req.param("id"));
    if (!result.ok) return c.json({ error: result.error }, refuse(result.error));
    return c.json({ ok: true, created: result.created });
  });

  app.post("/reports/:id/close", async (c) => {
    const parsed = CloseSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_close" }, 400);
    const result = await deps.close.manualClose({ reportId: c.req.param("id"), actor: ADMIN_ACTOR, evidence: parsed.data.evidence });
    if (!result.ok) return c.json({ error: result.error }, refuse(result.error));
    return c.json({ ok: true });
  });

  app.get("/cocoiru-key", (c) => c.json({ configured: deps.cocoiruKey.isSet() }));

  app.put("/cocoiru-key", async (c) => {
    const parsed = CocoiruKeySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid_cocoiru_key" }, 400);
    const key = parsed.data.key?.trim() || null;
    if (key !== null && key.length < 16) return c.json({ error: "cocoiru_key_too_short" }, 400);
    deps.cocoiruKey.set(key);
    return c.json({ configured: deps.cocoiruKey.isSet() });
  });

  return app;
}
