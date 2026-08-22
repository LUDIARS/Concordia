import { describe, expect, it } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";

async function register(env: TestAppEnv, id: string): Promise<void> {
  const response = await env.app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, provider: "claude-code", repo_path: "/work/Concordia", branch: "main", host: "host" }),
  });
  expect(response.status).toBe(200);
}

async function post(env: TestAppEnv, id: string, body: unknown): Promise<Response> {
  return await env.app.request(`/v1/sessions/${id}/escalation`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function release(env: TestAppEnv, id: string, body: unknown = {}): Promise<Response> {
  return await env.app.request(`/v1/sessions/${id}/escalation`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("escalation API", () => {
  it("declares escalation and persists state plus audit row", async () => {
    const env = makeTestApp();
    await register(env, "rescuer");

    const response = await post(env, "rescuer", { reason: "Cc down" });

    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.escalation.reason).toBe("Cc down");
    expect(env.escalations.isEscalated("rescuer")).toBe(true);
    expect(env.repo.findSession("rescuer")?.escalation_mode).toBe(1);
  });

  it("rejects an empty reason with 400", async () => {
    const env = makeTestApp();
    await register(env, "rescuer");

    expect((await post(env, "rescuer", { reason: "   " })).status).toBe(400);
    expect((await post(env, "rescuer", {})).status).toBe(400);
    expect(env.escalations.isEscalated("rescuer")).toBe(false);
  });

  it("returns 404 for an unknown session", async () => {
    const env = makeTestApp();
    expect((await post(env, "nope", { reason: "Cc down" })).status).toBe(404);
    expect((await release(env, "nope")).status).toBe(404);
  });

  it("stops the other active sessions and withdraws the claims on release", async () => {
    const env = makeTestApp();
    await register(env, "rescuer");
    await register(env, "peer");

    const started = await (await post(env, "rescuer", { reason: "Cc down" })).json() as any;
    expect(started.stopped_session_ids).toEqual(["peer"]);

    const released = await (await release(env, "rescuer", { note: "restored" })).json() as any;
    expect(released.escalation.note).toBe("restored");
    expect(released.withdrawn_claims).toBe(1);

    const pending = await (await env.app.request("/v1/sessions/peer/pending-tasks")).json() as any;
    expect(pending.tasks).toHaveLength(0);
  });

  it("reports the current state through GET", async () => {
    const env = makeTestApp();
    await register(env, "rescuer");
    await post(env, "rescuer", { reason: "Cc down" });

    const body = await (await env.app.request("/v1/sessions/rescuer/escalation")).json() as any;

    expect(body.active).toBe(true);
    expect(body.open.reason).toBe("Cc down");
    expect(body.history).toHaveLength(1);
  });

  it("swaps the injected workflow packet while escalated", async () => {
    const env = makeTestApp();
    env.adminState.setCcWorkflowEnabled(true);
    await register(env, "rescuer");
    await post(env, "rescuer", { reason: "Cc down" });

    const body = await (await env.app.request("/v1/sessions/rescuer/context")).json() as any;
    const workflow = body.context_packet.cc_workflow;
    const rules = workflow.rules.join("\n");

    expect(body.context_packet.escalation).toMatchObject({ active: true, reason: "Cc down" });
    expect(workflow.inject_source).toBe("escalation:cc-workflow");
    // 外れるもの: task 登録要求と worktree 要求。
    expect(rules).toContain("Task registration");
    expect(rules).toContain("not required");
    expect(rules).toContain("operate the working branch directly");
    // 外れないもの。
    expect(rules).toContain("Do not push directly to GitHub");
    expect(rules).toContain("security scan");
    expect(rules).toContain("Do not discard another session's changes");
    expect(workflow.completion_policy.join("\n")).toContain("working service");
  });

  it("restores the normal workflow packet after release", async () => {
    const env = makeTestApp();
    env.adminState.setCcWorkflowEnabled(true);
    await register(env, "rescuer");
    await post(env, "rescuer", { reason: "Cc down" });
    await release(env, "rescuer", { note: "restored" });

    const body = await (await env.app.request("/v1/sessions/rescuer/context")).json() as any;

    expect(body.context_packet.escalation.active).toBe(false);
    expect(body.context_packet.cc_workflow.inject_source).toBe("session-start:cc-workflow");
    expect(body.context_packet.cc_workflow.rules.join("\n")).toContain("task_update");
  });
});
