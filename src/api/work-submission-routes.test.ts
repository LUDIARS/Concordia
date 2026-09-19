import { expect, it, vi } from "vitest";
import type { ImplementationToolsService } from "../implementation-tools/service.js";
import { implementationToolsRouter } from "./implementation-tools.js";

const REVISOR_ROUTE = {
  route: "revisor-local-pr", allowsGithubPr: false, allowsBranchPush: false,
  submitEndpoint: "/v1/implementation-tools/submit", guidance: "…", project_code: "Cc",
};

function router(tools: Partial<ImplementationToolsService>) {
  return implementationToolsRouter({
    tools: tools as ImplementationToolsService,
    requestPolicyRefresh: vi.fn(),
  });
}

const post = (app: ReturnType<typeof router>, path: string, body: unknown) => app.request(path, {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
});

it("returns the guard rejection with 409 instead of reporting a commit that did not happen", async () => {
  const commitWork = vi.fn(async () => ({ ok: false as const, code: "protected_branch" as const, detail: "main" }));
  const app = router({ commitWork });
  const response = await post(app, "/commit", { session_id: "s1", message: "fix: x" });
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ ok: false, code: "protected_branch" });

  commitWork.mockResolvedValueOnce({ ok: true, sha: "abc", files: 2 } as never);
  const ok = await post(app, "/commit", { session_id: "s1", message: "fix: x", paths: ["src/a.ts"] });
  expect(ok.status).toBe(200);
  expect(commitWork).toHaveBeenLastCalledWith({ sessionId: "s1", message: "fix: x", paths: ["src/a.ts"] });
});

it("rejects a commit without a message before reaching the service", async () => {
  const commitWork = vi.fn();
  const response = await post(router({ commitWork }), "/commit", { session_id: "s1", message: "" });
  expect(response.status).toBe(400);
  expect(commitWork).not.toHaveBeenCalled();
});

it("submits through the resolved route and reports the route when it cannot submit", async () => {
  const submitWork = vi.fn(async () => ({ route: REVISOR_ROUTE, submitted: true, pullRequest: { number: 1 } }));
  const app = router({ submitWork });
  expect(await (await post(app, "/submit", { session_id: "s1" })).json()).toMatchObject({ submitted: true });

  submitWork.mockResolvedValueOnce({ submitted: false, route: { ...REVISOR_ROUTE, route: "github-pr", allowsGithubPr: true } } as never);
  const github = await (await post(app, "/submit", { session_id: "s1" })).json();
  expect(github).toMatchObject({ submitted: false, route: { route: "github-pr" } });
});

it("answers the hook lookup from a repo path alone, and asks for one when missing", async () => {
  const routeForRepo = vi.fn(() => REVISOR_ROUTE);
  const app = router({ routeForRepo } as never);
  const response = await app.request("/submission-route?repo=E%3A%2FDocument%2FArs%2FConcordia");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ route: "revisor-local-pr", allowsGithubPr: false });
  expect(routeForRepo).toHaveBeenCalledWith("E:/Document/Ars/Concordia");
  expect((await app.request("/submission-route")).status).toBe(400);
});
