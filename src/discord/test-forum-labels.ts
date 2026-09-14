/**
 * Test Forum の投稿で使う人間向けの状態語と表示形式。
 *
 * Revisor の画面 (ui-pr-view-script.mjs) と同じ語に揃える。 Discord 描画・レポート文書の
 * どちらからも使うため、 discord.js に依存しない純粋なモジュールに置く。
 * @implements SPEC-DISCORD-REVIEW-REPORT
 */
import type { RevisorLocalPrDetail } from "../pr/revisor-test-workflow-client.js";

const CHECK_STATUS_LABELS: Record<string, string> = {
  queued: "審査待ち",
  running: "審査中",
  test_ok: "Test OK",
  failed: "審査失敗",
  action_required: "人間の判断が必要",
  merged: "マージ済み",
  closed: "クローズ済み",
};

export function checkStatusLabel(
  checkStatus: string,
  detail: Pick<RevisorLocalPrDetail, "decisionState"> | null = null,
): string {
  if (checkStatus === "action_required" && detail?.decisionState === "failed") {
    return "審査失敗";
  }
  return CHECK_STATUS_LABELS[checkStatus] ?? checkStatus;
}

const RESULT_LABELS: Record<string, string> = {
  passed: "通過",
  failed: "失敗",
  skipped: "スキップ",
  running: "実行中",
};

/** 登録チェック 1 件の結果。 未知の値は「通過」等へ寄せず、そのまま不明と書く。 */
export function checkResultLabel(status: string): string {
  return RESULT_LABELS[status] ?? `結果不明 (${status})`;
}

const ENTRY_STATUS_LABELS: Record<string, string> = {
  running: "開始",
  passed: "完了",
  skipped: "スキップ",
  failed: "失敗",
  action_required: "要対応",
};

/** 審査履歴の 1 記録の状態。 */
export function reportEntryStatusLabel(status: string): string {
  return ENTRY_STATUS_LABELS[status] ?? `状態不明 (${status})`;
}

const STAGE_LABELS: Record<string, string> = {
  anatomia: "Anatomia 解析",
  tests: "登録テスト",
  security: "セキュリティスキャン",
  review: "モデルレビュー",
  leakage: "流出スキャン",
};

export function reviewStageLabel(stage: string): string {
  return STAGE_LABELS[stage] ?? stage;
}

const SECURITY_STATUS_LABELS: Record<string, string> = {
  passed: "通過",
  failed: "失敗",
  skipped: "スキップ",
};

export function securityStatusLabel(status: string): string {
  return SECURITY_STATUS_LABELS[status] ?? status;
}

/** Revisor の ISO UTC 時刻を、読み手の運用時間帯 (日本時間) で表示する。 */
export function formatReportTime(iso: string): string {
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) return "日時不明";
  const jst = new Date(epochMs + 9 * 60 * 60 * 1000).toISOString();
  return `${jst.slice(0, 10)} ${jst.slice(11, 19)} (日本時間)`;
}

/** Revisor 画面の「所要」列と同じく秒へ丸める。 記録が無ければ null。 */
export function formatDuration(durationMs: number | null | undefined): string | null {
  if (typeof durationMs !== "number" || !Number.isFinite(durationMs) || durationMs < 0) return null;
  return `${Math.round(durationMs / 1000)} 秒`;
}
