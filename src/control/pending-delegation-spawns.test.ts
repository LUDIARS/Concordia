import { describe, it, expect, beforeEach } from "vitest";
import {
  recordPendingDelegationSpawn,
  claimPendingDelegationSpawn,
  forgetPendingDelegationSpawnByRunId,
  _resetPendingDelegationSpawns,
} from "./pending-delegation-spawns.js";

describe("pending-delegation-spawns", () => {
  beforeEach(() => _resetPendingDelegationSpawns());

  it("cwd 完全一致で claim できる（絵文字 + call_name 付き）", () => {
    recordPendingDelegationSpawn({ cwd: "E:/Document/Ars", emoji: "🧪", callName: "test-impl" }, 1000);
    const got = claimPendingDelegationSpawn("E:/Document/Ars", 1001);
    expect(got?.emoji).toBe("🧪");
    expect(got?.callName).toBe("test-impl");
  });

  it("Windows の `\\` 区切り / 末尾スラッシュを正規化して一致", () => {
    recordPendingDelegationSpawn({ cwd: "E:\\Document\\Ars\\", emoji: "📦", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("E:/Document/Ars", 1001)?.emoji).toBe("📦");
  });

  it("repo_path が cwd 配下なら一致（AI が子ディレクトリへ移動）", () => {
    recordPendingDelegationSpawn({ cwd: "E:/Document/Ars", emoji: "🌳", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("E:/Document/Ars/Concordia", 1001)?.emoji).toBe("🌳");
  });

  it("claim は一度きり（同じ spawn を二重取得しない）", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "1", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.emoji).toBe("1");
    expect(claimPendingDelegationSpawn("/a", 1002)).toBeNull();
  });

  it("同 cwd 複数 spawn は最新を優先して claim", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "old", callName: "x" }, 1000);
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "new", callName: "y" }, 2000);
    expect(claimPendingDelegationSpawn("/a", 2001)?.emoji).toBe("new");
    expect(claimPendingDelegationSpawn("/a", 2002)?.emoji).toBe("old");
  });

  it("完全一致を子孫一致より優先", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "ancestor", callName: "x" }, 1000);
    recordPendingDelegationSpawn({ cwd: "/a/b", emoji: "exact", callName: "y" }, 1000);
    expect(claimPendingDelegationSpawn("/a/b", 1001)?.emoji).toBe("exact");
  });

  it("TTL 超過は expire して claim できない", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "1", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1000 + 5 * 60 * 1000 + 1)).toBeNull();
  });

  it("cwd 空は記録しない / repo_path 空は claim しない", () => {
    recordPendingDelegationSpawn({ cwd: "", emoji: "x", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("", 1001)).toBeNull();
    expect(claimPendingDelegationSpawn("/a", 1001)).toBeNull();
  });

  it("emoji 未設定 spawn も claim 可（emoji=null）", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: null, callName: "x" }, 1000);
    const got = claimPendingDelegationSpawn("/a", 1001);
    expect(got).not.toBeNull();
    expect(got?.emoji).toBeNull();
  });

  it("subsidiaryId を round-trip する（/spawn 子会社対応の要）", () => {
    recordPendingDelegationSpawn({ cwd: "/a", callName: "spawn", subsidiaryId: "sub-123" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.subsidiaryId).toBe("sub-123");
  });

  it("subsidiaryId 未設定は null（本社の通常 spawn）", () => {
    recordPendingDelegationSpawn({ cwd: "/a", emoji: "x", callName: "x" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.subsidiaryId).toBeNull();
  });

  it("round-trips runId for delegation run linkage", () => {
    recordPendingDelegationSpawn({ cwd: "/a", callName: "impl-from-design", runId: "run-123" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.runId).toBe("run-123");
  });

  it("forgets pending entries by runId", () => {
    recordPendingDelegationSpawn({ cwd: "/a", callName: "impl-from-design", runId: "run-123" }, 1000);
    forgetPendingDelegationSpawnByRunId("run-123");
    expect(claimPendingDelegationSpawn("/a", 1001)).toBeNull();
  });
});
