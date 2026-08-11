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

import { isMainPushAllowlisted, MAIN_PUSH_ALLOWLIST_ENV } from "./main-push-allowlist.js";

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
  /**
   * このセッションが宣言した作業対象プロジェクト / リポ (スコープ基準)。 gate ハンドラが
   * session の `target_project` (明示) → 無ければ登録時 `repo_path` (暗黙) の順で解決して渡す。
   * これと現在編集中のリポが食い違うとき {@link outsideScope} が警告する。 未解決なら省略。
   */
  targetProject?: string;
  /** cwd が linked worktree と解決できた場合 true。未解決なら省略。 */
  isWorktree?: boolean;
  /** session 登録情報由来の provider/model 識別子。未解決なら省略。 */
  sessionModel?: string;
  /** 人間承認により当該 session の強推論モデル実装ゲートを解除済み。 */
  implUnlocked?: boolean;
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

/** パス / プロジェクト名の末尾要素 (リポ leaf) を小文字で返す。 `/` `\` 両対応。
 *  undefined 許容 (outsideScope が未宣言 targetProject を渡す) — #299 由来の呼び出し
 *  (data-sufficiency 等、 string 渡し) とも互換。 */
export function repoLeaf(pathOrName?: string): string {
  if (!pathOrName) return "";
  const trimmed = pathOrName.trim().replace(/[/\\]+$/, "");
  const slash = trimmed.lastIndexOf("/");
  const back = trimmed.lastIndexOf("\\");
  return trimmed.slice(Math.max(slash, back) + 1).toLowerCase();
}

/** main/master を直接更新する Git push か。blackbox 特徴量もこの判定を共有する。 */
export function commandPushesMain(command: string | undefined, branch: string | undefined): boolean {
  if (!command || !/\bgit\b[\s\S]*\bpush\b/i.test(command)) return false;
  const targetsMain =
    /\borigin\s+(?:\S+\s+)?(?:main|master|refs\/heads\/(?:main|master))\b/i.test(command) ||
    /\bHEAD:(?:refs\/heads\/)?(?:main|master)\b/i.test(command) ||
    /:(?:refs\/heads\/)?(?:main|master)\b/i.test(command) ||
    /\bpush\b[\s\S]*--(?:all|mirror)\b/i.test(command);
  const explicitOtherRef = /\borigin\s+\S+/i.test(command) && !targetsMain;
  return targetsMain || (!explicitOtherRef && isMainBranch(branch));
}

/**
 * main 直 push 禁止 (deny)。 変更はブランチ → PR 経由。
 * - `origin main` / `HEAD:refs/heads/main` 等を明示、または `--all` / `--mirror` を使う
 * - または ref 省略で現在ブランチが main/master (= main を push する)
 *
 * 許可リスト (MELPOT 等、 main 直 push してよいリポ) に該当する場合は deny せず、
 * 追跡用の warn (`main-push-allowlisted`) に落とす — 黙って素通しにしない。
 */
export function makeNoMainPushPredicate(allowlist: readonly string[] = []): Predicate {
  return function noMainPush(a) {
    if (a.tool !== "Bash" || !a.command) return null;
    if (!commandPushesMain(a.command, a.branch)) return null;
    if (isMainPushAllowlisted(a, allowlist)) {
      return {
        rule: "main-push-allowlisted",
        decision: "warn",
        reason: "許可リスト対象リポのため main 直 push を許可しました。",
        suggestion: `許可リストは ${MAIN_PUSH_ALLOWLIST_ENV} (Cc 設定 harness.main_push_allowlist) で管理します。`,
      };
    }
    return {
      rule: "no-main-push",
      decision: "deny",
      reason: "main ブランチへ直接 push しようとしています (main 直 push 禁止)。",
      suggestion: `feat/... 等のブランチを切り、 PR 経由でマージしてください (許可リスト: ${MAIN_PUSH_ALLOWLIST_ENV})。`,
    };
  };
}

/** 許可リスト無し (= 全リポで main 直 push 禁止) の既定述語。 */
export const noMainPush: Predicate = makeNoMainPushPredicate();

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

/**
 * スコープ外プロジェクトでの編集 (warn)。 セッションが宣言した作業対象
 * ({@link HarnessAction.targetProject} = target_project 明示 or 登録 repo_path 暗黙) と、
 * 今まさに編集しようとしているリポの leaf が食い違うとき警告する。
 *
 * 「Lictor の作業のはずが別リポを触り始めた」 を着手時点で検知して、 意図しない
 * スコープ逸脱 (別プロジェクトのブランチ作業の混入) を止める。 ハード deny にすると
 * 正当な横断作業まで止めるため warn に留める (Cc への通知は gate ハンドラが担う)。
 *
 * targetProject / 編集リポが解決できないときは強制しない (「分からないのに違反にしない」)。
 * targetProject は Anatomia プロジェクト名 or リポパスのどちらでも leaf 比較で吸収する。
 */
export const outsideScope: Predicate = (a) => {
  if (!isEditTool(a.tool)) return null;
  const target = repoLeaf(a.targetProject);
  if (!target) return null; // スコープ未宣言 → 強制しない
  const current = repoLeaf(a.cwd ?? a.filePath);
  if (!current) return null; // 現在リポ不明 → 強制しない
  if (current === target) return null;
  return {
    rule: "outside-scope",
    decision: "warn",
    reason: `作業対象 (${a.targetProject}) 外のリポで編集しています (${current}${a.branch ? ` @ ${a.branch}` : ""})。`,
    suggestion: "別プロジェクトの作業なら別セッションで行うか、 対象プロジェクトを切り替えてください。",
  };
};

/** 既定の述語セット (登録順)。 */
import { noOpTestInWorktree, noServiceStartInSession } from "./test-isolation.js";

export const DEFAULT_PREDICATES: Predicate[] = [
  noMainPush,
  noServiceStartInSession,
  noOpTestInWorktree,
  branchBeforeEdit,
  maxReposWarn,
  outsideScope,
];

/**
 * 述語セットの `noMainPush` を許可リスト付きのものへ差し替えた複製を返す。
 * 許可リストが空なら既定セットのまま (= 従来どおり全リポで deny)。
 */
export function withMainPushAllowlist(
  allowlist: readonly string[],
  predicates: readonly Predicate[] = DEFAULT_PREDICATES,
): Predicate[] {
  if (allowlist.length === 0) return [...predicates];
  const allowlisted = makeNoMainPushPredicate(allowlist);
  return predicates.map((p) => (p === noMainPush ? allowlisted : p));
}
