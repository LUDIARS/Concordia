/**
 * 段階注入の第2段階 (実装タスクの後追い配信) — 冪等な遷移。
 *
 * 呼ばれる契機は委託先からの調査完了報告 (`POST /v1/delegation/runs/:id/investigated`)。
 * 何度呼ばれても、 Cc が再起動しても、 配信は 1 度きりであることを delegation_runs の
 * 列 (memoria_task_id / staged_followup_at) で保証する — in-memory Set だと再起動で
 * 抑止が外れて二重配信になる (run-watchdog.ts が同じ理由で DB に持っている)。
 *
 * 2 つの副作用は独立に冪等化する:
 *   - Memoria タスク作成   … memoria_task_id IS NULL のときだけ
 *   - 実装タスクの inject … staged_followup_at IS NULL のときだけ
 * Memoria が落ちていても実装は止めない (追跡タスクの不在は申し送りにする)。 後続の
 * 報告呼び出しで作成に成功したら、 補足 inject で id だけ追送する。
 *
 * spec/feature/delegation-staged-injection.md §4。
 */

import type { DelegationRunRow } from "../db/delegation-repo.js";
import { createChildLogger } from "../shared/logger.js";
import {
  buildFollowupInject,
  buildMemoriaAttachmentNote,
  buildMemoriaTaskDraft,
  resolveWhy,
  type MemoriaTaskLink,
} from "./staged-injection.js";

const log = createChildLogger("delegation/staged-followup");

/** 段階注入が使う delegation_runs の書き込み口だけを切り出したもの。 */
export interface StagedFollowupRunsRepo {
  findRun(id: string): DelegationRunRow | null;
  recordInvestigationReport(id: string, summary: string, nowMs: number): void;
  /** memoria_task_id が未設定のときだけ書く。 書けたら true (= 自分が作成者)。 */
  recordMemoriaTask(id: string, taskId: string, taskUrl: string): boolean;
  /** staged_followup_at が未設定のときだけ書く。 書けたら true (= 自分が配信者)。 */
  markStagedFollowupDelivered(id: string, nowMs: number): boolean;
}

/** Memoria への書き込みで使う契約だけ (既存の公式 API — Memoria 側は変更しない)。 */
export interface StagedFollowupMemoriaPort {
  createTask(input: { title: string; details?: string }): Promise<{ id: string | number }>;
  taskApiUrl(id: string | number): string;
}

export interface InvestigationReport {
  summary: string;
  files?: string[];
  blockers?: string[];
}

export interface StagedFollowupDeps {
  runs: StagedFollowupRunsRepo;
  memoria?: StagedFollowupMemoriaPort;
  /** 子セッションへの配信。 接続確認は呼び出し側 (API ルート) の責務。 */
  inject: (text: string, sourceSuffix: string) => void;
  concordiaUrl: string;
  now?: () => number;
}

export type StagedFollowupOutcome =
  | { ok: false; error: "run_not_staged" | "run_not_found" }
  | {
      ok: true;
      /** 今回の呼び出しで実装タスクを配信したか。 */
      delivered: boolean;
      /** 以前の呼び出しで配信済みだったか。 */
      already_delivered: boolean;
      memoria: MemoriaTaskLink | null;
      memoria_error: string | null;
      /** 今回の呼び出しで Memoria タスクを作成したか。 */
      memoria_created: boolean;
      /** 配信済み run に対して Memoria id だけを追送したか。 */
      supplement_delivered: boolean;
    };

