import { describe, it, expect, vi } from "vitest";
import { SessionPrOperations, type SessionPrOperationsDeps } from "./session-pr-operations.js";
import type { LocalPrMergeAudit } from "./local-pr-merge.js";
import type { RevisorLocalPrSummary } from "./revisor-local-pr-client.js";
import type { StaffRole } from "../staff/roles.js";

const SESSION = {
  id: "sess-1",
  repo_origin: "https://github.com/LUDIARS/Concordia.git",
  branch: "feat/rwf-pr-merge-ui",
};

const OPEN_PR: RevisorLocalPrSummary = {
  id: "lpr-1",
  number: 42,
  repository: "LUDIARS/Concordia",
  headRef: "feat/rwf-pr-merge-ui",
  status: "open",
  checkStatus: "test_ok",
};

function makeOperations(options: {
  role?: StaffRole | null;
  pullRequests?: RevisorLocalPrSummary[];
  session?: ReturnType<SessionPrOperationsDeps["sessions"]["findSession"]>;
  submit?: Awaited<ReturnType<SessionPrOperationsDeps["submit"]>>;
  mergeThrows?: boolean;
  listReader?: SessionPrOperationsDeps["listReader"];
} = {}) {
  const audits: LocalPrMergeAudit[] = [];
  const mergeLocalPr = vi.fn(async () => {
    if (options.mergeThrows) throw new Error("revisor down at http://127.0.0.1:9999");
  });
  const submit = vi.fn(async () => options.submit ?? { submitted: true as const, pullRequest: OPEN_PR });
  const operations = new SessionPrOperations({
    platform: "discord",
    sessions: { findSession: () => (options.session === undefined ? SESSION : options.session) },
    submit,
    listLocalPullRequests: async () => options.pullRequests ?? [OPEN_PR],
    merge: {
      staff: { roleOf: () => options.role ?? null },
      merger: { mergeLocalPr },
      audit: (record) => audits.push(record),
    },
    source: "discord-reaction-workflow",
    ...(options.listReader ? { listReader: options.listReader } : {}),
  });
  return { operations, audits, mergeLocalPr, submit };
}

const actor = { userId: "u-1" };

describe("SessionPrOperations.submitLocalPr", () => {
  it("delegates to the shared local PR submitter", async () => {
    const { operations, submit } = makeOperations();
    const outcome = await operations.submitLocalPr({ sessionId: "sess-1", actor });

    expect(submit).toHaveBeenCalledWith("sess-1");
    expect(outcome).toEqual({
      ok: true,
      kind: "submitted",
      pullRequest: { id: "lpr-1", number: 42, repository: "LUDIARS/Concordia", headRef: "feat/rwf-pr-merge-ui" },
    });
  });

  it("passes the skip reason through instead of swallowing it", async () => {
    const { operations } = makeOperations({
      submit: { submitted: false, reason: "repository_not_registered" },
    });
    const outcome = await operations.submitLocalPr({ sessionId: "sess-1", actor });
    expect(outcome).toEqual({ ok: false, kind: "skipped", reason: "repository_not_registered", detail: undefined });
  });

  it("reports a retried submission as resubmitted", async () => {
    const { operations } = makeOperations({
      submit: { submitted: false, resubmitted: true, pullRequest: OPEN_PR },
    });
    const outcome = await operations.submitLocalPr({ sessionId: "sess-1", actor });
    expect(outcome.ok).toBe(true);
    expect(outcome).toMatchObject({ kind: "resubmitted" });
  });
});

describe("SessionPrOperations.mergeLocalPr", () => {
  it("merges the session branch PR and records who authorized it", async () => {
    const { operations, audits, mergeLocalPr } = makeOperations({ role: "manager" });
    const outcome = await operations.mergeLocalPr({ sessionId: "sess-1", actor });

    expect(mergeLocalPr).toHaveBeenCalledWith("lpr-1");
    expect(outcome).toMatchObject({ ok: true, kind: "merged", authorizerRole: "管理職" });
    expect(audits).toEqual([{
      local_pr_id: "lpr-1",
      session_id: "sess-1",
      source: "discord-reaction-workflow",
      authorizer: { platform: "discord", user_id: "u-1", role: "manager" },
    }]);
  });

  it("refuses when the requester lacks merge_pr", async () => {
    const { operations, audits, mergeLocalPr } = makeOperations({ role: "staff" });
    const outcome = await operations.mergeLocalPr({ sessionId: "sess-1", actor });

    expect(mergeLocalPr).not.toHaveBeenCalled();
    expect(audits).toEqual([]);
    expect(outcome).toMatchObject({ ok: false, kind: "not_authorized" });
    expect((outcome as { detail: string }).detail).toContain("PR のマージ");
  });

  it("refuses when the reactor is not on the staff roster", async () => {
    const { operations, mergeLocalPr } = makeOperations({ role: null });
    const outcome = await operations.mergeLocalPr({ sessionId: "sess-1", actor });
    expect(mergeLocalPr).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "not_authorized" });
  });

  it("reports no_local_pr when the branch has no open local PR", async () => {
    const { operations } = makeOperations({ role: "manager", pullRequests: [] });
    const outcome = await operations.mergeLocalPr({ sessionId: "sess-1", actor });
    expect(outcome).toMatchObject({ ok: false, kind: "no_local_pr" });
  });

  it("does not leak the raw Revisor failure", async () => {
    const { operations } = makeOperations({ role: "manager", mergeThrows: true });
    const outcome = await operations.mergeLocalPr({ sessionId: "sess-1", actor });

    expect(outcome).toMatchObject({ ok: false, kind: "failed" });
    expect((outcome as { detail: string }).detail).not.toContain("127.0.0.1");
  });

  it("reports an unknown session as unavailable", async () => {
    const { operations } = makeOperations({ role: "manager", session: null });
    const outcome = await operations.mergeLocalPr({ sessionId: "missing", actor });
    expect(outcome).toMatchObject({ kind: "unavailable" });
  });
});

