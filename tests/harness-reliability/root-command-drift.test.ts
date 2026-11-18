import { describe, expect, it } from "vitest";
import { describeRootCommandDrift, nextRootCommandDrift, readRootCommandDrift, ROOT_COMMAND_DRIFT_KEY } from "../../src/harness/reliability/root-command-drift.js";
import { withRootCommandDrift } from "../../src/control-session/patrol.js";

/** TB-ROOT-DRIFT: 2026-11-18 neco 指示「管制というからにはちゃんと管理させたい」。 */
describe("TB-ROOT-DRIFT", () => {
  it("回数を数え、最後の checkout と rule で上書きする", () => {
    const first = nextRootCommandDrift(null, { repo: "E:/Document/Ars/Lictor", branch: "main", rules: ["task-branch", "task-branch"] }, 100);
    expect(first).toEqual({ count: 1, last_at: 100, last_repo: "E:/Document/Ars/Lictor", last_branch: "main", last_rules: ["task-branch"] });
    const second = nextRootCommandDrift(first, { repo: "E:\\Document\\Ars\\Actio", rules: ["outside-scope"] }, 200);
    expect(second).toMatchObject({ count: 2, last_at: 200, last_branch: null, last_rules: ["outside-scope"] });
  });

  it("metadata から読み、壊れた値・無い値は null", () => {
    const drift = nextRootCommandDrift(null, { repo: "E:/r", branch: "b", rules: ["max-repos"] }, 1);
    expect(readRootCommandDrift(JSON.stringify({ [ROOT_COMMAND_DRIFT_KEY]: drift }))).toEqual(drift);
    expect(readRootCommandDrift(null)).toBeNull();
    expect(readRootCommandDrift("{")).toBeNull();
    expect(readRootCommandDrift(JSON.stringify({ [ROOT_COMMAND_DRIFT_KEY]: { count: "x" } }))).toBeNull();
  });

  it("管制の分類理由にリポ名と branch と rule を添える。記録が無ければ理由はそのまま", () => {
    const drift = nextRootCommandDrift(null, { repo: "E:\\Document\\Ars\\Lictor\\", branch: "main", rules: ["task-branch"] }, 1);
    expect(describeRootCommandDrift(drift)).toBe("作業場所のずれ 1 回 (最終 Lictor@main: task-branch)");
    const metadata = JSON.stringify({ [ROOT_COMMAND_DRIFT_KEY]: drift });
    expect(withRootCommandDrift("無活動 25 分", metadata)).toBe("無活動 25 分 / 作業場所のずれ 1 回 (最終 Lictor@main: task-branch)");
    expect(withRootCommandDrift("無活動 25 分", null)).toBe("無活動 25 分");
  });
});
