/**
 * プロジェクトを持たない相談 (子会社の相談窓口) の判定と閉じ込め (spec/feature/tech-consultation.md §6)。
 *
 * 相談課は元々プロジェクト外の質問を受ける課。 「担当プロジェクトを持たず、 ユースケースが読み取り専用」の
 * 部署は、 プロジェクトではなく Concordia 配下の相談用ディレクトリ (会社ごと) で起動する (2026-10-02 neco 指示)。
 * 子会社のセッションは関係プロジェクトで起動範囲を閉じる (subsidiary-delegation §3.4) ので、 子会社では
 * さらに使えるツールを Web 検索だけに絞る (CC-CONSULT-INV-06/07)。
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

/** 本社の相談用ディレクトリ名。 子会社 id (uuid) とは重ならない。 */
export const HEAD_OFFICE_CONSULT_WORKSPACE = "head-office";

/**
 * 相談用ディレクトリ。 会社ごとに 1 つ (本社は `head-office`)。 子会社 id は Cc が発行した値だが、
 * パス区切りは潰しておく。
 */
export function projectlessConsultWorkspace(root: string, subsidiaryId: string | null): string {
  if (subsidiaryId === null) return join(root, HEAD_OFFICE_CONSULT_WORKSPACE);
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

/**
 * 相談用ディレクトリに置く Claude Code のローカル設定 (`.claude/settings.local.json`)。
 *
 * 相談用ディレクトリは Concordia 配下にあるため、 そのままでは上位の CLAUDE.md (Castra の略称表など) と
 * Concordia の自動メモリが相談セッションに読み込まれ、 回答へ社内のプロジェクト名が漏れた (2026-10-02)。
 * 指示ファイルはすべて読まず、 自動メモリも使わない (CC-CONSULT-INV-08)。
 */
export function consultWorkspaceClaudeSettings(): Record<string, unknown> {
  return {
    claudeMdExcludes: ["**/CLAUDE.md", "**/CLAUDE.local.md", "**/AGENTS.md", "**/.claude/rules/**"],
    autoMemoryEnabled: false,
  };
}

/** 相談セッションの起動 env。 自動メモリを読まない (設定ファイルと二重に止める)。 */
export const CONSULT_SESSION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});
