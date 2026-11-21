import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { confluxRouter, isConfluxLocalPeer } from "../api/conflux.js";
import { confluxIntegrationMigration } from "../db/conflux-integration-migration.js";
import { confluxIdentity } from "./identity.js";
import { readConfluxConfig } from "./config.js";
import { ConfluxRepository } from "./repository.js";
import { ConfluxRequests } from "./requests.js";
import { startConfluxWorker } from "./worker.js";

const databases: Database.Database[] = [];
afterEach(() => { for (const db of databases.splice(0)) db.close(); });

function fixture() {
  const db = new Database(":memory:");
  databases.push(db);
  db.exec("CREATE TABLE sessions (id TEXT PRIMARY KEY, status TEXT, metadata TEXT)");
  confluxIntegrationMigration.up(db);
  const repo = new ConfluxRepository(db);
  const launch = vi.fn<(input: unknown, enrollment: string) => Promise<boolean>>().mockResolvedValue(true);
  const requests = new ConfluxRequests(repo, {
    canSpawn: () => null, launch, canBuild: (code: string) => code === "Cc", spawnWaitMs: 0,
  });
  const app = confluxRouter({ requests, identity: () => null, isLocalPeer: () => true });
  const request = (path: string, body?: object, headers: Record<string, string> = {}) => app.request(path, {
    method: body ? "POST" : "GET",
    headers: { host: "127.0.0.1:11111", "content-type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { db, repo, launch, request };
}

const spawn = {
  idempotency_key: "request:1", project_code: "Cc", destination: { kind: "discord", address: { guild_id: "10000", channel_id: "10001" } },
  selection: { projectCode: "Cc", tide: "fast", variant: "debug", baseBranch: "evolution/fast/debug", workBranch: "feature/fast/debug/first" },
  title: "Example", brief: "Implement the flow", requested_by: "user", source_comments: [],
};
const build = { dedupe_key: "cf-build:cf-project:variant-id:1234567", project_code: "Cc",
  tide: "fast", variant: "debug", commit: "1234567", branch: "evolution/fast/debug", platforms: ["web"] };

describe("Conflux HTTP and durable receipts", () => {
  it("uses one launch and reconciles the actual session by enrollment", async () => {
    const { request, launch, db } = fixture();
    expect((await request("/spawn?idempotency_key=request%3A1")).status).toBe(404);
    const first = await request("/spawn", spawn);
    expect(first.status).toBe(503);
    const enrollment = launch.mock.calls[0][1];
    const reordered = { ...spawn, destination: { ...spawn.destination, address: { channel_id: "10001", guild_id: "10000" } } };
    expect((await request("/spawn", reordered)).status).toBe(503);
    db.prepare("INSERT INTO sessions VALUES (?, ?, ?)").run("session-live", "active", JSON.stringify({ concordia_spawn_id: enrollment }));
    const response = await request("/spawn?idempotency_key=request%3A1");
    const receipt = await response.json();
    expect(receipt).toMatchObject({ accepted: true, session_id: "session-live", status: "active" });
    expect(receipt.run_id).not.toBe(enrollment);
    expect(await (await request("/spawn", reordered)).json()).toEqual(receipt);
    expect((await request("/spawn", { ...spawn, brief: "different" })).status).toBe(409);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("keeps concurrent POSTs and uncertain launch outcomes behind the same receipt", async () => {
    const { request, launch } = fixture();
    launch.mockRejectedValueOnce(new Error("outcome unknown"));
    const results = await Promise.all([request("/spawn", spawn), request("/spawn", spawn)]);
    expect(results.map((response) => response.status)).toEqual([503, 503]);
    expect((await request("/spawn?idempotency_key=request%3A1")).status).toBe(503);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it("rejects forwarded calls and limits identity to a verified actor", async () => {
    const { request, launch } = fixture();
    expect((await request("/spawn", spawn, { "cf-ray": "public" })).status).toBe(403);
    expect((await request("/spawn", spawn, { host: "public.example" })).status).toBe(403);
    expect((await request("/identity")).status).toBe(401);
    expect(launch).not.toHaveBeenCalled();
    const actors = [{ sha256: createHash("sha256").update("test-token").digest("hex"), platform: "discord" as const, userId: "u", organizationId: "hq" }];
    const staff = { roleOf: vi.fn().mockReturnValue("executive") };
    expect(confluxIdentity("test-token", actors, staff, () => true))
      .toMatchObject({ actor_id: "discord:u", organization_id: "hq", roles: ["executive", "manager"], is_manager: true });
    expect(confluxIdentity("invalid", actors, staff, () => true)).toBeNull();
    expect(confluxIdentity("test-token", actors, staff, () => false)).toBeNull();
    expect(isConfluxLocalPeer({ incoming: { socket: { remoteAddress: "100.64.0.2" } } })).toBe(false);
    expect(isConfluxLocalPeer({ server: { incoming: { socket: { remoteAddress: "::ffff:127.0.0.1" } } } })).toBe(true);
  });

  it("keeps hook delivery disabled without both a trusted URL and token", () => {
    expect(readConfluxConfig({ CONFLUX_URL: "http://127.0.0.1:3001" }).hook).toBeNull();
    expect(readConfluxConfig({ CONFLUX_HOOK_TOKEN: "fixture" }).hook).toBeNull();
    expect(() => readConfluxConfig({ CONFLUX_URL: "http://public.example", CONFLUX_HOOK_TOKEN: "fixture" })).toThrow("Invalid CONFLUX_URL");
  });

  it("queues one build and durably records ordered Cf events", async () => {
    const { request, repo } = fixture();
    expect((await request("/build", build)).status).toBe(202);
    expect((await request("/build", build)).status).toBe(202);
    expect((await request("/build", { ...build, platforms: ["ios"] })).status).toBe(409);
    expect((await request("/build", { ...build, branch: "main" })).status).toBe(400);
    const job = repo.claimBuild()!;
    expect(repo.claimBuild()).toBeUndefined();
    repo.finishBuild(job, "succeeded");
    repo.finishBuild(job, "failed");
    expect(repo.pendingHooks(Date.now()).map(({ payload }) => JSON.parse(payload))).toEqual([
      { dedupeKey: build.dedupe_key, projectCode: "cf-project", variantId: "variant-id", commit: "1234567", seq: 1, state: "running" },
      { dedupeKey: build.dedupe_key, projectCode: "cf-project", variantId: "variant-id", commit: "1234567", seq: 2, state: "succeeded" },
    ]);
  });

  it("keeps a failed hook queued and delivers the matching Revisor observation", async () => {
    const { repo, request } = fixture();
    await request("/build", build);
    let now = 0;
    const hook = vi.fn<typeof fetch>()
      .mockImplementationOnce(async () => new Response(null, { status: 503 }))
      .mockImplementation(async () => new Response(null, { status: 200 }));
    const pullRequest = vi.fn().mockResolvedValue({ id: "pr", status: "merged", repository: "LUDIARS/Cc", headSha: "123456789" });
    const worker = startConfluxWorker(repo, {
      runBuild: async () => undefined,
      integrations: [{ prId: "pr", projectCode: "cf-project", repository: "ludiars/cc", decisionId: "decision", commit: "1234567" }],
      pullRequest, hook: { base: "http://127.0.0.1:3001", token: "test-hook" }, warn: vi.fn(),
      fetch: hook, now: () => now, intervalMs: 10,
    });
    try {
      await expect.poll(() => hook.mock.calls.length).toBe(3);
      const [url, init] = hook.mock.calls.find(([url]) => String(url).endsWith("/api/hooks/integration"))!;
      expect(url).toBe("http://127.0.0.1:3001/api/hooks/integration");
      expect(init?.headers).toMatchObject({ authorization: "Bearer test-hook" });
      expect(JSON.parse(String(init?.body))).toEqual({
        projectCode: "cf-project", decisionId: "decision", source: "revisor", commit: "1234567", outcome: "integrated", ref: "pr",
      });
      now = 60_000;
      await expect.poll(() => hook.mock.calls.length).toBe(4);
      expect(pullRequest).toHaveBeenCalledTimes(1);
    } finally {
      await worker.stop();
    }
  });
});
