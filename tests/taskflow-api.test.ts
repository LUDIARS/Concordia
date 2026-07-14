import { describe, expect, it } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

describe("GET /v1/taskflow/overview", () => {
  it("returns a stable empty overview when no task md exists", async () => {
    const response = await makeTestApp().app.request("/v1/taskflow/overview");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      counts: {
        total: 0,
        pending: 0,
        delegated: 0,
        done: 0,
        cancelled: 0,
        ci_failure: 0,
        ci_pending: 0,
      },
      tasks: [],
    });
  });

  it("rejects an unknown status filter", async () => {
    const response = await makeTestApp().app.request("/v1/taskflow/overview?status=working");
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_status" });
  });
});
