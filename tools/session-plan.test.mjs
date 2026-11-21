import test from "node:test";
import assert from "node:assert/strict";
import { buildPlanPayload, runSessionPlanCli } from "./session-plan.mjs";

/** active なセッション 1 件を持つ Concordia の代役。 event への応答は respond で差し替える。 */
function backend({ activeId = "s1", respond = () => ({ ok: true, plan: { status: "作業中 (1/2): 調べる", posted: true } }) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const path = new URL(url).pathname;
    calls.push({ path, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    const body = path.endsWith("/event") ? respond()
      : { session: { status: path === `/v1/sessions/${activeId}` ? "active" : "ended" } };
    return { ok: true, json: async () => body };
  };
  return { calls, fetchImpl };
}

function capture() {
  const out = { stdout: "", stderr: "" };
  return { out, stdout: (text) => { out.stdout += text; }, stderr: (text) => { out.stderr += text; } };
}

const PLAN_JSON = JSON.stringify({ items: [{ content: "調べる", status: "in_progress" }, { content: "直す", status: "pending" }] });

test("update sends the plan as the same event the desktop hook sends", async () => {
  const { calls, fetchImpl } = backend();
  const io = capture();
  const code = await runSessionPlanCli({ argv: ["update", `--json=${PLAN_JSON}`], env: { CONCORDIA_SESSION_ID: "s1" }, fetchImpl, ...io });
  assert.equal(code, 0);
  const event = calls.find((call) => call.path === "/v1/sessions/s1/event");
  assert.deepEqual(event.body, { kind: "desktop_plan", payload: { tool: "update_plan", input: JSON.parse(PLAN_JSON) } });
  assert.match(io.out.stdout, /作業中 \(1\/2\): 調べる/);
});

test("wrap-up reads the input from a file and falls back to LICTOR_SESSION_ID", async () => {
  const { calls, fetchImpl } = backend({ respond: () => ({ ok: true, plan: { status: "完了", posted: true } }) });
  const io = capture();
  const code = await runSessionPlanCli({
    argv: ["wrap-up", "--file=recap.json"], env: { LICTOR_SESSION_ID: "s1" }, fetchImpl,
    readFile: () => "﻿" + JSON.stringify({ recap: "直しました。" }), ...io,
  });
  assert.equal(code, 0);
  assert.deepEqual(calls.at(-1).body.payload, { tool: "wrap_up", input: { recap: "直しました。" } });
});

test("fails with a reason when there is no session, the session is not active or Concordia is down", async () => {
  const { calls, fetchImpl } = backend();
  const none = capture();
  assert.equal(await runSessionPlanCli({ argv: ["update", `--json=${PLAN_JSON}`], env: {}, fetchImpl, ...none }), 1);
  assert.match(none.out.stderr, /セッション ID がありません/);
  assert.equal(calls.length, 0);

  const ended = capture();
  assert.equal(await runSessionPlanCli({ argv: ["update", `--json=${PLAN_JSON}`], env: { CONCORDIA_SESSION_ID: "other" }, fetchImpl, ...ended }), 1);
  assert.match(ended.out.stderr, /active な登録がありません/);
  assert.equal(calls.some((call) => call.path.endsWith("/event")), false);

  const down = capture();
  const unreachable = async () => { throw new Error("ECONNREFUSED"); };
  assert.equal(await runSessionPlanCli({ argv: ["update", `--json=${PLAN_JSON}`], env: { CONCORDIA_SESSION_ID: "s1" }, fetchImpl: unreachable, ...down }), 1);
  assert.match(down.out.stderr, /接続できませんでした/);
});

test("fails when Concordia could not read the plan, and rejects bad arguments before sending", async () => {
  const { calls, fetchImpl } = backend({ respond: () => ({ ok: true, plan: null }) });
  const io = capture();
  assert.equal(await runSessionPlanCli({ argv: ["wrap-up", "--json={}"], env: { CONCORDIA_SESSION_ID: "s1" }, fetchImpl, ...io }), 2);
  assert.match(io.out.stderr, /形が違います/);

  const before = calls.length;
  assert.equal(await runSessionPlanCli({ argv: ["plan"], env: { CONCORDIA_SESSION_ID: "s1" }, fetchImpl, ...capture() }), 2);
  assert.equal(await runSessionPlanCli({ argv: ["update", "--json=not json"], env: { CONCORDIA_SESSION_ID: "s1" }, fetchImpl, ...capture() }), 2);
  assert.equal(calls.length, before);
  assert.match(buildPlanPayload(["update", "--json=[1]"]).error, /オブジェクト/);
  assert.match(buildPlanPayload(["update", "--file=x"], () => { throw new Error("ENOENT"); }).error, /読めませんでした/);
});
