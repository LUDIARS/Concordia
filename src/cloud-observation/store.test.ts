import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ObservationStore } from "./store.js";
import { ArtifactReceiver } from "../cloud-work/artifact-receiver.js";
import { observationIngress } from "./ingress.js";
import { Hono } from "hono";
import { cloudObservationInstructions, observationSettings, preflightObservation } from "./instructions.js";

const roots: string[] = [];
const stores: ObservationStore[] = [];
async function setup() {
  const root = await mkdtemp(join(tmpdir(), "cc-observation-")); roots.push(root);
  const store = new ObservationStore(root); stores.push(store);
  const receiver = new ArtifactReceiver(root, () => 1000);
  const { token } = await receiver.issue({ target: "tokyo", attempt: "trial", name: "artifacts.tar", maxBytes: 10000, issuedAt: 0, expiresAt: 100000 });
  const app = new Hono().route("/observations", observationIngress(receiver, store, "100.64.0.1:11114", () => 1000));
  return { root, store, receiver, token, app };
}
afterEach(async () => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
describe("durable cloud observations", () => {
  it("keeps pending questions and answers across reopening and rejects stale answers", async () => {
    const { root, store } = await setup();
    const event = { id: "e", sequence: 1, kind: "question", questionId: "height", message: "How tall?" };
    store.receive("tokyo", "trial", event, 1000);
    store.receive("tokyo", "trial", event, 2000);
    expect(store.events("tokyo", "trial", 0)).toHaveLength(1);
    expect(store.get("tokyo", "trial")?.state.lastReceivedAt).toBe(1000);
    const other = new ObservationStore(root); stores.push(other);
    other.answer("tokyo", "trial", "height", "10 floors", "123", 3000);
    expect(store.get("tokyo", "trial")?.state.question?.answer?.text).toBe("10 floors");
    expect(() => store.answer("tokyo", "trial", "height", "20 floors", "123", 4000)).toThrow("not_pending");
  });
  it("requires received preview bytes before the event and never overwrites a preview ID", async () => {
    const { store } = await setup();
    const event = { id: "e", sequence: 1, kind: "preview", previewId: "image", message: "Walls" };
    expect(() => store.receive("tokyo", "trial", event, 1000)).toThrow("preview_missing");
    const bytes = Buffer.from([255,216,0,255,217]);
    store.savePreview("tokyo", "trial", "image", bytes);
    store.savePreview("tokyo", "trial", "image", bytes);
    expect(() => store.savePreview("tokyo", "trial", "image", Buffer.from([255,216,1,255,217]))).toThrow("replay_conflict");
    expect(() => store.savePreview("tokyo", "trial", "svg", Buffer.from("<svg/>"))).toThrow("format_invalid");
    store.receive("tokyo", "trial", event, 1000);
    expect(store.events("tokyo", "trial", 0)[0]?.previewId).toBe("image");
  });
  it("authenticates callbacks, rejects cross-run access and exposes the matching answer", async () => {
    const { app, token, store } = await setup();
    const path = "/observations/tokyo/trial";
    const body = JSON.stringify({ id: "e", sequence: 1, kind: "question", questionId: "height", message: "How tall?" });
    const headers = { host: "100.64.0.1:11114", authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) };
    expect((await app.request(path, { method: "PUT", headers, body })).status).toBe(200);
    expect((await app.request("/observations/tokyo/other", { headers })).status).toBe(403);
    expect((await app.request(path, { headers: { ...headers, origin: "https://example.test" } })).status).toBe(403);
    store.answer("tokyo", "trial", "height", "10 floors", "123", 2000);
    const result = await (await app.request(path, { headers })).json();
    expect(result.state.question.answer.text).toBe("10 floors");
    expect((await app.request(path, { method: "POST", headers, body })).status).toBe(404);
  });
  it("provides a unique expiring capability only in transient instructions", async () => {
    const { root } = await setup();
    const env = { CONCORDIA_CLOUD_OBSERVATION_ENABLED: "true", CONCORDIA_ARTIFACT_ROOT: root,
      CONCORDIA_ARTIFACT_PORT: "11114", CONCORDIA_CLOUD_OBSERVATION_URL: "http://100.64.0.1:11114" };
    expect(() => observationSettings({ ...env, CONCORDIA_CLOUD_OBSERVATION_URL: "http://example.test:11114" })).toThrow();
    await expect(preflightObservation(env, async () => Response.json({ service: "concordia-cloud-artifact", ok: true, observations: 1 }))).resolves.toBeUndefined();
    await expect(preflightObservation(env, async () => Response.json({ service: "concordia-cloud-artifact", ok: true }))).rejects.toThrow("receiver_not_ready");
    await expect(preflightObservation(env, async () => Response.json({ service: "wrong", ok: true }))).rejects.toThrow("receiver_not_ready");
    const instructions = await cloudObservationInstructions(env, "tokyo", "second", 1000);
    expect(instructions).toContain("/observations/tokyo/second");
    const token = /Bearer ([A-Za-z0-9_-]{43})/.exec(instructions)?.[1];
    expect(token).toBeTruthy();
    await expect(new ArtifactReceiver(root, () => 2000).authorize("tokyo", "second", token!)).resolves.toMatchObject({ attempt: "second" });
    await expect(cloudObservationInstructions(env, "tokyo", "second", 1000)).rejects.toThrow();
  });
});
