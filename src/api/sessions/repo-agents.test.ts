import { describe, expect, it } from "vitest";
import { makeTestApp } from "../../../tests/helpers/test-app.js";
import type { RepoAgentService } from "../../control/succession/repo-agent-service.js";
import type { RepoAgentRow } from "../../control/succession/repo-agents-state.js";
import { successorReinject } from "./successor-reinject.js";

const ROW: RepoAgentRow = {
  checkout: "/workspace/Concordia/.wt-x", project_code: "Cc", trigger: "gate", rule: "task-branch", status: "active",
  at: 1, updated_at: 2, spawn_id: "s1", child_session_id: "child", pending_brief: null, note: null,
};

function fakeService(submitted: string[]): RepoAgentService {
  return {
    list: () => [ROW],
    submitBriefs: async (_id: string, text: string) => { submitted.push(text); return { accepted: 1, rejected: 0 }; },
  } as unknown as RepoAgentService;
}

function register(env: ReturnType<typeof makeTestApp>, id: string, metadata: Record<string, unknown> = {}) {
  return env.app.request("/v1/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, provider: "claude-code", repo_path: "/workspace/Concordia", host: "h", metadata }),
  });
}

describe("/v1/sessions/:id/repo-agents (spec/feature/session-auto-succession.md §3.6)", () => {
  it("GET は担当一覧と子の現 status を返す", async () => {
    const env = makeTestApp({ repoAgents: fakeService([]) });
    await register(env, "parent");
    await register(env, "child");
    const body = await (await env.app.request("/v1/sessions/parent/repo-agents")).json() as {
      agents: Array<RepoAgentRow & { child_status: string | null }>; repo_agent_of: unknown;
    };
    expect(body.repo_agent_of).toBeNull();
    expect(body.agents).toEqual([{ ...ROW, child_status: "active" }]);
  });

  it("GET は子から親 (repo_agent_of) を引ける", async () => {
    const env = makeTestApp({ repoAgents: fakeService([]) });
    await register(env, "child", { repo_agent_of: { parent_session_id: "parent", checkout: "/workspace/Concordia/.wt-x" } });
    const body = await (await env.app.request("/v1/sessions/child/repo-agents")).json() as { repo_agent_of: unknown };
    expect(body.repo_agent_of).toEqual({ parent_session_id: "parent", checkout: "/workspace/Concordia/.wt-x", project_code: null });
  });

  it("POST は repo-brief を手動依頼として渡す。 未配線は 503、 不正 body は 400、 不明は 404", async () => {
    const submitted: string[] = [];
    const env = makeTestApp({ repoAgents: fakeService(submitted) });
    await register(env, "parent");
    const post = (id: string, body: unknown) => env.app.request(`/v1/sessions/${id}/repo-agents`, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
    });
    expect(await (await post("parent", { text: "```repo-brief\n{}\n```" })).json()).toEqual({ ok: true, accepted: 1, rejected: 0 });
    expect(submitted).toHaveLength(1);
    expect((await post("parent", {})).status).toBe(400);
    expect((await post("missing", { text: "x" })).status).toBe(404);

    const bare = makeTestApp();
    await register(bare, "parent");
    expect((await bare.app.request("/v1/sessions/parent/repo-agents", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "x" }),
    })).status).toBe(503);
  });
});

describe("successorReinject", () => {
  it("kind ごとの見出しと source を返す。 リポ担当は依頼文に前置きがあるので見出し無し", () => {
    expect(successorReinject("handover").source).toBe("auto:handover-handoff");
    expect(successorReinject("relictor").source).toBe("auto:relictor-handoff");
    expect(successorReinject("repo-agent")).toEqual({ header: "", source: "auto:repo-agent-brief" });
  });
});
