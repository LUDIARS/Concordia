/** Pure migration of known Cc commands; never edits the live user configuration. */
const EVENTS = {
  SessionStart: ["session-start"],
  UserPromptSubmit: ["prompt"],
  PostToolUse: ["tool-result", "edit"],
  PreCompact: ["compact"],
  PostCompact: ["post-compact"],
};
const FIELDS = {
  SessionStart: ["source"],
  UserPromptSubmit: ["turn_id", "prompt"],
  PostToolUse: ["turn_id", "tool_name", "tool_use_id", "tool_input", "tool_response"],
  PreCompact: ["turn_id", "trigger"],
  PostCompact: ["turn_id", "trigger"],
};
const COMMON = ["session_id", "transcript_path", "cwd", "hook_event_name", "model"];
function normalizePath(value) { return value.replace(/\\/g, "/"); }

function commandEvent(command, scriptPath) {
  if (typeof command !== "string") return null;
  // Exact simple command only: wrappers, extra flags and shell operators need human review.
  const match = /^node\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+))\s+([a-z-]+)\s+--provider=codex-cli\s*$/.exec(command);
  if (!match || normalizePath(match[1] ?? match[2] ?? match[3]) !== normalizePath(scriptPath)) return null;
  return match[4];
}

export function migrateCodexHooks(config, { scriptPath, server = "concordia-hooks" }) {
  if (!config || typeof config !== "object" || Array.isArray(config) ||
      !config.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) {
    throw new Error("Expected a hooks.json object with hooks");
  }
  if (typeof scriptPath !== "string" || !scriptPath) throw new Error("scriptPath is required");
  const result = structuredClone(config);
  const converted = [];
  const retained = [];
  for (const [name, groups] of Object.entries(result.hooks)) {
    if (!Array.isArray(groups)) throw new Error("Expected hook groups for " + name);
    for (const group of groups) {
      if (!Array.isArray(group.hooks)) throw new Error("Expected handlers for " + name);
      group.hooks = group.hooks.map(hook => {
        if (hook.type !== "command") return hook;
        const event = commandEvent(hook.command, scriptPath);
        if (!event) return hook;
        if (!EVENTS[name]?.includes(event)) {
          retained.push({ event: name, reason: "unsupported lifecycle event" });
          return hook;
        }
        for (const key of ["commandWindows", "command_windows"]) {
          if (hook[key] !== undefined && commandEvent(hook[key], scriptPath) !== event) {
            retained.push({ event: name, reason: "different Windows command" });
            return hook;
          }
        }
        if (hook.async === true) {
          retained.push({ event: name, reason: "asynchronous command needs explicit migration" });
          return hook;
        }
        const { command, commandWindows, command_windows, type, async: asyncFlag, ...options } = hook;
        converted.push({ event: name, handler: event });
        const ctx = Object.fromEntries([...COMMON, ...FIELDS[name]].map(field => [field, "$" + "{" + field + "}"]));
        return { ...options, type: "mcp_tool", server, tool: "run_hook", input: { event, ctx } };
      });
    }
  }
  return { config: result, converted, retained };
}

/** Explicitly forward only Cc hook variables to the per-session MCP process. */
export function hookMcpConfig({ projectRoot, nodeCommand = "node" }) {
  if (typeof projectRoot !== "string" || !projectRoot) throw new Error("projectRoot is required");
  const root = normalizePath(projectRoot).replace(/\/$/, "");
  return [
    "[mcp_servers.concordia-hooks]",
    "command = " + JSON.stringify(nodeCommand),
    "args = [" + JSON.stringify(root + "/tools/concordia-hook-mcp.mjs") + "]",
    "cwd = " + JSON.stringify(root),
    'env_vars = ["CONCORDIA_HOOK", "CONCORDIA_SESSION_ID", "CONCORDIA_DISABLE", "CONCORDIA_URL", "CONCORDIA_TIMEOUT_MS", "CLAUDE_SESSION_ID"]',
    "",
  ].join("\n");
}
