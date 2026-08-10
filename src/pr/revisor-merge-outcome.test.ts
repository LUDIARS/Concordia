import { describe, expect, it } from "vitest";
import { RevisorMergeError, classifyMergeFailure } from "./revisor-merge-outcome.js";

describe("classifyMergeFailure", () => {
  it("打ち切りは timeout になる (status より打ち切りが優先)", () => {
    const failure = classifyMergeFailure(new RevisorMergeError("timed out", { timedOut: true }));
    expect(failure.reason).toBe("timeout");
    // 「失敗した」と読ませない — Revisor 側は続行し得る。
    expect(failure.detail).toContain("継続している可能性");
  });

  it("status を持たない失敗は unreachable になる", () => {
    expect(classifyMergeFailure(new RevisorMergeError("connect ECONNREFUSED")).reason)
      .toBe("unreachable");
  });

  it("401 / 403 は unauthorized になる", () => {
    expect(classifyMergeFailure(new RevisorMergeError("x", { status: 401 })).reason).toBe("unauthorized");
    expect(classifyMergeFailure(new RevisorMergeError("x", { status: 403 })).reason).toBe("unauthorized");
  });

  it("競合は conflict になり、原文を返さずに rebase を案内する", () => {
    const failure = classifyMergeFailure(new RevisorMergeError("x", {
      status: 409,
      revisorError: "The head conflicts with the current 'main'; rebase the branch and submit a new review.",
    }));
    expect(failure.reason).toBe("conflict");
    expect(failure.detail).toBe("head が main と競合しています。rebase して出し直してください。");
  });

  it("既にマージ済みの応答は already_merged になる", () => {
    const failure = classifyMergeFailure(new RevisorMergeError("x", {
      status: 409,
      revisorError: "This pull request has already been merged.",
    }));
    expect(failure.reason).toBe("already_merged");
  });

  it("分類できた失敗でも原文を漏らさない", () => {
    const failure = classifyMergeFailure(new RevisorMergeError("x", {
      status: 409,
      revisorError: "conflict in E:\\Document\\Ars\\Revisor\\src\\server.mjs",
    }));
    expect(failure.reason).toBe("conflict");
    expect(failure.detail).not.toContain("E:\\");
    expect(failure.detail).not.toContain("server.mjs");
  });

  it("分類できない失敗は原文を漏らさない", () => {
    const failure = classifyMergeFailure(new RevisorMergeError("x", {
      status: 500,
      revisorError: "boom at E:\\Document\\Ars\\secret",
    }));
    expect(failure.reason).toBe("unknown");
    expect(failure.detail).not.toContain("secret");
  });

  it("RevisorMergeError 以外は unknown に寄せる", () => {
    expect(classifyMergeFailure(new Error("unexpected internal detail")).detail)
      .not.toContain("unexpected internal detail");
  });
});
