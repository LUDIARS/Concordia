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

  it("round-trips the branch resolved before Session registration", () => {
    recordPendingDelegationSpawn({ cwd: "/a", branch: "fix/branch-register", callName: "spawn" }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.branch).toBe("fix/branch-register");
  });

  it("claims concurrent same-cwd spawns by unique spawn id", () => {
    recordPendingDelegationSpawn({ cwd: "/a", spawnId: "spawn-main", branch: "main", callName: "spawn" }, 1000);
    recordPendingDelegationSpawn({ cwd: "/a", spawnId: "spawn-fix", branch: "fix/one", callName: "spawn" }, 1001);
    expect(claimPendingDelegationSpawn("/a", 1002, "spawn-main")?.branch).toBe("main");
    expect(claimPendingDelegationSpawn("/a", 1003, "spawn-fix")?.branch).toBe("fix/one");
  });

  it("round-trips parentSessionId for delegation parent linkage", () => {
    recordPendingDelegationSpawn({
      cwd: "/a",
      callName: "impl-from-design",
      runId: "run-123",
      parentSessionId: "parent-123",
    }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.parentSessionId).toBe("parent-123");
  });

  it("defaults goal-and-go ON and round-trips an explicit opt-out", () => {
    recordPendingDelegationSpawn({
      cwd: "/a",
      callName: "impl-from-design",
    }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.goalAndGo).toBe(true);
    recordPendingDelegationSpawn({
      cwd: "/b",
      callName: "one-shot",
      goalAndGo: false,
    }, 1002);
    expect(claimPendingDelegationSpawn("/b", 1003)?.goalAndGo).toBe(false);
  });

  it("round-trips the canonical team id", () => {
    recordPendingDelegationSpawn({
      cwd: "/a",
      callName: "impl-from-design",
      teamId: "team_123",
    }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.teamId).toBe("team_123");
  });

  it("round-trips the linked Memoria task", () => {
    recordPendingDelegationSpawn({
      cwd: "/a",
      callName: "impl-from-design",
      memoriaTaskId: 42,
      memoriaTaskTitle: "SampleLab task",
    }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)).toMatchObject({
      memoriaTaskId: 42,
      memoriaTaskTitle: "SampleLab task",
    });
  });

  it("round-trips the TestWorkflow surface correlation", () => {
    recordPendingDelegationSpawn({ cwd: "/a", callName: "spawn", testSurfaceId: 42 }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)?.testSurfaceId).toBe(42);
  });

  it("round-trips Discord requester, source post, and startup inject", () => {
    recordPendingDelegationSpawn({
      cwd: "/a",
      callName: "forum-spawn",
      requesterDiscordUserId: "123456789",
      sourceDiscordGuildId: "111111111",
      sourceDiscordChannelId: "222222222",
      startupInjectText: "Cc の修正",
    }, 1000);
    expect(claimPendingDelegationSpawn("/a", 1001)).toMatchObject({
      requesterDiscordUserId: "123456789",
      sourceDiscordGuildId: "111111111",
      sourceDiscordChannelId: "222222222",
      startupInjectText: "Cc の修正",
    });
  });

  it("forgets pending entries by runId", () => {
    recordPendingDelegationSpawn({ cwd: "/a", callName: "impl-from-design", runId: "run-123" }, 1000);
    forgetPendingDelegationSpawnByRunId("run-123");
    expect(claimPendingDelegationSpawn("/a", 1001)).toBeNull();
  });
});
