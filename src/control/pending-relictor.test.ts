import { describe, it, expect, beforeEach } from "vitest";
import { recordPendingRelictor, claimPendingRelictor, _resetPendingRelictor } from "./pending-relictor.js";

beforeEach(() => _resetPendingRelictor());

describe("pending-relictor", () => {
  it("cwd 完全一致で claim し handoff/goal を返す (claim は消費)", () => {
    recordPendingRelictor({ cwd: "E:/repo/Concordia", handoff: "資料", goal: { mode: "scoped", text: "#441" } });
    const claimed = claimPendingRelictor("E:/repo/Concordia");
    expect(claimed?.handoff).toBe("資料");
    expect(claimed?.goal).toEqual({ mode: "scoped", text: "#441" });
    // 2 回目は消費済みで null
    expect(claimPendingRelictor("E:/repo/Concordia")).toBeNull();
  });

  it("Windows の \\ と末尾スラッシュを正規化して一致", () => {
    recordPendingRelictor({ cwd: "E:\\repo\\Concordia\\", handoff: "h" });
    expect(claimPendingRelictor("E:/repo/Concordia")?.handoff).toBe("h");
  });

  it("cwd が repo_path の祖先でも一致 (AI が配下へ移動)", () => {
    recordPendingRelictor({ cwd: "E:/repo/Concordia", handoff: "h" });
    expect(claimPendingRelictor("E:/repo/Concordia/sub/dir")?.handoff).toBe("h");
  });

  it("無関係 cwd は null", () => {
    recordPendingRelictor({ cwd: "E:/repo/A", handoff: "h" });
    expect(claimPendingRelictor("E:/repo/B")).toBeNull();
  });

  it("TTL 超過は expire して claim されない", () => {
    recordPendingRelictor({ cwd: "E:/repo/A", handoff: "h" }, 0);
    expect(claimPendingRelictor("E:/repo/A", 10 * 60 * 1000)).toBeNull();
  });

  it("空 cwd は記録しない", () => {
    recordPendingRelictor({ cwd: "  ", handoff: "h" });
    expect(claimPendingRelictor("")).toBeNull();
  });
});
