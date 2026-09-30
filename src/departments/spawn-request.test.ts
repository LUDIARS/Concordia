import { describe, expect, it } from "vitest";
import { applySpawnLaunch, readSpawnLaunchRequest } from "./spawn-request.js";

describe("readSpawnLaunchRequest", () => {
  it("reads explicit launch items and treats blanks as unspecified", () => {
    expect(readSpawnLaunchRequest({ template: "t", provider: " ", model: "opus", project: "Concordia", cwd: "" }))
      .toEqual({ template: "t", provider: null, model: "opus", reasoning_effort: null, project: "Concordia", cwd: null });
  });

  it("reads an effort given through runtime options", () => {
    expect(readSpawnLaunchRequest({ options: { effort: "max" } }).reasoning_effort).toBe("max");
    expect(readSpawnLaunchRequest({ options: { model_reasoning_effort: "low" } }).reasoning_effort).toBe("low");
  });
});

describe("applySpawnLaunch", () => {
  const launch = {
    template: "claude-opus-impl", provider: null, model: "opus",
    reasoning_effort: "high", project: "Concordia", cwd: null,
  };

  it("writes defaulted items and removes cleared ones", () => {
    const body = applySpawnLaunch({ mode: "tab", provider: "", department: "dept-1" }, launch);
    expect(body).toEqual({
      mode: "tab",
      department: "dept-1",
      template: "claude-opus-impl",
      model: "opus",
      project: "Concordia",
      reasoning_effort: "high",
      options: { reasoning_effort: "high" },
    });
  });

  it("does not inject the department effort when the request set one in options", () => {
    const body = applySpawnLaunch({ options: { effort: "low" } }, launch);
    expect(body.options).toEqual({ effort: "low" });
    expect(body.reasoning_effort).toBeUndefined();
  });

  it("does not mutate the original body", () => {
    const original = { template: "t" };
    applySpawnLaunch(original, launch);
    expect(original).toEqual({ template: "t" });
  });
});
