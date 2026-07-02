import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { TestingClaimsRepo, TEST_CLAIM_TTL_SEC } from "./testing-claims-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: TestingClaimsRepo;
const NOW = 1_800_000_000;

beforeEach(() => {
  db = makeTestDb();
  repo = new TestingClaimsRepo(db);
});

describe("TestingClaimsRepo", () => {
  it("claim → listActive に載り、release で消える", () => {
    const { claim, conflicts } = repo.claim({ service: "concordia", session_id: "s1", note: "restart test", now: NOW });
    expect(claim.service).toBe("concordia");
    expect(conflicts).toEqual([]);
    expect(repo.listActive(NOW).map((c) => c.session_id)).toEqual(["s1"]);
    expect(repo.hasActiveClaim("s1", NOW)).toBe(true);

    expect(repo.release("s1", "concordia", NOW + 10)).toBe(1);
    expect(repo.listActive(NOW + 10)).toEqual([]);
    expect(repo.hasActiveClaim("s1", NOW + 10)).toBe(false);
  });

  it("同一サービスの他セッション claim は conflict として返る (宣言自体は成立)", () => {
    repo.claim({ service: "concordia", session_id: "s1", now: NOW });
    const { conflicts } = repo.claim({ service: "concordia", session_id: "s2", now: NOW + 5 });
    expect(conflicts.map((c) => c.session_id)).toEqual(["s1"]);
    // 両方 active (advisory — 強制ロックしない)
    expect(repo.listActive(NOW + 5).map((c) => c.session_id).sort()).toEqual(["s1", "s2"]);
  });

  it("同一セッションの再 claim は旧 claim を上書きする", () => {
    repo.claim({ service: "concordia", session_id: "s1", note: "old", now: NOW });
    const { conflicts } = repo.claim({ service: "concordia", session_id: "s1", note: "new", now: NOW + 5 });
    expect(conflicts).toEqual([]);
    const active = repo.listActive(NOW + 5);
    expect(active).toHaveLength(1);
    expect(active[0]!.note).toBe("new");
  });

  it("TTL を過ぎた放置 claim は active から外れる", () => {
    repo.claim({ service: "memoria", session_id: "s1", now: NOW });
    expect(repo.listActive(NOW + TEST_CLAIM_TTL_SEC + 1)).toEqual([]);
    expect(repo.hasActiveClaim("s1", NOW + TEST_CLAIM_TTL_SEC + 1)).toBe(false);
  });

  it("release(service 省略) はそのセッションの全 claim を解放する", () => {
    repo.claim({ service: "a", session_id: "s1", now: NOW });
    repo.claim({ service: "b", session_id: "s1", now: NOW });
    expect(repo.release("s1", null, NOW + 1)).toBe(2);
    expect(repo.listActive(NOW + 1)).toEqual([]);
  });
});
