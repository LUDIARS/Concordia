import test from "node:test";
import assert from "node:assert/strict";
import { migrateCodexHooks, hookMcpConfig } from "./concordia-hook-migration.mjs";
const scriptPath = "E:/Document/Ars/Concordia/tools/concordia-hook.mjs";
const command = event => 'node "' + scriptPath + '" ' + event + " --provider=codex-cli";
const handler = event => ({ type: "command", command: command(event), timeout: 30, statusMessage: "Cc" });

test("migration preserves foreign hooks, group matchers and handler limits", () => {
  const foreign = { type: "command", command: "node memoria.mjs" };
  const config = { description: "user hooks", hooks: {
    PostToolUse: [{ matcher: ".*", hooks: [handler("tool-result"), foreign] }],
    SessionEnd: [{ hooks: [handler("session-end")] }],
  } };
  const snapshot = structuredClone(config);
  const result = migrateCodexHooks(config, { scriptPath });
  assert.deepEqual(config, snapshot);
  const group = result.config.hooks.PostToolUse[0];
  assert.equal(group.matcher, ".*");
  assert.deepEqual(group.hooks[1], foreign);
  assert.equal(group.hooks[0].timeout, 30);
  assert.equal(group.hooks[0].statusMessage, "Cc");
  assert.equal(group.hooks[0].type, "mcp_tool");
  assert.equal(group.hooks[0].command, undefined);
  assert.deepEqual(result.config.hooks.SessionEnd, config.hooks.SessionEnd);
  assert.deepEqual(result.retained, [{ event: "SessionEnd", reason: "unsupported lifecycle event" }]);
});
test("context templates preserve structured inputs and responses", () => {
  const config = { hooks: { PostToolUse: [{ hooks: [handler("tool-result")] }] } };
  const result = migrateCodexHooks(config, { scriptPath });
  const input = result.config.hooks.PostToolUse[0].hooks[0].input;
  assert.equal(input.event, "tool-result");
  const placeholder = field => "$" + "{" + field + "}";
  for (const field of ["tool_input", "tool_response", "session_id", "tool_use_id"])
    assert.equal(input.ctx[field], placeholder(field));
});
test("all supported lifecycle events migrate and a second pass makes no changes", () => {
  const config = { hooks: Object.fromEntries([
    ["SessionStart", "session-start"], ["UserPromptSubmit", "prompt"],
    ["PostToolUse", "edit"], ["PreCompact", "compact"], ["PostCompact", "post-compact"],
  ].map(([name, event]) => [name, [{ hooks: [handler(event)] }]])) };
  const first = migrateCodexHooks(config, { scriptPath });
  assert.equal(first.converted.length, 5);
  const second = migrateCodexHooks(first.config, { scriptPath });
  assert.deepEqual(second.config, first.config);
  assert.equal(second.converted.length, 0);
});
test("compound commands and different Windows commands are not silently replaced", () => {
  const hooks = [
    { ...handler("tool-result"), command: command("tool-result") + " && other" },
    { ...handler("tool-result"), commandWindows: "node other.mjs" },
    { ...handler("tool-result"), command: command("tool-result").replace("Concordia/", "Other/") },
    { ...handler("tool-result"), async: true },
  ];
  const config = { hooks: { PostToolUse: [{ hooks }] } };
  const result = migrateCodexHooks(config, { scriptPath });
  assert.deepEqual(result.config, config);
  assert.equal(result.converted.length, 0);
});
test("equivalent Windows path override migrates without retaining a shell command", () => {
  const hook = { ...handler("tool-result"), commandWindows: command("tool-result").replaceAll("/", "\\") };
  const result = migrateCodexHooks({ hooks: { PostToolUse: [{ hooks: [hook] }] } }, { scriptPath });
  assert.equal(result.converted.length, 1);
  assert.equal(result.config.hooks.PostToolUse[0].hooks[0].commandWindows, undefined);
});
test("MCP registration uses the main project and forwards per-session Cc identity", () => {
  const config = hookMcpConfig({ projectRoot: "E:/Document/Ars/Concordia" });
  assert.match(config, /concordia-hook-mcp\.mjs/);
  assert.match(config, /CONCORDIA_SESSION_ID/);
  assert.match(config, /CONCORDIA_DISABLE/);
  assert.doesNotMatch(config, /powershell|cmd\.exe|\.wt-/);
});
