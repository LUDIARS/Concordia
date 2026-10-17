import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudGitIngress } from "./git-ingress.js";
import { GitRunGrants } from "./git-run-grant.js";
import { CloudGitReceiver } from "./git-receiver.js";

describe("dedicated cloud ingress", () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "cc-ingress-")); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  async function fixture() {
    const grants = new GitRunGrants(root);
    const { token } = await grants.issue({ targetId: "target", attemptId: "run", repositoryKey: "repo", provider: "claude-cloud",
      sourceRevision: "a".repeat(40), issuedAt: 1, expiresAt: 5000, maxPackBytes: 100 });
    const receiver = new CloudGitReceiver();
    const advertise = vi.spyOn(receiver, "advertise").mockResolvedValue(Buffer.from("refs"));
    const receive = vi.spyOn(receiver, "receive").mockResolvedValue(Buffer.from("ok"));
    const access = { verify: vi.fn(async (assertion?: string) => assertion === "verified-jwt" ? { email: null, commonName: "client" } : null) };
    const app = cloudGitIngress({ publicHost: "git.example.com", access, grants, receiver, now: () => 2000 });
    const headers = { host: "git.example.com", "cf-access-jwt-assertion": "verified-jwt", authorization: `Basic ${Buffer.from(`run:${token}`).toString("base64")}` };
    return { app, headers, advertise, receive };
  }
  const path = "/git/target/run.git";
  it("requires both Access and the run token even for advertisement", async () => {
    const { app, headers, advertise } = await fixture();
    expect((await app.request(`${path}/info/refs?service=git-receive-pack`, { headers })).status).toBe(200);
    expect((await app.request(`${path}/info/refs?service=git-receive-pack`, { headers: { ...headers, "cf-access-jwt-assertion": "" } })).status).toBe(403);
    expect((await app.request(`${path}/info/refs?service=git-receive-pack`, { headers: { ...headers, authorization: "" } })).status).toBe(401);
    expect(advertise).toHaveBeenCalledTimes(1);
  });
  it("does not expose ordinary Cc endpoints or fetch service", async () => {
    const { app, headers } = await fixture();
    expect((await app.request("/v1/sessions", { headers })).status).toBe(404);
    expect((await app.request(`${path}/info/refs?service=git-upload-pack`, { headers })).status).toBe(400);
    expect((await app.request(`${path}/info/refs?service=git-receive-pack`, { headers: { ...headers, host: "localhost" } })).status).toBe(403);
  });
  it("bounds actual request bytes without trusting Content-Length", async () => {
    const { app, headers, receive } = await fixture();
    const response = await app.request(`${path}/git-receive-pack`, { method: "POST", headers: { ...headers, "content-type": "application/x-git-receive-pack-request" }, body: "x".repeat(101) });
    expect(response.status).toBe(413);
    expect(receive).not.toHaveBeenCalled();
  });
  it("returns binary Git response only from the bound run", async () => {
    const { app, headers, receive } = await fixture();
    const response = await app.request(`${path}/git-receive-pack`, { method: "POST", headers: { ...headers, "content-type": "application/x-git-receive-pack-request" }, body: "pack" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/x-git-receive-pack-result");
    expect(await response.text()).toBe("ok");
    expect(receive).toHaveBeenCalledTimes(1);
  });
});
