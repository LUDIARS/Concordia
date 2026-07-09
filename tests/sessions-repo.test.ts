import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { SessionsRepo } from "../src/db/sessions-repo.js";

function fresh(): SessionsRepo {
  const db = makeTestDb();
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

  it("findActivePeers matches by repo_path, excludes self and inactive", () => {
    const base = {
      provider: "claude-code" as const, repo_path: "/x",
      repo_origin: null, host: "h", started_at: 1, last_seen_at: 1,
      branch: "main", transcript_path: null, metadata: null,
    };
    repo.insertSession({ ...base, id: "a" });
    repo.insertSession({ ...base, id: "b" });
    repo.insertSession({ ...base, id: "c" });
    repo.setStatus("c", "ended", 2, 2);
    // 別 repo_path のセッションは peer に含まれない
    repo.insertSession({ ...base, id: "d", repo_path: "/y" });
    const peers = repo.findActivePeers("/x", "a");
    expect(peers.map((p) => p.id).sort()).toEqual(["b"]);
  });

  it("finds lost candidates by repo_path+host", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h1", started_at: 1, last_seen_at: 1,
      transcript_path: null, metadata: null,
    });
    repo.setStatus("a", "lost", 100);
    const cands = repo.findLostCandidates("/x", "h1");
    expect(cands.map((s) => s.id)).toEqual(["a"]);
    expect(repo.findLostCandidates("/x", "different-host")).toEqual([]);
    expect(repo.findLostCandidates("/other-path", "h1")).toEqual([]);
  });

  it("patchSession can update repo_path and repo_origin", () => {
    repo.insertSession({
      id: "a", provider: "claude-code", repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 1, last_seen_at: 1,
      transcript_path: null, metadata: null,
    });
    repo.patchSession("a", { repo_path: "/x/sub", repo_origin: "https://example/r.git" });
    const s = repo.findSession("a");
    expect(s?.repo_path).toBe("/x/sub");
    expect(s?.repo_origin).toBe("https://example/r.git");
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

  it("latestEventsByKind returns the newest matching event per session", () => {
    const base = {
      provider: "claude-code" as const,
      repo_path: "/x",
      repo_origin: null,
      branch: null,
      host: "h",
      started_at: 1,
      last_seen_at: 1,
      transcript_path: null,
      metadata: null,
    };
    repo.insertSession({ ...base, id: "a" });
    repo.insertSession({ ...base, id: "b" });
    repo.appendEvent({ session_id: "a", ts: 10, kind: "prompt", payload: { summary: "old" } });
    repo.appendEvent({ session_id: "a", ts: 20, kind: "edit", payload: { file: "f" } });
    repo.appendEvent({ session_id: "a", ts: 30, kind: "prompt", payload: { summary: "new" } });
    repo.appendEvent({ session_id: "b", ts: 15, kind: "prompt", payload: { summary: "other" } });

    const rows = repo.latestEventsByKind(["a", "b"], "prompt");
    const payloadBySession = new Map(rows.map((ev) => [ev.session_id, JSON.parse(ev.payload)]));
    expect(payloadBySession.get("a")).toEqual({ summary: "new" });
    expect(payloadBySession.get("b")).toEqual({ summary: "other" });
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

  it("purgeStale deletes stale lost rows but never rows with a live WS client", () => {
    const base = {
      provider: "claude-code" as const, repo_path: "/x", repo_origin: null,
      branch: null, host: "h", started_at: 0, last_seen_at: 10,
      transcript_path: null, metadata: null,
    };
    // 生きた WS を持つ lost セッション: purge すると reaper の保護が消え、
    // 動作中の process tree が「記録なき孤児」として kill される — 消してはいけない。
    repo.insertSession({ ...base, id: "alive" });
    expect(repo.incrementWsClients("alive")).toBe(1);
    // incrementWsClients は last_seen_at を現在時刻へ進めるため、 setStatus で
    // cutoff より古い last_seen に戻し「stale だが WS は生きている」状態を作る。
    repo.setStatus("alive", "lost", 10);
    // WS が居ない stale lost は従来どおり purge 対象。
    repo.insertSession({ ...base, id: "dead" });
    repo.setStatus("dead", "lost", 10);

    expect(repo.purgeStale(100)).toBe(1);
    expect(repo.findSession("alive")).not.toBeNull();
    expect(repo.findSession("dead")).toBeNull();
  });
});
