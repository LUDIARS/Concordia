import { beforeEach, describe, expect, it } from "vitest";
import { makeTestApp } from "../../../tests/helpers/test-app.js";
import {
  _resetPendingRelictor,
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
});
