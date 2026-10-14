import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import type { BountyReportRow } from "../db/bounty-reports-repo.js";
import type { ActioBinding } from "../taskflow/actio-binding.js";
import { BOUNTY_ACTIO_SOURCE, createBountyActioAdapter } from "./actio-adapter.js";
import { createBountyNotifier } from "./notifier-adapter.js";
import { createCocoiruKeyStore, ensureBountyOperatorToken, readBountyOperatorToken } from "./operator-credentials.js";
import { createBountyPrLookup } from "./pr-lookup-adapter.js";
import { toBountyAdminSummary } from "./admin-view.js";

const binding: ActioBinding = {
  repoPath: "E:/Document/Ars/Concordia", project: "Concordia", projectId: "Cc", ownerId: "actio-local",
  authMode: "loopback", subsidiaryId: null, teamId: "team-1",
};

describe("createBountyActioAdapter (bug-bounty.md §6)", () => {
  it("creates an issue task under concordia.bounty.v1 with the report id as sourceRef", async () => {
    const request = vi.fn(async () => ({ task: { id: "t-9" } }));
    const adapter = createBountyActioAdapter({ bindings: async () => [binding], transport: { request }, repoPath: () => binding.repoPath });
    expect(await adapter.createIssueTask({ reportId: "br_1", project: "Cc", subsidiaryId: null, title: "t", description: "d" }))
      .toEqual({ ok: true, taskRef: "actio:t-9" });
    expect(request).toHaveBeenCalledWith(binding, "POST", "/api/tasks", expect.objectContaining({
      source: BOUNTY_ACTIO_SOURCE, sourceRef: "br_1", kind: "issue", lane: "backlog", executorType: "ai", assigneeId: "actio-local", teamId: "team-1",
    }));
  });

  it("refuses to pick a team or an assignee and classifies Actio being down as retryable", async () => {
    const request = vi.fn(async () => { throw new Error("Actio task request outcome unknown; reconcile using the same task identity"); });
    const make = (bindings: ActioBinding[]) => createBountyActioAdapter({ bindings: async () => bindings, transport: { request }, repoPath: () => binding.repoPath });
    const input = { reportId: "br_1", project: "Cc", subsidiaryId: null, title: "t", description: "d" };
    expect(await make([{ ...binding, teamId: null, teamCandidates: ["a", "b"] }]).createIssueTask(input)).toMatchObject({ ok: false, error: "team_ambiguous" });
    expect(await make([]).createIssueTask(input)).toMatchObject({ ok: false, error: "no_binding" });
    expect(await make([{ ...binding, authMode: "bearer", tokenEnv: "X", ownerId: "u1" }]).createIssueTask(input)).toMatchObject({ ok: false, error: "assignee_unresolved" });
    expect(await make([binding]).createIssueTask(input)).toMatchObject({ ok: false, error: "actio_unavailable" });
  });
});

const report = (patch: Partial<BountyReportRow>): BountyReportRow => ({
  id: "br_1", subsidiary_id: "sub_a", project_code: "Cc", reporter_kind: "person", reporter_id: "bp_1", reporter_session_id: null,
  recipient_reporter_id: "bp_1", what_happened: "x", repro_steps: "", intake_platform: "discord", intake_key: "discord:1",
  intake_ref_json: JSON.stringify({ channel_id: "55555" }), status: "accepted", verdict: "accepted", verdict_reason: null,
  severity: null, sensitive: 1, self_inflicted: 0, hotfix_eligible: 0, duplicate_of: null, public_title: null, public_summary: null,
  actio_task_ref: null, actio_task_error: null, fix_pr: null, deploy_code: null, deploy_hash: null, close_evidence: null,
  closed_by: null, received_at: 1, triaged_at: null, deployed_at: null, withdrawn_at: null, updated_at: 1, triage_run_id: null,
  triage_started_at: null, triage_failures: 0, triage_escalated_at: null, info_requested_at: null, appeal_requested_at: null,
  appeal_reason: null, appeal_decided_at: null, actio_task_attempted_at: null, hotfix_run_id: null, hotfix_started_at: null,
  reward_state: null, reward_note: null, reward_tokens: null, actio_done_notified_at: null, ...patch,
});

