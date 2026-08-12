import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import {
  DelegationService,
  renderTemplate,
  resolveDelegationSpawner,
  validateArgs,
  type DelegationDefinition,
} from "./service.js";
import { DelegationEffortBlackbox } from "./effort-blackbox.js";
import { spawnSession } from "../control/spawner.js";

// The test creates and removes a real Git worktree. Keep a finite timeout, but
// do not make a busy Windows review worker fail a correct worktree operation.
const REAL_GIT_WORKTREE_TIMEOUT_MS = 60_000;

describe("resolveDelegationSpawner", () => {
  it("uses the normal Lictor session spawner for Codex Delegation by default", () => {
    expect(resolveDelegationSpawner()).toBe(spawnSession);
  });

  it("preserves an explicitly injected test spawner", () => {
    const injected = () => ({ ok: true as const, pid: 1, command: ["test"] });
    expect(resolveDelegationSpawner(injected)).toBe(injected);
  });
});

describe("renderTemplate", () => {
  it("substitutes ${var}", async () => {
    const r = renderTemplate("Hello ${name}!", { name: "World" }, [
      { name: "name", type: "string", required: true },
    ]);
    expect(r.rendered).toBe("Hello World!");
    expect(r.missing).toEqual([]);
  });

  it("uses ${var:default}", async () => {
    const r = renderTemplate("${greet:hi} ${who}", { who: "Ada" }, [
      { name: "greet", type: "string", required: false },
      { name: "who", type: "string", required: true },
    ]);
    expect(r.rendered).toBe("hi Ada");
  });

  it("reports missing required", async () => {
    const r = renderTemplate("${a} ${b}", {}, [
      { name: "a", type: "string", required: true },
      { name: "b", type: "string", required: true },
    ]);
    expect(r.missing.sort()).toEqual(["a", "b"]);
  });

  it("uses schema default when arg missing", async () => {
    const r = renderTemplate("${x}", {}, [
      { name: "x", type: "string", required: false, default: "fallback" },
    ]);
    expect(r.rendered).toBe("fallback");
  });

  it("flags unknown vars referenced in template", async () => {
    const r = renderTemplate("${known} ${unknown}", { known: "ok" }, [
      { name: "known", type: "string", required: true },
    ]);
    expect(r.unknown_vars).toEqual(["unknown"]);
  });

  it("treats empty string value as absent — renders to '' and includes in missing for required", async () => {
    const r = renderTemplate("${req}", { req: "" }, [
      { name: "req", type: "string", required: true },
    ]);
    // Empty string is treated the same as undefined — substitution renders to ""
    expect(r.rendered).toBe("");
    // And it's counted as missing for required args
    expect(r.missing).toContain("req");
  });

  it("falls back to inline default when value is empty string", async () => {
    const r = renderTemplate("${opt:default-val}", { opt: "" }, [
      { name: "opt", type: "string", required: false },
    ]);
    // Empty string triggers fallback syntax
    expect(r.rendered).toBe("default-val");
  });
});

describe("validateArgs", () => {
  it("accepts well-typed args", async () => {
    expect(
      validateArgs({ s: "x", n: 1, b: true }, [
        { name: "s", type: "string", required: true },
        { name: "n", type: "number", required: true },
        { name: "b", type: "boolean", required: true },
      ]),
    ).toEqual({ ok: true });
  });

  it("flags wrong types", async () => {
    const r = validateArgs({ n: "string-not-number" }, [
      { name: "n", type: "number", required: true },
    ]);
    expect(r.ok).toBe(false);
  });

  it("flags null value for required arg with no default as missing required", () => {
    const r = validateArgs({ x: null } as Record<string, unknown>, [
      { name: "x", type: "string", required: true },
    ]);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("missing required arg: x");
  });

  it("accepts null value for optional arg without error", () => {
    const r = validateArgs({ x: null } as Record<string, unknown>, [
      { name: "x", type: "string", required: false },
    ]);
    expect(r.ok).toBe(true);
  });

  it("accepts entirely missing optional arg", () => {
    const r = validateArgs({}, [{ name: "x", type: "string", required: false }]);
    expect(r.ok).toBe(true);
  });
});

