import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactReceiver } from "./artifact-receiver.js";
import { artifactIngress } from "./artifact-ingress.js";

describe("private artifact HTTP boundary", () => {
  let root: string, token: string, app: ReturnType<typeof artifactIngress>;
  const authority = "100.64.1.2:11114", path = "/artifacts/Tokyo2070/trial";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "cc-ingress-"));
    const receiver = new ArtifactReceiver(root, () => 1000);
    ({ token } = await receiver.issue({ target: "Tokyo2070", attempt: "trial", name: "model.blend", maxBytes: 10, issuedAt: 1000, expiresAt: 2000 }));
    app = artifactIngress(receiver, authority);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const headers = (token: string): Record<string, string> => ({ host: authority, authorization: `Bearer ${token}`, "content-type": "application/octet-stream", "content-length": "3", "x-artifact-sha256": createHash("sha256").update("abc").digest("hex") });
  it("receives then reports a verified receipt", async () => {
    const result = await app.request(`http://${authority}${path}`, { method: "PUT", headers: headers(token), body: "abc" });
    expect(result.status).toBe(200);
    expect(await result.json()).toMatchObject({ state: "received", receipt: { bytes: 3 } });
    const status = await app.request(`http://${authority}${path}`, { headers: headers(token) });
    expect(await status.json()).toMatchObject({ state: "received" });
  });
  it("rejects absent authentication and forged host", async () => {
    expect((await app.request(path, { headers: { host: authority } })).status).toBe(401);
    expect((await app.request(path, { headers: { ...headers(token), host: "evil.example" } })).status).toBe(403);
    expect((await app.request(path, { headers: { ...headers(token), origin: "https://evil.example" } })).status).toBe(403);
  });
  it("rejects oversized uploads and does not expose Cc APIs", async () => {
    expect((await app.request(path, { method: "PUT", headers: { ...headers(token), "content-length": "11" }, body: "abc" })).status).toBe(413);
    expect((await app.request("/v1/sessions", { headers: headers(token) })).status).toBe(404);
  });
});
