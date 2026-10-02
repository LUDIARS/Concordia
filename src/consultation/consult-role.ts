/**
 * 相談者の役職を、 相談の作業ディレクトリ (役職ごとのフォルダ) とモデル選びの区分に読む
 * (spec/feature/tech-consultation.md §6、 2026-10-02 neco 指示)。
 *
 * 「相談は役職ごとにディレクトリを分けてスキルやメモリを使い分ける」「作業ディレクトリは
 * E:/Document/Consult/役職ごとのフォルダとし、 データを Discord の個人 ID のフォルダを作って保存する」。
 * 事前ヒアリングの役職 (自由記述) から読み、 読めなければ general。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

export const CONSULT_ROLE_FOLDERS = ["engineer", "planner", "designer", "sound", "general"] as const;
export type ConsultRoleFolder = (typeof CONSULT_ROLE_FOLDERS)[number];

// 上から順に当てる。 「Sound designer」 はサウンド、 「アートディレクター」 はデザイナーに入る。
const ROLE_PATTERNS: ReadonlyArray<readonly [ConsultRoleFolder, RegExp]> = [
  ["sound", /サウンド|音響|音楽|作曲|コンポーザ|sound|composer|audio/i],
  ["designer", /デザイ|アート|イラスト|グラフィック|ui\b|ux\b|design|art\b|artist/i],
  ["planner", /企画|プランナ|ディレクタ|プロデューサ|planner|director|producer/i],
  ["engineer", /エンジニ|プログラマ|開発|engineer|programmer|developer/i],
];

/** 役職 (自由記述) を役職フォルダに読む。 */
export function consultRoleFolder(roleTitle: string | null | undefined): ConsultRoleFolder {
  if (!roleTitle) return "general";
  return ROLE_PATTERNS.find(([, pattern]) => pattern.test(roleTitle))?.[0] ?? "general";
}
