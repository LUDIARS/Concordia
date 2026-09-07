import { describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { classifySessionClaim, sessionEnrollmentMatches } from "./ws.js";

/**
 * enrollment (CONCORDIA_SPAWN_ID) は Cc が spawn したセッションにしか配られない。
 * それを全セッションに要求すると、 手動起動した Lictor セッションは満たしようのない
 * 条件で 1008 を返され、 Lictor がそれを terminal 扱いして再接続を止め、
 * 生きているセッションが lost として刈られる (Memoria #1354)。
 */
function repoWith(metadata: string | null): SessionsRepo {
  return { findSession: () => ({ metadata }) } as unknown as SessionsRepo;
}

const repoWithoutSession = { findSession: () => null } as unknown as SessionsRepo;

describe("sessionEnrollmentMatches", () => {
  it("spawn 由来セッションは一致する enrollment を要求する", () => {
    const repo = repoWith(JSON.stringify({ concordia_spawn_id: "spawn-secret" }));

    expect(sessionEnrollmentMatches(repo, "s1", "spawn-secret")).toBe(true);
    expect(sessionEnrollmentMatches(repo, "s1", "wrong-secret")).toBe(false);
    expect(sessionEnrollmentMatches(repo, "s1", "")).toBe(false);
  });

  it("spawn 由来でないセッションは enrollment を要求しない", () => {
    // 手動起動の Lictor セッション: 配られた秘密が無いので提示しようがない。
    expect(sessionEnrollmentMatches(repoWith(JSON.stringify({ host: "local" })), "s2", "")).toBe(true);
    expect(sessionEnrollmentMatches(repoWith(null), "s3", "")).toBe(true);
  });

  it("壊れた metadata を enrollment 無しのセッションへ降格しない", () => {
    expect(sessionEnrollmentMatches(repoWith("{ not json"), "s4", "")).toBe(false);
    expect(sessionEnrollmentMatches(repoWith("[]"), "s5", "")).toBe(false);
    expect(sessionEnrollmentMatches(repoWith(JSON.stringify({ concordia_spawn_id: " " })), "s6", "")).toBe(false);
    expect(sessionEnrollmentMatches(repoWith(JSON.stringify({ concordia_spawn_id: 123 })), "s7", "")).toBe(false);
  });

  it("存在しないセッションの claim は拒否する", () => {
    expect(sessionEnrollmentMatches(repoWithoutSession, "missing", "anything")).toBe(false);
    expect(sessionEnrollmentMatches(repoWithoutSession, "missing", "")).toBe(false);
  });
});

/**
 * 2026-09-07: 拒否理由が 1 種類しか無かったため、「そんな session id は無い」を
 * 「enrollment が不正」と誤って名乗っていた。廃止済み agent-client が claude の
 * transcript UUID を名乗って毎秒リトライし、43,540 件のログを埋めた事象を
 * 「enrollment の破損」と読み違える原因になっていた。
 */
describe("classifySessionClaim", () => {
  it("セッション行が無い claim は unknown-session (認証失敗ではない)", () => {
    expect(classifySessionClaim(repoWithoutSession, "not-a-session-id", "")).toBe("unknown-session");
    expect(classifySessionClaim(repoWithoutSession, "not-a-session-id", "anything")).toBe("unknown-session");
  });

  it("秘密が合わない claim は enrollment-mismatch", () => {
    const repo = repoWith(JSON.stringify({ concordia_spawn_id: "spawn-secret" }));
    expect(classifySessionClaim(repo, "s1", "wrong-secret")).toBe("enrollment-mismatch");
    expect(classifySessionClaim(repo, "s1", "")).toBe("enrollment-mismatch");
  });

  it("壊れた metadata は enrollment-mismatch (無 enrollment へ降格しない)", () => {
    expect(classifySessionClaim(repoWith("{ not json"), "s4", "")).toBe("enrollment-mismatch");
  });

  it("正当な claim は accepted", () => {
    const repo = repoWith(JSON.stringify({ concordia_spawn_id: "spawn-secret" }));
    expect(classifySessionClaim(repo, "s1", "spawn-secret")).toBe("accepted");
    expect(classifySessionClaim(repoWith(null), "s3", "")).toBe("accepted");
  });
});
