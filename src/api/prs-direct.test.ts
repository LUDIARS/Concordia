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

  // 呼び出し側が {title, body} のようなオブジェクトを渡した実例がある。
  // typeof チェックだけで undefined へ落とすと、意図した本文が使われないまま
  // Revisor の自動生成本文で PR が作られ、呼び出し側はそれに気づけない。
  it("rejects a non-string pr_content instead of silently dropping it", async () => {
    const submitDirectLocalPr = vi.fn(async () => ({ ok: true }) as never);
    const app = prsRouter({ prs: EMPTY_PRS, submitDirectLocalPr });

    for (const prContent of [{ title: "t", body: "b" }, ["t"], 42, true, null]) {
      const response = await post(app, {
        repo_path: "E:/Document/Ars/Concordia",
        pr_content: prContent,
      });
      expect(response.status, JSON.stringify(prContent)).toBe(400);
      expect(await response.json()).toEqual({ error: "pr_content (string) required when provided" });
    }
    expect(submitDirectLocalPr).not.toHaveBeenCalled();
  });

  it("keeps treating an empty or blank pr_content as unset", async () => {
    // 空文字は「本文を指定しなかった」であって誤りではない。仕様どおり素通しする。
    const submitDirectLocalPr = vi.fn(async (
      _request: Parameters<NonNullable<PrsApiDeps["submitDirectLocalPr"]>>[0],
    ) => ({ ok: true }) as never);
    const app = prsRouter({ prs: EMPTY_PRS, submitDirectLocalPr });

    for (const prContent of ["", "   ", "\n"]) {
      const response = await post(app, {
        repo_path: "E:/Document/Ars/Concordia",
        pr_content: prContent,
      });
      expect(response.status).toBe(200);
    }
    for (const call of submitDirectLocalPr.mock.calls) {
      expect(call[0]).not.toHaveProperty("prContent");
    }
  });

  it("passes a non-empty pr_content through", async () => {
    const submitDirectLocalPr = vi.fn(async () => ({ ok: true }) as never);
    const app = prsRouter({ prs: EMPTY_PRS, submitDirectLocalPr });

    const response = await post(app, {
      repo_path: "E:/Document/Ars/Concordia",
      pr_content: "## 実装内容\n\n本文",
    });

    expect(response.status).toBe(200);
    expect(submitDirectLocalPr).toHaveBeenLastCalledWith(expect.objectContaining({
      prContent: "## 実装内容\n\n本文",
    }));
  });
});
