/** @implements spec/feature/task-workflow-v3.md — CC-AT-TEAM-02 seal failure diagnostics */

import { describe, expect, it } from "vitest";
import { ActioTeamCandidatesError, ActioTeamSelectionError } from "../taskflow/actio-team-selection.js";
import { describeSealFailure, SEAL_FAILURE_ERROR } from "./seal-failure.js";

describe("describeSealFailure", () => {
  it("classifies known taskflow failures without raw exception text", () => {
    expect(describeSealFailure(new Error("Actio task service unavailable"))).toEqual({
      code: "actio_unavailable", message: "Actio の稼働状態を確認してください。",
    });
    const unknown = describeSealFailure(new Error("token=secret-value"));
    expect(unknown.code).toBe("taskflow_internal_error");
    expect(JSON.stringify(unknown)).not.toContain("secret-value");
  });

  it("names candidate teams and the actio_team_id hint for team failures", () => {
    const detail = describeSealFailure(new ActioTeamSelectionError(["team-a", "team-b"]));
    expect(detail).toMatchObject({ code: "actio_team_invalid", candidate_team_ids: ["team-a", "team-b"] });
    expect(detail.hint).toContain("actio_team_id");
    expect(describeSealFailure(new ActioTeamCandidatesError("Actio task request rejected (400)", ["team-a"])))
      .toMatchObject({ code: "actio_request_rejected", candidate_team_ids: ["team-a"] });
  });

  it("keeps the historical error text available for compatible callers", () => {
    expect(SEAL_FAILURE_ERROR).toBe("Actio task registration or execution claim failed; inspect the existing task/run before retry");
    expect(describeSealFailure(new Error("x")).message).not.toBe(SEAL_FAILURE_ERROR);
  });
});
