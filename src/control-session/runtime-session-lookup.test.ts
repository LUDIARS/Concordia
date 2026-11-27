/**
 * 回帰: 管制 runtime は sessions repo のメソッドを受け手ごと呼ぶ。
 * SessionsRepo.findSession は this.db を読むため、裸で渡すと巡回の途中 (送信判定) で TypeError になり、
 * 先頭行だけ分類されて後続行が止まり送信 0 件になっていた (2026-11-27 本社ログ 124 回)。
 *
 * @implements spec/feature/control-session.md §2 §4
 */
import { describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { SessionRow } from "../shared/types.js";
import { ControlBoardRepo } from "./board-repo.js";
import type { ControlInjectEvent } from "./instruction-dispatch.js";
import { createControlRuntime, type ControlRuntimeDeps } from "./runtime.js";

const MIN = 60;

function session(id: string): SessionRow {
  return {
    id, provider: "claude-code", repo_path: `E:/${id}`, repo_origin: "LUDIARS/Concordia", branch: `feat/${id}`, host: "h",
    started_at: 1, ended_at: null, status: "active", last_seen_at: 1, current_task: null, transcript_path: null,
    metadata: "{}", ws_clients: 1, target_project: null,
  } as SessionRow;
}

/** 本物の SessionsRepo と同じく、メソッドが this のフィールドを読む repo。裸で渡すと this が外れて落ちる。 */
class ThisBoundSessionsRepo {
  readonly lookups: string[] = [];
  constructor(private readonly rows: Map<string, SessionRow>) {}
  findAllActive(): SessionRow[] {
    return [...this.rows.values()];
  }
  findSession(id: string): SessionRow | null {
    this.lookups.push(id);
    return this.rows.get(id) ?? null;
  }
}

function buildRuntime(root: string, opts: { repo: ThisBoundSessionsRepo; idleSec: Map<string, number>; humanWait?: Set<string> }) {
  const nowMs = 2_000_000_000_000;
  const nowSec = Math.floor(nowMs / 1000);
  const db = makeTestDb();
  const values = new Map<string, string>();
  const emitted: ControlInjectEvent[] = [];
  const warnings: string[] = [];
  const deps: ControlRuntimeDeps = {
    db,
    settings: { get: (k) => values.get(k) ?? null, set: (k, v) => { values.set(k, v); }, delete: (k) => { values.delete(k); } },
    isEnabled: () => true,
    isBodyEnabled: () => false,
    sessions: opts.repo,
    projectOf: () => "Cc",
    latestStat: () => null,
    lastActivitySec: (id) => {
      const idle = opts.idleSec.get(id);
      return idle === undefined ? null : nowSec - idle;
    },
    probes: {
      isAutoCheckDisabled: () => false, hasPendingQuestion: () => false,
      isHumanWaitActive: (id) => opts.humanWait?.has(id) ?? false,
      isWaitingForHumanResponse: () => false, isAwaitingAsk: async () => false,
    },
    // 偽の送信口。実際のセッションへは何も送らない。
    inject: { canDeliver: () => true, emit: (event) => { emitted.push(event); } },
    injectToSession: () => true,
    spawn: async () => ({ ok: true }),
    enrollment: { record: () => {}, forget: () => {} },
    workspaceRoot: () => root,
    concordiaUrl: "http://127.0.0.1:1",
    runOneShot: async () => ({ ok: true, stdout: "" }),
    patrol: {
      listOpenLocalPrs: async () => [],
      runningDelegations: () => [],
      findLocalPrByBranch: async () => null,
      findRun: () => null,
      parentReceivedRunTerminal: () => false,
      transcriptContains: async (s, token) => emitted.some((e) => e.target_session_id === s.id && e.text.includes(token)),
      git: async () => ({ ok: true, stdout: "" }),
    },
    now: () => nowMs,
    log: { info: () => {}, warn: (message) => { warnings.push(message); } },
  };
  return { runtime: createControlRuntime(deps), board: new ControlBoardRepo(db), emitted, warnings };
}

describe("control runtime session lookup keeps the repo receiver", () => {
  it("patrol classifies the new row, the stalled row and the following row, and nudges only the stalled one once", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-lookup-"));
    try {
      const rows = new Map(["fresh", "stalled", "later"].map((id) => [id, session(id)] as const));
      const repo = new ThisBoundSessionsRepo(rows);
      const idleSec = new Map([["fresh", 1 * MIN], ["stalled", 107 * MIN], ["later", 1 * MIN]]);
      const { runtime, board, emitted, warnings } = buildRuntime(root, { repo, idleSec });

      await runtime.tick();

      expect(warnings.filter((w) => w.includes("control patrol failed"))).toEqual([]);
      for (const id of ["fresh", "stalled", "later"]) {
        expect(board.find(id)?.classified_at, id).not.toBeNull();
      }
      expect(board.find("stalled")?.status).toBe("stalled");
      expect(emitted.map((e) => e.target_session_id)).toEqual(["stalled"]);
      expect(repo.lookups).toContain("stalled");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("manual bulk instruction looks sessions up through the repo and keeps the existing gates", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-control-lookup-"));
    try {
      const rows = new Map(["w1", "hw"].map((id) => [id, session(id)] as const));
      const repo = new ThisBoundSessionsRepo(rows);
      const { runtime, emitted } = buildRuntime(root, { repo, idleSec: new Map(), humanWait: new Set(["hw"]) });

      const result = await runtime.api.dispatch({ targets: ["w1", "hw", "ghost"], text: "状況を報告して", origin: { kind: "human", label: "neco" } });

      expect(result.delivered).toEqual(["w1"]);
      expect(result.skipped).toEqual([
        { session_id: "hw", reason: "human_wait" },
        { session_id: "ghost", reason: "not_active" },
      ]);
      expect(emitted.map((e) => e.target_session_id)).toEqual(["w1"]);
      expect(repo.lookups).toEqual(expect.arrayContaining(["w1", "hw", "ghost"]));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
