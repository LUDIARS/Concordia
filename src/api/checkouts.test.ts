import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { SessionsRepo } from "../db/sessions-repo.js";
import { TestingClaimsRepo } from "../db/testing-claims-repo.js";
import { checkoutsRouter } from "./checkouts.js";

const REPO_PATH = "E:/Document/Ars/Concordia";
const QUERY = `repo_origin=LUDIARS%2FConcordia&repo_path=${encodeURIComponent(REPO_PATH)}&branch=main`;

function setup() {
  const db = makeTestDb();
  const sessions = new SessionsRepo(db);
  const claims = new TestingClaimsRepo(db);
  const warnings: string[] = [];
  const app = checkoutsRouter({
    sessions,
    claims,
    resolveWorkspaceRoots: () => ["E:/Document/Ars"],
    log: { info: () => {}, warn: (m) => warnings.push(m), error: () => {} },
  });
  return { app, sessions, claims, warnings };
}

function addSession(sessions: SessionsRepo, id: string, repoPath: string, branch: string) {
  sessions.insertSession({
    id,
    provider: "claude-code",
    repo_path: repoPath,
    repo_origin: "LUDIARS/Concordia",
    branch,
    host: "test-host",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
    active_repos: [],
  });
}

describe("GET /v1/checkouts/lock", () => {
  it("掴み手が居なければ allowed:true を返す", async () => {
    const { app } = setup();
    const res = await app.request(`/lock?${QUERY}`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ allowed: true });
  });

  it("その checkout の active session が居れば理由と holders 付きで拒否する", async () => {
    const { app, sessions } = setup();
    addSession(sessions, "s-1", REPO_PATH, "main");
    const res = await app.request(`/lock?${QUERY}`);
    expect(res.status).toBe(200);
    const body = await res.json() as { allowed: boolean; reason: string; holders: { session_id: string }[] };
    expect(body.allowed).toBe(false);
    expect(body.reason).toBe("session_active");
    expect(body.holders.map((h) => h.session_id)).toEqual(["s-1"]);
  });

  it("その repo のサービスの testing claim があれば拒否する", async () => {
    const { app, claims } = setup();
    claims.claim({ service: "concordia", session_id: "s-test", note: "再起動確認", now: Math.floor(Date.now() / 1000) });
    const body = await (await app.request(`/lock?${QUERY}`)).json() as { allowed: boolean; reason: string };
    expect(body).toMatchObject({ allowed: false, reason: "testing_claim_active" });
  });

  it("資格情報付き origin は 400 + allowed:false で拒否し、原文をログへ出さない", async () => {
    const { app, warnings } = setup();
    const dirty = encodeURIComponent("https://user:ghp_secret@github.com/LUDIARS/Concordia.git");
    const res = await app.request(`/lock?repo_origin=${dirty}&repo_path=${encodeURIComponent(REPO_PATH)}&branch=main`);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      allowed: false, error: "invalid_repo_origin", reason: "credentials_present",
    });
    expect(warnings.join("\n")).not.toContain("ghp_secret");
  });

  it("必須クエリが欠けていれば 400 + allowed:false を返す", async () => {
    const { app } = setup();
    const res = await app.request(`/lock?repo_origin=LUDIARS%2FConcordia&branch=main`);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ allowed: false, error: "invalid_query" });
  });

  it("判断材料を取れなかったときは 500 + allowed:false を返す (allowed:true へ倒さない)", async () => {
    const { sessions, claims } = setup();
    const app = checkoutsRouter({
      sessions,
      claims,
      resolveWorkspaceRoots: () => { throw new Error("workspace roots unavailable"); },
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const res = await app.request(`/lock?${QUERY}`);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ allowed: false, error: "internal_error" });
  });

  it("testing claim を読めない構成では 503 + allowed:false を返す (404 で素通りさせない)", async () => {
    const { sessions } = setup();
    const app = checkoutsRouter({
      sessions,
      claims: undefined,
      resolveWorkspaceRoots: () => ["E:/Document/Ars"],
      log: { info: () => {}, warn: () => {}, error: () => {} },
    });
    const res = await app.request(`/lock?${QUERY}`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ allowed: false, error: "claims_unavailable" });
  });

  it("読み取り専用であること — 照会は testing claim を増やさない", async () => {
    const { app, claims } = setup();
    await app.request(`/lock?${QUERY}`);
    expect(claims.listUnreleased()).toEqual([]);
  });
});
