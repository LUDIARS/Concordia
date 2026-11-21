/**
 * Antigravity CLI (agy) の hook 入力を、 Concordia のハーネスが読む Claude Code の hook 形式へ写す
 * (spec/feature/agy-harness-hook.md)。 純関数のみ。
 *
 * agy 1.5.13 の実機で確かめた形:
 *   入力  { hookEventName, conversationId, cwd, lastUserInput, transcriptPath,
 *           toolCall: { id, name, args }, error? (PostToolUse) }
 *   PreToolUse の応答  何も出さない = そのまま進める / { decision: "deny", reason } = 止める
 *                      (`{}` や未知の decision は agy が拒否・エラーにするので出さない)
 */

/** agy のツール名 → ハーネスの規則が見る Claude Code のツール名。 ここに無いツールはゲートを通さない。 */
const TOOL_NAMES = new Map([
  ["run_command", "Bash"],
  ["write_to_file", "Write"],
  ["write_file", "Write"],
  ["create_file", "Write"],
  ["replace_file_content", "Edit"],
  ["edit_file", "Edit"],
  ["apply_patch", "Edit"],
  ["delete_file", "Edit"],
  ["multi_replace_file_content", "MultiEdit"],
  ["notebook_edit", "NotebookEdit"],
]);

const PATH_KEYS = ["Path", "TargetFile", "AbsolutePath", "FilePath", "File", "file_path", "path"];
const COMMAND_KEYS = ["CommandLine", "Command", "command"];

function firstString(args, keys) {
  for (const key of keys) {
    const value = args?.[key];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/** ハーネスの規則の対象になる agy のツールか。 */
export function isGatedAgyTool(name) {
  return TOOL_NAMES.has(name);
}

/**
 * agy の hook 入力を Claude Code の hook 形式にする。 ツール呼び出しでない入力は tool_name 無しで返す。
 * 対応の無いツールは agy の名前のまま渡す (観測には残し、 ゲートの規則には掛からない)。
 */
export function toClaudeHookInput(agy) {
  const call = agy?.toolCall;
  const args = call?.args && typeof call.args === "object" ? call.args : {};
  const toolName = typeof call?.name === "string" ? TOOL_NAMES.get(call.name) ?? call.name : undefined;
  const command = firstString(args, COMMAND_KEYS);
  const filePath = firstString(args, PATH_KEYS);
  return {
    session_id: typeof agy?.conversationId === "string" ? agy.conversationId : undefined,
    cwd: typeof agy?.cwd === "string" ? agy.cwd : undefined,
    transcript_path: typeof agy?.transcriptPath === "string" ? agy.transcriptPath : null,
    hook_event_name: agy?.hookEventName,
    ...(typeof agy?.lastUserInput === "string" ? { prompt: agy.lastUserInput } : {}),
    ...(toolName ? {
      tool_name: toolName,
      tool_use_id: typeof call.id === "string" ? call.id : undefined,
      tool_input: {
        ...(command === undefined ? {} : { command }),
        ...(filePath === undefined ? {} : { file_path: filePath }),
      },
      ...(agy.hookEventName === "PostToolUse"
        ? { tool_response: { error: typeof agy.error === "string" ? agy.error : "" } }
        : {}),
    } : {}),
  };
}

/** PostToolUse の入力が失敗を表すか。 */
export function isAgyToolFailure(agy) {
  return typeof agy?.error === "string" && agy.error.length > 0;
}

/** PreToolUse を止める応答。 理由は agy がモデルと人に見せる。 */
export function agyDenyResponse(reason) {
  const text = String(reason ?? "").trim() || "Concordia harness denied this tool call.";
  return JSON.stringify({ decision: "deny", reason: text });
}
