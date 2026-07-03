import { describe, it, expect, beforeEach } from "vitest";
import type { SessionsRepo } from "../src/db/sessions-repo.js";
import { makeTestApp } from "./helpers/test-app.js";

function makeApp() {
  return makeTestApp({ rng: () => 0.99 });
}

function startSession(repo: SessionsRepo, id: string) {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: "/abs/Concordia",
    repo_origin: "github:LUDIARS/Concordia",
    branch: "main",
    host: "h",
    started_at: 1,
    last_seen_at: Math.floor(Date.now() / 1000),
    transcript_path: null,
    metadata: null,
  });
}

describe("/v1/monitor", () => {
  let env: ReturnType<typeof makeApp>;
  beforeEach(() => { env = makeApp(); });

  it("includes the last user prompt summary on active sessions", async () => {
    startSession(env.repo, "sess-a");
    env.repo.appendEvent({ session_id: "sess-a", ts: 10, kind: "prompt", payload: { summary: "first request" } });
    env.repo.appendEvent({ session_id: "sess-a", ts: 20, kind: "edit", payload: { file: "x" } });
    env.repo.appendEvent({ session_id: "sess-a", ts: 30, kind: "prompt", payload: { summary: "latest request" } });

    const r = await env.app.request("/v1/monitor");
    expect(r.status).toBe(200);
    const body = await r.json() as any;
    expect(body.active.find((s: any) => s.id === "sess-a")?.last_user_message).toBe("latest request");
  });
});
