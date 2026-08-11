/**
 * 設定ページのセクション定義 (表示順とラベル)。
 *
 * 章立ては `spec/setup/config-reference.md` のカテゴリに合わせる
 * (リファレンスと設定ページで章が食い違うと突き合わせができなくなるため)。
 */

import type { SettingSectionId } from "./types.js";

export interface SettingSection {
  id: SettingSectionId;
  label: string;
  description: string;
}

/** 配列の順序がそのまま設定ページの表示順。 */
export const SETTING_SECTIONS: readonly SettingSection[] = [
  { id: "core", label: "コア", description: "本体の bind 先・DB・秘密鍵。 変更には再起動が要る。" },
  { id: "workspace", label: "ワークスペース", description: "ローカルクローンの走査ルートと GitHub Organization。" },
  { id: "llm", label: "LLM", description: "report / rule proposer が使う Claude CLI の制御。" },
  { id: "discord", label: "Discord", description: "Discord bot の接続と挙動。" },
  { id: "slack", label: "Slack", description: "Slack bot の接続と挙動。" },
  { id: "session", label: "セッション管制", description: "spawn・lost 判定・回収・停止 nudge。" },
  { id: "compaction", label: "コンパクション", description: "コンテキスト圧縮の自動発火条件。" },
  { id: "delegation", label: "委託 (delegation)", description: "AI 間タスク委託と goal-and-go。" },
  { id: "harness", label: "ハーネス", description: "prompt 解析・事前調査・実装ゲート。" },
  { id: "workflow", label: "ワークフロー", description: "リアクションワークフローと自動提出。" },
  { id: "services", label: "兄弟サービス", description: "Excubitor / Memoria / Anatomia / Thaleia / Villa の接続先。" },
  { id: "observability", label: "observability", description: "サービス監視・error 自動対応。" },
  { id: "logging", label: "ログ", description: "ログレベルと出力先。" },
  { id: "cache", label: "キャッシュ", description: "HTTP キャッシュと Redis。" },
  { id: "pr-queue", label: "PR キュー", description: "GitHub PR 同期と Revisor 連携。" },
  { id: "federation", label: "マルチ拠点連合", description: "本社 / 拠点ロールの連合リンク。" },
  { id: "runtime", label: "runtime 制御", description: "チャットミュート・予算・上長メンション等の運転スイッチ。" },
] as const;
