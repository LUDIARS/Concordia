/**
 * ローカルセッションのハーネス強制 — 決定的述語 (LLM 不使用)。
 *
 * 子会社ガードは外部依頼が稀なので毎回 Sonnet で判定するが、 ローカルセッションは
 * 編集/コマンドのたびに走るため Sonnet (60s) は使えない。 ここは機械化可能な A 層ルールを
 * **決定的な述語**として実装する (Anatomia verify と同じ思想)。 自然文ポリシー (harness_rules,
 * Sonnet guard 用) とは別レイヤ。
 *
 * 各述語は action を受け、 違反なら PredicateHit、 非該当なら null を返す純関数。
 * applicability が判定できない (branch 不明など) ときは null = 強制しない。 「分からないのに
 * 違反扱いしない」 — 偽陽性で作業を止める方が害が大きいため。 ただし判定できる場面では
 * fail-closed (deny) で確実に止める。
 */

export type Decision = "allow" | "deny" | "warn";

export interface HarnessAction {
  /** 試行ツール (Edit | Write | MultiEdit | NotebookEdit | Bash | ...)。 */
  tool: string;
  /** Bash のコマンドライン (tool=Bash のとき)。 */
  command?: string;
  /** 編集対象ファイルの絶対パス (編集系ツールのとき)。 */
  filePath?: string;
  /** 操作の作業ディレクトリ / リポジトリルート。 */
  cwd?: string;
  /** Anatomia/Concordia プロジェクト名 (任意)。 */
  project?: string;
  /** 対象リポの現在ブランチ (hook が git で解決して渡す。 不明なら省略)。 */
  branch?: string;
  /** 当該セッションでこれまでに編集したリポ root の集合 (5 リポ警告用)。 */
  editedRepos?: string[];
}

export interface PredicateHit {
  /** 述語キー (監査ログの rule 列に入る)。 */
  rule: string;
  decision: Exclude<Decision, "allow">;
  reason: string;
  /** 解消のための助言 (任意)。 */
  suggestion?: string;
}

export type Predicate = (a: HarnessAction) => PredicateHit | null;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const MAIN_BRANCHES = new Set(["main", "master"]);

export function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool);
}
function isMainBranch(branch?: string): boolean {
  return !!branch && MAIN_BRANCHES.has(branch.trim());
}

/**
 * main 直 push 禁止 (deny)。 変更はブランチ → PR 経由。
 * - `origin main` / `origin master` / `HEAD:main` を明示している
 * - または ref 省略で現在ブランチが main/master (= main を push する)
 */
export const noMainPush: Predicate = (a) => {
  if (a.tool !== "Bash" || !a.command) return null;
  const cmd = a.command;
  if (!/\bgit\b[\s\S]*\bpush\b/.test(cmd)) return null;
  const targetsMain = /\borigin\s+(?:\S+\s+)?(?:main|master)\b/.test(cmd) || /\bHEAD:(?:main|master)\b/.test(cmd) || /:(?:main|master)\b/.test(cmd);
  // ref を明示せず現在ブランチが main/master → main を push する。 他ブランチを明示している場合は対象外。
  const explicitOtherRef = /\borigin\s+\S+/.test(cmd) && !targetsMain;
  const pushesCurrentMain = !explicitOtherRef && isMainBranch(a.branch);
  if (targetsMain || pushesCurrentMain) {
    return {
      rule: "no-main-push",
      decision: "deny",
      reason: "main ブランチへ直接 push しようとしています (main 直 push 禁止)。",
      suggestion: "feat/... 等のブランチを切り、 PR 経由でマージしてください。",
    };
  }
  return null;
};

/**
 * 編集前ブランチ (warn)。 main/master 上でコードを編集している。 ハード deny にすると
 * 一時的な編集まで止めてしまうため警告に留め、 commit/push 前のブランチ切りを促す。
 * branch が解決できない場合は強制しない。
 */
export const branchBeforeEdit: Predicate = (a) => {
  if (!isEditTool(a.tool)) return null;
  if (!isMainBranch(a.branch)) return null;
  return {
    rule: "branch-before-edit",
    decision: "warn",
    reason: `main ブランチ上で編集しています (${a.filePath ?? "ファイル不明"})。`,
    suggestion: "commit/push の前にブランチを切ってください (例: git switch -c feat/...)。",
  };
};

export const MAX_REPOS = 5;

/**
 * 多リポ同時編集の警告 (warn)。 1 セッションで上限を超えるリポを触っている。
 */
export const maxReposWarn: Predicate = (a) => {
  if (!a.editedRepos || a.editedRepos.length === 0) return null;
  const distinct = new Set(a.editedRepos.map((r) => r.trim()).filter(Boolean));
  if (distinct.size > MAX_REPOS) {
    return {
      rule: "max-repos",
      decision: "warn",
      reason: `このセッションで ${distinct.size} リポジトリを編集中です (上限 ${MAX_REPOS})。`,
      suggestion: "影響範囲が広すぎないか、 作業を分割すべきでないか確認してください。",
    };
  }
  return null;
};

/** 既定の述語セット (登録順)。 */
export const DEFAULT_PREDICATES: Predicate[] = [noMainPush, branchBeforeEdit, maxReposWarn];
