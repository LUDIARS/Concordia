import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import type { SpawnRequest, SpawnResult } from "../spawner.js";
import {
  createSessionSuccessionService,
  handoverHeading,
  type SessionSuccessionPorts,
} from "./session-succession-service.js";
import { authorHandoffBySession, HANDOVER_REQUEST_SOURCE } from "./session-handoff-author.js";

function session(overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id: "s1", provider: "claude-code", repo_path: "E:/Document/Ars/Concordia/.wt-a", repo_origin: null, branch: "feat/a",
    host: "h", started_at: 100, ended_at: null, status: "active", last_seen_at: 100, current_task: "作業",
    transcript_path: null, metadata: JSON.stringify({ lictor_port: 5000 }), ws_clients: 0, target_project: null,
    ...overrides,
  };
}

function harness(options: { session?: SessionRow | null; spawn?: (req: SpawnRequest) => Promise<SpawnResult>; lictor?: boolean } = {}) {
  const calls: string[] = [];
  const recorded: Array<{ spawnId: string; kind: string; cwd: string; handoff: string }> = [];
  const forgotten: string[] = [];
  const posts: string[] = [];
  const spawns: SpawnRequest[] = [];
  const statuses: Array<{ id: string; status: string }> = [];
  let row: SessionRow | null = options.session === undefined ? session() : options.session;
  let release: (() => void) | null = null;
  const ports: SessionSuccessionPorts = {
    sessions: {
      findSession: () => row,
      setStatus: (id, status) => { statuses.push({ id, status }); if (row) row = { ...row, status }; },
      appendEvent: () => { calls.push("appendEvent"); },
    },
    toSpawnProvider: (provider) => (provider === "claude-code" ? "claude" : provider === "codex-cli" ? "codex" : null),
    resolveLictorPort: () => (options.lictor === false ? { error: "no port" } : { port: 5000 }),
    authorHandoffBySession: async () => { calls.push("author"); return "自筆の資料"; },
    generateDetachedHandoff: async () => {
      calls.push("detached");
      await new Promise<void>((resolve) => { release = resolve; });
      return "切り離し資料";
    },
    postHandoff: async (_id, markdown) => { posts.push(markdown); },
    readGoal: () => null,
    recordPendingSuccession: (input) => { calls.push("record"); recorded.push(input); },
    forgetPendingSuccession: (spawnId) => { forgotten.push(spawnId); },
    spawn: async (request) => {
      calls.push("spawn");
      spawns.push(request);
      return options.spawn ? options.spawn(request) : { ok: true, command: ["lictor"], pid: 1 };
    },
    emitEnded: () => { calls.push("emitEnded"); },
    forceExit: async () => { calls.push("forceExit"); },
    scheduleInsuranceKill: () => { calls.push("insurance"); },
    newSpawnId: () => "spawn-1",
    now: () => 200,
    log: { info: () => undefined, warn: () => undefined },
  };
  return { ports, calls, recorded, forgotten, posts, spawns, statuses, release: () => release?.() };
}

