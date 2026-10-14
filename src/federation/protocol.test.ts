import { describe, expect, it } from "vitest";
import {
  ACTIVITY_REPORT_MAX_PRS,
  ACTIVITY_REPORT_MAX_SESSIONS,
  ACTIVITY_SESSION_MAX_PRS,
  FEDERATION_PROTOCOL_VERSION,
  parseFederationFrame,
  serializeFederationFrame,
} from "./protocol.js";

describe("federation protocol", () => {
  it("round-trips every frame type", () => {
    const frames = [
      { type: "hello", site_id: "site-a", token: "t", site_version: "1.0.0", platform: "darwin" },
      { type: "welcome", hq_version: "1.0.0", pending_events: 3 },
      { type: "event", seq: 7, payload: { kind: "noop" } },
      { type: "ingress", guild_id: "g1", channel_id: "c1", message_id: "m1", author_id: "u1", author_label: "User", text: "hello", ts: 1 },
      { type: "egress-request", request_id: "r1", guild_id: "g1", channel_id: "c1", text: "hello" },
      { type: "egress-result", request_id: "r1", ok: true },
      { type: "ack", seq: 7 },
      { type: "error", code: "auth_failed", message: "nope" },
    ] as const;
    for (const frame of frames) {
      const parsed = parseFederationFrame(serializeFederationFrame(frame));
      expect(parsed.ok, frame.type).toBe(true);
      if (parsed.ok) expect(parsed.frame.type).toBe(frame.type);
    }
  });

  it("accepts a site activity report and rejects one over the session cap", () => {
    const session = {
      id: "s-1", title: "日報", repo: "Concordia", branch: "main", provider: "claude-code",
      status: "ended", started_at: 1, ended_at: 2, duration_sec: 1,
    };
    const ok = parseFederationFrame(serializeFederationFrame({
      type: "activity-report", date_iso: "2026-10-14", generated_at: 3, session_count: 1, sessions: [session],
    }));
    expect(ok.ok).toBe(true);
    const tooMany = parseFederationFrame(JSON.stringify({
      v: 1, type: "activity-report", date_iso: "2026-10-14", generated_at: 3, session_count: 81,
      sessions: Array.from({ length: ACTIVITY_REPORT_MAX_SESSIONS + 1 }, (_, i) => ({ ...session, id: `s-${i}` })),
    }));
    expect(tooMany.ok).toBe(false);
    const extraField = parseFederationFrame(JSON.stringify({
      v: 1, type: "activity-report", date_iso: "2026-10-14", generated_at: 3, session_count: 1,
      sessions: [{ ...session, metadata: "{}" }],
    }));
    expect(extraField.ok).toBe(false);
  });

  it("accepts sessions with submitted PRs, keeps PR-less (old site) reports, and enforces the PR caps", () => {
    const session = {
      id: "s-1", title: "日報", repo: "Concordia", branch: "main", provider: "claude-code",
      status: "ended", started_at: 1, ended_at: 2, duration_sec: 1,
    };
    const pr = { source: "github", repo: "LUDIARS/Concordia", number: 1, title: "PR", state: "open", url: "https://github.com/LUDIARS/Concordia/pull/1" };
    const frame = (sessions: unknown[]) => parseFederationFrame(JSON.stringify({
      v: 1, type: "activity-report", date_iso: "2026-10-14", generated_at: 3, session_count: sessions.length, sessions,
    }));
    expect(frame([{ ...session, prs: [pr, { ...pr, source: "local", number: 2, url: null }] }]).ok).toBe(true);
    // 旧版の拠点は prs を送らない。
    expect(frame([session]).ok).toBe(true);
    // PR の余計な項目 (本文など) は拒否する。
    expect(frame([{ ...session, prs: [{ ...pr, body: "secret" }] }]).ok).toBe(false);
    expect(frame([{ ...session, prs: [{ ...pr, source: "gitlab" }] }]).ok).toBe(false);
    expect(frame([{ ...session, prs: [{ ...pr, title: "x".repeat(151) }] }]).ok).toBe(false);
    // セッションあたりの上限。
    const perSession = Array.from({ length: ACTIVITY_SESSION_MAX_PRS + 1 }, (_, i) => ({ ...pr, number: i + 1 }));
    expect(frame([{ ...session, prs: perSession }]).ok).toBe(false);
    // 報告全体の上限。
    const full = Array.from({ length: ACTIVITY_SESSION_MAX_PRS }, (_, i) => ({ ...pr, number: i + 1 }));
    const sessionsAtCap = Array.from({ length: ACTIVITY_REPORT_MAX_PRS / ACTIVITY_SESSION_MAX_PRS }, (_, i) => ({ ...session, id: `s-${i}`, prs: full }));
    expect(frame(sessionsAtCap).ok).toBe(true);
    expect(frame([...sessionsAtCap, { ...session, id: "over", prs: [pr] }]).ok).toBe(false);
  });

  it("rejects unsupported protocol versions", () => {
    const raw = JSON.stringify({ v: FEDERATION_PROTOCOL_VERSION + 1, type: "ack", seq: 1 });
    const parsed = parseFederationFrame(raw);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.reason).toBe("unsupported_version");
  });

  it("rejects non-JSON, unknown types, and schema violations", () => {
    expect(parseFederationFrame("not json").ok).toBe(false);
    const unknown = parseFederationFrame(JSON.stringify({ v: 1, type: "steal-token" }));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.reason).toBe("unknown_type");
    const badSite = parseFederationFrame(
      JSON.stringify({ v: 1, type: "hello", site_id: "UPPER CASE", token: "t" }),
    );
    expect(badSite.ok).toBe(false);
  });

  it("rejects Object.prototype keys as frame types without throwing", () => {
    // 素の object literal を type で引くと Object.prototype 由来の値が truthy で
    // 返る。未認証の相手が例外を起こせないよう unknown_type で弾くこと。
    for (const type of ["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"]) {
      const parsed = parseFederationFrame(JSON.stringify({ v: 1, type }));
      expect(parsed.ok, type).toBe(false);
      if (!parsed.ok) expect(parsed.reason, type).toBe("unknown_type");
    }
  });
});
