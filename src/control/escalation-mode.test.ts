import { describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { makeTestDb } from "../../tests/helpers/db.js";
import { EscalationRepo } from "../db/escalation-repo.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TasksRepo } from "../db/tasks-repo.js";
import { STOP_CLAIM_KIND, endEscalation, selectStopClaimTargets, startEscalation } from "./escalation-mode.js";
import type { SessionRow } from "../shared/types.js";

function makeDeps(db: Database.Database) {
  return { sessions: new SessionsRepo(db), escalations: new EscalationRepo(db), tasks: new TasksRepo(db) };
}

function seed(db: Database.Database, id: string, status: "active" | "lost" = "active"): void {
  new SessionsRepo(db).insertSession({
    id,
    provider: "claude-code",
    repo_path: "/work/Concordia",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1_000,
    last_seen_at: 1_000,
    transcript_path: null,
    metadata: null,
  });
  if (status !== "active") db.prepare("UPDATE sessions SET status = ? WHERE id = ?").run(status, id);
}

function row(id: string, over: Partial<SessionRow> = {}): SessionRow {
  return {
    id,
    provider: "claude-code",
    repo_path: "/work/Concordia",
    repo_origin: null,
    branch: "main",
    host: "host",
    started_at: 1,
    ended_at: null,
    status: "active",
    last_seen_at: 1,
    current_task: null,
    transcript_path: null,
    metadata: null,
    ws_clients: 0,
    target_project: null,
    ...over,
  } as SessionRow;
}

describe("stop claim targeting", () => {
  it("skips the initiator, non-active sessions, and other escalation sessions", () => {
    const sessions = [
      row("initiator"),
      row("peer"),
      row("lost", { status: "lost" }),
      row("other-escalated", { escalation_mode: 1 }),
      row("escalated-by-id"),
    ];

    const targets = selectStopClaimTargets(sessions, ["escalated-by-id"], "initiator").map((s) => s.id);

    expect(targets).toEqual(["peer"]);
  });
});

describe("escalation start", () => {
  it("delivers a prioritised stop claim to every other active session", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer-a");
    seed(db, "peer-b");
    const deps = makeDeps(db);

    const result = startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });

    expect(result.stopped_session_ids.sort()).toEqual(["peer-a", "peer-b"]);
    const claim = deps.tasks.pull("peer-a", 10)[0];
    expect(claim.kind).toBe(STOP_CLAIM_KIND);
    expect(claim.priority).toBeGreaterThan(0);
    expect(JSON.parse(claim.payload).instruction).toContain("中断");
    // 停止であって巻き戻しではない — 破棄させない旨が本文に残る。
    expect(JSON.parse(claim.payload).instruction).toContain("破棄");
    expect(deps.tasks.pull("rescuer", 10)).toHaveLength(0);
  });

  it("puts the stop claim ahead of an already queued task", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    deps.tasks.enqueue({ session_id: "peer", kind: "chat-reply", payload: {}, now: 10 });

    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });

    expect(deps.tasks.pull("peer", 10).map((t) => t.kind)).toEqual([STOP_CLAIM_KIND, "chat-reply"]);
  });

  it("does not stop another escalation session", () => {
    const db = makeTestDb();
    seed(db, "rescuer-a");
    seed(db, "rescuer-b");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer-a", actor: "human", reason: "Cc down" });

    const second = startEscalation(deps, { session_id: "rescuer-b", actor: "human", reason: "Revisor down" });

    expect(second.stopped_session_ids).toEqual([]);
    expect(deps.tasks.pull("rescuer-a", 10)).toHaveLength(0);
  });

  it("replaces a stale undelivered claim instead of stacking a second one", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });
    endEscalation(deps, { session_id: "rescuer" });
    // 解除で消えた分を戻さずに、 未配送のまま残った状態を作り直す。
    deps.tasks.enqueue({ session_id: "peer", kind: STOP_CLAIM_KIND, payload: {} });

    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down again" });

    const claims = deps.tasks.pull("peer", 10).filter((t) => t.kind === STOP_CLAIM_KIND);
    expect(claims).toHaveLength(1);
    // 残っていた古い claim ではなく、 今の理由が届く。
    expect(JSON.parse(claims[0].payload).reason).toBe("Cc down again");
  });
});

describe("escalation release", () => {
  it("withdraws undelivered stop claims so a returning session is not stopped late", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });

    const result = endEscalation(deps, { session_id: "rescuer", note: "restored" });

    expect(result.withdrawn_claims).toBe(1);
    expect(result.event?.note).toBe("restored");
    // 復帰してから pull しても、 終わった停止の claim は届かない。
    expect(deps.tasks.pull("peer", 10)).toHaveLength(0);
  });

  it("keeps stop claims while another escalation session is still open", () => {
    const db = makeTestDb();
    seed(db, "rescuer-a");
    seed(db, "rescuer-b");
    seed(db, "peer");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer-a", actor: "human", reason: "Cc down" });
    startEscalation(deps, { session_id: "rescuer-b", actor: "human", reason: "Revisor down" });

    endEscalation(deps, { session_id: "rescuer-a" });

    expect(deps.tasks.pull("peer", 10).map((t) => t.kind)).toEqual([STOP_CLAIM_KIND]);
  });

  it("leaves delivered claims alone (the peer already stopped)", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });
    deps.tasks.pull("peer", 10);

    expect(endEscalation(deps, { session_id: "rescuer" }).withdrawn_claims).toBe(0);
  });

  it("does not let the retry pass re-deliver a claim from a released escalation", () => {
    const db = makeTestDb();
    seed(db, "rescuer");
    seed(db, "peer");
    const deps = makeDeps(db);
    startEscalation(deps, { session_id: "rescuer", actor: "human", reason: "Cc down" });
    // peer が claim を受け取った (= 停止した) 後にエスカレーションが解除される。
    deps.tasks.pull("peer", 10);

    endEscalation(deps, { session_id: "rescuer", note: "restored" });

    // 応答が無いまま retry 周期が回っても、 終わった停止は戻ってこない。
    deps.tasks.requeueForRetry({ retryAfterSec: 0 });
    expect(deps.tasks.pull("peer", 10)).toHaveLength(0);
  });
});
