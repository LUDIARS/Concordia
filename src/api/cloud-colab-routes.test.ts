import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { ColabService } from "../cloud-work/colab-service.js";
import { cloudColabRoutes } from "./cloud-colab-routes.js";

const owner = { userId: "user-1", organizationId: "org-1", projectKey: "cc", organizationRole: "owner", expiresAt: 12345 };
const scope = { repositoryKey: "repo", subsidiaryId: null };
const body = { session_id: "parent", attemptId: "attempt-1", targetId: "colab-1", taskReference: "actio:task-1", seconds: 60,
  ownerApproved: true, evidence: { code: "public", data: "non_confidential", destination: "owner-drive" } };
const post = (payload: object, site = "same-origin") => ({
  method: "POST", headers: { "content-type": "application/json", "sec-fetch-site": site }, body: JSON.stringify(payload),
});

function fixture(authenticated: boolean) {
  const colab = { start: vi.fn(async () => ({})), targets: vi.fn(async () => []), list: vi.fn(async () => []), stop: vi.fn(async () => ({})) };
  const authorizeSubmit = vi.fn(async () => undefined);
  const app = new Hono();
  if (authenticated) app.use("*", async (c, next) => { c.set("concordiaWebIdentity", owner); await next(); });
  app.route("/", cloudColabRoutes({ colab: colab as unknown as ColabService, authorizeSubmit,
    scope: async id => id === "parent" ? scope : null }));
  return { app, colab, authorizeSubmit };
}

describe("Colab owner controls", () => {
  it("requires same-origin browser input and a verified identity rather than an owner supplied in JSON", async () => {
    const anonymous = fixture(false);
    expect((await anonymous.app.request("/runs", post({ ...body, userId: owner.userId }))).status).toBe(403);
    expect(anonymous.colab.start).not.toHaveBeenCalled();
    const signedIn = fixture(true);
    expect((await signedIn.app.request("/runs", post(body, "cross-site"))).status).toBe(403);
    expect((await signedIn.app.request("/runs", post({ ...body, ownerApproved: false }))).status).toBe(400);
    expect(signedIn.colab.start).not.toHaveBeenCalled();
    expect((await signedIn.app.request("/runs", post(body))).status).toBe(202);
    expect(signedIn.authorizeSubmit).toHaveBeenCalledWith("parent", scope);
    expect(signedIn.colab.start).toHaveBeenCalledWith(scope, owner, body);
  });

  it("does not require further budget to request cleanup", async () => {
    const { app, colab, authorizeSubmit } = fixture(true);
    expect((await app.request("/runs/attempt-1/stop", post({ session_id: "parent" }))).status).toBe(200);
    expect(authorizeSubmit).not.toHaveBeenCalled();
    expect(colab.stop).toHaveBeenCalledWith(scope, owner, "attempt-1");
  });
});
