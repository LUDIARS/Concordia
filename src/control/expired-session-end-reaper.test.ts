import { describe, expect, it, vi } from "vitest";
import { reapExpiredSessionEnds, type ExpiredSessionEndRepo } from "./expired-session-end-reaper.js";
import { SESSION_END_PENDING_AT_KEY } from "./session-end-process.js";
import type { StopResult } from "./stop-session.js";

const NOW = 2_000_000;
const GRACE = 300;

interface FakeRow {
  id: string;
  status: string;
  ws_clients: number;
  metadata: string | null;
}

/**
 * `findEndedWithPendingMarkerOlderThan` の契約 (ended / ws_clients=0 / マーカー経過超過) だけを
 * 再現する repo スタブ。last_seen_at を条件に含めないことが本修正の要点なので、
 * ここでも last_seen_at は一切参照しない。
 */
function fakeRepo(rows: FakeRow[]) {
  const merged: Array<{ id: string; patch: Record<string, unknown> }> = [];
  return {
    merged,
    rows,
    findEndedWithPendingMarkerOlderThan(cutoff: number, key: string) {
      return rows.filter((r) => {
        if (r.status !== "ended" || r.ws_clients > 0 || !r.metadata) return false;
        const marker = (JSON.parse(r.metadata) as Record<string, unknown>)[key];
        return typeof marker === "number" && marker < cutoff;
      });
    },
    findSession(id: string) {
      return rows.find((r) => r.id === id);
    },
    mergeMetadata(id: string, patch: Record<string, unknown>) {
      merged.push({ id, patch });
    },
  };
}

/** SessionRow の全項目は不要なので、必要な 3 メソッドだけの境界として渡す。 */
function asRepo(fake: ReturnType<typeof fakeRepo>): ExpiredSessionEndRepo {
  return fake as unknown as ExpiredSessionEndRepo;
}

function meta(markerAgeSec: number, pid = 4242): string {
  return JSON.stringify({
    [SESSION_END_PENDING_AT_KEY]: NOW - markerAgeSec,
    lictor_pid: pid,
    concordia_spawn_id: "00000000-0000-4000-8000-000000004242",
    start_iso: new Date((NOW - 10_000) * 1000).toISOString(),
  });
}

function stopDeps(overrides: Partial<{ alive: boolean; stopOk: boolean }> = {}) {
  const { alive = true, stopOk = true } = overrides;
  const stopProcess = vi.fn(async () => (stopOk ? { ok: true as const, method: "taskkill" as const } : { ok: false as const, error: "boom" }));
  return {
    deps: {
      isAlive: () => alive,
      stopProcess,
      // 世代照合を通すため、マーカーより十分古い起動時刻に見えるプロセスを返す。
      scanProcesses: async () => [
        { pid: 4242, kind: "lictor" as const, sessionId: null, ageSec: 10_000, cmd: "node bin/lictor.mjs" },
      ],
      nowSec: () => NOW,
    },
    stopProcess,
  };
}

describe("reapExpiredSessionEnds", () => {
  it("reclaims an ended session whose completion notice never arrived", async () => {
    const repo = fakeRepo([{ id: "s1", status: "ended", ws_clients: 0, metadata: meta(GRACE + 60) }]);
    const { deps, stopProcess } = stopDeps();

    const r = await reapExpiredSessionEnds({ repo: asRepo(repo), stopDeps: deps }, { dryRun: false, nowSec: NOW, graceSec: GRACE });

    expect(r.candidates).toEqual(["s1"]);
    expect(stopProcess).toHaveBeenCalledWith(4242);
    expect(r.stopped).toHaveLength(1);
    expect(repo.merged).toEqual([{ id: "s1", patch: { [SESSION_END_PENDING_AT_KEY]: null } }]);
  });

  it("leaves sessions still inside the grace window alone", async () => {
    const repo = fakeRepo([{ id: "s1", status: "ended", ws_clients: 0, metadata: meta(GRACE - 60) }]);
    const { deps, stopProcess } = stopDeps();

    const r = await reapExpiredSessionEnds({ repo: asRepo(repo), stopDeps: deps }, { dryRun: false, nowSec: NOW, graceSec: GRACE });

    expect(r.candidates).toEqual([]);
    expect(stopProcess).not.toHaveBeenCalled();
  });

  it("keeps the marker when the stop fails so the next tick retries", async () => {
    const repo = fakeRepo([{ id: "s1", status: "ended", ws_clients: 0, metadata: meta(GRACE + 60) }]);
    const { deps } = stopDeps({ stopOk: false });

    const r = await reapExpiredSessionEnds({ repo: asRepo(repo), stopDeps: deps }, { dryRun: false, nowSec: NOW, graceSec: GRACE });

    expect(r.failed).toHaveLength(1);
    expect(repo.merged).toEqual([]);
  });

  it("skips a session that reconnected between listing and stopping", async () => {
    const repo = fakeRepo([{ id: "s1", status: "ended", ws_clients: 0, metadata: meta(GRACE + 60) }]);
    const { deps, stopProcess } = stopDeps();
    // 抽出後に WS 再接続した状況を作る。
    const listed = repo.findEndedWithPendingMarkerOlderThan;
    repo.findEndedWithPendingMarkerOlderThan = (cutoff: number, key: string) => {
      const out = listed.call(repo, cutoff, key);
      repo.rows[0]!.ws_clients = 1;
      return out;
    };

    const r = await reapExpiredSessionEnds({ repo: asRepo(repo), stopDeps: deps }, { dryRun: false, nowSec: NOW, graceSec: GRACE });

    expect(r.candidates).toEqual(["s1"]);
    expect(stopProcess).not.toHaveBeenCalled();
    expect(r.stopped).toEqual([]);
  });

  it("lists candidates without stopping on dryRun", async () => {
    const repo = fakeRepo([{ id: "s1", status: "ended", ws_clients: 0, metadata: meta(GRACE + 60) }]);
    const { deps, stopProcess } = stopDeps();

    const r = await reapExpiredSessionEnds({ repo: asRepo(repo), stopDeps: deps }, { dryRun: true, nowSec: NOW, graceSec: GRACE });

    expect(r.candidates).toEqual(["s1"]);
    expect(stopProcess).not.toHaveBeenCalled();
    expect(repo.merged).toEqual([]);
  });
});
