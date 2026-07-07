import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionsRepo } from "../src/db/sessions-repo.js";
import { clearHttpCacheForTest } from "../src/shared/http-cache.js";
import { makeTestApp } from "./helpers/test-app.js";

const OLD_HTTP_CACHE = process.env.CONCORDIA_HTTP_CACHE_ENABLED;
const OLD_REDIS = process.env.CONCORDIA_REDIS_ENABLED;

function seedSession(repo: SessionsRepo, id: string): void {
  repo.insertSession({
    id,
    provider: "claude-code",
    repo_path: `/repo/${id}`,
    repo_origin: null,
    branch: "main",
    host: "h",
    started_at: 1,
    last_seen_at: 1,
    transcript_path: null,
    metadata: null,
  });
}

describe("Concordia HTTP cache", () => {
  beforeEach(() => {
    clearHttpCacheForTest();
    process.env.CONCORDIA_HTTP_CACHE_ENABLED = "1";
    process.env.CONCORDIA_REDIS_ENABLED = "0";
  });

  afterEach(() => {
    clearHttpCacheForTest();
    if (OLD_HTTP_CACHE === undefined) delete process.env.CONCORDIA_HTTP_CACHE_ENABLED;
    else process.env.CONCORDIA_HTTP_CACHE_ENABLED = OLD_HTTP_CACHE;
    if (OLD_REDIS === undefined) delete process.env.CONCORDIA_REDIS_ENABLED;
    else process.env.CONCORDIA_REDIS_ENABLED = OLD_REDIS;
  });

  it("serves configured GET endpoints from the in-process layer before Redis", async () => {
    const env = makeTestApp();
    seedSession(env.repo, "s1");

    const first = await env.app.request("/v1/monitor");
    expect(first.status).toBe(200);
    expect(first.headers.get("x-concordia-cache")).toBe("miss");
    expect(((await first.json()) as any).active).toHaveLength(1);

    seedSession(env.repo, "s2");

    const second = await env.app.request("/v1/monitor");
    expect(second.status).toBe(200);
    expect(second.headers.get("x-concordia-cache")).toBe("l1");
    expect(((await second.json()) as any).active).toHaveLength(1);
  });

  it("honors request cache-control bypass", async () => {
    const env = makeTestApp();
    seedSession(env.repo, "s1");
    await env.app.request("/v1/monitor");
    seedSession(env.repo, "s2");

    const bypass = await env.app.request("/v1/monitor", {
      headers: { "cache-control": "no-cache" },
    });
    expect(bypass.status).toBe(200);
    expect(bypass.headers.get("x-concordia-cache")).toBe("bypass");
    expect(((await bypass.json()) as any).active).toHaveLength(2);
  });
});