describe("SessionPrOperations.mergeSelectedLocalPr", () => {
  it("merges the explicitly selected PR of that repository", async () => {
    const other: RevisorLocalPrSummary = { ...OPEN_PR, id: "lpr-2", number: 43, headRef: "feat/other" };
    const { operations, mergeLocalPr } = makeOperations({ role: "manager", pullRequests: [OPEN_PR, other] });

    const outcome = await operations.mergeSelectedLocalPr({ sessionId: "sess-1", localPrId: "lpr-2", actor });
    expect(mergeLocalPr).toHaveBeenCalledWith("lpr-2");
    expect(outcome).toMatchObject({ ok: true, kind: "merged" });
  });

  it("rejects a PR that is not open in that session's repository", async () => {
    const { operations, mergeLocalPr } = makeOperations({ role: "manager", pullRequests: [OPEN_PR] });
    const outcome = await operations.mergeSelectedLocalPr({ sessionId: "sess-1", localPrId: "lpr-999", actor });

    expect(mergeLocalPr).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ kind: "no_local_pr" });
  });
});

describe("SessionPrOperations.listOpenLocalPrs", () => {
  it("lists open local PRs of the session repository (origin URL is normalized)", async () => {
    const foreign: RevisorLocalPrSummary = { ...OPEN_PR, id: "lpr-x", repository: "LUDIARS/Memoria" };
    const closed: RevisorLocalPrSummary = { ...OPEN_PR, id: "lpr-c", status: "merged" };
    const { operations } = makeOperations({ pullRequests: [OPEN_PR, foreign, closed] });

    expect(await operations.listOpenLocalPrs("sess-1")).toEqual([OPEN_PR]);
  });
});

describe("SessionPrOperations.listLocalPrs (RWF 📋)", () => {
  const fullPr = (overrides: Record<string, unknown> = {}) => ({
    id: "lpr-1",
    number: 42,
    repository: "LUDIARS/Concordia",
    title: "feat: rwf listing",
    author: "session",
    status: "open",
    checkStatus: "queued",
    headRef: "feat/rwf-pr-merge-ui",
    baseRef: "main",
    headSha: "abc",
    createdAt: "2026-08-13T00:00:00Z",
    updatedAt: "2026-08-13T00:00:00Z",
    ...overrides,
  });

  it("is unavailable when no list reader is wired", async () => {
    const { operations } = makeOperations();
    const outcome = await operations.listLocalPrs({ sessionId: "sess-1", actor });
    expect(outcome).toMatchObject({ ok: false, kind: "unavailable" });
  });

  it("scopes to the session repository when fired from a session channel", async () => {
    const { operations } = makeOperations({
      listReader: {
        listLocalPrs: async () => [
          fullPr(),
          fullPr({ id: "lpr-2", number: 7, repository: "LUDIARS/Memoria", title: "other repo" }),
        ] as never,
      },
    });
    const outcome = await operations.listLocalPrs({ sessionId: "sess-1", actor });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.openCount).toBe(1);
      expect(outcome.markdown).toContain("#42");
      expect(outcome.markdown).not.toContain("other repo");
    }
  });

  it("lists all repositories when there is no session", async () => {
    const { operations } = makeOperations({
      listReader: {
        listLocalPrs: async () => [
          fullPr(),
          fullPr({ id: "lpr-2", number: 7, repository: "LUDIARS/Memoria", title: "other repo" }),
        ] as never,
      },
    });
    const outcome = await operations.listLocalPrs({ sessionId: null, actor });
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      expect(outcome.openCount).toBe(2);
      expect(outcome.markdown).toContain("other repo");
    }
  });

  it("does not broaden an unknown session to all repositories", async () => {
    const listLocalPrs = vi.fn(async () => [fullPr()] as never);
    const { operations } = makeOperations({
      session: null,
      listReader: { listLocalPrs },
    });

    const outcome = await operations.listLocalPrs({ sessionId: "missing", actor });

    expect(outcome).toMatchObject({ ok: false, kind: "unavailable" });
    expect(listLocalPrs).not.toHaveBeenCalled();
  });

  it("does not list every repository when the session has no repository", async () => {
    const listLocalPrs = vi.fn(async () => [fullPr()] as never);
    const { operations } = makeOperations({
      session: { ...SESSION, repo_origin: null },
      listReader: { listLocalPrs },
    });

    const outcome = await operations.listLocalPrs({ sessionId: "sess-1", actor });

    expect(outcome).toMatchObject({ ok: false, kind: "unavailable" });
    expect(listLocalPrs).not.toHaveBeenCalled();
  });

  it("reports reader failures without leaking raw service details", async () => {
    const { operations } = makeOperations({
      listReader: {
        listLocalPrs: async () => { throw new Error("connect failed at http://secret.invalid/private"); },
      },
    });

    const outcome = await operations.listLocalPrs({ sessionId: "sess-1", actor });

    expect(outcome).toMatchObject({ ok: false, kind: "unavailable" });
    expect((outcome as { detail: string }).detail).not.toContain("secret.invalid");
    expect((outcome as { detail: string }).detail).not.toContain("/private");
    expect((outcome as { markdown: string }).markdown).toContain("Revisor local PR 一覧");
    expect((outcome as { markdown: string }).markdown).toContain("GitHub PR のキューは別系統");
  });
});
