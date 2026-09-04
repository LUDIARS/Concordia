import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { makeDiscordSessionChannelsRepo } from "../db/discord-repo.js";
import { PrRecordsRepo } from "../db/pr-records-repo.js";
import type { DelegationService } from "../delegation/service.js";
import { delegationRouter } from "./delegation.js";

const tempRoots: string[] = [];
const COMPLETION_EVIDENCE_TEST_TIMEOUT_MS = 120_000;

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("delegation completed evidence", () => {
  it.each(["completed", "failed"] as const)(
    "closes the child session Discord channel when a delegation run becomes %s",
    (status) => {
      const db = makeTestDb();
      const repo = new DelegationRepo(db);
      const channels = makeDiscordSessionChannelsRepo(db);
      channels.upsert({ session_id: "child-session", channel_id: "child-channel" });
      repo.createRun({
        id: "source-run", template_id: null, call_name: "impl", target_provider: "codex", parent_session_id: null,
        args: {}, rendered_prompt: "prompt", prompt_file_path: "prompt.md", spawn_pid: 1,
        spawn_command: ["codex"], triggered_by: null, status: "running", child_session_id: "child-session",
      });

      repo.updateRunStatus("source-run", status);

      expect(channels.findBySessionId("child-session")).toMatchObject({ status: "ended", display_state: "ended" });
    },
  );

  it("closes a legacy child session channel found through session metadata", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const channels = makeDiscordSessionChannelsRepo(db);
    db.prepare(`INSERT INTO sessions(id, provider, repo_path, host, started_at, status, last_seen_at, metadata) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run("legacy-child", "codex", "repo", "host", 1, "active", 1, JSON.stringify({ delegation_run_id: "source-run" }));
    channels.upsert({ session_id: "legacy-child", channel_id: "legacy-channel" });
    repo.createRun({
      id: "source-run", template_id: null, call_name: "impl", target_provider: "codex", parent_session_id: null,
      args: {}, rendered_prompt: "prompt", prompt_file_path: "prompt.md", spawn_pid: 1,
      spawn_command: ["codex"], triggered_by: null, status: "running", child_session_id: null,
    });

    repo.updateRunStatus("source-run", "completed");

    expect(channels.findBySessionId("legacy-child")).toMatchObject({ status: "ended", display_state: "ended" });
  });

  it("keeps completed behavior for runs without checkout metadata", async () => {
    const { app, repo } = makeApp(null, null);

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
  });

  it("does not inherit a same-name global parttimer exemption", async () => {
    const { app, repo } = makeApp(process.cwd(), null, "employee", "parttimer");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")?.status).toBe("failed");
  });

  it("uses the category recorded at launch instead of mutable template state", async () => {
    const { app, repo } = makeApp(process.cwd(), null, "parttimer", "parttimer");
    const template = repo.findTemplateByCallName("impl");
    if (!template) throw new Error("expected template");
    repo.updateTemplate(template.id, { category: "employee" });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
  });

  it("accepts completed when the recorded feature worktree contains a commit beyond main", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    writeFileSync(join(cwd, "evidence.txt"), "done\n", "utf8");
    await git(cwd, ["add", "evidence.txt"]);
    await git(cwd, ["commit", "-m", "evidence"]);
    const { app, repo } = makeApp(cwd, "feat/evidence");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it("rejects completed without a feature-branch commit and records the failure", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    const { app, repo } = makeApp(cwd, "feat/evidence");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "completed_without_evidence" });
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed", error: expect.stringContaining("no completion evidence") });
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it("accepts an orchestrator run without a feature branch when its direct child PR merged", async () => {
    const { app, repo, prs } = makeApp(process.cwd(), null);
    repo.claimChildSession("source-run", "child-session");
    const childPr = prs.upsertFromStat({
      repo_origin: "https://github.com/example/repo.git",
      number: 1,
      author_session_id: "child-session",
    });
    prs.reconcile({
      repo_origin: childPr.repo_origin,
      number: childPr.number,
      state: "merged",
    });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
  });

  it("rejects an orchestrator run without a merged direct child PR", async () => {
    const { app, repo, prs } = makeApp(process.cwd(), null);
    repo.claimChildSession("source-run", "child-session");
    prs.upsertFromStat({
      repo_origin: "https://github.com/example/repo.git",
      number: 1,
      author_session_id: "child-session",
    });
    const descendantPr = prs.upsertFromStat({
      repo_origin: "https://github.com/example/repo.git",
      number: 2,
      author_session_id: "grandchild-session",
    });
    prs.reconcile({
      repo_origin: descendantPr.repo_origin,
      number: descendantPr.number,
      state: "merged",
    });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed", error: expect.stringContaining("no completion evidence") });
  });

  it("does not let a merged child PR override invalid feature-branch evidence", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    const { app, repo, prs } = makeApp(cwd, "feat/evidence");
    repo.claimChildSession("source-run", "child-session");
    const childPr = prs.upsertFromStat({
      repo_origin: "https://github.com/example/repo.git",
      number: 1,
      author_session_id: "child-session",
    });
    prs.reconcile({
      repo_origin: childPr.repo_origin,
      number: childPr.number,
      state: "merged",
    });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed", error: expect.stringContaining("no completion evidence") });
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it("rejects completed when the recorded checkout is missing", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "concordia-completion-evidence-missing-"));
    tempRoots.push(cwd);
    rmSync(cwd, { recursive: true, force: true });
    const { app, repo } = makeApp(cwd, "feat/evidence");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")?.error).toContain("checkout is missing");
  });

  it("rejects completed when HEAD differs from the recorded branch", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    const { app, repo } = makeApp(cwd, "feat/other");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")?.error).toContain("recorded non-protected feature branch");
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it("rejects a zero-commit feature branch when develop diverged behind main", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["branch", "develop"]);
    writeFileSync(join(cwd, "main-only.txt"), "main\n", "utf8");
    await git(cwd, ["add", "main-only.txt"]);
    await git(cwd, ["commit", "-m", "main-only"]);
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    const { app, repo } = makeApp(cwd, "feat/evidence");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed" });
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it("rejects a detached HEAD even when it has a commit beyond main", async () => {
    const cwd = await makeFeatureWorktree();
    await git(cwd, ["checkout", "-b", "feat/evidence"]);
    writeFileSync(join(cwd, "evidence.txt"), "done\n", "utf8");
    await git(cwd, ["add", "evidence.txt"]);
    await git(cwd, ["commit", "-m", "evidence"]);
    await git(cwd, ["checkout", "--detach"]);
    const { app, repo } = makeApp(cwd, "HEAD");

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")).toMatchObject({ status: "failed" });
  }, COMPLETION_EVIDENCE_TEST_TIMEOUT_MS);

  it.each(["partial", "failed"] as const)("keeps %s status behavior outside the completed evidence guard", async (status) => {
    const { app, repo } = makeApp(null, null);
    const body = status === "partial"
      ? { status, remaining: [{ title: "finish implementation" }] }
      : { status, detail: "agent failed" };

    const response = await postStatus(app, body);

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe(status === "failed" ? "failed" : "completed");
  });

  // レビュー専用テンプレ (脆弱性対応 / レビュー / 調査) はコードを書かないので feature branch
  // を持たない。 ガードはそれを一律 reject していたため completed を報告できなかった。
  it("accepts completed from a review-only template even without a feature branch", async () => {
    const { app, repo } = makeAppWithTemplate(process.cwd(), null, { review_only: true });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(200);
    expect(repo.findRun("source-run")?.status).toBe("completed");
  });

  // 「branch が無ければ素通し」に緩めたわけではないことの確認。 実装テンプレの run は
  // branch 証跡が無ければ従来どおり落ちる。
  it("still rejects completed without a feature branch when the template is not review-only", async () => {
    const { app, repo } = makeAppWithTemplate(process.cwd(), null, { review_only: false });

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")?.status).toBe("failed");
  });

  it("does not let an unfinished implementation run disable its own evidence requirement", async () => {
    const { app, repo, templateId } = makeAppWithTemplate(process.cwd(), null, { review_only: false });

    const patchResponse = await app.request(`/v1/delegation/templates/${templateId}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ review_only: true }),
    });
    const completionResponse = await postStatus(app, { status: "completed" });

    expect(patchResponse.status).toBe(409);
    expect(repo.findTemplate(templateId)?.review_only).toBe(0);
    expect(completionResponse.status).toBe(409);
    expect(repo.findRun("source-run")?.status).toBe("failed");
  });

  // テンプレが削除された run は宣言を確認できない。 証跡を要求する側へ倒す。
  it("rejects completed without a feature branch when the template no longer exists", async () => {
    const { app, repo, templateId } = makeAppWithTemplate(process.cwd(), null, { review_only: true });
    repo.deleteTemplatePermanently(templateId);

    const response = await postStatus(app, { status: "completed" });

    expect(response.status).toBe(409);
    expect(repo.findRun("source-run")?.status).toBe("failed");
  });
});

