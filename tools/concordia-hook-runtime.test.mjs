import test from "node:test";
import assert from "node:assert/strict";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";
import { runHookCli } from "./concordia-hook.mjs";

function backend(activeId, calls, context = "recovery context") {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const body = path.endsWith("/hook") ? { ok: true, context }
      : { session: { status: path === "/v1/sessions/" + activeId ? "active" : "ended" } };
    return { ok: true, json: async () => body };
  };
}
test("CLI disable avoids stdin and dispatch entirely", async () => {
  await runHookCli({ env: { CONCORDIA_DISABLE: "1" },
    readInput: () => assert.fail("must not wait for stdin"),
    run: () => assert.fail("must not dispatch") });
});
test("CLI forwards context, flags and provider without changing the envelope", async () => {
  let received;
  const ctx = { session_id: "native", tool_response: { exit_code: 1 } };
  await runHookCli({ argv: ["tool-result", "--provider=codex-cli", "--kind=note"], env: {},
    readInput: () => JSON.stringify(ctx), run: async value => { received = value; } });
  assert.deepEqual(received.ctx, ctx);
  assert.equal(received.provider, "codex-cli");
  assert.equal(received.flags.kind, "note");
  assert.equal(received.event, "tool-result");
});
test("runtime disable performs no IO", async () => {
  await runConcordiaHook({ event: "tool-result", env: { CONCORDIA_DISABLE: "1" },
    fetchImpl: () => assert.fail("disabled hook made a request") });
});
test("active context session wins and PostToolUse preserves recovery JSON", async () => {
  const calls = [], chunks = [];
  await runConcordiaHook({ event: "tool-result",
    env: { CONCORDIA_SESSION_ID: "other" },
    ctx: { session_id: "native", tool_name: "Bash", tool_use_id: "call-1",
      tool_input: { command: "git status" }, tool_response: { exit_code: 1 } },
    fetchImpl: backend("native", calls), output: text => chunks.push(text) });
  assert.equal(calls.some(call => call.path.includes("other")), false);
  const observation = calls.find(call => call.path.endsWith("/hook"));
  assert.equal(observation.path, "/v1/harness/reliability/native/hook");
  assert.equal(observation.body.failed, true);
  assert.equal(observation.body.command, "git status");
  assert.equal(observation.body.event_id, "tool-result:call-1");
  assert.deepEqual(JSON.parse(chunks.join("")), { hookSpecificOutput: {
    hookEventName: "PostToolUse", additionalContext: "recovery context" } });
});
test("unregistered native session falls back to active Lictor session", async () => {
  const calls = [];
  await runConcordiaHook({ event: "tool-result", env: { CONCORDIA_SESSION_ID: "wrapped" },
    ctx: { session_id: "native" }, fetchImpl: backend("wrapped", calls), output: () => {} });
  assert.equal(calls.at(-1).path, "/v1/harness/reliability/wrapped/hook");
});
test("offline short circuit is reset at the next invocation", async () => {
  let attempts = 0;
  await runConcordiaHook({ event: "edit", env: { CONCORDIA_SESSION_ID: "wrapped" },
    ctx: { session_id: "native" }, fetchImpl: async () => { attempts++; throw new Error("offline"); } });
  assert.equal(attempts, 1);
  const calls = [];
  await runConcordiaHook({ event: "tool-result", env: {}, ctx: { session_id: "native" },
    fetchImpl: backend("native", calls), output: () => {} });
  assert.equal(calls.at(-1).path, "/v1/harness/reliability/native/hook");
});
test("concurrent invocations do not share session or output", async () => {
  const results = await Promise.all(["one", "two"].map(async id => {
    const calls = [], chunks = [];
    await runConcordiaHook({ event: "tool-result", env: {}, ctx: { session_id: id },
      fetchImpl: backend(id, calls, id), output: text => chunks.push(text) });
    return { calls, text: chunks.join("") };
  }));
  assert.equal(JSON.parse(results[0].text).hookSpecificOutput.additionalContext, "one");
  assert.equal(JSON.parse(results[1].text).hookSpecificOutput.additionalContext, "two");
});
test("SessionStart does not auto-register without explicit opt-in", async () => {
  await runConcordiaHook({ event: "session-start", env: {}, ctx: { session_id: "native" },
    fetchImpl: () => assert.fail("unopted session must not register") });
});