describe("DelegationService.invoke", () => {
  let db: ReturnType<typeof makeTestDb>;
  let repo: DelegationRepo;
  let promptsDir: string;
  let svc: DelegationService;
  const spawnCalls: Array<unknown> = [];

  beforeEach(() => {
    db = makeTestDb();
    repo = new DelegationRepo(db);
    promptsDir = mkdtempSync(join(tmpdir(), "deleg-test-"));
    spawnCalls.length = 0;
    svc = new DelegationService({
      repo,
      promptsDir,
      spawn: (req) => {
        spawnCalls.push(req);
        return { ok: true, pid: 999, command: ["wt.exe", "stub", req.provider] };
      },
    });
    repo.createTemplate({
      call_name: "echo",
      title: "Echo",
      target_provider: "codex",
      prompt_template: "echo ${msg}",
      input_schema: [{ name: "msg", type: "string", required: true }],
    });
  });

  afterEach(() => {
    rmSync(promptsDir, { recursive: true, force: true });
  });

  it("writeAdHocPrompt writes the raw prompt to a file and returns its path", async () => {
    const path = await svc.writeAdHocPrompt("自由テキストの初回指示\n2行目");
    expect(path.startsWith(promptsDir)).toBe(true);
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toBe("自由テキストの初回指示\n2行目");
  });

  it("invokes a template, writes prompt file, spawns by default", async () => {
    const r = await svc.invoke({ call_name: "echo", args: { msg: "hi" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered_prompt).toBe("echo hi");
    expect(existsSync(r.prompt_file_path)).toBe(true);
    const file = readFileSync(r.prompt_file_path, "utf8");
    expect(file).toContain("echo hi");
    expect(file).toContain("echo");
    expect(r.spawn_pid).toBe(999);
    expect(spawnCalls.length).toBe(1);
    expect((spawnCalls[0] as { mode?: string }).mode).toBe("window");
  });

  it("extra_prompt: render 結果末尾に追記し、prompt file と rendered_prompt 両方に載る", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      extra_prompt: "追加の指示だよ",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered_prompt).toContain("echo hi");
    expect(r.rendered_prompt).toContain("追加の初回指示");
    expect(r.rendered_prompt).toContain("追加の指示だよ");
    expect(readFileSync(r.prompt_file_path, "utf8")).toContain("追加の指示だよ");
  });

  it("extra_prompt 空文字は追記しない", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      extra_prompt: "   ",
    });
    if (!r.ok) throw new Error("expected ok");
    expect(r.rendered_prompt).toBe("echo hi");
  });

  it("injectManual dep: kind 別マニュアルが prompt file の協調コンテキストに差し込まれる", async () => {
    const requestedKinds: string[] = [];
    const svcWithManual = new DelegationService({
      repo,
      promptsDir,
      spawn: () => ({ ok: true, pid: 1, command: ["stub"] }),
      injectManual: (kind) => {
        requestedKinds.push(kind);
        return kind === "実装" ? "実装マニュアル本文 (worktree を生成してから作業)" : null;
      },
    });
    // call_name "echo" は review/design/test を含まない → 実装
    const r = await svcWithManual.invoke({ call_name: "echo", args: { msg: "hi" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(requestedKinds).toEqual(["実装"]);
    const file = readFileSync(r.prompt_file_path, "utf8");
    expect(file).toContain("## 作業マニュアル (kind: 実装)");
    expect(file).toContain("実装マニュアル本文 (worktree を生成してから作業)");
  });

  it("injectManual が null を返す kind ではマニュアル節を差し込まない", async () => {
    const svcWithManual = new DelegationService({
      repo,
      promptsDir,
      spawn: () => ({ ok: true, pid: 1, command: ["stub"] }),
      injectManual: () => null,
    });
    const r = await svcWithManual.invoke({ call_name: "echo", args: { msg: "hi" } });
    if (!r.ok) throw new Error("expected ok");
    expect(readFileSync(r.prompt_file_path, "utf8")).not.toContain("## 作業マニュアル");
  });

  it("file name matches run.id", async () => {
    const r = await svc.invoke({ call_name: "echo", args: { msg: "x" } });
    if (!r.ok) throw new Error("expected ok");
    expect(r.prompt_file_path).toContain(r.run.id);
  });

  it("spawn=false: writes file, records run, does not spawn", async () => {
    const r = await svc.invoke({ call_name: "echo", args: { msg: "x" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spawn_pid).toBeNull();
    expect(spawnCalls.length).toBe(0);
    expect(r.run.status).toBe("pending");
  });

  it("returns error for unknown call_name", async () => {
    const r = await svc.invoke({ call_name: "nope", args: {} });
    expect(r.ok).toBe(false);
  });

  it("returns error for missing required args", async () => {
    const r = await svc.invoke({ call_name: "echo", args: {} });
    expect(r.ok).toBe(false);
  });

  it("returns error for inactive template", async () => {
    repo.createTemplate({
      call_name: "inactive-tpl",
      title: "Inactive",
      target_provider: "codex",
      prompt_template: "do ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
      is_active: false,
    });
    const r = await svc.invoke({ call_name: "inactive-tpl", args: { x: "ok" } });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error).toContain("inactive");
  });

  it("passes template.model to spawn as --model args", async () => {
    repo.createTemplate({
      call_name: "with-model",
      title: "With model",
      target_provider: "codex",
      model: "gpt-5.5",
      prompt_template: "do ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
    });
    const r = await svc.invoke({ call_name: "with-model", args: { x: "y" } });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[]; provider: string };
    expect(req.provider).toBe("codex");
    expect(req.args).toEqual(["--model", "gpt-5.5", "-c", 'model_reasoning_effort="low"']);
  });

  it("passes one-shot Codex runtime options to spawn args", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      options: { model_reasoning_effort: "high" },
    });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[]; provider: string };
    expect(req.provider).toBe("codex");
    expect(req.args).toEqual(["-c", 'model_reasoning_effort="high"']);
    if (!r.ok) return;
    expect(r.run.effort_level).toBe("high");
    expect(r.run.effort_source).toBe("one-shot");
  });

  it("rejects an invalid explicit effort instead of silently defaulting", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      options: { model_reasoning_effort: "impossible" },
    });
    expect(r).toMatchObject({ ok: false, error: "invalid codex effort: impossible" });
    expect(spawnCalls).toEqual([]);
  });

  it("uses template default runtime options and lets invoke override them", async () => {
    repo.createTemplate({
      call_name: "with-default-options",
      title: "With default options",
      target_provider: "codex",
      runtime_options: { model_reasoning_effort: "medium" },
      prompt_template: "do ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
    });

    const r1 = await svc.invoke({ call_name: "with-default-options", args: { x: "y" } });
    expect(r1.ok).toBe(true);
    expect((spawnCalls[0] as { args?: string[] }).args).toEqual([
      "-c",
      'model_reasoning_effort="medium"',
    ]);

    const r2 = await svc.invoke({
      call_name: "with-default-options",
      args: { x: "z" },
      options: { model_reasoning_effort: "high" },
    });
    expect(r2.ok).toBe(true);
    expect((spawnCalls[1] as { args?: string[] }).args).toEqual([
      "-c",
      'model_reasoning_effort="high"',
    ]);
  });

  it("supports one-shot provider/model/reasoning overrides without changing the template", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      options: { fast_mode: true },
      overrides: { provider: "claude", model: "claude-sonnet-5", reasoning_effort: "high" },
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const req = spawnCalls[0] as { provider: string; args?: string[]; env?: Record<string, string> };
    expect(req.provider).toBe("claude");
    expect(req.args).toEqual(["--model", "claude-sonnet-5", "--effort", "high"]);
    expect(r.run.target_provider).toBe("claude");
    expect(r.run.effort_level).toBe("high");
    expect(r.run.effort_source).toBe("override");
    expect(r.run.effective_model).toBe("claude-sonnet-5");
    expect(r.run.fast_mode).toBe(1);
    expect(req.env?.CONCORDIA_DELEGATION_FAST_MODE).toBe("1");
    expect(repo.findTemplateByCallName("echo")?.target_provider).toBe("codex");
  });

  it("starts an Opus delegation with medium effort and extended thinking disabled by default", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      overrides: { provider: "claude", model: "claude-opus-5" },
    });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[]; env?: Record<string, string> };
    expect(req.args).toEqual(["--model", "claude-opus-5", "--effort", "medium"]);
    expect(req.env?.CLAUDE_CODE_DISABLE_THINKING).toBe("1");
    if (!r.ok) return;
    expect(r.run.effort_level).toBe("medium");
    expect(r.run.effort_source).toBe("opus-default");
  });

  it("records parent_session_id and passes run/parent ids to spawned env", async () => {
    const r = await svc.invoke({
      call_name: "echo",
      args: { msg: "hi" },
      parent_session_id: "parent-1",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const req = spawnCalls[0] as { env?: Record<string, string> };
    expect(r.run.parent_session_id).toBe("parent-1");
    expect(req.env?.CONCORDIA_DELEGATION_RUN_ID).toBe(r.run.id);
    expect(req.env?.CONCORDIA_DELEGATION_PARENT_SESSION_ID).toBe("parent-1");
    expect(req.env?.CONCORDIA_PARENT_SESSION_ID).toBe("parent-1");
  });

  it("automatically selects and records Codex effort when unspecified", async () => {
    const r = await svc.invoke({ call_name: "echo", args: { msg: "hi" } });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[] };
    expect(req.args).toEqual(["-c", 'model_reasoning_effort="low"']);
    if (!r.ok) return;
    expect(r.run.effort_level).toBe("low");
    expect(r.run.effort_source).toBe("auto-baseline");
    expect(r.run.effort_bucket).toBe("routine");
  });

  it("uses the growth blackbox when configured", async () => {
    const blackboxService = new DelegationService({
      repo,
      promptsDir,
      effortBlackbox: new DelegationEffortBlackbox(db, async () => ({
        ok: true,
        stdout: '{"effort":"high","confidence":0.9,"rationale":"uncertain task"}',
        stderr: "",
      })),
      spawn: (req) => {
        spawnCalls.push(req);
        return { ok: true, pid: 3, command: ["stub", req.provider] };
      },
    });
    const r = await blackboxService.invoke({ call_name: "echo", args: { msg: "hi" } });
    if (!r.ok) throw new Error("expected ok");
    expect((spawnCalls[0] as { args?: string[] }).args).toEqual(["-c", 'model_reasoning_effort="high"']);
    expect(r.run.effort_source).toBe("blackbox-llm");
    expect(r.run.effort_decision_id).toEqual(expect.any(Number));
    blackboxService.recordEffortOutcome(r.run, "completed");
  });

  it("injects Concordia context block into the prompt file", async () => {
    const r = await svc.invoke({ call_name: "echo", args: { msg: "hi" } });
    if (!r.ok) throw new Error("expected ok");
    const file = readFileSync(r.prompt_file_path, "utf8");
    expect(file).toContain("Concordia コンテキスト");
    // 起動後の報告ファースト指示が含まれる
    expect(file).toContain("これから何をするか");
    // 「勝手に作業しない」 ガードが含まれる
    expect(file).toContain("勝手に作業しない");
    // persona 機構は撤去済み: 人格ブロック / persona 行は出ない
    expect(file).not.toContain("割り当て人格");
    expect(file).not.toContain("- persona:");
  });

  it("records spawn_failed when spawner returns error", async () => {
    const failing = new DelegationService({
      repo,
      promptsDir,
      spawn: () => ({ ok: false, error: "wt.exe not found" }),
    });
    const r = await failing.invoke({ call_name: "echo", args: { msg: "x" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("spawn_failed");
    expect(r.run.error).toContain("wt.exe");
  });

  it("default_cwd: expands ${var} from args when caller does not provide cwd", async () => {
    repo.createTemplate({
      call_name: "cwd-template",
      title: "CWD Template",
      target_provider: "codex",
      prompt_template: "do ${task}",
      input_schema: [
        { name: "task", type: "string", required: true },
        { name: "repo", type: "string", required: false },
      ],
      default_cwd: "/repos/${repo}",
    });
    const r = await svc.invoke({
      call_name: "cwd-template",
      args: { task: "build", repo: "myrepo" },
    });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { cwd?: string };
    expect(req.cwd).toBe("/repos/myrepo");
  });

  it("branch + worktree rewrites the spawned cwd without switching the source repo", async () => {
    const repoRoot = mkdtempSync(join(tmpdir(), "deleg-wt-repo-"));
    const worktreeRoot = join(dirname(repoRoot), `${repoRoot.split(/[\\/]/).pop()}-feat-delegation-wt`);
    rmSync(worktreeRoot, { recursive: true, force: true });
    initGitRepo(repoRoot);
    const sourceBranch = git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
    repo.createTemplate({
      call_name: "branch-wt",
      title: "Branch WT",
      target_provider: "claude",
      prompt_template: "do ${task}",
      input_schema: [{ name: "task", type: "string", required: true }],
      default_cwd: repoRoot,
    });

    try {
      const r = await svc.invoke({
        call_name: "branch-wt",
        args: { task: "build" },
        branch: "feat/delegation-wt",
      });

      expect(r.ok).toBe(true);
      if (!r.ok) return;
      const req = spawnCalls[0] as { cwd?: string; provider: string };
      expect(req.provider).toBe("claude");
      expect(req.cwd).toBe(worktreeRoot);
      expect(r.spawn_cwd).toBe(worktreeRoot);
      expect(r.spawn_branch).toBe("feat/delegation-wt");
      expect(r.spawn_worktree_created).toBe(true);
      expect(r.run.spawn_cwd).toBe(worktreeRoot);
      expect(r.run.spawn_branch).toBe("feat/delegation-wt");
      expect(r.run.spawn_worktree_path).toBe(worktreeRoot);
      expect(r.run.spawn_worktree_created).toBe(1);
      expect(existsSync(join(worktreeRoot, ".git"))).toBe(true);
      expect(git(repoRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe(sourceBranch);
      expect(git(worktreeRoot, ["rev-parse", "--abbrev-ref", "HEAD"]).trim()).toBe("feat/delegation-wt");
    } finally {
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(repoRoot, { recursive: true, force: true });
    }
  }, REAL_GIT_WORKTREE_TIMEOUT_MS);
});

describe("DelegationService.invokeDefinition", () => {
  let db: ReturnType<typeof makeTestDb>;
  let repo: DelegationRepo;
  let promptsDir: string;
  let svc: DelegationService;
  const spawnCalls: Array<unknown> = [];

  beforeEach(() => {
    db = makeTestDb();
    repo = new DelegationRepo(db);
    promptsDir = mkdtempSync(join(tmpdir(), "deleg-defn-test-"));
    spawnCalls.length = 0;
    svc = new DelegationService({
      repo,
      promptsDir,
      spawn: (req) => {
        spawnCalls.push(req);
        return { ok: true, pid: 777, command: ["wt.exe", req.provider] };
      },
    });
  });

  afterEach(() => {
    rmSync(promptsDir, { recursive: true, force: true });
  });

  it("invokes a DelegationDefinition directly without global template lookup", async () => {
    const def: DelegationDefinition = {
      template_id: null, // subsidiary-owned, not a global template
      call_name: "custom-task",
      title: "Custom Task",
      target_provider: "codex",
      model: null,
      prompt_template: "Custom: ${task}",
      input_schema: JSON.stringify([{ name: "task", type: "string", required: true }]),
      default_cwd: null,
      project: null,
      emoji: "",
    };
    const r = await svc.invokeDefinition(def, { args: { task: "do it" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered_prompt).toBe("Custom: do it");
    // subsidiary-owned copy → template_id is null
    expect(r.run.template_id).toBeNull();
    expect(r.run.call_name).toBe("custom-task");
    expect(spawnCalls.length).toBe(0);
  });

  it("invokeDefinition bypasses is_active check — inactive global template does not block", async () => {
    // Create an inactive global template
    repo.createTemplate({
      call_name: "shared-name",
      title: "Global (inactive)",
      target_provider: "codex",
      prompt_template: "global ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
      is_active: false,
    });
    // invokeDefinition uses a provided subsidiary copy directly — no lookup, no is_active check
    const def: DelegationDefinition = {
      template_id: null,
      call_name: "shared-name",
      title: "Subsidiary copy",
      target_provider: "codex",
      model: null,
      prompt_template: "subsidiary ${x}",
      input_schema: JSON.stringify([{ name: "x", type: "string", required: true }]),
      default_cwd: null,
      project: null,
      emoji: "",
    };
    const r = await svc.invokeDefinition(def, { args: { x: "hello" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Uses the subsidiary copy's prompt, not the inactive global template
    expect(r.rendered_prompt).toBe("subsidiary hello");
  });

  it("invokeDefinition with template_id records that id on the run row", async () => {
    const globalTpl = repo.createTemplate({
      call_name: "global-tpl",
      title: "Global",
      target_provider: "codex",
      prompt_template: "global ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
    });
    const def: DelegationDefinition = {
      template_id: globalTpl.id, // referencing the global template id
      call_name: "global-tpl",
      title: "Global",
      target_provider: "codex",
      model: null,
      prompt_template: "global ${x}",
      input_schema: JSON.stringify([{ name: "x", type: "string", required: true }]),
      default_cwd: null,
      project: null,
      emoji: "",
    };
    const r = await svc.invokeDefinition(def, { args: { x: "val" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.template_id).toBe(globalTpl.id);
  });
});

function initGitRepo(repoRoot: string): void {
  git(repoRoot, ["init"]);
  git(repoRoot, ["config", "user.email", "concordia-test@example.invalid"]);
  git(repoRoot, ["config", "user.name", "Concordia Test"]);
  writeFileSync(join(repoRoot, "README.md"), "test\n", "utf8");
  git(repoRoot, ["add", "README.md"]);
  git(repoRoot, ["commit", "-m", "init"]);
}

function git(cwd: string, args: string[]): string {
  return execFileSync(process.platform === "win32" ? "git.exe" : "git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}
