import { beforeEach, describe, expect, it } from "vitest";
import { makeTestApp } from "../../../tests/helpers/test-app.js";
import {
  _resetPendingRelictor,
  claimPendingRelictor,
  recordPendingRelictor,
} from "../../control/pending-relictor.js";

beforeEach(() => _resetPendingRelictor());

describe("session succession enrollment", () => {
  it("accepts the ID-bound handover successor and restores its handoff and goal", async () => {
    const env = makeTestApp();
    recordPendingRelictor({
      cwd: "/workspace/Concordia",
      spawnId: "successor-00000001",
      handoff: "### 次の一手\nレビューを続ける",
      goal: { mode: "scoped", text: "PR #535" },
      kind: "handover",
    });

    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "handover-successor",
        provider: "codex-cli",
        repo_path: "/workspace/Concordia",
        host: "test-host",
        metadata: { concordia_spawn_id: "successor-00000001" },
      }),
    });

    expect(response.status).toBe(200);
    const detail = await (await env.app.request("/v1/sessions/handover-successor")).json() as {
      session: { metadata: { goal?: unknown } };
      events: Array<{ kind: string; payload: { source?: string; text?: string } }>;
    };
    expect(detail.session.metadata.goal).toEqual({ mode: "scoped", text: "PR #535" });
    expect(detail.events).toContainEqual(expect.objectContaining({
      kind: "inject",
      payload: expect.objectContaining({
        source: "auto:handover-handoff",
        text: expect.stringContaining("レビューを続ける"),
      }),
    }));
  });

  it("continues to reject an unknown enrollment ID", async () => {
    const env = makeTestApp();
    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "unknown-successor",
        provider: "codex-cli",
        repo_path: "/workspace/Concordia",
        host: "test-host",
        metadata: { concordia_spawn_id: "unknown-00000001" },
      }),
    });

    expect(response.status).toBe(401);
  });

  it("rejects a successor enrollment from the wrong cwd without consuming it", async () => {
    const env = makeTestApp();
    recordPendingRelictor({
      cwd: "/workspace/Concordia",
      spawnId: "successor-cwd-bound",
      handoff: "private handoff",
      kind: "handover",
    });

    const register = (id: string, repoPath: string) => env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id,
        provider: "codex-cli",
        repo_path: repoPath,
        host: "test-host",
        metadata: { concordia_spawn_id: "successor-cwd-bound" },
      }),
    });

    expect((await register("wrong-cwd", "/workspace/Other")).status).toBe(401);
    expect((await register("correct-cwd", "/workspace/Concordia")).status).toBe(200);
  });

  it("does not let a blank enrollment value claim a legacy cwd-only handoff", async () => {
    const env = makeTestApp();
    recordPendingRelictor({ cwd: "/workspace/Concordia", handoff: "legacy private handoff" });

    const response = await env.app.request("/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "blank-enrollment",
        provider: "codex-cli",
        repo_path: "/workspace/Concordia",
        host: "test-host",
        metadata: { concordia_spawn_id: "   " },
      }),
    });

    expect(response.status).toBe(401);
    expect(claimPendingRelictor("/workspace/Concordia")?.handoff).toBe("legacy private handoff");
  });
});
