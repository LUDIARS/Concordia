/**
 * 依頼窓口のスレッドに出す知らせの文面 (純関数)。受付・起動・カードの開閉・終了・催促だけを出し、
 * セッション本体の会話は既存のセッション用チャンネルが正本 (実装メモ 2)。
 *
 * @implements spec/feature/request-desk.md — Discord の依頼スレッド
 */
import type { ControlCard } from "../control-cards/card-domain.js";
import type { DeskRequest } from "../desk/desk-request-policy.js";

export const DESK_CHANNEL_NAME = "依頼窓口";
export const DESK_CHANNEL_TOPIC = "依頼を投稿すると作業セッションを起動し、依頼ごとのスレッドで受付・起動・人間のアクション / 判断 (管制カード)・終了を知らせます。先頭 [codex] で Codex、既定は Claude。セッションへの細かい指示は各セッションのチャンネルへ。";

export function deskThreadName(request: Pick<DeskRequest, "id" | "body">): string {
  const head = request.body.replace(/\s+/g, " ").trim().slice(0, 60);
  return `依頼 ${request.id.slice(0, 8)} ${head}`.slice(0, 95);
}

export function acceptedNotice(request: Pick<DeskRequest, "id" | "provider">, webUrl: string): string {
  return [
    `依頼 ${request.id.slice(0, 8)} を受け付けました (${request.provider})。作業セッションを起動します。`,
    `受付・起動・人間のアクション / 判断・終了はこのスレッドに出します。Web: ${webUrl}`,
  ].join("\n");
}

/** 依頼の状態ごとの知らせ。出さない状態は null。 */
export function stateNotice(request: Pick<DeskRequest, "id" | "state" | "error">, links: { discord: string | null; web: string } | null): string | null {
  const id = request.id.slice(0, 8);
  if (request.state === "running") {
    const where = [links?.discord ? `Discord: ${links.discord}` : null, links ? `Web: ${links.web}` : null].filter(Boolean).join(" / ");
    return `依頼 ${id} の作業セッションを起動しました。細かい指示はセッションのチャンネルへ。${where ? `\n${where}` : ""}`;
  }
  if (request.state === "launch_unknown") return `依頼 ${id} の起動結果が不明です。起動 ID で照合しています (同じ依頼を別に起動し直しません)。`;
  if (request.state === "launch_failed") return `依頼 ${id} のセッションを起動できませんでした: ${(request.error ?? "理由不明").slice(0, 500)}`;
  if (request.state === "finished") return `依頼 ${id} の作業セッションが終了しました。`;
  return null;
}

export function cardNotice(kind: "opened" | "closed", card: Pick<ControlCard, "card_kind" | "summary" | "link" | "close_reason">): string {
  const label = card.card_kind === "human_action" ? "人間のアクション" : "人間の判断";
  if (kind === "opened") return `🃏 ${label}が必要です: ${card.summary}${card.link ? `\n回答先: ${card.link}` : ""}`;
  return `✅ ${label}のカードが閉じました: ${card.summary}`;
}