export async function deliverStagedFollowup(
  runId: string,
  report: InvestigationReport,
  deps: StagedFollowupDeps,
): Promise<StagedFollowupOutcome> {
  const now = deps.now ?? (() => Date.now());
  const run = deps.runs.findRun(runId);
  if (!run) return { ok: false, error: "run_not_found" };
  if (!run.staged_injection) return { ok: false, error: "run_not_staged" };

  deps.runs.recordInvestigationReport(run.id, renderReport(report), now());

  const ensured = await ensureMemoriaTask(run, report, deps);
  // 作成/記録のあとに読み直す。 並行呼び出しで自分が作成者でなかった場合、 正本は DB 側。
  const current = deps.runs.findRun(run.id) ?? run;
  const memoria = memoriaLinkOf(current);

  const alreadyDelivered = current.staged_followup_at != null;
  if (!alreadyDelivered) {
    // mark → inject の順。 逆にすると、 同時到着した 2 本がどちらも「未配信」を見て
    // 二重に inject する。 mark が真を返した 1 本だけが配信者になる。
    const claimed = deps.runs.markStagedFollowupDelivered(run.id, now());
    if (claimed) {
      const text = buildFollowupInject({
        runId: current.id,
        title: current.call_name,
        task: current.rendered_prompt,
        why: resolveWhy({
          args: parseArgs(current.args_json),
          investigationSummary: report.summary ?? null,
          title: current.call_name,
        }),
        memoria,
        memoriaError: memoria ? null : ensured.error,
        repoPath: current.spawn_cwd ?? null,
        branch: current.spawn_branch ?? null,
        concordiaUrl: deps.concordiaUrl,
      });
      deps.inject(text, "followup");
      log.info({ run_id: current.id, memoria_task_id: memoria?.id ?? null }, "staged followup delivered");
      return {
        ok: true,
        delivered: true,
        already_delivered: false,
        memoria,
        memoria_error: memoria ? null : ensured.error,
        memoria_created: ensured.created,
        supplement_delivered: false,
      };
    }
  }

  // 配信済み。 今回はじめて Memoria タスクが取れたなら、 id だけ補足で送る
  // (実装タスクは再送しない — 冪等性の要求)。
  let supplement = false;
  if (ensured.created && memoria) {
    deps.inject(buildMemoriaAttachmentNote(memoria), "followup-memoria");
    supplement = true;
  }
  return {
    ok: true,
    delivered: false,
    already_delivered: true,
    memoria,
    memoria_error: memoria ? null : ensured.error,
    memoria_created: ensured.created,
    supplement_delivered: supplement,
  };
}

async function ensureMemoriaTask(
  run: DelegationRunRow,
  report: InvestigationReport,
  deps: StagedFollowupDeps,
): Promise<{ created: boolean; error: string | null }> {
  if (run.memoria_task_id) return { created: false, error: null };
  const fromArgs = memoriaTaskIdFromArgs(parseArgs(run.args_json));
  if (fromArgs && deps.memoria) {
    // 委託元が既存タスクを指定していたら作らずに関連付ける (二重起票の回避)。
    const recorded = deps.runs.recordMemoriaTask(run.id, fromArgs, deps.memoria.taskApiUrl(fromArgs));
    return { created: recorded, error: null };
  }
  if (!deps.memoria) return { created: false, error: "memoria client is not configured" };
  const draft = buildMemoriaTaskDraft({
    runId: run.id,
    callName: run.call_name,
    title: run.call_name,
    task: run.rendered_prompt,
    why: resolveWhy({
      args: parseArgs(run.args_json),
      investigationSummary: report.summary ?? null,
      title: run.call_name,
    }),
    repoPath: run.spawn_cwd ?? null,
  });
  try {
    const task = await deps.memoria.createTask(draft);
    const id = String(task.id);
    const recorded = deps.runs.recordMemoriaTask(run.id, id, deps.memoria.taskApiUrl(id));
    return { created: recorded, error: null };
  } catch (error) {
    const message = (error as Error).message;
    // Memoria の不調で実装を止めない。 未作成の事実は follow-up 本文に載せる。
    log.warn({ run_id: run.id, error: message }, "memoria task creation failed; continuing without tracker task");
    return { created: false, error: message };
  }
}

function memoriaLinkOf(run: DelegationRunRow): MemoriaTaskLink | null {
  if (!run.memoria_task_id) return null;
  return { id: run.memoria_task_id, url: run.memoria_task_url ?? "" };
}

function memoriaTaskIdFromArgs(args: Record<string, unknown>): string | null {
  for (const key of ["memoria_task_id", "memoria_task", "task_id"]) {
    const value = args[key];
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function parseArgs(json: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(json) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 調査報告を 1 本のテキストへ (証跡として run に残す)。 */
function renderReport(report: InvestigationReport): string {
  const lines = [report.summary.trim()];
  if (report.files?.length) lines.push("", `files: ${report.files.join(", ")}`);
  if (report.blockers?.length) lines.push("", `blockers: ${report.blockers.join(" / ")}`);
  return lines.join("\n");
}
