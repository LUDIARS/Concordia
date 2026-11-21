import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

/** agy (CLI) から届くプラン更新が、 デスクトップ版と同じ event の口で反映されること (SPEC-SESSION-PLAN-DISCORD)。 */
describe("POST /v1/sessions/:id/event kind=desktop_plan", () => {
  async function start(provider: string) {
    const env = makeTestApp();
    await env.app.request("/v1/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id: "agy1", provider, repo_path: "/x", host: "h" }),
    });
    const send = async (payload: unknown) => (await env.app.request("/v1/sessions/agy1/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "desktop_plan", payload }),
    })).json() as Promise<Record<string, unknown>>;
    return { env, send };
  }

  it("saves an agy plan, mirrors its steps as tasks, posts it as the agy plan and returns the result", async () => {
    const { env, send } = await start("antigravity-cli");
    const plan = { tool: "update_plan", input: { items: [{ content: "調べる", status: "in_progress" }, { content: "直す", status: "pending" }] } };
    expect(await send(plan)).toEqual({ ok: true, plan: { status: "作業中 (1/2): 調べる", posted: true } });
    expect(await send(plan)).toEqual({ ok: true, plan: { status: "作業中 (1/2): 調べる", posted: false } });
    expect(await send({ tool: "wrap_up", input: { recap: "直しました。" } })).toEqual({ ok: true, plan: { status: "完了", posted: true } });

    const metadata = JSON.parse(env.repo.findSession("agy1")!.metadata ?? "{}");
    expect(metadata.desktop_plan).toMatchObject({ phase: "summary", status: "完了" });
    const tasks = await (await env.app.request("/v1/sessions/agy1/tasks")).json() as { items: Array<{ task_text: string; status: string }> };
    expect(tasks.items.map((task) => [task.task_text, task.status])).toEqual([["調べる", "completed"], ["直す", "completed"]]);
    const latest = env.chat.latestForSession("agy1");
    expect(latest).toMatchObject({ channel: "system", author_label: "agy プラン" });
    expect(latest?.text).toContain("直しました。");
  });

  it("returns plan null for a payload it cannot read, so the sender can fail", async () => {
    const { send } = await start("antigravity-cli");
    expect(await send({ tool: "wrap_up", input: {} })).toEqual({ ok: true, plan: null });
  });

  it("keeps the plain response for other event kinds", async () => {
    const { env } = await start("claude-code");
    const res = await env.app.request("/v1/sessions/agy1/event", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "edit", payload: { file: "x.ts" } }),
    });
    expect(await res.json()).toEqual({ ok: true });
  });
});
