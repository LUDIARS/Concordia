import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fetchClaudeOAuthUsage,
  __resetUsageCacheForTest,
} from "./anthropic-oauth-usage.js";

describe("fetchClaudeOAuthUsage", () => {
  let dir: string;
  let credPath: string;

  beforeEach(() => {
    __resetUsageCacheForTest();
    dir = mkdtempSync(join(tmpdir(), "concordia-oauth-test-"));
    credPath = join(dir, ".credentials.json");
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it("returns null when credentials file missing", async () => {
    const r = await fetchClaudeOAuthUsage({ credentialsPath: join(dir, "no-such-file") });
    expect(r).toBeNull();
  });

  it("returns null when accessToken missing", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { refreshToken: "x" } }));
    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r).toBeNull();
  });

  it("parses API response into structured OAuthUsage", async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: "sk-ant-oat01-fake" },
    }));
    const apiBody = {
      five_hour: { utilization: 5.0, resets_at: "2026-05-28T11:00:00Z" },
      seven_day: { utilization: 94.0, resets_at: "2026-05-28T23:59:59Z" },
      seven_day_sonnet: { utilization: 4.0, resets_at: "2026-05-29T00:00:00Z" },
      seven_day_opus: null,
      seven_day_mythos: { utilization: 31.0, resets_at: "2026-05-29T00:00:00Z" },
      extra_usage: {
        is_enabled: false,
        monthly_limit: null,
        used_credits: null,
        utilization: null,
        currency: null,
      },
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(apiBody), {
      status: 200,
      headers: { "content-type": "application/json" },
    })));
    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r).not.toBeNull();
    expect(r!.fiveHour).toEqual({
      utilization: 5.0,
      resetsAtSec: Math.floor(new Date("2026-05-28T11:00:00Z").getTime() / 1000),
    });
    expect(r!.sevenDay!.utilization).toBe(94.0);
    expect(r!.sevenDaySonnet!.utilization).toBe(4.0);
    expect(r!.sevenDayOpus).toBeNull();
    expect(r!.sevenDayFable!.utilization).toBe(31.0);
    expect(r!.extraCredit.isEnabled).toBe(false);
  });

  it("returns null on 401", async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: "expired" },
    }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r).toBeNull();
  });

  it("caches result within TTL window", async () => {
    writeFileSync(credPath, JSON.stringify({
      claudeAiOauth: { accessToken: "ok" },
    }));
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      five_hour: { utilization: 1, resets_at: "2026-05-28T11:00:00Z" },
      seven_day: null,
      seven_day_sonnet: null,
      seven_day_opus: null,
      extra_usage: { is_enabled: false },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const r1 = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    const r2 = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r1).not.toBeNull();
    expect(r2).toBe(r1); // same cached object
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
