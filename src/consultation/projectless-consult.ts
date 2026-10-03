/**
 * プロジェクトを持たない相談 (子会社の相談窓口) の判定と閉じ込め (spec/feature/tech-consultation.md §6)。
 *
 * 相談課は元々プロジェクト外の質問を受ける課。 「担当プロジェクトを持たず、 ユースケースが読み取り専用」の
 * 部署は、 プロジェクトではなく相談用の作業ディレクトリ (役職ごと、 既定 E:/Document/Consult/<役職>) で起動する
 * (2026-10-02 neco 指示)。
 * 子会社のセッションは関係プロジェクトで起動範囲を閉じる (subsidiary-delegation §3.4) ので、 子会社では
 * さらに使えるツールを Web 検索だけに絞る (CC-CONSULT-INV-06/07)。
 *
 * 業務判断だけを持つ純関数。 ディレクトリの作成と起動は呼び出し側 (admin spawn) が行う。
 *
 * @implements SPEC-CONSULT-PROJECTLESS
 */

import { dirname, join } from "node:path";
import { consultClaudePermissions } from "./consult-fetch-link.js";
import { consultRoleFolder } from "./consult-role.js";

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
 * プロジェクト無しの相談セッションに渡す claude の起動引数 (本社・子会社とも。 2026-10-02 neco 指示「本社の相談も同じで」)。
 * - `--tools=`: 組み込みツールを Web 検索・ToDo・スキル・シェルだけにする (Read / 編集は存在しない)。
 *   シェルは公開リンクの取得コマンド 1 本だけを役職フォルダの permissions で許し、 ほかは聞かずに拒否する
 *   (consult-fetch-link.ts、 2026-10-03 neco 指示「相談時にもらった Notion / Google Drive を取得できるように」)。
 *   ハーネスのフックは Castra 配下の一部ツールにしか掛からないため、 ここで閉じる。
 * - `--strict-mcp-config`: 利用者設定の MCP (Notion 等) を読み込まない。
 * スキルは役職フォルダのもの (Codex と共有の `<役職>/.agents/skills`) を使う。 利用者のスキル (~/.claude) は
 * 相談専用の設定フォルダ (CLAUDE_CONFIG_DIR) で外す (consultClaudeConfigDir)。
 */
export const PROJECTLESS_CONSULT_CLAUDE_ARGS: readonly string[] = Object.freeze([
  "--tools=WebSearch,TodoWrite,Skill,Bash",
  "--strict-mcp-config",
]);

/**
 * 相談専用の Claude 設定フォルダ (`<root>/.claude-config`)。 `CLAUDE_CONFIG_DIR` で渡し、 利用者の
 * ~/.claude (Castra のワークフローを含むスキル・CLAUDE.md・設定) を読ませない。 ログイン情報もここに持つ
 * (初回は人が `CLAUDE_CONFIG_DIR=<このフォルダ> claude` でログインする)。
 */
export function consultClaudeConfigDir(root: string): string {
  return join(root, ".claude-config");
}

/**
 * Astra (codex) の相談専用の CODEX_HOME (`<root>/.codex-home`)。 利用者の ~/.codex (AGENTS.md・スキル・フック・MCP) を
 * 読ませない。 ログイン情報 (auth.json) もここに持つ (初回は人が `CODEX_HOME=<このフォルダ> codex login` でログインする)。
 * hooks.json と config.toml は Cc が起動ごとに書く (consult-codex-home.ts)。
 */
export function consultCodexHome(root: string): string {
  return join(root, ".codex-home");
}

/** claude.json の projects のキー (前方スラッシュ。 Lictor の normalizeProjectKey と同じ流儀)。 */
function claudeProjectKey(cwd: string): string {
  return cwd.replace(/\\/g, "/").replace(/\/$/, "");
}

/**
 * 相談専用の設定フォルダの claude.json に、 役職フォルダの信頼 (trust picker を出さない) を書き足す。
 * Lictor の事前焼き込みは ~/.claude.json にしか書かないため、 ここで書く。 変更が無ければ null。
 */
export function withConsultWorkspaceTrust(claudeJson: unknown, roleWorkspace: string): Record<string, unknown> | null {
  if (!claudeJson || typeof claudeJson !== "object" || Array.isArray(claudeJson)) return null;
  const root = claudeJson as Record<string, unknown>;
  const projects = (root.projects && typeof root.projects === "object" && !Array.isArray(root.projects)
    ? root.projects : {}) as Record<string, Record<string, unknown>>;
  const key = claudeProjectKey(roleWorkspace);
  if (projects[key]?.hasTrustDialogAccepted === true) return null;
  return { ...root, projects: { ...projects, [key]: { ...(projects[key] ?? {}), hasTrustDialogAccepted: true } } };
}

