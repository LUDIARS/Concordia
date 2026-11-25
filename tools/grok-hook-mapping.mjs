/** Grok CLI の入力を supervisor と観測 runtime が使う Claude 互換形式に変換する。 @implements CC-GROK-HOOK GHK-03 */
const TOOL_NAMES = new Map([
  ["run_terminal_command", "Bash"], ["Shell", "Bash"], ["Bash", "Bash"],
  ["write", "Write"], ["write_file", "Write"], ["Write", "Write"],
  ["search_replace", "Edit"], ["hashline_edit", "Edit"], ["StrReplace", "Edit"],
  ["EditNotebook", "Edit"], ["Edit", "Edit"], ["MultiEdit", "MultiEdit"],
  ["NotebookEdit", "NotebookEdit"],
]);

function firstString(...values) {
  return values.find((value) => typeof value === "string" && value.trim().length > 0);
}

export function isGrokHarnessTool(name) {
  return TOOL_NAMES.has(name);
}

export function toClaudeHookInput(grok) {
  const name = firstString(grok?.toolName, grok?.tool_name);
  const camel = grok?.toolInput;
  const snake = grok?.tool_input;
  const command = firstString(camel?.command, camel?.CommandLine, snake?.command, snake?.CommandLine);
  const pathKeys = ["file_path", "path", "target_notebook", "Path", "TargetFile", "notebook_path"];
  const path = firstString(...[camel, snake].flatMap((input) => pathKeys.map((key) => input?.[key])));
  const toolInput = {
    ...(command === undefined ? {} : { command }),
    ...(path === undefined ? {} : { file_path: path, notebook_path: path }),
  };
  const result = grok?.toolResult ?? grok?.tool_response;
  return {
    hook_event_name: firstString(grok?.hookEventName, grok?.hook_event_name),
    session_id: firstString(grok?.sessionId, grok?.session_id),
    cwd: firstString(grok?.cwd),
    transcript_path: firstString(grok?.transcriptPath, grok?.transcript_path) ?? null,
    prompt: firstString(grok?.prompt),
    tool_name: TOOL_NAMES.get(name) ?? name,
    tool_use_id: firstString(grok?.toolUseId, grok?.tool_use_id),
    tool_input: toolInput,
    tool_response: result,
    error: grok?.error ?? result?.error,
  };
}

export function grokDenyResponse(reason) {
  return JSON.stringify({
    decision: "deny",
    reason: String(reason ?? "").trim() || "Concordia harness denied this tool call.",
  });
}
