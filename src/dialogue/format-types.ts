/**
 * ユースケースのフォーマットの型とキー一覧。
 *
 * フォーマット一覧 (`formats.ts`) と個別フォーマット (`planning-adjustment.ts`) が共有する。 型を
 * `formats.ts` に置くと、 一覧を組む `formats.ts` と個別フォーマットが互いを import する循環になるので
 * ここへ分ける。 公開名は `formats.ts` からも再エクスポートする。
 *
 * @implements spec/feature/dialogue-context.md §2
 */

export type UseCaseWorkMode = "edit" | "read-only";

export interface UseCaseFormat {
  key: UseCaseFormatKey;
  name: string;
  workMode: UseCaseWorkMode;
  useRequesterProfile: boolean;
  /** 回答前に事前ヒアリング (知りたいこと・技術レベル・役職・目的) を揃えるか (tech-consultation.md §3)。 */
  intake: boolean;
  summary: string;
  preData: string;
}

export const USE_CASE_FORMAT_KEYS = ["chores", "qa", "sparring", "research-report", "planning-adjustment"] as const;
export type UseCaseFormatKey = typeof USE_CASE_FORMAT_KEYS[number];
