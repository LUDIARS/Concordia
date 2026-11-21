import test from "node:test";
import assert from "node:assert/strict";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";
import { desktopPlanCall } from "./concordia-hook-desktop-plan.mjs";

function backend(activeId, calls) {
  return async (url, init) => {
    const path = new URL(url).pathname;
    calls.push({ path, body: init.body ? JSON.parse(init.body) : null });
    const body = path.endsWith("/hook") ? { ok: true, context: null }
      : { session: { status: path === "/v1/sessions/" + activeId ? "active" : "ended" } };
    return { ok: true, json: async () => body };
  };
}

test("only the desktop app plan tools with an object input are plan calls", () => {
  assert.deepEqual(desktopPlanCall({ tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "done" } }),
    { tool: "wrap_up", input: { recap: "done" } });
  assert.equal(desktopPlanCall({ tool_name: "TodoWrite", tool_input: { todos: [] } }), null);
  assert.equal(desktopPlanCall({ tool_name: "mcp__ccd_turn__update_plan", tool_input: "advance" }), null);
  assert.equal(desktopPlanCall(null), null);
});

test("plan update of an active session is forwarded as a desktop_plan event", async () => {
  const calls = [];
  const input = { items: [{ content: "調べる", status: "in_progress" }], scope: "first_task" };
  await runConcordiaHook({ event: "tool-result", env: {},
    ctx: { session_id: "native", tool_name: "mcp__ccd_turn__update_plan", tool_use_id: "call-2", tool_input: input },
    fetchImpl: backend("native", calls), output: () => {} });
  const posted = calls.find(call => call.path === "/v1/sessions/native/event");
  assert.deepEqual(posted.body, { kind: "desktop_plan", payload: { tool: "update_plan", input } });
  assert.equal(calls.some(call => call.path === "/v1/sessions"), false);
});

test("plan update of an unregistered session registers it for observation first", async () => {
  const calls = [];
  await runConcordiaHook({ event: "tool-result", env: {},
    ctx: { session_id: "desktop", cwd: process.cwd(), tool_name: "mcp__ccd_turn__wrap_up", tool_input: { recap: "done" } },
    fetchImpl: backend("nobody", calls), output: () => {} });
  const registered = calls.find(call => call.path === "/v1/sessions");
  assert.equal(registered.body.id, "desktop");
  assert.equal(registered.body.metadata.desktop_app, true);
  assert.equal(registered.body.metadata.cc_hook_observation, true);
  assert.deepEqual(calls.at(-1), { path: "/v1/sessions/desktop/event",
    body: { kind: "desktop_plan", payload: { tool: "wrap_up", input: { recap: "done" } } } });
});

test("other tools of an unregistered session are still ignored", async () => {
  const calls = [];
  await runConcordiaHook({ event: "tool-result", env: {},
    ctx: { session_id: "desktop", tool_name: "Bash", tool_input: { command: "ls" } },
    fetchImpl: backend("nobody", calls), output: () => {} });
  assert.equal(calls.some(call => call.path === "/v1/sessions" || call.path.endsWith("/event")), false);
});
