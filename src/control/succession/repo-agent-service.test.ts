import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import type { SpawnRequest, SpawnResult } from "../spawner.js";
import { createRepoAgentService, type RepoAgentServicePorts } from "./repo-agent-service.js";
import { readRepoAgents } from "./repo-agents-state.js";
import { createSpawnBudget } from "./spawn-budget.js";

const REGISTERED = ["E:/Document/Ars/Concordia", "E:/Document/Ars/Memoria"];
const CHECKOUT = "E:/Document/Ars/Concordia/.wt-x";

function row(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "parent", provider: "claude-code", repo_path: "E:/Document/Ars", repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0, current_task: null, transcript_path: null,
    metadata: null, ws_clients: 0, target_project: null, active_repos: "[]",
    ...overrides,
  };
}

function brief(checkout: string, text = "A を直す。テストは書くだけ"): string {
  return ["```repo-brief", JSON.stringify({ checkout, brief: text }), "```"].join("\n");
}

function harness(options: { spawn?: (req: SpawnRequest) => Promise<SpawnResult>; budget?: number; maxAgents?: number } = {}) {
  const sessions = new Map<string, SessionRow>([["parent", row()]]);
  const injects: Array<{ id: string; text: string; source: string }> = [];
  const lines: Array<{ id: string; text: string }> = [];
  const pending: Array<{ cwd: string; spawnId: string; handoff: string }> = [];
  const forgotten: string[] = [];
  const spawns: SpawnRequest[] = [];
  let now = 1000;
  let seq = 0;
  const ports: RepoAgentServicePorts = {
    sessions: {
      findSession: (id) => sessions.get(id) ?? null,
      updateMetadata: (id, update) => {
        const current = sessions.get(id);
        if (!current) return;
        const metadata = current.metadata ? JSON.parse(current.metadata) as Record<string, unknown> : {};
        sessions.set(id, { ...current, metadata: JSON.stringify(update(metadata)) });
      },
    },
    settings: () => ({ enabled: true, maxAgentsPerParent: options.maxAgents ?? 3, briefTimeoutSec: 600 }),
    registeredRepos: () => REGISTERED,
    workspaceRoots: () => ["E:/Document/Ars"],
    projectCodeFor: (repo) => (repo.endsWith("Concordia") ? "Cc" : "Mm"),
    toSpawnProvider: (provider) => (provider === "claude-code" ? "claude" : provider === "codex-cli" ? "codex" : null),
    isSessionEnding: () => false,
    inject: (id, text, source) => { injects.push({ id, text, source }); },
    postLine: (id, text) => { lines.push({ id, text }); },
    childThread: (id) => `<#thread-${id}>`,
    lastAssistantText: () => "PR #900 を提出しました",
    recordPending: (input) => { pending.push(input); },
    forgetPending: (spawnId) => { forgotten.push(spawnId); },
    spawn: async (request) => {
      spawns.push(request);
      return options.spawn ? options.spawn(request) : { ok: true, command: ["lictor"], pid: 1 };
    },
    spawnBudget: createSpawnBudget(() => now, options.budget ?? 2),
    newSpawnId: () => `spawn-${++seq}`,
    now: () => now,
    log: { info: () => undefined, warn: () => undefined },
  };
  const service = createRepoAgentService(ports);
  const rows = () => readRepoAgents(JSON.parse(sessions.get("parent")!.metadata ?? "{}") as Record<string, unknown>);
  return {
    service, sessions, injects, lines, pending, forgotten, spawns, rows,
    advance: (sec: number) => { now += sec; },
  };
}

const DENY = { rule: "task-branch", decision: "deny" };

