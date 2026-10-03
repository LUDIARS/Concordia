/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-2: the consult CODEX_HOME hooks.json routes PreToolUse (harness gate) and SessionStart (transcript report)
 * to the given hook script as command hooks only — no mcp_tool hook, since the consult turns MCP off.
 */
type Hook = { type?: unknown; command?: unknown };
type Group = { hooks?: Hook[] };

export default {
  post(result: unknown, hookScript?: unknown): boolean {
    if (typeof hookScript !== "string" || !result || typeof result !== "object") return false;
    const hooks = (result as { hooks?: Record<string, Group[]> }).hooks;
    if (!hooks) return false;
    const commands = (event: string): Hook[] => (hooks[event] ?? []).flatMap((group) => group.hooks ?? []);
    const routes = (event: string, arg: string) => {
      const list = commands(event);
      return list.length > 0 && list.every((hook) => hook.type === "command"
        && typeof hook.command === "string" && hook.command.includes(hookScript) && hook.command.includes(arg));
    };
    const noMcp = Object.values(hooks).every((groups) =>
      groups.every((group) => (group.hooks ?? []).every((hook) => hook.type === "command")));
    return routes("PreToolUse", "pre-tool") && routes("SessionStart", "session-start") && noMcp;
  },
};
