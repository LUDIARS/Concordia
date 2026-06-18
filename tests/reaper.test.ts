import { describe, it, expect } from "vitest";
import {
  classifyKind,
  extractSessionId,
  parseWindowsProcLine,
  parsePosixProcLine,
  classifyOrphans,
  parseLictorPid,
  parseAgentClientPid,
  type RunningAgentProc,
} from "../src/control/reaper.js";

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
