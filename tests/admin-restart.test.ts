import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp() {
  return makeTestApp({ rng: () => 0.99 }).app;
}

describe("/v1/admin/restart", () => {
  beforeAll(() => { process.env.CONCORDIA_RESTART_DRY_RUN = "1"; });
  afterAll(() => { delete process.env.CONCORDIA_RESTART_DRY_RUN; });

  it("dry run returns ok without spawning or exiting", async () => {
    const app = makeApp();
    const r = await app.request("/v1/admin/restart", { method: "POST" });
    expect(r.status).toBe(200);
    const j = (await r.json()) as any;
    expect(j.ok).toBe(true);
    expect(j.dry_run).toBe(true);
  });
});
