import { describe, expect, it } from "vitest";
import type { DirectorCaseSummary, DirectorStepStatus } from "../../api.js";
import {
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
      steps: statuses.map((status, index) => ({ id: `${id}-${index}`, sequence: index + 1, kind: "implement", title: "s", status })),
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
