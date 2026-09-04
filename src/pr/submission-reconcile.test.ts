import { describe, expect, it, vi } from "vitest";

import type { RevisorLocalPrSummary } from "./revisor-local-pr-client.js";
import { isInconclusiveSubmissionError, reconcileInconclusiveSubmission } from "./submission-reconcile.js";

function pr(overrides: Partial<RevisorLocalPrSummary> = {}): RevisorLocalPrSummary {
  return {
    id: "local-1",
    number: 42,
    repository: "LUDIARS/Concordia",
    headRef: "feat/parttimer-stability",
    status: "open",
    checkStatus: "queued",
    ...overrides,
  } as RevisorLocalPrSummary;
}

describe("isInconclusiveSubmissionError", () => {
  it("treats an aborted request as inconclusive", () => {
    const error = new Error("This operation was aborted");
    error.name = "AbortError";
    expect(isInconclusiveSubmissionError(error)).toBe(true);
    // name が落ちた再送 (構造化クローン経由等) でも本文で拾う。
    expect(isInconclusiveSubmissionError(new Error("This operation was aborted"))).toBe(true);
  });

  it("treats a transport failure as inconclusive", () => {
    expect(isInconclusiveSubmissionError(new Error("fetch failed"))).toBe(true);
    expect(isInconclusiveSubmissionError(new Error("socket hang up"))).toBe(true);
  });

  it("treats a Revisor status response as conclusive", () => {
    expect(isInconclusiveSubmissionError(new Error("Revisor /v1/local-prs failed (409): duplicate"))).toBe(false);
    expect(isInconclusiveSubmissionError(new Error("Revisor returned an invalid local PR"))).toBe(false);
  });
});

describe("reconcileInconclusiveSubmission", () => {
  it("finds the PR that was created despite the lost response", async () => {
    const found = await reconcileInconclusiveSubmission({
      repository: "https://github.com/LUDIARS/Concordia.git",
      branch: "feat/parttimer-stability",
      listOpenPullRequests: async () => [pr()],
    });
    expect(found?.number).toBe(42);
  });

  it("returns null when no PR matches the branch", async () => {
    const found = await reconcileInconclusiveSubmission({
      repository: "LUDIARS/Concordia",
      branch: "feat/other",
      listOpenPullRequests: async () => [pr()],
    });
    expect(found).toBeNull();
  });

  it("does not mask the original failure when the re-read also fails", async () => {
    const listOpenPullRequests = vi.fn(async () => {
      throw new Error("Revisor is down");
    });
    await expect(reconcileInconclusiveSubmission({
      repository: "LUDIARS/Concordia",
      branch: "feat/parttimer-stability",
      listOpenPullRequests,
    })).resolves.toBeNull();
  });

  it("skips the re-read without a repository or branch", async () => {
    const listOpenPullRequests = vi.fn(async () => [pr()]);
    expect(await reconcileInconclusiveSubmission({ repository: null, branch: "x", listOpenPullRequests })).toBeNull();
    expect(await reconcileInconclusiveSubmission({ repository: "LUDIARS/Concordia", branch: "", listOpenPullRequests })).toBeNull();
    expect(listOpenPullRequests).not.toHaveBeenCalled();
  });
});
