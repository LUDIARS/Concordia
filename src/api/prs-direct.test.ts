import { describe, expect, it, vi } from "vitest";
import { prsRouter, type PrsApiDeps } from "./prs.js";

const EMPTY_PRS = { list: () => [] } as never;

function post(app: ReturnType<typeof prsRouter>, body: Record<string, unknown>) {
  return app.request("http://localhost/local/direct", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/prs/local/direct", () => {
  it("returns 503 when direct submission is not wired", async () => {
    const app = prsRouter({ prs: EMPTY_PRS });
    const response = await post(app, { repo_path: "E:/Document/Ars/Concordia" });
    expect(response.status).toBe(503);
  });

  it("requires repo_path", async () => {
    const app = prsRouter({ prs: EMPTY_PRS, submitDirectLocalPr: vi.fn() });
    const response = await post(app, { branch: "feat/x" });
    expect(response.status).toBe(400);
  });

  it("passes trimmed inputs through and omits blank optionals", async () => {
    const submitDirectLocalPr = vi.fn(async () => ({ submitted: true as const, pullRequest: { id: "pr-1", number: 1, repository: "LUDIARS/Concordia" } }));
    const app = prsRouter({ prs: EMPTY_PRS, submitDirectLocalPr: submitDirectLocalPr as PrsApiDeps["submitDirectLocalPr"] });

    const response = await post(app, { repo_path: " E:/Document/Ars/Concordia ", branch: " ", session_id: "" });

    expect(response.status).toBe(200);
    expect(submitDirectLocalPr).toHaveBeenCalledWith({
      repoPath: "E:/Document/Ars/Concordia",
      branch: undefined,
      sessionId: undefined,
    });
    await expect(response.json()).resolves.toMatchObject({ submitted: true });
  });

  it("returns skip reasons as 200 so callers can see why nothing was submitted", async () => {
    const app = prsRouter({
      prs: EMPTY_PRS,
      submitDirectLocalPr: async () => ({ submitted: false as const, reason: "no_commits" }),
    });
    const response = await post(app, { repo_path: "E:/Document/Ars/Concordia" });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ submitted: false, reason: "no_commits" });
  });

  it("requires a session and strict boolean for direct fast-lane opt-in", async () => {
    const submitDirectLocalPr = vi.fn(async () => ({ submitted: false as const, reason: "no_commits" }));
    let active = true;
    const sessions = {
      findSession: (id: string) => id === "s-1" ? { id, status: active ? "active" : "ended" } : null,
      recentEvents: () => [],
      appendEvent: () => undefined,
    } as unknown as NonNullable<PrsApiDeps["sessions"]>;
    const app = prsRouter({ prs: EMPTY_PRS, sessions, submitDirectLocalPr });
    expect((await post(app, {
      repo_path: "E:/Document/Ars/Concordia",
      fast_lane: true,
    })).status).toBe(400);
    expect((await post(app, {
      repo_path: "E:/Document/Ars/Concordia",
      session_id: "s-1",
      fast_lane: "true",
    })).status).toBe(400);
    const accepted = await post(app, {
      repo_path: "E:/Document/Ars/Concordia",
      session_id: "s-1",
      fast_lane: true,
    });
    expect(accepted.status).toBe(200);
    expect(submitDirectLocalPr).toHaveBeenLastCalledWith(expect.objectContaining({
      sessionId: "s-1",
      fastLane: true,
    }));
    active = false;
    expect((await post(app, {
      repo_path: "E:/Document/Ars/Concordia",
      session_id: "s-1",
      fast_lane: true,
    })).status).toBe(403);
  });
});
