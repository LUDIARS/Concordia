import { describe, expect, it } from "vitest";
import type { SessionRow } from "../../shared/types.js";
import { createAutoSuccessionWatcher, type AutoSuccessionWatcherPorts } from "./auto-succession-watcher.js";
import { createSpawnBudget } from "./spawn-budget.js";
import { readSuccessionSettings } from "./succession-settings.js";

const FINAL = { ts: 0, kind: "text", payload: { role: "assistant", text: "完了", phase: "final_answer" } };

function session(id: string, overrides: Partial<SessionRow> = {}): SessionRow {
  return {
    id, provider: "claude-code", repo_path: "E:/Document/Ars/Concordia", repo_origin: null, branch: null, host: "h",
    started_at: 0, ended_at: null, status: "active", last_seen_at: 0, current_task: null, transcript_path: null,
    metadata: null, ws_clients: 0, target_project: null, ...overrides,
  };
}

function harness(sessions: SessionRow[], tokens: Record<string, number | null>, options: { busy?: string[]; asking?: string[] } = {}) {
  const calls: string[] = [];
  const metadata = new Map<string, Record<string, unknown>>();
  let resolveHandover: (() => void) | null = null;
  let holdHandover = false;
  const ports: AutoSuccessionWatcherPorts = {
    listActiveSessions: () => sessions.map((s) => ({ ...s, metadata: metadata.has(s.id) ? JSON.stringify(metadata.get(s.id)) : s.metadata })),
    readContextTokens: async (s) => { calls.push(`read:${s.id}`); return tokens[s.id] ?? null; },
    lastFrame: (id) => (options.busy?.includes(id) ? { ts: 0, kind: "tool_use", payload: {} } : FINAL),
    isAwaitingHuman: async (s) => { calls.push(`awaiting:${s.id}`); return options.asking?.includes(s.id) ?? false; },
    isSessionEnding: () => false,
    recordAttempt: (id, patch) => { calls.push(`record:${id}`); metadata.set(id, { ...(metadata.get(id) ?? {}), ...patch }); },
    succession: {
      isInProgress: () => false,
      handover: async (id, options) => {
        calls.push(`handover:${id}:${options?.autoLabel}`);
        if (holdHandover) await new Promise<void>((resolve) => { resolveHandover = resolve; });
        return { ok: true, spawnCommand: [] };
      },
    },
    repoAgents: { sweep: async (s, idle) => { calls.push(`sweep:${s.id}:${idle}`); } },
    spawnBudget: createSpawnBudget(() => 1000),
    settings: () => readSuccessionSettings({}, () => undefined),
    now: () => 1000,
    log: { info: () => undefined, warn: () => undefined },
  };
  return {
    watcher: createAutoSuccessionWatcher(ports), calls, metadata,
    hold: () => { holdHandover = true; },
    release: () => resolveHandover?.(),
  };
}

describe("AutoSuccessionWatcher (§2.2)", () => {
  it("判定 → 記録 → 実行の順で呼ぶ", async () => {
    const h = harness([session("a")], { a: 720_000 });
    await h.watcher.tick();
    expect(h.calls).toEqual(["sweep:a:true", "read:a", "awaiting:a", "record:a", "handover:a:ctx 72%"]);
    expect(h.metadata.get("a")).toEqual({ auto_handover: { attempted_at: 1000, measure: { tokens: 720_000, pct: 0.72 } } });
  });

  it("1 走査の spawn 上限 (2) を守り、 超えた分は記録せず次の機会へ回す", async () => {
    const h = harness([session("a"), session("b"), session("c")], { a: 800_000, b: 800_000, c: 800_000 });
    await h.watcher.tick();
    expect(h.calls.filter((c) => c.startsWith("handover"))).toEqual(["handover:a:ctx 80%", "handover:b:ctx 80%"]);
    expect(h.metadata.has("c")).toBe(false);
  });

  it("試行済みのセッションは結果に関わらず再送しない (INV-1)", async () => {
    const h = harness([session("a")], { a: 800_000 });
    await h.watcher.tick();
    await h.watcher.tick();
    expect(h.calls.filter((c) => c.startsWith("handover"))).toHaveLength(1);
  });

  it("Codex・委託子は占有を読まずに飛ばす", async () => {
    const h = harness([
      session("codex", { provider: "codex-cli" }),
      session("child", { metadata: JSON.stringify({ delegation_run_id: "r1" }) }),
    ], { codex: 990_000, child: 990_000 });
    await h.watcher.tick();
    expect(h.calls.filter((c) => !c.startsWith("sweep"))).toEqual([]);
  });

  it("閾値未満・観測なし・作業中・人間待ちは実行しない (INV-2, INV-3)", async () => {
    const h = harness([session("low"), session("none"), session("busy"), session("ask")],
      { low: 699_999, none: null, busy: 800_000, ask: 800_000 }, { busy: ["busy"], asking: ["ask"] });
    await h.watcher.tick();
    expect(h.calls.filter((c) => c.startsWith("record") || c.startsWith("handover"))).toEqual([]);
    expect(h.calls).toContain("sweep:busy:false");
    // 返事待ちの判定 (transcript 末尾の読み取り) は、 他の条件を満たしたセッションだけで行う。
    expect(h.calls.filter((c) => c.startsWith("awaiting"))).toEqual(["awaiting:ask"]);
  });

  it("前の走査が進行中なら次の走査は何もしない", async () => {
    const h = harness([session("a")], { a: 800_000 });
    h.hold();
    const first = h.watcher.tick();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await h.watcher.tick();
    expect(h.calls.filter((c) => c.startsWith("sweep"))).toHaveLength(1);
    h.release();
    await first;
  });
});
