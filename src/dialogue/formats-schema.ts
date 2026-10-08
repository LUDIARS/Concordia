/** @implements SPEC-DLG-FORMATS: format schema independent of preset values. */
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
