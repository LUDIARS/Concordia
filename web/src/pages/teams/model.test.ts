import { describe, expect, it } from "vitest";
import type { DirectorCaseSummary, DirectorStepStatus } from "../../api.js";
import {
  blockedReasonLabel,
  blockedSteps,
  caseProgress,
  deriveCaseColumn,
  filterChannelsByTeam,
  fmtTokensShort,
  groupCasesByColumn,
  parseRepoLines,
} from "./model.js";

const steps = (...statuses: DirectorStepStatus[]) => statuses.map((status) => ({ status }));

describe("deriveCaseColumn", () => {
  it("classifies by blocked > active > terminal > pending", () => {
    expect(deriveCaseColumn([])).toBe("pending");
    expect(deriveCaseColumn(steps("pending", "pending"))).toBe("pending");
    expect(deriveCaseColumn(steps("active", "pending"))).toBe("active");
    expect(deriveCaseColumn(steps("completed", "pending"))).toBe("active");
    expect(deriveCaseColumn(steps("blocked", "active"))).toBe("blocked");
    expect(deriveCaseColumn(steps("completed", "completed"))).toBe("completed");
    expect(deriveCaseColumn(steps("completed", "cancelled"))).toBe("completed");
    expect(deriveCaseColumn(steps("cancelled"))).toBe("cancelled");
  });
});

describe("groupCasesByColumn", () => {
  it("buckets every case into exactly one column", () => {
    const entry = (id: string, ...statuses: DirectorStepStatus[]): DirectorCaseSummary => ({
      case: { id, title: id, goal: "", project: "p", session_id: null, team_id: "t", created_at: 1, updated_at: 1 },
      steps: statuses.map((status, index) => ({ id: `${id}-${index}`, sequence: index + 1, kind: "implement", title: "s", status, blocked_reason: null })),
    });
    const grouped = groupCasesByColumn([entry("a", "pending"), entry("b", "active"), entry("c", "completed")]);
    expect(grouped.pending.map((e) => e.case.id)).toEqual(["a"]);
    expect(grouped.active.map((e) => e.case.id)).toEqual(["b"]);
    expect(grouped.completed.map((e) => e.case.id)).toEqual(["c"]);
    expect(grouped.blocked).toEqual([]);
  });
});

describe("caseProgress", () => {
  it("counts completed steps over total", () => {
    expect(caseProgress(steps("completed", "active", "pending"))).toBe("1/3");
  });
});

describe("fmtTokensShort", () => {
  it("shortens token counts", () => {
    expect(fmtTokensShort(0)).toBe("0");
    expect(fmtTokensShort(999)).toBe("999");
    expect(fmtTokensShort(1234)).toBe("1.2k");
    expect(fmtTokensShort(2_500_000)).toBe("2.50M");
  });
});

describe("filterChannelsByTeam", () => {
  const channels = [{ sessionId: "a" }, { sessionId: "b" }];
  it("passes everything through when no team is selected", () => {
    expect(filterChannelsByTeam(channels, null)).toEqual(channels);
  });
  it("keeps only the team's sessions", () => {
    expect(filterChannelsByTeam(channels, ["b"])).toEqual([{ sessionId: "b" }]);
    expect(filterChannelsByTeam(channels, [])).toEqual([]);
  });
});

describe("parseRepoLines", () => {
  it("trims and drops empty lines", () => {
    expect(parseRepoLines(" LUDIARS/A \n\nLUDIARS/B\n")).toEqual(["LUDIARS/A", "LUDIARS/B"]);
  });
});

describe("blockedSteps", () => {
  const entry = (
    id: string,
    steps: Array<{
      status: DirectorStepStatus;
      reason?: DirectorCaseSummary["steps"][number]["blocked_reason"];
      title?: string;
    }>,
    updatedAt = 1,
  ): DirectorCaseSummary => ({
    case: { id, title: `${id} の目標`, goal: "", project: "p", session_id: null, team_id: "t", created_at: 1, updated_at: updatedAt },
    steps: steps.map((step, index) => ({
      id: `${id}-${index}`,
      sequence: index + 1,
      kind: "implement",
      title: step.title ?? "s",
      status: step.status,
      blocked_reason: step.reason ?? null,
    })),
  });

  it("止まっている工程だけを case 横断で拾う", () => {
    const result = blockedSteps([
      entry("a", [{ status: "completed" }, { status: "blocked", reason: "human-decision" }], 200),
      entry("b", [{ status: "active" }]),
      entry("c", [{ status: "blocked", reason: "internal-note" }], 100),
    ]);

    expect(result.map((row) => row.caseId)).toEqual(["c", "a"]);
    expect(result.map((row) => row.step.blocked_reason)).toEqual(["internal-note", "human-decision"]);
  });

  it("1 つの case に複数あれば全部出す", () => {
    // case 単位で 1 件に畳むと、 2 つ目以降の止まりが見えなくなる。
    const result = blockedSteps([
      entry("a", [{ status: "blocked", title: "一つ目" }, { status: "blocked", title: "二つ目" }]),
    ]);

    expect(result.map((row) => row.step.title)).toEqual(["一つ目", "二つ目"]);
  });

  it("止まっていなければ空", () => {
    expect(blockedSteps([entry("a", [{ status: "completed" }])])).toEqual([]);
  });

  it("case のタイトルと project を持ち回る (工程だけでは何の話か分からない)", () => {
    const [row] = blockedSteps([entry("a", [{ status: "blocked" }])]);
    expect(row.caseTitle).toBe("a の目標");
    expect(row.project).toBe("p");
  });
});

describe("blockedReasonLabel", () => {
  it("安全な分類だけを表示文へ変換する", () => {
    expect(blockedReasonLabel("run-failed")).toBe("委託 run が失敗");
    expect(blockedReasonLabel("human-decision")).toBe("人間の判断待ち");
    expect(blockedReasonLabel("internal-note")).toBe("詳細はケース内の記録を確認");
    expect(blockedReasonLabel(null)).toBe("理由の記録なし");
  });
});
