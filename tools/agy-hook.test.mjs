import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gateAgyToolCall, observeAgyEvent, runAgyHookCli } from "./agy-hook.mjs";
import { agyDenyResponse, isGatedAgyTool, toClaudeHookInput } from "./agy-hook-mapping.mjs";

const BASE = { conversationId: "conv-1", cwd: "C:\\work", lastUserInput: "直して", transcriptPath: "C:\\t.jsonl" };
const command = { ...BASE, hookEventName: "PreToolUse",
  toolCall: { id: "call-1", name: "run_command", args: { CommandLine: "git status", WaitMsBeforeAsync: 5000 } } };
const write = { ...BASE, hookEventName: "PreToolUse",
  toolCall: { id: "call-2", name: "write_file", args: { Path: "C:\\work\\a.txt", Content: "x", Overwrite: true } } };
const read = { ...BASE, hookEventName: "PreToolUse", toolCall: { id: "call-3", name: "view_file", args: { AbsolutePath: "C:\\work\\a.txt" } } };

/** supervisor の設定が揃った env (実ファイルを置く)。 */
function harnessEnv() {
  const dir = mkdtempSync(join(tmpdir(), "agy-hook-"));
  mkdirSync(join(dir, "runtime", "harness"), { recursive: true });
  writeFileSync(join(dir, "runtime", "harness", "supervisor-cli.js"), "");
  writeFileSync(join(dir, "config.json"), "{}");
  return { CONCORDIA_HARNESS_RUNTIME: join(dir, "runtime"), CONCORDIA_HARNESS_CONFIG: join(dir, "config.json") };
}

test("agy tool calls are mapped to the Claude hook shape the harness reads", () => {
  assert.deepEqual(toClaudeHookInput(command), {
    session_id: "conv-1", cwd: "C:\\work", transcript_path: "C:\\t.jsonl", hook_event_name: "PreToolUse", prompt: "直して",
    tool_name: "Bash", tool_use_id: "call-1", tool_input: { command: "git status" },
  });
  const mapped = toClaudeHookInput(write);
  assert.equal(mapped.tool_name, "Write");
  assert.deepEqual(mapped.tool_input, { file_path: "C:\\work\\a.txt" });
  assert.equal(toClaudeHookInput(read).tool_name, "view_file");
  assert.equal(toClaudeHookInput({ ...BASE, hookEventName: "Stop" }).tool_name, undefined);
  assert.deepEqual(toClaudeHookInput({ ...command, hookEventName: "PostToolUse", error: "boom" }).tool_response, { error: "boom" });
});

test("only command and edit tools are gated", () => {
  for (const name of ["run_command", "write_file", "write_to_file", "replace_file_content", "multi_replace_file_content", "edit_file", "notebook_edit", "apply_patch"]) {
    assert.equal(isGatedAgyTool(name), true, name);
  }
  for (const name of ["view_file", "grep_search", "search_web", undefined]) assert.equal(isGatedAgyTool(name), false, String(name));
});

test("an allowed tool call prints nothing and a denied one returns agy's deny response", async () => {
  const env = harnessEnv();
  const seen = [];
  const allow = await gateAgyToolCall({ agy: command, env,
    supervise: async (call) => { seen.push(JSON.parse(call.input)); return { code: 0, stderr: "" }; } });
  assert.equal(allow, null);
  assert.equal(seen[0].tool_name, "Bash");
  const deny = await gateAgyToolCall({ agy: write, env,
    supervise: async () => ({ code: 2, stderr: "[harness-supervisor] task registration required\n" }) });
  assert.deepEqual(JSON.parse(deny), { decision: "deny", reason: "[harness-supervisor] task registration required" });
});

test("the gate fails closed on a crashed supervisor and on missing configuration", async () => {
  const crashed = await gateAgyToolCall({ agy: command, env: harnessEnv(), supervise: async () => ({ code: null, stderr: "" }) });
  assert.equal(JSON.parse(crashed).decision, "deny");
  const unconfigured = await gateAgyToolCall({ agy: command, env: {}, supervise: async () => assert.fail("must not run") });
  assert.match(JSON.parse(unconfigured).reason, /CONCORDIA_HARNESS_RUNTIME/);
});

test("ungated tools and a disabled hook skip the supervisor", async () => {
  const supervise = async () => assert.fail("must not run");
  assert.equal(await gateAgyToolCall({ agy: read, env: harnessEnv(), supervise }), null);
  assert.equal(await gateAgyToolCall({ agy: command, env: { CONCORDIA_DISABLE: "1" }, supervise }), null);
});

test("observation forwards tool results, failures, edits and the first prompt of a turn", async () => {
  const events = [];
  const run = async (options) => { events.push([options.event, options.provider, options.ctx.tool_name ?? null]); options.output("ignored"); };
  await observeAgyEvent({ event: "post-tool", agy: { ...command, hookEventName: "PostToolUse", error: "" }, run });
  await observeAgyEvent({ event: "post-tool", agy: { ...write, hookEventName: "PostToolUse", error: "disk full" }, run });
  await observeAgyEvent({ event: "prompt", agy: { ...BASE, hookEventName: "PreInvocation", invocationNum: 0 }, run });
  await observeAgyEvent({ event: "prompt", agy: { ...BASE, hookEventName: "PreInvocation", invocationNum: 1 }, run });
  assert.deepEqual(events, [
    ["tool-result", "antigravity-cli", "Bash"],
    ["tool-failure", "antigravity-cli", "Write"],
    ["edit", "antigravity-cli", "Write"],
    ["prompt", "antigravity-cli", null],
  ]);
});

test("the CLI denies unreadable pre-tool input and stays silent for observation", async () => {
  const out = [];
  await runAgyHookCli({ argv: ["pre-tool"], env: {}, readInput: () => "not json", write: (text) => out.push(text) });
  assert.equal(JSON.parse(out[0]).decision, "deny");
  await runAgyHookCli({ argv: ["post-tool"], env: {}, readInput: () => "not json", write: () => assert.fail("must stay silent") });
  assert.equal(JSON.parse(agyDenyResponse("")).reason.length > 0, true);
});
