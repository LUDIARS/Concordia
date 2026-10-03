import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionMessagesRepo } from "../db/session-messages-repo.js";
import { SessionMessageService } from "./service.js";
import type { ConcordiaEvent } from "../events.js";

function turn(seq: number, status: string, timestamp: number, id = "turn-1"): ConcordiaEvent {
  return {type:"transcript.frame",target_session_id:"s1",seq,kind:"turn",payload:{status,timestamp,turn_id:id,text:"never relay"},ts:timestamp};
}
describe("durable response turn", () => {
  it("retains start seconds and edits the same row after service reconstruction", () => {
    const db = makeTestDb();
    try {
      const repo = new SessionMessagesRepo(db);
      const events: ConcordiaEvent[] = [];
      const deps = {repo,emit:(ev:ConcordiaEvent)=>events.push(ev),isFinalOnly:()=>true};
      const startedAt = Date.parse("2026-10-03T01:02:03Z") / 1000;
      new SessionMessageService(deps).project(turn(1,"started",startedAt));
      const first = repo.currentTurn("s1")!;
      expect(first.content).toContain("01:02:03");
      expect(first.content).not.toContain("never relay");
      const restarted = new SessionMessageService(deps);
      restarted.project(turn(1,"started",startedAt));
      restarted.project(turn(2,"completed",startedAt + 7));
      expect(repo.list("s1")).toHaveLength(1);
      expect(repo.currentTurn("s1")).toMatchObject({id:first.id,metadata:{turn_status:"completed",started_at:startedAt}});
      expect(events.filter(e=>e.type === "session.message").map(e=>e.type === "session.message" && e.op)).toEqual(["create","update"]);
    } finally {db.close();}
  });
  it("rejects stale, mismatched and invalid boundaries and clears lost-session state", () => {
    const db = makeTestDb();
    try {
      const repo = new SessionMessagesRepo(db);
      const service = new SessionMessageService({repo,emit:()=>{}});
      service.project(turn(3,"started",100));
      service.project(turn(2,"completed",101));
      service.project(turn(4,"completed",101,"other"));
      service.project(turn(5,"started",Number.MAX_VALUE,"other"));
      expect(repo.currentTurn("s1")?.metadata?.turn_status).toBe("started");
      service.project({type:"session.lost",session_id:"s1",ts:110} as ConcordiaEvent);
      expect(repo.currentTurn("s1")?.metadata?.turn_status).toBe("interrupted");
      service.project(turn(6,"started",120,"turn-2"));
      expect(repo.currentTurn("s1")?.metadata).toMatchObject({turn_id:"turn-2",started_at:120,ended_at:null});
    } finally {db.close();}
  });
});
