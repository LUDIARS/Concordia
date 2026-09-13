/**
 * テストフォーラムのマージ操作で利用者へ返す文面。 結果はスレッドの通常メッセージで残す。
 * メンションは表示だけで通知しない (送信側で allowedMentions を抑制する)。
 * @implements spec/feature/test-forum-controls.md — マージの受付と結果通知
 */
import type { RevisorMergeFailureReason } from "../pr/revisor-merge-outcome.js";

export const MERGE_ACCEPTED_REPLY = "マージを受け付けました。完了または失敗の理由をこのスレッドへ投稿します。";
export const MERGE_IN_PROGRESS_REPLY = "このテスト候補のマージは受付済みです。結果はこのスレッドへ投稿します。";

export type MergeCompletion = "merged" | "already_merged" | "confirmed";

function operator(userId: string): string {
  return `操作: <@${userId}>`;
}

/** 結果不明の理由。 「拒否した」等、確認できていない事実を書かない。 */
export function mergeUnknownDetail(reason: RevisorMergeFailureReason): string {
  if (reason === "timeout") return "Revisor の応答を待ち切れませんでした。Revisor 側で処理が続いている可能性があります。";
  if (reason === "unreachable") return "Revisor との通信が途中で失敗し、マージ要求が処理されたかを確認できません。";
  return "Revisor からマージの結果を確認できませんでした。";
}

export function mergeSucceededNotice(prNumber: number, userId: string, how: MergeCompletion): string {
  const lead = how === "already_merged"
    ? `✅ #${prNumber} は既にマージ済みでした。`
    : how === "confirmed"
      ? `✅ #${prNumber} のマージは完了していました。Revisor の応答は途中で途切れましたが、状態を読み直してマージ済みを確認しました。`
      : `✅ #${prNumber} を squash merge しました。`;
  return `${lead} (${operator(userId)})\n同期で Revisor の状態を確認したあと、テスト・QA セッションを終了してこのスレッドを閉じます。`;
}

export function mergeFailedNotice(prNumber: number, userId: string, detail: string): string {
  return [
    `❌ #${prNumber} のマージに失敗しました (${operator(userId)})。`,
    `理由: ${detail}`,
    "Revisor はマージを実行していないため、マージ操作を戻しました。原因を解消してからやり直してください。",
  ].join("\n");
}

export function mergeUnknownNotice(prNumber: number, userId: string, detail: string): string {
  return [
    `⚠️ #${prNumber} のマージ結果を確認できませんでした (${operator(userId)})。`,
    `理由: ${detail}`,
    "二重実行を防ぐため、このスレッドのマージ操作は戻しません。Revisor の画面で状態を確認してください。"
      + "Revisor でマージ済みになれば、同期がこのスレッドへ記録して閉じます。",
  ].join("\n");
}