/**
 * 相談の作業ディレクトリ。 役職ごとに 1 つ (`<root>/<役職フォルダ>`)。 役職フォルダごとにスキルとメモリを
 * 使い分ける (2026-10-02 neco 指示)。 本社・子会社で分けない。
 */
export function consultRoleWorkspace(root: string, roleTitle: string | null | undefined): string {
  return join(root, consultRoleFolder(roleTitle));
}

/**
 * 相談者のデータの置き場所 (`<役職フォルダ>/<Discord の個人 ID>`)。 Discord 以外からの起動 (ID が無い) は null。
 * ID は数字だけを受ける (パスを作るため)。
 */
export function consultPersonalDataDir(roleWorkspace: string, discordUserId: string | null | undefined): string | null {
  const id = discordUserId?.trim() ?? "";
  return /^\d{5,32}$/.test(id) ? join(roleWorkspace, id) : null;
}

/** 初回指示の先頭に置く作業範囲の説明 (強制はツール制限が担い、 これは説明)。 */
export function projectlessConsultRestriction(): string {
  return [
    "## 作業範囲の制限 (Concordia 相談窓口)",
    "このセッションはプロジェクトを持たない相談です。質問に回答だけを返します。",
    "- ローカルのファイル・リポジトリ・社内サービスは参照できません。必要なら Web 検索を使ってください。",
    "- 相談者が送った公開の Notion / Google Drive のリンクは consult-fetch-link スキルの取得コマンドで読めます。ほかのコマンドは実行できません。",
    "- 社内固有の事情を推測で書かず、分からないことは分からないと答えてください。",
  ].join("\n");
}

const INSTRUCTION_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude/rules/**"] as const;

/**
 * 役職フォルダに置く Claude Code のローカル設定 (`.claude/settings.local.json`)。
 *
 * 2026-10-02、 相談用ディレクトリを Concordia 配下に置いたところ、 上位の CLAUDE.md (Castra の略称表など) と
 * 自動メモリが相談セッションに読み込まれ、 回答へ社内のプロジェクト名が漏れた。 Castra のメモリと
 * ワークフローは引き継がない (CC-CONSULT-INV-08)。 役職フォルダ自身の CLAUDE.md とスキルは使い分けのために
 * 読ませ、 上位のフォルダと、 相談者ごとのデータフォルダの中の指示ファイルは読ませない。
 * 自動メモリは使わない (相談で使う環境のメモリは別途指定する)。
 * ツールの許可は Web 検索・ToDo・スキルと公開リンクの取得コマンドだけ。 ほかは聞かずに拒否する (consultClaudePermissions)。
 */
export function consultWorkspaceClaudeSettings(roleWorkspace: string): Record<string, unknown> {
  // 役職フォルダ自身の AGENTS.md は外さない (Claude Code は CLAUDE.md が無ければ AGENTS.md を指示として読む)。
  const ancestors: string[] = [];
  for (let dir = dirname(roleWorkspace); ; dir = dirname(dir)) {
    ancestors.push(dir);
    if (dirname(dir) === dir) break;
  }
  const slash = (path: string) => path.replace(/\\/g, "/").replace(/\/$/, "");
  return {
    claudeMdExcludes: [
      ...ancestors.flatMap((dir) => INSTRUCTION_FILES.map((file) => `${slash(dir)}/${file}`)),
      ...INSTRUCTION_FILES.map((file) => `${slash(roleWorkspace)}/*/**/${file}`),
    ],
    autoMemoryEnabled: false,
    permissions: consultClaudePermissions(dirname(roleWorkspace)),
  };
}

/**
 * そのパスが相談用ディレクトリの中か (役職フォルダ・相談者のデータフォルダ)。 相談セッションの判定に使う
 * (ブランチ切替の案内を出さない。 2026-10-03 neco 指示「相談窓口へのブランチ切り替えは通知しないで」)。
 */
export function isInConsultWorkspace(path: string | null | undefined, root: string | null | undefined): boolean {
  if (!path || !root) return false;
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = norm(path);
  const base = norm(root);
  return target === base || target.startsWith(`${base}/`);
}

/** 相談セッションの起動 env (共通部分)。 自動メモリを読まない (設定ファイルと二重に止める)。 */
export const CONSULT_SESSION_ENV: Readonly<Record<string, string>> = Object.freeze({
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
});