describe("RepoAgentService: ゲート契機 (§3.1 02a, §3.5)", () => {
  it("cwd と作業先のずれの deny で requested を記録し、 依頼文の書き方を返す", () => {
    const h = harness();
    const text = h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: "E:/Document/Ars", filePath: `${CHECKOUT}/src/a.ts` });
    expect(text).toContain("```repo-brief");
    expect(text).toContain(CHECKOUT);
    expect(h.rows()).toMatchObject([{ checkout: CHECKOUT, project_code: "Cc", trigger: "gate", rule: "task-branch", status: "requested" }]);
  });

  it("同じ checkout の 2 回目は新しい行を作らず §3.5 の案内を返す", () => {
    const h = harness();
    const input = { sessionId: "parent", hits: [DENY], cwd: CHECKOUT, filePath: null };
    h.service.onGateDenied(input);
    expect(h.service.onGateDenied(input)).toContain("準備中");
    expect(h.rows()).toHaveLength(1);
  });

  it("安全上の deny・起動 cwd と同じ checkout・未登録は契機にしない", () => {
    const h = harness();
    expect(h.service.onGateDenied({ sessionId: "parent", hits: [{ rule: "no-main-push", decision: "deny" }], cwd: CHECKOUT, filePath: null })).toBeNull();
    expect(h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: "E:/Document/Ars", filePath: null })).toBeNull();
    expect(h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: "E:/Document/Ars/Unknown", filePath: null })).toBeNull();
    expect(h.rows()).toEqual([]);
  });

  it("委託子・リポ担当自身は契機にしない (再帰防止)", () => {
    const h = harness();
    h.sessions.set("parent", row({ metadata: JSON.stringify({ repo_agent_of: { parent_session_id: "p0", checkout: "E:/Document/Ars/Memoria" } }) }));
    expect(h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: CHECKOUT, filePath: null })).toBeNull();
  });
});

describe("RepoAgentService: 依頼文の受領と担当の起動 (§3.3, §3.4)", () => {
  it("repo-brief 受領 → pending 登録 → 親と同じ provider で spawn → 子登録で親子が結ばれる", async () => {
    const h = harness();
    h.sessions.set("parent", row({ provider: "codex-cli" }));
    h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: CHECKOUT, filePath: null });
    await h.service.onAssistantText("parent", `書きます\n${brief(CHECKOUT)}`);

    expect(h.rows()[0]).toMatchObject({ status: "spawning", spawn_id: "spawn-1" });
    expect(h.pending).toHaveLength(1);
    expect(h.pending[0]).toMatchObject({ cwd: CHECKOUT, spawnId: "spawn-1" });
    expect(h.pending[0]?.handoff).toContain("親セッション parent から [Cc]");
    expect(h.pending[0]?.handoff).toContain("A を直す");
    expect(h.spawns[0]).toMatchObject({ provider: "codex", cwd: CHECKOUT, mode: "tab", spawnId: "spawn-1", title: "[Cc] A を直す。テストは書くだけ" });

    h.service.onChildRegistered({ parentSessionId: "parent", checkout: CHECKOUT, projectCode: "Cc" }, "child-1");
    expect(h.rows()[0]).toMatchObject({ status: "active", child_session_id: "child-1" });
    expect(h.injects.at(-1)?.text).toContain("担当は child-1");
    expect(h.lines.at(-1)?.text).toBe("担当: [Cc] .wt-x → <#thread-child-1>");
  });

  it("requested 行が無い repo-brief は手動 (02c) として受け付ける", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", brief("E:/Document/Ars/Memoria"));
    expect(h.rows()[0]).toMatchObject({ checkout: "E:/Document/Ars/Memoria", trigger: "manual", status: "spawning" });
  });

  it("担当がいる checkout への repo-brief は spawn せず子へ追加依頼として渡す (§3.5)", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    h.service.onChildRegistered({ parentSessionId: "parent", checkout: CHECKOUT, projectCode: "Cc" }, "child-1");
    await h.service.onAssistantText("parent", brief(CHECKOUT, "追加でこれも"));
    expect(h.spawns).toHaveLength(1);
    expect(h.injects.at(-1)).toMatchObject({ id: "child-1" });
    expect(h.injects.at(-1)?.text).toContain("追加でこれも");
  });

  it("不正な repo-brief は捨てて親へ理由を返す", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", "```repo-brief\n{broken\n```");
    expect(h.spawns).toEqual([]);
    expect(h.injects.at(-1)?.text).toContain("JSON として読めません");
  });

  it("spawn 失敗で spawn_failed・pending 破棄・親へ通知", async () => {
    const h = harness({ spawn: async () => ({ ok: false, error: "launcher missing" }) });
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    expect(h.rows()[0]).toMatchObject({ status: "spawn_failed", note: "launcher missing" });
    expect(h.forgotten).toEqual(["spawn-1"]);
    expect(h.injects.at(-1)?.text).toContain("立てられませんでした");
  });

  it("spawn 上限を超えた分は requested のまま保留し、 次の走査で立てる", async () => {
    const h = harness({ budget: 1 });
    await h.service.onAssistantText("parent", `${brief(CHECKOUT)}\n${brief("E:/Document/Ars/Memoria")}`);
    expect(h.spawns).toHaveLength(1);
    expect(h.rows().find((r) => r.checkout === "E:/Document/Ars/Memoria")).toMatchObject({ status: "requested", pending_brief: "A を直す。テストは書くだけ" });
    h.advance(61);
    await h.service.sweep(h.sessions.get("parent")!, false);
    expect(h.spawns).toHaveLength(2);
    expect(h.rows().find((r) => r.checkout === "E:/Document/Ars/Memoria")?.status).toBe("spawning");
  });

  it("担当上限で手動依頼を断り、 親へ伝える", async () => {
    const h = harness({ maxAgents: 1 });
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    await h.service.onAssistantText("parent", brief("E:/Document/Ars/Memoria"));
    expect(h.spawns).toHaveLength(1);
    expect(h.injects.at(-1)?.text).toContain("上限");
  });
});

