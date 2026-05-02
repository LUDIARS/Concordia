import { describe, it, expect, beforeEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../src/db/schema.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";

function fresh(): SessionsRepo {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new SessionsRepo(db);
}

describe("SessionsRepo", () => {
  let repo: SessionsRepo;
  beforeEach(() => { repo = fresh(); });

  it("inserts and finds a session", () => {
    repo.insertSession({
      id: "s1", provider: "claude-code", repo_path: "/tmp/foo",
      repo_origin: "https://github.com/x/foo", branch: "main", host: "h1",
      started_at: 100, last_seen_at: 100, transcript_path: null, metadata: null,
    });
    const s = repo.findSession("s1");
    expect(s?.status).toBe("active");
    expect(s?.host).toBe("h1");
  });

  it("findActivePeers excludes self and inactive", () => {
    const base = {
      provider: "claude-code" as const, repo_path: "/x",
      repo_origin: "origin", host: "h", started_at: 1, last_seen_at: 1,
      branch: "main", transcript_path: null, metadata: null,
    };
    repo.insertSession({ ...base, id: "a" });
    repo.insertSession({ ...base, id: "b" });
    repo.insertSession({ ...base, id: "c" });
    repo.setStatus("c", "ended", 2, 2);
    const peers = repo.findActivePeers("origin", "a");
    expect(peers.map((p) => p.id).sort()).toEqual(["b"]);
  });

  it("finds lost candidates by repo+host", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: "origin",
      branch: null, host: "h1", started_at: 1, last_seen_at: 1,
      transcript_path: null, metadata: null,
    });
    repo.setStatus("a", "lost", 100);
    const cands = repo.findLostCandidates("origin", "h1");
    expect(cands.map((s) => s.id)).toEqual(["a"]);
    expect(repo.findLostCandidates("origin", "different-host")).toEqual([]);
  });

  it("appendEvent + recentEvents", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 1, last_seen_at: 1,
      transcript_path: null, metadata: null,
    });
    repo.appendEvent({ session_id: "a", ts: 10, kind: "prompt", payload: { x: 1 } });
    repo.appendEvent({ session_id: "a", ts: 20, kind: "edit", payload: { file: "f" } });
    const ev = repo.recentEvents("a", 5);
    expect(ev).toHaveLength(2);
    expect(ev[0].kind).toBe("edit");
  });

  it("findStaleActive picks only active before cutoff", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 0, last_seen_at: 50,
      transcript_path: null, metadata: null,
    });
    repo.insertSession({
      id: "b", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 0, last_seen_at: 200,
      transcript_path: null, metadata: null,
    });
    const stale = repo.findStaleActive(100);
    expect(stale.map((s) => s.id)).toEqual(["a"]);
  });

  it("abandonLost flips lost rows older than cutoff", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 0, last_seen_at: 10,
      transcript_path: null, metadata: null,
    });
    repo.setStatus("a", "lost", 10);
    expect(repo.abandonLost(20)).toBe(1);
    expect(repo.findSession("a")?.status).toBe("abandoned");
  });
});
