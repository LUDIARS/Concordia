import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gateGrokToolCall, observeGrokEvent, runGrokHookCli } from "./grok-hook.mjs";
import { toClaudeHookInput } from "./grok-hook-mapping.mjs";

const shell = { hookEventName: "PreToolUse", sessionId: "grok-1", cwd: "C:/work",
  toolName: "run_terminal_command", toolInput: { CommandLine: "git status" }, toolUseId: "tool-1" };
const edit = { hook_event_name: "PostToolUse", session_id: "grok-1",
  tool_name: "EditNotebook", tool_input: { target_notebook: "file.ipynb" }, tool_response: { ok: true } };

test("accepts both Grok and Claude wire names", () => {
  const camel = toClaudeHookInput(shell);
  assert.equal(camel.hook_event_name, "PreToolUse");
  assert.equal(camel.session_id, "grok-1");
  assert.equal(camel.tool_use_id, "tool-1");
  assert.equal(camel.tool_name, "Bash");
  assert.deepEqual(camel.tool_input, { command: "git status" });
  const snake = toClaudeHookInput(edit);
  assert.equal(snake.tool_name, "Edit");
  assert.equal(snake.session_id, "grok-1");
  assert.equal(snake.tool_input.file_path, "file.ipynb");
  assert.deepEqual(snake.tool_response, { ok: true });
  for (const [name, mapped] of Object.entries({
    Shell: "Bash", Bash: "Bash", write: "Write", write_file: "Write", Write: "Write",
    search_replace: "Edit", hashline_edit: "Edit", StrReplace: "Edit", Edit: "Edit",
    MultiEdit: "MultiEdit", NotebookEdit: "NotebookEdit",
  })) assert.equal(toClaudeHookInput({ toolName: name }).tool_name, mapped);
});

test("requires the supervisor for a protected tool and fails closed", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "grok-hook-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const runtime = join(dir, "runtime");
  const config = join(dir, "config.json");
  mkdirSync(join(runtime, "harness"), { recursive: true });
  writeFileSync(join(runtime, "harness", "supervisor-cli.js"), "");
  writeFileSync(config, "{}");
  const env = { CONCORDIA_HARNESS_RUNTIME: runtime, CONCORDIA_HARNESS_CONFIG: config };
  const allow = await gateGrokToolCall({ grok: shell, env, supervise: async (call) => {
    assert.equal(JSON.parse(call.input).tool_name, "Bash");
    return { code: 0 };
  } });
  assert.equal(allow, null);
  const deny = await gateGrokToolCall({ grok: shell, env, supervise: async () => ({ code: 2, stderr: "blocked" }) });
  assert.deepEqual(JSON.parse(deny), { decision: "deny", reason: "blocked" });
  const crash = await gateGrokToolCall({ grok: shell, env, supervise: async () => { throw new Error("crash"); } });
  assert.match(JSON.parse(crash).reason, /crash/);
  for (const [grok, configEnv] of [[shell, {}], [{ toolName: "Shell" }, env], [{}, env]]) {
    assert.equal(JSON.parse(await gateGrokToolCall({ grok, env: configEnv })).decision, "deny");
  }
  assert.equal(await gateGrokToolCall({ grok: { toolName: "read_file" }, env: {} }), null);
});

test("routes prompts, results, failed results and successful edits into the shared runtime", async () => {
  const seen = [];
  const run = async ({ event, provider }) => { seen.push([event, provider]); };
  await observeGrokEvent({ event: "prompt", grok: { prompt: "確認して" }, run });
  await observeGrokEvent({ event: "post-tool", grok: edit, run });
  await observeGrokEvent({ event: "post-tool-failure", grok: edit, run });
  assert.deepEqual(seen, ["prompt", "tool-result", "edit", "tool-failure"].map((event) => [event, "grok-cli"]));
});

test("rejects unreadable PreToolUse input and wires all four configured events", async () => {
  const output = [];
  await runGrokHookCli({ argv: ["pre-tool"], env: {}, readInput: () => "{", write: (text) => output.push(text) });
  assert.equal(JSON.parse(output[0]).decision, "deny");
  await runGrokHookCli({ argv: ["pre-tool"], env: {}, readInput: () => '{"toolName":"read_file"}', write: (text) => output.push(text) });
  assert.equal(output.length, 1);
  const { hooks } = JSON.parse(readFileSync(new URL("./grok-hooks.example.json", import.meta.url), "utf8"));
  for (const [event, subcommand] of Object.entries({
    PreToolUse: "pre-tool", PostToolUse: "post-tool", PostToolUseFailure: "post-tool-failure", UserPromptSubmit: "prompt",
  })) assert.ok(hooks[event][0].hooks[0].command.includes(`grok-hook.mjs ${subcommand}`));
});