describe("RepoAgentService: 時間切れ・終了・副契機", () => {
  it("brief timeout で brief_missing (子を立てない、 INV-5)", async () => {
    const h = harness();
    h.service.onGateDenied({ sessionId: "parent", hits: [DENY], cwd: CHECKOUT, filePath: null });
    h.advance(600);
    await h.service.sweep(h.sessions.get("parent")!, false);
    expect(h.rows()[0]?.status).toBe("brief_missing");
    expect(h.spawns).toEqual([]);
  });

  it("spawning のまま 5 分経てば spawn_failed (§8)", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    h.advance(300);
    await h.service.sweep(h.sessions.get("parent")!, false);
    expect(h.rows()[0]?.status).toBe("spawn_failed");
  });

  it("子の終了で行が ended になり、 親へ抜粋と PR 番号が届く", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    h.service.onChildRegistered({ parentSessionId: "parent", checkout: CHECKOUT, projectCode: "Cc" }, "child-1");
    h.sessions.set("child-1", row({ id: "child-1", repo_path: CHECKOUT, status: "ended",
      metadata: JSON.stringify({ repo_agent_of: { parent_session_id: "parent", checkout: CHECKOUT, project_code: "Cc" } }) }));
    h.service.onSessionEnded("child-1");
    expect(h.rows()[0]?.status).toBe("ended");
    const notice = h.injects.at(-1);
    expect(notice?.id).toBe("parent");
    expect(notice?.text).toContain("PR: #900");
    expect(h.lines.at(-1)?.text).toContain("担当終了");
  });

  it("親が畳まれていれば終了通知を送らない", async () => {
    const h = harness();
    await h.service.onAssistantText("parent", brief(CHECKOUT));
    h.service.onChildRegistered({ parentSessionId: "parent", checkout: CHECKOUT, projectCode: "Cc" }, "child-1");
    h.sessions.set("parent", { ...h.sessions.get("parent")!, status: "ended" });
    h.sessions.set("child-1", row({ id: "child-1", metadata: JSON.stringify({ repo_agent_of: { parent_session_id: "parent", checkout: CHECKOUT } }) }));
    const before = h.injects.length;
    h.service.onSessionEnded("child-1");
    expect(h.injects.length).toBe(before);
  });

  it("副契機: 待機中なら分岐リポを requested にして依頼の案内を 1 回だけ inject する (INV-3)", async () => {
    const h = harness();
    h.sessions.set("parent", row({ active_repos: JSON.stringify(["E:/Document/Ars", "E:/Document/Ars/Memoria", CHECKOUT]) }));
    await h.service.sweep(h.sessions.get("parent")!, false);
    expect(h.rows()).toEqual([]);
    await h.service.sweep(h.sessions.get("parent")!, true);
    expect(h.rows().map((r) => [r.checkout, r.trigger])).toEqual([["E:/Document/Ars/Memoria", "branch"], [CHECKOUT, "branch"]]);
    expect(h.injects).toHaveLength(1);
    await h.service.sweep(h.sessions.get("parent")!, true);
    expect(h.injects).toHaveLength(1);
  });
});
