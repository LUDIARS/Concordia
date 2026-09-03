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
    const missingPath = join(dir, "no-such-file");
    const fetchMock = vi.fn();
    const warn = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchClaudeOAuthUsage({ credentialsPath: missingPath, log: { warn } })).toBeNull();
    expect(await fetchClaudeOAuthUsage({ credentialsPath: missingPath, log: { warn } })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining(missingPath));
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

  it("同時呼び出しは 1 本の fetch に束ねる (single-flight)", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchMock = vi.fn(() => new Promise<Response>((resolve) => { resolveFetch = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const p1 = fetchClaudeOAuthUsage({ credentialsPath: credPath });
    const p2 = fetchClaudeOAuthUsage({ credentialsPath: credPath });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch!(new Response(JSON.stringify({
      five_hour: { utilization: 7, resets_at: "2026-05-28T11:00:00Z" },
      seven_day: null,
      extra_usage: { is_enabled: false },
    }), { status: 200 }));
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r1).not.toBeNull();
    expect(r2).toBe(r1);
  });

  it("取得失敗時は 30 分以内の直近成功値を返し、fetchedAt は古いまま", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    const okBody = JSON.stringify({
      five_hour: { utilization: 3, resets_at: "2026-05-28T11:00:00Z" },
      seven_day: { utilization: 40, resets_at: "2026-05-28T23:59:59Z" },
      extra_usage: { is_enabled: false },
    });
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(okBody, { status: 200 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.fn();
    const first = await fetchClaudeOAuthUsage({ credentialsPath: credPath, log: { warn } });
    expect(first?.sevenDay?.utilization).toBe(40);
    // noCache で強制再取得 → 503 → 直近成功値にフォールバック。
    const second = await fetchClaudeOAuthUsage({ credentialsPath: credPath, noCache: true, log: { warn } });
    expect(second).toBe(first);
    expect(second?.fetchedAt).toBe(first?.fetchedAt);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("serving last good value"));
  });

  it("認証失敗時は直近成功値を返さない", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        five_hour: { utilization: 3, resets_at: "2026-05-28T11:00:00Z" },
        extra_usage: { is_enabled: false },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchClaudeOAuthUsage({ credentialsPath: credPath })).not.toBeNull();

    expect(await fetchClaudeOAuthUsage({ credentialsPath: credPath, noCache: true })).toBeNull();
  });

  it("直近成功値が無ければ失敗は null のまま", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    const fetchMock = vi.fn(async () => new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await fetchClaudeOAuthUsage({ credentialsPath: credPath })).toBeNull();
    expect(await fetchClaudeOAuthUsage({ credentialsPath: credPath })).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("30 分を超えた成功値にはフォールバックしない", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        five_hour: { utilization: 3, resets_at: "2026-05-28T11:00:00Z" },
        extra_usage: { is_enabled: false },
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response("busy", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const first = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    if (!first) throw new Error("expected an initial usage response");
    first.fetchedAt = Date.now() - 30 * 60_000 - 1;

    expect(await fetchClaudeOAuthUsage({ credentialsPath: credPath, noCache: true })).toBeNull();
  });

  it("limits[] の weekly_scoped (scope.model=Fable) を sevenDayFable と weeklyScoped に写す (2026-09-03 実測形)", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    const apiBody = {
      five_hour: { utilization: 34, resets_at: "2026-09-03T05:09:59.691358+00:00" },
      seven_day: { utilization: 57, resets_at: "2026-09-03T23:59:59.691381+00:00" },
      seven_day_opus: null,
      seven_day_sonnet: null,
      extra_usage: { is_enabled: false },
      limits: [
        { kind: "session", group: "session", percent: 34, severity: "normal", resets_at: "2026-09-03T05:09:59.691358+00:00", scope: null, is_active: false },
        { kind: "weekly_all", group: "weekly", percent: 57, severity: "normal", resets_at: "2026-09-03T23:59:59.691381+00:00", scope: null, is_active: false },
        {
          kind: "weekly_scoped", group: "weekly", percent: 90, severity: "critical",
          resets_at: "2026-09-03T23:59:59.592131+00:00",
          scope: { model: { id: null, display_name: "Fable" }, surface: null }, is_active: true,
        },
      ],
    };
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(apiBody), { status: 200 })));
    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r!.sevenDay!.utilization).toBe(57);
    expect(r!.sevenDayFable).toEqual({
      utilization: 90,
      resetsAtSec: Math.floor(new Date("2026-09-03T23:59:59.592131+00:00").getTime() / 1000),
    });
    expect(r!.weeklyScoped).toEqual([{
      label: "Fable",
      utilization: 90,
      resetsAtSec: Math.floor(new Date("2026-09-03T23:59:59.592131+00:00").getTime() / 1000),
      severity: "critical",
    }]);
  });

  it("limits[] が無い / 壊れていても weeklyScoped は空配列", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      five_hour: null, seven_day: null, extra_usage: { is_enabled: false }, limits: "broken",
    }), { status: 200 })));
    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r!.weeklyScoped).toEqual([]);
    expect(r!.sevenDayFable).toBeNull();
  });

  it("weekly_scoped の欠損 reset は null のまま保ち、不正な表示値を除去する", async () => {
    writeFileSync(credPath, JSON.stringify({ claudeAiOauth: { accessToken: "ok" } }));
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
      extra_usage: { is_enabled: false },
      limits: [
        {
          kind: "weekly_scoped",
          percent: 60,
          resets_at: null,
          severity: "critical\n@everyone",
          scope: { model: { display_name: "Fable\n<!channel>" } },
        },
        { kind: "weekly_scoped", percent: 101, scope: { model: { display_name: "invalid" } } },
      ],
    }), { status: 200 })));

    const r = await fetchClaudeOAuthUsage({ credentialsPath: credPath });
    expect(r!.weeklyScoped).toEqual([{
      label: "Fable !channel",
      utilization: 60,
      resetsAtSec: null,
      severity: null,
    }]);
    expect(r!.sevenDayFable).toEqual({ utilization: 60, resetsAtSec: null });
  });
});
