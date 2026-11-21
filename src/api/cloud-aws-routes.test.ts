import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AwsService } from "../cloud-work/aws-service.js";
import { cloudAwsRoutes } from "./cloud-aws-routes.js";

const request = { session_id: "session", attemptId: "attempt", targetId: "host", runner: "build", inputs: {},
  taskReference: "actio:work", deadline: "2026-11-21T03:00:00Z",
  evidence: { code: "public", data: "non_confidential", destination: "approved" } };
const scope = { repositoryKey: "repo", subsidiaryId: null };
const owner = { userId: "owner", organizationId: "org", organizationRole: "owner", expiresAt: 1, projectKey: "cc" };

function setup(web = false, local = true) {
  const authorizeSubmit = vi.fn(async () => {});
  const aws = {
    propose: vi.fn(async () => ({ status: "human_approval_required" })),
    start: vi.fn<AwsService["start"]>().mockImplementation(async (_scope, _actor, _input, authorize) => {
      await authorize();
      return {} as Awaited<ReturnType<AwsService["start"]>>;
    }),
  };
  const app = new Hono();
  if (web) app.use("*", async (c, next) => { c.set("concordiaWebIdentity", owner); await next(); });
  app.route("/", cloudAwsRoutes({ aws: aws as unknown as AwsService, scope: async () => scope,
    localRequest: () => local, authorizeSubmit }));
  return { app, aws, authorizeSubmit };
}

function post(app: Hono, path: string, body: object, headers: Record<string, string> = {}) {
  return app.request(path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
}

describe("AWS cloud work HTTP", () => {
  it("accepts a loopback proposal and denies starting with a forged confirmation", async () => {
    const { app, aws } = setup();
    expect((await post(app, "/proposals", request)).status).toBe(202);
    expect((await post(app, "/runs", { ...request, ownerApproved: true })).status).toBe(403);
    expect(aws.propose).toHaveBeenCalledOnce();
    expect(aws.start).not.toHaveBeenCalled();
  });

  it("rejects forwarded local requests and requires same-origin human approval", async () => {
    const local = setup();
    expect((await post(local.app, "/proposals", request, { "x-forwarded-for": "192.0.2.1" })).status).toBe(403);
    const web = setup(true, false);
    expect((await post(web.app, "/runs", { ...request, ownerApproved: true }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect((await post(web.app, "/runs", request, { "sec-fetch-site": "same-origin" })).status).toBe(400);
    expect((await post(web.app, "/runs", { ...request, ownerApproved: true, proposal: true }, { "sec-fetch-site": "same-origin" })).status).toBe(202);
    expect(web.aws.start).toHaveBeenCalledWith(scope, { sessionId: "session", owner },
      expect.objectContaining({ attemptId: "attempt" }), expect.any(Function), true);
    expect(web.authorizeSubmit).toHaveBeenCalledWith("session", scope);
  });
});
