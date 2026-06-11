import { describe, it, expect, beforeEach } from "vitest";
import { makeTestApp } from "./helpers/test-app.js";

function buildTestApp() {
  return makeTestApp();
}

describe("machines API", () => {
  let env: ReturnType<typeof buildTestApp>;
  beforeEach(() => { env = buildTestApp(); });

  it("GET /v1/machines aggregates sessions per host with per-status counts", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-A", "active");
    await seed(env, "s3", "DESKTOP-A", "ended");
    await seed(env, "s4", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { machines: Array<{ host: string; active: number; ended: number }> };
    const byHost = Object.fromEntries(j.machines.map((m) => [m.host, m]));
    expect(byHost["DESKTOP-A"]).toMatchObject({ active: 2, ended: 1 });
    expect(byHost["DESKTOP-B"]).toMatchObject({ active: 1, ended: 0 });
  });

  it("GET /v1/machines/:host returns sessions filtered by host", async () => {
    await seed(env, "s1", "DESKTOP-A", "active");
    await seed(env, "s2", "DESKTOP-B", "active");

    const r = await env.app.request("/v1/machines/DESKTOP-A");
    expect(r.status).toBe(200);
    const j = (await r.json()) as { host: string; sessions: Array<{ id: string }> };
    expect(j.host).toBe("DESKTOP-A");
    expect(j.sessions.map((s) => s.id).sort()).toEqual(["s1"]);
  });
});

async function seed(
  env: ReturnType<typeof buildTestApp>,
  id: string,
  host: string,
  status: "active" | "ended" | "lost" | "abandoned",
): Promise<void> {
  const now = Math.floor(Date.now() / 1000);
  env.repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/repo",
    repo_origin: null,
    branch: null,
    host,
    started_at: now,
    last_seen_at: now,
    transcript_path: null,
    metadata: null,
  });
  if (status !== "active") env.repo.setStatus(id, status, now, now);
}
