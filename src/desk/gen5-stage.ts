/** @implements CC-DESK-GEN5 — 受付担当が先頭行で報告できる工程。順序を強制せず手戻りを許す。 */
export const GEN5_STAGES = [
  "企画・要件定義", "MVP・初回バックログ定義", "基礎の構築", "ゲームプレイMVPの実装",
  "人間のプレイ確認", "試遊指示の受付", "UX判断", "期間・コスト判断", "次スプリント計画",
] as const;

export const GEN5_PREFIX = "Gen5工程: ";
