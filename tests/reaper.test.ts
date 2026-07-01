import { describe, it, expect } from "vitest";
import {
  classifyKind,
  extractSessionId,
  parseWindowsProcLine,
  parsePosixProcLine,
  classifyOrphans,
  liveSetsFromRepo,
  parseLictorPid,
  parseAgentClientPid,
  type RunningAgentProc,
} from "../src/control/reaper.js";
import type { SessionsRepo } from "../src/db/sessions-repo.js";

describe("classifyKind", () => {
  it("lictor.mjs を lictor に分類", () => {
    expect(classifyKind('"node" "C:\\Users\\x\\npm\\node_modules\\@ludiars\\lictor\\bin\\lictor.mjs"')).toBe("lictor");
  });
  it("concordia-agent-client を agent-client に分類 (lictor より優先)", () => {
    expect(classifyKind("node E:/Ars/Concordia/tools/concordia-agent-client.mjs --session s1")).toBe("agent-client");
  });
  it("無関係な node は null", () => {
    expect(classifyKind("node E:/Ars/Memoria/server/index.js")).toBeNull();
  });
});

describe("extractSessionId", () => {
  it("--session <id> を抽出", () => {
    expect(extractSessionId("node client.mjs --session lictor-abc123 --log x")).toBe("lictor-abc123");
  });
  it("-s <id> も対応", () => {
    expect(extractSessionId("node client.mjs -s sess-9")).toBe("sess-9");
  });
  it("無ければ null", () => {
    expect(extractSessionId("node client.mjs")).toBeNull();
  });
});

describe("parseWindowsProcLine", () => {
  it("pid<TAB>age<TAB>cmd を parse し lictor を返す", () => {
    const r = parseWindowsProcLine('1234\t600\t"node" "x\\lictor\\bin\\lictor.mjs"');
    expect(r).toMatchObject({ pid: 1234, ageSec: 600, kind: "lictor", sessionId: null });
  });
  it("agent-client は sessionId を埋める", () => {
    const r = parseWindowsProcLine("999\t30\tnode tools/concordia-agent-client.mjs --session s7");
    expect(r).toMatchObject({ pid: 999, ageSec: 30, kind: "agent-client", sessionId: "s7" });
  });
  it("対象外 node は null", () => {
    expect(parseWindowsProcLine("5\t10\tnode server.js")).toBeNull();
  });
});

describe("parsePosixProcLine", () => {
  it("ps の pid etimes args を parse", () => {
    const r = parsePosixProcLine("  4242   900 node /ars/Lictor/bin/lictor.mjs");
    expect(r).toMatchObject({ pid: 4242, ageSec: 900, kind: "lictor" });
  });
});

describe("parseLictorPid", () => {
  it("metadata JSON から lictor_pid を取る", () => {
    expect(parseLictorPid('{"lictor_pid":31868,"lictor_port":51200}')).toBe(31868);
  });
  it("壊れた JSON / 欠落は null", () => {
    expect(parseLictorPid("not json")).toBeNull();
    expect(parseLictorPid('{"x":1}')).toBeNull();
    expect(parseLictorPid(null)).toBeNull();
  });
  it("agent_client_pid も同様に取れる", () => {
    expect(parseAgentClientPid('{"lictor_pid":1,"agent_client_pid":4242}')).toBe(4242);
    expect(parseAgentClientPid('{"lictor_pid":1}')).toBeNull();
    expect(parseAgentClientPid(null)).toBeNull();
  });
});

describe("classifyOrphans (誤爆防止が核心)", () => {
  const procs: RunningAgentProc[] = [
    { pid: 100, kind: "lictor", sessionId: null, ageSec: 600, cmd: "lictor.mjs" }, // live
    { pid: 200, kind: "lictor", sessionId: null, ageSec: 600, cmd: "lictor.mjs" }, // orphan
    { pid: 300, kind: "lictor", sessionId: null, ageSec: 30, cmd: "lictor.mjs" }, // 若すぎ → 見送り
    { pid: 400, kind: "agent-client", sessionId: "live-sess", ageSec: 600, cmd: "client --session live-sess" }, // live
    { pid: 500, kind: "agent-client", sessionId: "dead-sess", ageSec: 600, cmd: "client --session dead-sess" }, // orphan
    { pid: 600, kind: "agent-client", sessionId: null, ageSec: 600, cmd: "client" }, // session 無し → orphan
  ];
  const liveLictorPids = new Set<number>([100]);
  const liveSessionIds = new Set<string>(["live-sess"]);

  it("live な lictor_pid / session は孤児にしない", () => {
    const orphans = classifyOrphans(procs, liveLictorPids, liveSessionIds, 180);
    const pids = orphans.map((o) => o.pid).sort((a, b) => a - b);
    expect(pids).toEqual([200, 500, 600]);
  });

  it("minAgeSec 未満は対象外 (起動直後の登録レース回避)", () => {
    const orphans = classifyOrphans(procs, liveLictorPids, liveSessionIds, 180);
    expect(orphans.find((o) => o.pid === 300)).toBeUndefined();
  });

  it("lost セッションを live 扱いにすれば殺さない (呼び出し側が active+lost を渡す前提)", () => {
    // pid 200 を live に含めると孤児から外れる
    const orphans = classifyOrphans(procs, new Set([100, 200]), liveSessionIds, 180);
    expect(orphans.find((o) => o.pid === 200)).toBeUndefined();
  });
});

describe("liveSetsFromRepo (session-end 進行中の保護 = 安全弁)", () => {
  type Row = { id: string; status: string; metadata: string | null; ended_at: number | null };
  const makeRepo = (rows: Row[]): SessionsRepo =>
    ({
      listSessions: ({ status }: { status?: string }) => rows.filter((r) => r.status === status),
    }) as unknown as SessionsRepo;

  const now = 10_000;
  const rows: Row[] = [
    { id: "active-1", status: "active", metadata: '{"lictor_pid":11,"agent_client_pid":111}', ended_at: null },
    // ended から 60s (grace 内) — 保護される
    { id: "ending-fresh", status: "ended", metadata: '{"lictor_pid":22}', ended_at: now - 60 },
    // ended から 600s (grace 超) — 保護されない
    { id: "ending-stale", status: "ended", metadata: '{"lictor_pid":33}', ended_at: now - 600 },
  ];

  it("grace 無しでは active/lost のみ live (ended は含めない)", () => {
    const { lictorPids, sessionIds } = liveSetsFromRepo(makeRepo(rows));
    expect([...sessionIds]).toEqual(["active-1"]);
    expect([...lictorPids]).toEqual([11]);
  });

  it("grace 内の ended は live 扱いで保護され、 grace 超の ended は保護しない", () => {
    const { lictorPids, sessionIds } = liveSetsFromRepo(makeRepo(rows), { nowSec: now, graceSec: 300 });
    expect(sessionIds.has("ending-fresh")).toBe(true); // session-end 途中 → 殺さない
    expect(lictorPids.has(22)).toBe(true);
    expect(sessionIds.has("ending-stale")).toBe(false); // grace 超 → 回収対象
    expect(lictorPids.has(33)).toBe(false);
  });

  it("graceSec=0 (無効) なら ended は一切保護しない", () => {
    const { sessionIds } = liveSetsFromRepo(makeRepo(rows), { nowSec: now, graceSec: 0 });
    expect(sessionIds.has("ending-fresh")).toBe(false);
  });
});
