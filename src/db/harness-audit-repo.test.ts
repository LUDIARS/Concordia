import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { HarnessAuditRepo } from "./harness-audit-repo.js";

describe("harness audit repo", () => {
  let repo: HarnessAuditRepo;
  beforeEach(() => {
    repo = new HarnessAuditRepo(makeTestDb());
  });

  it("record → recent で取得できる", () => {
    const row = repo.record({
      session_id: "s1", project: "concordia", hook: "gate", event: "block",
      tool: "Bash", action: "git push", rule: "no-main-push", decision: "deny",
      reason: "main 直 push 禁止", detail: { hits: [] }, ms: 3,
    });
    expect(row.decision).toBe("deny");
    expect(row.event).toBe("block");
    const recent = repo.recent();
    expect(recent).toHaveLength(1);
    expect(recent[0].rule).toBe("no-main-push");
    expect(JSON.parse(recent[0].detail_json)).toEqual({ hits: [] });
  });

  it("session_id / decision / event でフィルタできる", () => {
    repo.record({ session_id: "s1", event: "gate", decision: "allow" });
    repo.record({ session_id: "s1", event: "block", decision: "deny" });
    repo.record({ session_id: "s2", event: "gate", decision: "warn" });

    expect(repo.recent({ session_id: "s1" })).toHaveLength(2);
    expect(repo.recent({ decision: "deny" })).toHaveLength(1);
    expect(repo.recent({ event: "gate" })).toHaveLength(2);
  });

  it("summary は decision 別件数を返す", () => {
    repo.record({ event: "gate", decision: "allow" });
    repo.record({ event: "gate", decision: "allow" });
    repo.record({ event: "block", decision: "deny" });
    const sum = Object.fromEntries(repo.summary().map((s) => [s.decision, s.count]));
    expect(sum.allow).toBe(2);
    expect(sum.deny).toBe(1);
  });

  it("recent は新しい順", () => {
    repo.record({ event: "gate", decision: "allow", reason: "first" });
    repo.record({ event: "gate", decision: "warn", reason: "second" });
    const recent = repo.recent();
    expect(recent[0].reason).toBe("second");
  });

  it("distinctEditedRepos は編集ツールが触った異なるリポ root を返す", () => {
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Edit", repo: "/repo/a" });
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Write", repo: "/repo/b" });
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Edit", repo: "/repo/a" }); // 重複は 1
    // Bash は編集ではないので集計対象外。
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Bash", repo: "/repo/c" });
    // 別セッションは混ざらない。
    repo.record({ session_id: "s2", event: "gate", decision: "allow", tool: "Edit", repo: "/repo/z" });

    expect(repo.distinctEditedRepos("s1").sort()).toEqual(["/repo/a", "/repo/b"]);
    expect(repo.distinctEditedRepos("s2")).toEqual(["/repo/z"]);
  });

  it("distinctEditedRepos は session_id 空なら空配列 (蓄積不能)", () => {
    repo.record({ session_id: "", event: "gate", decision: "allow", tool: "Edit", repo: "/repo/a" });
    expect(repo.distinctEditedRepos("")).toEqual([]);
  });

  it("editedFilePaths は編集ツールが触ったファイルパスの集合を返す (gate の editedFiles 供給)", () => {
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Edit", action: "/repo/a/x.ts" });
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Write", action: "/repo/a/y.ts" });
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Edit", action: "/repo/a/x.ts" }); // 重複は 1
    repo.record({ session_id: "s1", event: "gate", decision: "allow", tool: "Bash", action: "git status" }); // 編集でない
    repo.record({ session_id: "s2", event: "gate", decision: "allow", tool: "Edit", action: "/repo/z/z.ts" });

    expect(repo.editedFilePaths("s1").sort()).toEqual(["/repo/a/x.ts", "/repo/a/y.ts"]);
    expect(repo.editedFilePaths("")).toEqual([]);
  });
});
