import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("/v1/sessions/:id/goal-and-go", () => {
  it("persists an explicit opt-in and preserves other session metadata", async () => {
    const env = makeTestApp();
    env.repo.insertSession({
      id: "gng-1",
      provider: "codex-cli",
      repo_path: "/work/project",
      repo_origin: null,
      branch: null,
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: JSON.stringify({ role_label: "実装担当" }),
    });

    const enabled = await env.app.request("/v1/sessions/gng-1/goal-and-go", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true }),
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      ok: true,
      goal_and_go: { enabled: true, continuation_count: 0, stopped_reason: null },
    });

    const fetched = await env.app.request("/v1/sessions/gng-1/goal-and-go");
    expect(fetched.status).toBe(200);
    expect(await fetched.json()).toMatchObject({ goal_and_go: { enabled: true } });
    expect(JSON.parse(env.repo.findSession("gng-1")!.metadata!)).toMatchObject({
      role_label: "実装担当",
      goal_and_go: { enabled: true },
    });
  });

  it("rejects an invalid flag and returns 404 for an unknown session", async () => {
    const env = makeTestApp();
    env.repo.insertSession({
      id: "gng-2",
      provider: "claude-code",
      repo_path: "/work/project",
      repo_origin: null,
      branch: null,
      host: "host",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    });
    const invalid = await env.app.request("/v1/sessions/gng-2/goal-and-go", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: "yes" }),
    });
    expect(invalid.status).toBe(400);

    const missing = await env.app.request("/v1/sessions/missing/goal-and-go");
    expect(missing.status).toBe(404);
  });
});