function makeAppWithTemplate(
  cwd: string | null,
  branch: string | null,
  { review_only }: { review_only: boolean },
): { app: Hono; repo: DelegationRepo; prs: PrRecordsRepo; templateId: string } {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const prs = new PrRecordsRepo(db);
  const template = repo.createTemplate({
    call_name: review_only ? "vulnerability-response-daily" : "impl",
    title: review_only ? "脆弱性対応" : "実装",
    target_provider: "codex",
    prompt_template: "prompt",
    review_only,
  });
  repo.createRun({
    id: "source-run", template_id: template.id, call_name: template.call_name, target_provider: "codex",
    parent_session_id: null, args: {}, rendered_prompt: "prompt", prompt_file_path: "prompt.md", spawn_pid: 1,
    spawn_command: ["codex"], triggered_by: null, status: "running", spawn_cwd: cwd, spawn_worktree_path: cwd,
    spawn_branch: branch,
  });
  const service = { recordEffortOutcome: vi.fn(), invoke: vi.fn() } as unknown as DelegationService;
  return {
    app: new Hono().route("/v1/delegation", delegationRouter({ repo, service, prs })),
    repo,
    prs,
    templateId: template.id,
  };
}

function makeApp(
  cwd: string | null,
  branch: string | null,
  category: "employee" | "parttimer" | null = "employee",
  templateCategory: "employee" | "parttimer" | null = null,
): { app: Hono; repo: DelegationRepo; prs: PrRecordsRepo } {
  const db = makeTestDb();
  const repo = new DelegationRepo(db);
  const prs = new PrRecordsRepo(db);
  const template = templateCategory ? repo.createTemplate({
    call_name: "impl",
    title: "Implementation",
    target_provider: "claude",
    category: templateCategory,
    prompt_template: "task",
  }) : null;
  repo.createRun({
    id: "source-run", template_id: template?.id ?? null, category, call_name: "impl", target_provider: "codex", parent_session_id: null,
    args: { task: "finish" }, rendered_prompt: "prompt", prompt_file_path: "prompt.md", spawn_pid: 1,
    spawn_command: ["codex"], triggered_by: null, status: "running", spawn_cwd: cwd, spawn_worktree_path: cwd,
    spawn_branch: branch,
  });
  const service = {
    recordEffortOutcome: vi.fn(),
    invoke: vi.fn(async () => ({
      ok: true as const,
      run: repo.createRun({
        id: "requeued-run", template_id: null, call_name: "impl", target_provider: "codex", parent_session_id: null,
        args: { task: "finish" }, rendered_prompt: "prompt", prompt_file_path: "prompt.md", spawn_pid: 2,
        spawn_command: ["codex"], triggered_by: "partial-requeue:source-run", status: "spawned",
      }),
    })),
  } as unknown as DelegationService;
  return { app: new Hono().route("/v1/delegation", delegationRouter({ repo, service, prs })), repo, prs };
}

async function makeFeatureWorktree(): Promise<string> {
  const cwd = mkdtempSync(join(tmpdir(), "concordia-completion-evidence-"));
  tempRoots.push(cwd);
  await git(cwd, ["init"]);
  await git(cwd, ["config", "user.email", "concordia-test@example.invalid"]);
  await git(cwd, ["config", "user.name", "Concordia Test"]);
  writeFileSync(join(cwd, "README.md"), "test\n", "utf8");
  await git(cwd, ["add", "README.md"]);
  await git(cwd, ["commit", "-m", "init"]);
  await git(cwd, ["branch", "-M", "main"]);
  return cwd;
}

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd,
    encoding: "utf8",
    windowsHide: true,
  });
  return stdout;
}

function postStatus(app: Hono, body: unknown): Promise<Response> {
  return Promise.resolve(app.request("/v1/delegation/runs/source-run/status", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}
