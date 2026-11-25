/**
 * 依頼窓口のスレッドに出す知らせの文面 (純関数)。受付・起動・カードの開閉・終了・催促だけを出し、
 * セッション本体の会話は既存のセッション用チャンネルが正本 (実装メモ 2)。
 *
 * @implements spec/feature/request-desk.md — Discord の依頼スレッド
 */
import type { ControlCard } from "../control-cards/card-domain.js";
import type { DeskRequest } from "../desk/desk-request-policy.js";

export const DESK_CHANNEL_NAME = "依頼窓口";
export const DESK_CHANNEL_TOPIC = "依頼を Actio に登録し、対象プロジェクトの管制へ届けます。依頼ごとのスレッドで進行を知らせます。対象は [プロジェクト略号] で指定できます。先頭 [codex] は管制を新規起動する場合の CLI 指定です。";

export function deskThreadName(request: Pick<DeskRequest, "id" | "body">): string {
  const head = request.body.replace(/\s+/g, " ").trim().slice(0, 60);
  return `依頼 ${request.id.slice(0, 8)} ${head}`.slice(0, 95);
}

export function acceptedNotice(request: Pick<DeskRequest, "id" | "provider" | "routing_enabled">, webUrl: string): string {
  return [
    `依頼 ${request.id.slice(0, 8)} を受け付けました。${request.routing_enabled ? "対象を確認して Actio に登録します。" : "作業セッションを起動します。"}`,
    `割り当て・人間のアクション / 判断・終了はこのスレッドに出します。Web: ${webUrl}`,
  ].join("\n");
}

/** 依頼の状態ごとの知らせ。出さない状態は null。 */
export function stateNotice(request: Pick<DeskRequest, "id" | "state" | "error" | "routing_issue" | "task_reference">, links: { discord: string | null; web: string } | null): string | null {
  const id = request.id.slice(0, 8);
  if (request.routing_issue === "project" || request.routing_issue === "delivery") return `依頼 ${id} の確認が必要です。 ${request.error ?? ""}`;
  if (request.state === "running") {
    const where = [links?.discord ? `Discord: ${links.discord}` : null, links ? `Web: ${links.web}` : null].filter(Boolean).join(" / ");
    if (request.task_reference) return `依頼 ${id} をプロジェクト管制へ割り当てました (${request.task_reference})。${where ? `\n${where}` : ""}`;
    return `依頼 ${id} の作業セッションを起動しました。細かい指示はセッションのチャンネルへ。${where ? `\n${where}` : ""}`;
  }
  if (request.state === "launch_unknown") return `依頼 ${id} の起動結果が不明です。起動 ID で照合しています (同じ依頼を別に起動し直しません)。`;
  if (request.state === "launch_failed") return `依頼 ${id} のセッションを起動できませんでした: ${(request.error ?? "理由不明").slice(0, 500)}`;
  if (request.state === "finished") return `依頼 ${id} の${request.task_reference ? "Actio タスク" : "作業セッション"}が終了しました。`;
  if (request.state === "accepted" && request.task_reference) return `依頼 ${id} を Actio に登録しました (${request.task_reference})。`;
  return null;
}

export function cardNotice(kind: "opened" | "closed", card: Pick<ControlCard, "card_kind" | "summary" | "link" | "close_reason">): string {
  const label = card.card_kind === "human_action" ? "人間のアクション" : "人間の判断";
  if (kind === "opened") return `🃏 ${label}が必要です: ${card.summary}${card.link ? `\n回答先: ${card.link}` : ""}`;
  return `✅ ${label}のカードが閉じました: ${card.summary}`;
}
