/**
 * プロジェクトを持たない相談 (子会社の相談窓口) の判定と閉じ込め (spec/feature/tech-consultation.md §6)。
 *
 * 子会社のセッションは関係プロジェクトで起動範囲を閉じる (subsidiary-delegation §3.4)。 相談課は元々
 * プロジェクト外の質問を受ける課なので、 子会社では「担当プロジェクトを持たず、 ユースケースが
 * 読み取り専用」の部署に限ってプロジェクト無しで起動する。 その代わり本社の作業領域を読ませないよう、
 * 空の相談用ディレクトリで起動し、 使えるツールを Web 検索だけに絞る (CC-CONSULT-INV-06/07)。
 *
 * 業務判断だけを持つ純関数。 ディレクトリの作成と起動は呼び出し側 (admin spawn) が行う。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { join } from "node:path";

export interface ProjectlessConsultInput {
  /** 部署の担当プロジェクト。 */
  projects: readonly string[];
  /** 部署のユースケース。 未設定なら null。 */
  useCase: { work_mode: string; archived_at: number | null } | null;
}

/** 担当プロジェクトが無く、 稼働中のユースケースが読み取り専用の部署か。 */
export function isProjectlessConsultDepartment(input: ProjectlessConsultInput): boolean {
  return input.projects.length === 0
    && input.useCase !== null
    && input.useCase.archived_at === null
    && input.useCase.work_mode === "read-only";
}

/**
 * プロジェクト無しの相談セッションに渡す claude の起動引数。
 * - `--tools=`: 組み込みツールを Web 検索と ToDo だけにする (Read / シェル / 編集は存在しない)。
 *   ハーネスのフックは Castra 配下の一部ツールにしか掛からないため、 ここで閉じる。
 * - `--strict-mcp-config`: 利用者設定の MCP (Notion 等) を読み込まない。
 * - `--disable-slash-commands`: 利用者のスキル本文を読み込まない。
 */
export const PROJECTLESS_CONSULT_CLAUDE_ARGS: readonly string[] = Object.freeze([
  "--tools=WebSearch,TodoWrite",
  "--strict-mcp-config",
  "--disable-slash-commands",
]);

/** 相談用ディレクトリ。 子会社ごとに 1 つ。 id は Cc が発行した値だが、 パス区切りは潰しておく。 */
export function projectlessConsultWorkspace(root: string, subsidiaryId: string): string {
  const safe = subsidiaryId.replace(/[^A-Za-z0-9_-]/g, "_");
  return join(root, safe || "_");
}

/** 初回指示の先頭に置く作業範囲の説明 (強制はツール制限が担い、 これは説明)。 */
export function projectlessConsultRestriction(): string {
  return [
    "## 作業範囲の制限 (Concordia 相談窓口)",
    "このセッションはプロジェクトを持たない相談です。質問に回答だけを返します。",
    "- ローカルのファイル・リポジトリ・社内サービスは参照できません。必要なら Web 検索を使ってください。",
    "- 社内固有の事情を推測で書かず、分からないことは分からないと答えてください。",
  ].join("\n");
}
