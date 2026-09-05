import { describe, expect, it } from "vitest";
import { classifyIssueEvent, issueBranchName } from "./issue-event.js";

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: "labeled",
    label: { name: "Cc" },
    sender: { login: "neco" },
    repository: { full_name: "LUDIARS/Concordia" },
    issue: {
      number: 42,
      title: "落ちる",
      body: "手順",
      html_url: "https://github.com/LUDIARS/Concordia/issues/42",
      labels: [{ name: "Cc" }],
      user: { login: "reporter" },
    },
    ...overrides,
  };
}

describe("classifyIssueEvent", () => {
  it("fires on the label being attached, crediting the person who attached it", () => {
    const result = classifyIssueEvent({ event: "issues", payload: payload(), label: "Cc" });
    expect(result).toEqual({
      kind: "trigger",
      trigger: {
        repoOrigin: "LUDIARS/Concordia",
        issueNumber: 42,
        issueTitle: "落ちる",
        issueBody: "手順",
        issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
        label: "Cc",
        actor: "neco",
      },
    });
  });

  it("credits the event sender when the issue is opened already labelled", () => {
    const result = classifyIssueEvent({
      event: "issues",
      payload: payload({ action: "opened", label: undefined }),
      label: "Cc",
    });
    expect(result.kind).toBe("trigger");
    expect(result.kind === "trigger" && result.trigger.actor).toBe("neco");
  });

  it("does not substitute the trusted author for an untrusted actor who reopens the issue", () => {
    const result = classifyIssueEvent({
      event: "issues",
      payload: payload({ action: "reopened", sender: { login: "untrusted" }, label: undefined }),
      label: "Cc",
    });
    expect(result.kind).toBe("trigger");
    expect(result.kind === "trigger" && result.trigger.actor).toBe("untrusted");
  });

  it("matches the label case-insensitively", () => {
    const result = classifyIssueEvent({
      event: "issues",
      payload: payload({ label: { name: "cc" } }),
      label: "Cc",
    });
    expect(result.kind).toBe("trigger");
  });

  it("ignores a different label on the same issue", () => {
    const result = classifyIssueEvent({
      event: "issues",
      payload: payload({ label: { name: "bug" } }),
      label: "Cc",
    });
    expect(result).toEqual({ kind: "ignored", reason: "label_absent" });
  });

  it("ignores actions that are not label attachment", () => {
    expect(classifyIssueEvent({ event: "issues", payload: payload({ action: "closed" }), label: "Cc" }))
      .toEqual({ kind: "ignored", reason: "other_action" });
  });

  it("ignores pull requests, which arrive as issue events too", () => {
    const withPr = payload();
    (withPr.issue as Record<string, unknown>).pull_request = { url: "..." };
    expect(classifyIssueEvent({ event: "issues", payload: withPr, label: "Cc" }))
      .toEqual({ kind: "ignored", reason: "pull_request" });
  });

  it("ignores other webhook events entirely", () => {
    expect(classifyIssueEvent({ event: "push", payload: payload(), label: "Cc" }))
      .toEqual({ kind: "ignored", reason: "not_issue_event" });
  });

  it("refuses payloads without a repository or number instead of guessing", () => {
    expect(classifyIssueEvent({ event: "issues", payload: payload({ repository: {} }), label: "Cc" }))
      .toEqual({ kind: "ignored", reason: "malformed" });
  });
});

describe("issueBranchName", () => {
  it("keeps one branch per issue", () => {
    expect(issueBranchName(42, "Fix the crash")).toBe("cc-issue-42-fix-the-crash");
  });

  it("falls back to the number when the title has no ASCII (日本語 Issue)", () => {
    expect(issueBranchName(7, "落ちる")).toBe("cc-issue-7");
  });

  it("does not end with a separator when the slug is truncated", () => {
    const branch = issueBranchName(1, "a".repeat(30) + " " + "b".repeat(30));
    expect(branch.endsWith("-")).toBe(false);
  });
});