describe("createBountyNotifier (bug-bounty.md §7)", () => {
  it("mentions only the reporter through the structured field, injects sessions and skips Cocoiru", async () => {
    const postDiscord = vi.fn(async () => undefined);
    const injectSession = vi.fn(() => true);
    const notifier = createBountyNotifier({
      reporters: { find: () => ({ id: "bp_1", subsidiary_id: "sub_a", platform: "discord", platform_user_id: "905235114026467350", public_name: null, created_at: 1, updated_at: 1 }) },
      postDiscord, injectSession, authorityChannel: () => null,
    });
    expect(await notifier.replyToReporter(report({}), "結果")).toBe(true);
    expect(postDiscord).toHaveBeenCalledWith({ channelId: "55555", subsidiaryId: "sub_a", content: "<@905235114026467350>\n結果", mentionUserId: "905235114026467350" });
    expect(await notifier.replyToReporter(report({ intake_platform: "session", reporter_session_id: "s1" }), "結果")).toBe(true);
    expect(injectSession).toHaveBeenCalledWith("s1", "結果");
    expect(await notifier.replyToReporter(report({ intake_platform: "cocoiru" }), "結果")).toBe(false);
    expect(await notifier.notifyAuthority("要対応")).toBe(false);
  });
});

describe("createBountyPrLookup (SPEC-BOUNTY-FIX-LINK)", () => {
  it("finds the session's PR in the project repository and the sessions linked to a task", () => {
    const db = makeTestDb();
    db.prepare(`INSERT INTO pr_records(repo_origin, number, title, state, ci_status, review_state, author_session_id, created_at, updated_at)
      VALUES (?, ?, 't', 'open', 'unknown', 'none', ?, ?, ?)`).run("LUDIARS/Actio", 7, "s1", 1, 1);
    db.prepare(`INSERT INTO pr_records(repo_origin, number, title, state, ci_status, review_state, author_session_id, created_at, updated_at)
      VALUES (?, ?, 't', 'open', 'unknown', 'none', ?, ?, ?)`).run("https://github.com/LUDIARS/Concordia.git", 42, "s1", 2, 2);
    db.prepare(`INSERT INTO sessions(id, provider, repo_path, host, started_at, status, last_seen_at, metadata)
      VALUES ('s1', 'claude-code', 'E:/x', 'h', 1, 'active', 1, ?)`).run(JSON.stringify({ cc_task_links: [{ task_reference: "actio:t-1" }] }));
    const lookup = createBountyPrLookup({ db, repoOrigin: (code) => (code === "Cc" ? "LUDIARS/Concordia" : null) });
    expect(lookup.prOfSession("s1", "Cc")).toBe("42");
    expect(lookup.prOfSession("s1", "Zz")).toBeNull();
    expect(lookup.sessionsOfTask("actio:t-1")).toEqual(["s1"]);
    expect(lookup.sessionsOfTask("actio:t-")).toEqual([]);
  });
});

describe("operator credentials (CC-BOUNTY-INV-10)", () => {
  it("creates the Bot token once and rotates a corrupt one", () => {
    const dir = mkdtempSync(join(tmpdir(), "bounty-token-"));
    const token = ensureBountyOperatorToken(dir);
    expect(token).toMatch(/^[a-f0-9]{64}$/u);
    expect(ensureBountyOperatorToken(dir)).toBe(token);
    writeFileSync(join(dir, ".bounty-operator.token"), "broken");
    expect(readBountyOperatorToken(dir)).toBeNull();
    expect(ensureBountyOperatorToken(dir)).not.toBe(token);
  });

  it("stores the Cocoiru key encrypted and refuses to store it without a secret box", () => {
    const meta = new Map<string, string>();
    const store = { get: (k: string) => meta.get(k) ?? null, set: (k: string, v: string) => { meta.set(k, v); }, delete: (k: string) => { meta.delete(k); } };
    const box = { encrypt: (v: string) => `enc:${Buffer.from(v).toString("base64")}`, decrypt: (v: string) => Buffer.from(v.slice(4), "base64").toString() };
    const keys = createCocoiruKeyStore({ meta: store, secretBox: box });
    keys.set("cocoiru-0123456789abcdef");
    expect([...meta.values()][0]).not.toContain("cocoiru-0123456789abcdef");
    expect(keys.read()).toBe("cocoiru-0123456789abcdef");
    keys.set(null);
    expect(keys.isSet()).toBe(false);
    expect(() => createCocoiruKeyStore({ meta: store, secretBox: null }).set("x".repeat(20))).toThrow();
  });
});

describe("toBountyAdminSummary (bug-bounty.md §8.2)", () => {
  it("flags reports that need a person", () => {
    const { what_happened: _w, repro_steps: _r, intake_ref_json: _i, intake_key: _k, ...row } = report({ status: "received", triage_escalated_at: 5 });
    const summary = toBountyAdminSummary(row, () => null);
    expect(summary.needs_attention).toContain("仕分けの失敗");
    expect(summary).not.toHaveProperty("what_happened");
  });
});
