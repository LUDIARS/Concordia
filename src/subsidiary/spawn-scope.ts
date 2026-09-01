/**
 * 子会社 guild から直接起動する `/spawn` の対象が担当プロジェクト内かを判定する純粋ロジック。
 *
 * 受付チャンネル (gate.ts) と Session forum (forum-spawn.ts) は既に関係プロジェクトで
 * 縛られている。 `/spawn` を子会社に開放する (2026-09-01 neco 指示 1) と、 コマンド引数
 * (`project` / `cwd` / `template`) から任意のリポジトリへ起動できる口が新たに開くため、
 * ここで同じ集合に閉じ込める。
 *
 * @implements spec/feature/subsidiary-delegation.md §3.4
 */

import { isProjectNameInScope } from "./project-scope.js";

export type SubsidiarySpawnScopeDenial =
  /** 関係プロジェクトが 1 件も設定されていない窓口 (未設定を全許可にしない)。 */
  | "no_projects"
  /** `project` 未指定 — 何を起こすのか照合できない。 */
  | "project_missing"
  /** 生パス指定は関係プロジェクト集合と突き合わせられない。 */
  | "cwd_not_allowed"
  /** 指定 project が担当範囲外。 */
  | "out_of_scope";

export type SubsidiarySpawnScopeResult =
  | { ok: true; project: string }
  | { ok: false; denial: SubsidiarySpawnScopeDenial };

export interface SubsidiarySpawnTarget {
  project?: string | null;
  cwd?: string | null;
  projects: readonly string[];
}

/**
 * 子会社の `/spawn` 指定を関係プロジェクトへ閉じる。 すべて fail-closed:
 * 未設定 / 未指定 / 生 cwd / 範囲外 はいずれも起動させない。
 */
export function checkSubsidiarySpawnTarget(input: SubsidiarySpawnTarget): SubsidiarySpawnScopeResult {
  if (input.projects.length === 0) return { ok: false, denial: "no_projects" };
  // cwd は workspace root 外の任意パスを指せるため、 project 名では照合できない。
  // 子会社からは受け付けず、 project 指定に一本化する。
  if (input.cwd?.trim()) return { ok: false, denial: "cwd_not_allowed" };
  const project = input.project?.trim() ?? "";
  if (!project) return { ok: false, denial: "project_missing" };
  if (!isProjectNameInScope(project, input.projects)) return { ok: false, denial: "out_of_scope" };
  return { ok: true, project };
}

/**
 * 出張先へ返す文面。 対象 project 名も許可集合も出さない (spec §3.4: deny 文面は
 * 内部構成を列挙しない)。 詳細は Cc 側のログ / 監査にだけ残す。
 */
export function subsidiarySpawnDenialMessage(denial: SubsidiarySpawnScopeDenial): string {
  switch (denial) {
    case "no_projects":
      return "この窓口には担当プロジェクトが設定されていないため、セッションを起動できません。";
    case "project_missing":
      return "この窓口では `project` の指定が必須です。担当プロジェクト名を指定してください。";
    case "cwd_not_allowed":
      return "この窓口では `cwd` の直接指定はできません。`project` で担当プロジェクトを指定してください。";
    case "out_of_scope":
      return "この窓口の担当範囲外のため起動しません。";
  }
}