describe("SessionSuccessionService (§2.2)", () => {
  it("handover: 自筆 handoff → 投稿 → spawn ID で登録 → spawn → 旧セッション ended → force-exit → 保険 kill の順", async () => {
    const h = harness();
    const result = await createSessionSuccessionService(h.ports).handover("s1");
    expect(result).toEqual({ ok: true, spawnCommand: ["lictor"] });
    expect(h.calls).toEqual(["author", "record", "spawn", "appendEvent", "emitEnded", "forceExit", "insurance"]);
    expect(h.recorded).toEqual([{ cwd: "E:/Document/Ars/Concordia/.wt-a", spawnId: "spawn-1", handoff: "自筆の資料", goal: null, kind: "handover" }]);
    expect(h.spawns[0]).toMatchObject({ provider: "claude", cwd: "E:/Document/Ars/Concordia/.wt-a", mode: "tab", spawnId: "spawn-1" });
    expect(h.statuses).toEqual([{ id: "s1", status: "ended" }]);
    expect(h.posts[0]).toBe("🤝 **次セッション引き継ぎ資料 (handover)**\n\n自筆の資料");
  });

  it("自動起動の見出しは契機を示す", async () => {
    const h = harness();
    await createSessionSuccessionService(h.ports).handover("s1", { autoLabel: "ctx 72%" });
    expect(h.posts[0]?.startsWith("🤝 **次セッション引き継ぎ資料 (自動: ctx 72%)**")).toBe(true);
    expect(handoverHeading()).toBe("🤝 **次セッション引き継ぎ資料 (handover)**");
  });

  it("後継は旧セッションと同じ provider で立てる (Codex → codex)", async () => {
    const h = harness({ session: session({ provider: "codex-cli" }) });
    await createSessionSuccessionService(h.ports).handover("s1");
    expect(h.spawns[0]?.provider).toBe("codex");
  });

  it("spawn 失敗は 500 で pending を破棄し、 旧セッションを畳まない (回帰)", async () => {
    const h = harness({ spawn: async () => ({ ok: false, error: "boom" }) });
    const result = await createSessionSuccessionService(h.ports).handover("s1");
    expect(result).toEqual({ ok: false, status: 500, error: "spawn failed: boom" });
    expect(h.forgotten).toEqual(["spawn-1"]);
    expect(h.statuses).toEqual([]);
    expect(h.calls).not.toContain("forceExit");
  });

  it("同じセッションの継承が進行中なら 409 (回帰)", async () => {
    const h = harness();
    const service = createSessionSuccessionService(h.ports);
    const first = service.relictor("s1");
    await Promise.resolve();
    expect(service.isInProgress("s1")).toBe(true);
    expect(await service.handover("s1")).toEqual({ ok: false, status: 409, error: "session succession already in progress" });
    h.release();
    expect((await first).ok).toBe(true);
    expect(service.isInProgress("s1")).toBe(false);
    expect(h.posts[0]?.startsWith("🔁 **再起動引き継ぎ資料 (relictor)**")).toBe(true);
  });

  it.each([
    ["not_found", { session: null }, 404, "not_found"],
    ["inactive", { session: session({ status: "ended" }) }, 400, "session is ended"],
    ["not spawnable", { session: session({ provider: "gemini-cli" }) }, 400, "provider gemini-cli is not spawnable"],
    ["not lictor", { lictor: false }, 400, "not lictor-wrapped: no port"],
  ] as const)("前提を満たさなければ拒否する (%s)", async (_name, options, status, error) => {
    const h = harness(options);
    expect(await createSessionSuccessionService(h.ports).handover("s1")).toEqual({ ok: false, status, error });
    expect(h.calls).toEqual([]);
  });

  it("投稿が失敗しても移行は続ける", async () => {
    const h = harness();
    h.ports.postHandoff = async () => { throw new Error("chat down"); };
    expect((await createSessionSuccessionService(h.ports).handover("s1")).ok).toBe(true);
  });
});

describe("authorHandoffBySession", () => {
  const ports = (elicited: string | null, asked = true) => {
    const injected: string[] = [];
    return {
      injected,
      value: {
        transcriptMaxId: () => 42,
        inject: async (_id: string, _text: string, source: string) => { injected.push(source); return asked; },
        elicit: async (_id: string, watermark: number) => (watermark === 42 ? elicited : null),
        generateDetached: async () => "切り離し",
        log: { warn: () => undefined },
      },
    };
  };

  it("依頼を inject し、 watermark 以降の自筆を返す", async () => {
    const p = ports("自筆");
    expect(await authorHandoffBySession(p.value, session())).toBe("自筆");
    expect(p.injected[0]).toBe(HANDOVER_REQUEST_SOURCE);
  });

  it("捕捉できなければ切り離し生成へフォールバックし、 空にしない", async () => {
    expect(await authorHandoffBySession(ports(null).value, session())).toBe("切り離し");
    expect(await authorHandoffBySession(ports("自筆", false).value, session())).toBe("切り離し");
  });
});
