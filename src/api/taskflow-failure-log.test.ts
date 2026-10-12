import { describe, expect, it, vi } from "vitest";
import { taskflowRouter } from "./taskflow.js";
import { describeTaskflowFailure } from "../taskflow/failure.js";
import { taskflowFailureLogFields } from "../taskflow/failure-diagnostics.js";
import type { TaskStore } from "../taskflow/store.js";

// vitest runs with `isolate: false`, so module mocks of the logger are unreliable here:
// the log fields are asserted through the pure builder that onError uses.
function appThrowing(error: unknown) {
  return taskflowRouter({
    store: { scan: vi.fn(async () => { throw error; }) } as unknown as TaskStore,
    state: {}, sessions: {}, delegation: {}, prs: {},
  } as unknown as Parameters<typeof taskflowRouter>[0]);
}

describe("taskflow onError diagnostic log", () => {
  it("adds type, redacted message and site for unclassified exceptions", () => {
    const error = new RangeError("bad offset token=s3cr3t");
    const fields = taskflowFailureLogFields(describeTaskflowFailure(error), error);
    expect(fields).toMatchObject({ reason: "taskflow_internal_error", status: 500, error_name: "RangeError" });
    expect(fields.error_message).toContain("bad offset");
    expect(JSON.stringify(fields)).not.toContain("s3cr3t");
    expect(fields.error_site).toMatch(/src\/api\/taskflow-failure-log\.test\.ts:\d+:\d+$/);
  });

  it("keeps known failures to reason and status only", () => {
    const error = new Error("Actio task service unavailable");
    expect(taskflowFailureLogFields(describeTaskflowFailure(error), error)).toEqual({ reason: "actio_unavailable", status: 503 });
  });

  it("does not change the API response for unclassified exceptions", async () => {
    const response = await appThrowing(new RangeError("bad offset token=s3cr3t")).request("/tasks");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "taskflow_actio_unavailable_or_invalid_scope", reason: "taskflow_internal_error" });
  });
});
