import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";
import type { TestAppEnv } from "./helpers/test-app.js";

// 文章からの作業対象推定は、ワークスペースルートのセッションだけに行う
// (src/control/target-inference-policy.ts、actio:fbe1a347-f1a6-4738-9fac-de0ac4fe77e1)。
const ROOT = "D:\\LUDIARS";
const ACTIO = "D:\\LUDIARS\\Actio";
const WORKTREE = "D:\\LUDIARS\\.wt-Cernere-presence";

describe("sessions API — target_project inference from text", () => {
  let env: TestAppEnv;

  beforeEach(() => {
    env = makeTestApp();
    env.adminState.setWorkspaceRoots([ROOT]);
    env.projectCodes.register({ code: "At", project: "Actio", repoPath: ACTIO, repoOrigin: null, addedBy: "test" });
  });

  async function start(id: string, repoPath: string): Promise<void> {
    const r = await env.app.request("/v1/sessions", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ id, provider: "codex-cli", repo_path: repoPath, host: "h" }),
    });
    expect(r.status).toBeLessThan(300);
  }

  function targetOf(id: string): string | null {
    return env.repo.findSession(id)?.target_project ?? null;
  }

  async function patchTask(id: string, currentTask: string): Promise<void> {
    const r = await env.app.request(`/v1/sessions/${id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ current_task: currentTask }),
    });
    expect(r.status).toBe(200);
  }

  async function setTitle(id: string, text: string): Promise<void> {
    const r = await env.app.request(`/v1/sessions/${id}/title`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text }),
    });
    expect(r.status).toBe(200);
  }

  it("PATCH keeps a worktree session's target when current_task mentions another project", async () => {
    await start("child", WORKTREE);
    await patchTask("child", "Actio のタスク本文と作業ツリー内の設計を確認する");
    expect(targetOf("child")).toBeNull();
  });

  it("PATCH still infers the target for a workspace-root session", async () => {
    await start("root", ROOT);
    await patchTask("root", "Actio のタスク一覧を直す");
    expect(targetOf("root")?.replace(/\//g, "\\")).toBe(ACTIO);
  });

  it("PATCH does not infer when the same patch moves the session into a specific repository", async () => {
    await start("moving", ROOT);
    const r = await env.app.request("/v1/sessions/moving", {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo_path: WORKTREE, current_task: "Actio タスク参照から実装する" }),
    });
    expect(r.status).toBe(200);
    expect(targetOf("moving")).toBeNull();
  });

  it("POST title keeps a worktree session's target", async () => {
    await start("child-title", WORKTREE);
    await setTitle("child-title", "[At] Actio タスクの実装");
    expect(targetOf("child-title")).toBeNull();
  });

  it("POST title still infers the target for a workspace-root session", async () => {
    await start("root-title", ROOT);
    await setTitle("root-title", "[At] Actio タスクの実装");
    expect(targetOf("root-title")?.replace(/\//g, "\\")).toBe(ACTIO);
  });

  it("POST title-suggestion keeps a worktree session's target", async () => {
    await start("child-suggest", WORKTREE);
    const r = await env.app.request("/v1/sessions/child-suggest/title-suggestion", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "[At] Actio タスクの実装" }),
    });
    // lictor_port が無いので転送は 404。推定は転送より前に行われるため、上書きの有無だけを見る。
    expect(r.status).toBe(404);
    expect(targetOf("child-suggest")).toBeNull();
  });
});
