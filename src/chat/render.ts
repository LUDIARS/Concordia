/**
 * 中央チャット発話の共有型.
 *
 * かつてここに persona 声色での発話描画 (renderChat / buildRenderPrompt) があったが、
 * persona 機構の撤去 (2026-07-17) に伴い削除した. 「いつ / 誰が喋るか」 の判断型
 * (ChatIntent) と描画設定型だけを残す (rules/decide.ts・render-config.ts が参照).
 */

export type ChatRenderer = "cli" | "template";

/** 発話の意図. prompt の組み立てと文体を切り替える. */
export type ChatIntent =
  | "chitchat" // 雑談
  | "review" // 軽レビュー / 振り返り
  | "reply" // 他者発言への返信
  | "react" // 動作ログ等への反応
  | "notice" // 離脱通知などの軽い告知
  | "consult"; // 相談 / 確認

export interface RenderConfig {
  renderer: ChatRenderer;
  /** cli の `--model` に渡すエイリアス (例 "haiku"). */
  model: string;
}
