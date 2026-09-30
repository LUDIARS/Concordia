/**
 * 読み取り専用ユースケースの部署のセッションで、 ファイル編集と git の書き込みを拒否する
 * 決定的述語 (CC-DLG-INV-03)。
 *
 * 対象かどうかはセッションの申告ではなく、 Cc が保持する「セッションの部署 →
 * ユースケースの作業モード」で決める (sessionContext が解決して渡す)。 読み取り・調査・
 * 回答は妨げないため、 シェルは git の状態を変えるサブコマンドだけを止める。
 *
 * @implements spec/feature/dialogue-context.md §3
 * @implements SPEC-DLG-USE-CASES
 */

interface UseCaseReadOnlyAction {
  tool: string;
  command?: string;
  useCaseReadOnly?: boolean;
}

interface UseCaseReadOnlyHit {
  rule: string;
  decision: "deny";
  reason: string;
  suggestion: string;
}

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

/** 作業ツリー・履歴・リモートを変える git サブコマンド。 */
const GIT_WRITE_SUBCOMMANDS = new Set([
  "add", "am", "apply", "branch", "checkout", "cherry-pick", "clean", "commit", "merge", "mv",
  "pull", "push", "rebase", "reset", "restore", "revert", "rm", "stash", "switch", "tag", "worktree",
]);

/** git の読み取りでも branch 一覧のような参照は許す (branch は -d/-D/-m 等の書き込みだけ止める)。 */
const GIT_BRANCH_WRITE_FLAGS = /(^|\s)-(d|D|m|M|c|C|f)(\s|$)|--(delete|move|copy|force|set-upstream-to)/;

const SUGGESTION = "この部署のユースケースは読み取り専用です。回答・調査だけを行い、変更が必要なら依頼者に伝えてください。";

export function useCaseReadOnly(action: UseCaseReadOnlyAction): UseCaseReadOnlyHit | null {
  if (action.useCaseReadOnly !== true) return null;
  if (EDIT_TOOLS.has(action.tool)) {
    return {
      rule: "use-case-read-only",
      decision: "deny",
      reason: "読み取り専用のユースケースの部署では、ファイルを編集できません。",
      suggestion: SUGGESTION,
    };
  }
  if (action.tool !== "Bash" || !action.command) return null;
  const subcommand = gitWriteSubcommand(action.command);
  if (!subcommand) return null;
  return {
    rule: "use-case-read-only",
    decision: "deny",
    reason: `読み取り専用のユースケースの部署では git ${subcommand} を実行できません。`,
    suggestion: SUGGESTION,
  };
}

/** コマンド列 (&&, ;, | で連結) のどこかに git の書き込みがあれば、 そのサブコマンド名を返す。 */
export function gitWriteSubcommand(command: string): string | null {
  for (const segment of command.split(/&&|\|\||;|\|/)) {
    const tokens = segment.trim().split(/\s+/);
    const gitIndex = tokens.findIndex((token) => /(^|[\\/])git(\.exe)?$/.test(token));
    if (gitIndex < 0) continue;
    // `git -C <dir> commit` のようなグローバル option を飛ばしてサブコマンドを取る。
    let index = gitIndex + 1;
    while (index < tokens.length && tokens[index]!.startsWith("-")) {
      index += tokens[index] === "-C" || tokens[index] === "-c" ? 2 : 1;
    }
    const subcommand = tokens[index];
    if (!subcommand || !GIT_WRITE_SUBCOMMANDS.has(subcommand)) continue;
    if (subcommand === "branch" && !GIT_BRANCH_WRITE_FLAGS.test(tokens.slice(index + 1).join(" "))) continue;
    if (subcommand === "stash" && tokens[index + 1] === "list") continue;
    if (subcommand === "worktree" && tokens[index + 1] === "list") continue;
    if (subcommand === "tag" && (tokens.length === index + 1 || tokens[index + 1] === "-l" || tokens[index + 1] === "--list")) continue;
    return subcommand;
  }
  return null;
}
