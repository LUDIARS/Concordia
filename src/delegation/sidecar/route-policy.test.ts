import { describe, expect, it, vi } from "vitest";
import { decideSidecarRoute, decideSidecarRouteDeterministic, type SidecarRouteInput } from "./route-policy.js";

const bounded: SidecarRouteInput = {
  kind: "ui_tweak",
  size: "small",
  acceptanceDefined: true,
  scopeDefined: true,
  sensitive: false,
  openQuestions: false,
};

describe("decideSidecarRouteDeterministic", () => {
  it("sends bounded work with defined acceptance to the sidecar", () => {
    expect(decideSidecarRouteDeterministic(bounded)).toEqual({
      route: "sidecar", reason: "bounded_work", uncertainty: "low", source: "deterministic", budgetMinutes: 20,
    });
  });

  it.each([
    [{ acceptanceDefined: false }, "clarify", "acceptance_undefined"],
    [{ openQuestions: true }, "clarify", "open_questions"],
    [{ sensitive: true }, "parent", "sensitive_change"],
    [{ kind: "cross_cutting_design" as const }, "parent", "cross_cutting_design"],
    [{ kind: "root_cause_unknown" as const }, "parent", "root_cause_unknown"],
    [{ scopeDefined: false }, "parent", "scope_undefined"],
    [{ size: "tiny" as const }, "parent", "too_small_to_delegate"],
  ])("keeps ambiguous or risky work away from the sidecar (%#)", (override, route, reason) => {
    expect(decideSidecarRouteDeterministic({ ...bounded, ...override })).toMatchObject({ route, reason });
  });

  it("leaves undecided cases to the classifier", () => {
    expect(decideSidecarRouteDeterministic({ ...bounded, kind: "other" })).toBeNull();
    expect(decideSidecarRouteDeterministic({ ...bounded, size: "large" })).toBeNull();
  });
});

describe("decideSidecarRoute", () => {
  const undecided = { ...bounded, kind: "other" as const };

  it("holds in the parent when no classifier is configured", async () => {
    expect(await decideSidecarRoute(undecided, null)).toMatchObject({ route: "parent", reason: "classifier_unavailable", uncertainty: "high" });
  });

  it("holds in the parent when the classifier fails or is not confident", async () => {
    const failing = { classify: vi.fn().mockRejectedValue(new Error("down")) };
    expect(await decideSidecarRoute(undecided, failing)).toMatchObject({ route: "parent", reason: "classifier_unavailable" });
    const unsure = { classify: vi.fn().mockResolvedValue({ route: "sidecar", confident: false, model: "m" }) };
    expect(await decideSidecarRoute(undecided, unsure)).toMatchObject({ route: "parent", reason: "classifier_uncertain", classifierModel: "m" });
  });

  it("uses a confident classifier decision and records the model", async () => {
    const sure = { classify: vi.fn().mockResolvedValue({ route: "sidecar", confident: true, model: "m" }) };
    expect(await decideSidecarRoute(undecided, sure)).toMatchObject({
      route: "sidecar", source: "classifier", classifierModel: "m", budgetMinutes: 20,
    });
  });

  it("does not call the classifier when the deterministic rules decide", async () => {
    const classifier = { classify: vi.fn() };
    await decideSidecarRoute(bounded, classifier);
    expect(classifier.classify).not.toHaveBeenCalled();
  });
});
