import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { makeGithubIssueRunsRepo } from "../db/github-issue-runs-repo.js";
import { ProjectCodesRepo } from "../db/project-codes-repo.js";
import type { GithubWorkflowConfig } from "../github/config.js";
import type { GithubGateway } from "../github/gh-cli.js";
import { githubSignature } from "../github/signature.js";
import { githubRouter } from "./github.js";

const SECRET = "webhook-secret-value";

function payload(): Record<string, unknown> {
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
      user: { login: "neco" },
    },
  };
}

function config(secret: string | null): GithubWorkflowConfig {
  return {
    label: () => "Cc",
    trustedActors: () => ["neco"],
    pollIntervalMs: () => 300_000,
    baseBranch: () => "main",
    fixCallName: () => "github-issue-fix",
    webhookSecret: () => secret,
    setWebhookSecret: () => {},
    clearWebhookSecret: () => {},
  };
}

function github(): GithubGateway {
  return {
    listLabeledIssues: async () => [],
    findLabelActor: async () => null,
    commentOnIssue: async () => {},
    createPullRequest: async () => "https://github.com/LUDIARS/Concordia/pull/1",
    findPullRequestByHead: async () => null,
  };
}

function harness(options: { secret?: string | null; enabled?: boolean } = {}) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const projects = new ProjectCodesRepo(db);
  projects.register({
    code: "Cc",
    project: "Concordia",
    repoPath: "E:/Document/Ars/Concordia",
    repoOrigin: "https://github.com/LUDIARS/Concordia.git",
    addedBy: "test",
  });
  projects.setGithubIssueWorkflow("Cc", true);
  const runs = makeGithubIssueRunsRepo(db);
  const delivered = new Set<string>();
  const workflowConfig = config(options.secret === undefined ? SECRET : options.secret);
  const app = githubRouter({
    runs,
    config: workflowConfig,
    markDelivery: (id) => (delivered.has(id) ? false : (delivered.add(id), true)),
    pollOnce: async () => ({ scanned: 0, dispatched: 0 }),
    isEnabled: () => options.enabled ?? true,
    dispatch: {
      runs,
      projects,
      config: workflowConfig,
      github: github(),
      invoke: async () => ({
        ok: true,
        run: { id: "deleg-1" },
        rendered_prompt: "",
        prompt_file_path: "",
      } as never),
    },
  });
  return { db, app, runs };
}

async function post(app: ReturnType<typeof harness>["app"], body: string, headers: Record<string, string>) {
  return app.request("/webhook", { method: "POST", body, headers });
}

describe("POST /v1/github/webhook", () => {
  it("dispatches a correctly signed issues event", async () => {
    const { db, app, runs } = harness();
    const body = JSON.stringify(payload());
    const response = await post(app, body, {
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(response.status).toBe(202);
    expect(runs.findByIssue("LUDIARS/Concordia", 42, "Cc")).not.toBeNull();
    db.close();
  });

  it("rejects an unsigned request", async () => {
    const { db, app, runs } = harness();
    const body = JSON.stringify(payload());
    const response = await post(app, body, { "x-github-event": "issues", "x-github-delivery": "d-1" });
    expect(response.status).toBe(401);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("rejects a request signed with the wrong secret", async () => {
    const { db, app, runs } = harness();
    const body = JSON.stringify(payload());
    const response = await post(app, body, {
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": githubSignature("not-the-secret", body),
    });
    expect(response.status).toBe(401);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("refuses every request while no secret is configured", async () => {
    const { db, app, runs } = harness({ secret: null });
    const body = JSON.stringify(payload());
    const response = await post(app, body, {
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(response.status).toBe(503);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("does not dispatch a signed event while the workflow is disabled", async () => {
    const { db, app, runs } = harness({ enabled: false });
    const body = JSON.stringify(payload());
    const response = await post(app, body, {
      "x-github-event": "issues",
      "x-github-delivery": "d-disabled",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(response.status).toBe(409);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("rejects an oversized body before dispatch", async () => {
    const { db, app, runs } = harness();
    const body = "x".repeat(1024 * 1024 + 1);
    const response = await post(app, body, {
      "content-length": String(Buffer.byteLength(body)),
      "x-github-event": "issues",
      "x-github-delivery": "d-large",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(response.status).toBe(413);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("answers a ping without touching the workflow", async () => {
    const { db, app, runs } = harness();
    const body = JSON.stringify({ zen: "…" });
    const response = await post(app, body, {
      "x-github-event": "ping",
      "x-github-delivery": "d-ping",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(response.status).toBe(200);
    expect(runs.list()).toEqual([]);
    db.close();
  });

  it("ignores a redelivery of the same event", async () => {
    const { db, app } = harness();
    const body = JSON.stringify(payload());
    const headers = {
      "x-github-event": "issues",
      "x-github-delivery": "d-1",
      "x-hub-signature-256": githubSignature(SECRET, body),
    };
    await post(app, body, headers);
    const again = await post(app, body, headers);
    expect(await again.json()).toEqual({ ok: true, duplicate: true });
    db.close();
  });

  it("ignores events for other labels", async () => {
    const { db, app, runs } = harness();
    const other = payload();
    other.label = { name: "bug" };
    const body = JSON.stringify(other);
    const response = await post(app, body, {
      "x-github-event": "issues",
      "x-github-delivery": "d-2",
      "x-hub-signature-256": githubSignature(SECRET, body),
    });
    expect(await response.json()).toMatchObject({ ignored: "label_absent" });
    expect(runs.list()).toEqual([]);
    db.close();
  });
});

describe("issue run listing and retry", () => {
  it("rejects unknown run statuses", async () => {
    const { db, app } = harness();
    const response = await app.request("/issue-runs?status=running,not-a-status");
    expect(response.status).toBe(400);
    db.close();
  });

  it("refuses to retry a run that is still in flight", async () => {
    const { db, app, runs } = harness();
    const created = runs.create({
      repoOrigin: "LUDIARS/Concordia",
      issueNumber: 42,
      issueTitle: "落ちる",
      issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
      label: "Cc",
      actor: "neco",
      projectCode: "Cc",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "cc-issue-42",
    })!;
    runs.update(created.id, { status: "running" });
    const response = await app.request(`/issue-runs/${created.id}/retry`, { method: "POST" });
    expect(response.status).toBe(409);
    db.close();
  });

  it("clears a terminal run so the poller can pick the issue up again", async () => {
    const { db, app, runs } = harness();
    const created = runs.create({
      repoOrigin: "LUDIARS/Concordia",
      issueNumber: 42,
      issueTitle: "落ちる",
      issueUrl: "https://github.com/LUDIARS/Concordia/issues/42",
      label: "Cc",
      actor: "neco",
      projectCode: "Cc",
      repoPath: "E:/Document/Ars/Concordia",
      branch: "cc-issue-42",
    })!;
    runs.update(created.id, { status: "failed" });
    const response = await app.request(`/issue-runs/${created.id}/retry`, { method: "POST" });
    expect(response.status).toBe(200);
    expect(runs.find(created.id)).toBeNull();
    db.close();
  });
});
