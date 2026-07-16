import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo, parseInputSchema } from "./delegation-repo.js";

let db: ReturnType<typeof makeTestDb>;
let repo: DelegationRepo;

beforeEach(() => {
  db = makeTestDb();
  repo = new DelegationRepo(db);
});

describe("DelegationRepo / templates", () => {
  it("creates and finds a template by call_name", () => {
    const created = repo.createTemplate({
      call_name: "fix-bug",
      title: "Fix a bug",
      description: "",
      target_provider: "codex",
      prompt_template: "Fix ${what}",
      input_schema: [{ name: "what", type: "string", required: true }],
    });
    expect(created.id).toBeTruthy();
    expect(created.call_name).toBe("fix-bug");
    const found = repo.findTemplateByCallName("fix-bug");
    expect(found?.id).toBe(created.id);
  });

  it("defaults category to employee and round-trips an explicit category", () => {
    const defaulted = repo.createTemplate({
      call_name: "cat-default",
      title: "t",
      target_provider: "codex",
      prompt_template: "p",
    });
    expect(defaulted.category).toBe("employee");

    const explicit = repo.createTemplate({
      call_name: "cat-parttimer",
      title: "t",
      target_provider: "claude",
      prompt_template: "p",
      category: "parttimer",
    });
    expect(explicit.category).toBe("parttimer");

    const patched = repo.updateTemplate(explicit.id, { category: "freelancer" });
    expect(patched?.category).toBe("freelancer");
    // category を渡さない patch では既存値を維持する
    const untouched = repo.updateTemplate(explicit.id, { title: "t2" });
    expect(untouched?.category).toBe("freelancer");
  });

  it("upsertTemplate replaces existing by call_name", () => {
    const a = repo.upsertTemplate({
      call_name: "foo",
      title: "v1",
      target_provider: "codex",
      prompt_template: "v1",
    });
    const b = repo.upsertTemplate({
      call_name: "foo",
      title: "v2",
      target_provider: "codex",
      prompt_template: "v2",
    });
    expect(b.id).toBe(a.id);
    expect(b.title).toBe("v2");
  });

  it("listTemplates excludes inactive by default", () => {
    repo.createTemplate({
      call_name: "active",
      title: "A",
      target_provider: "codex",
      prompt_template: "x",
    });
    const inactive = repo.createTemplate({
      call_name: "inactive",
      title: "I",
      target_provider: "codex",
      prompt_template: "x",
    });
    repo.deactivateTemplate(inactive.id);
    expect(repo.listTemplates().map((t) => t.call_name)).toEqual(["active"]);
    expect(repo.listTemplates({ includeInactive: true }).map((t) => t.call_name).sort())
      .toEqual(["active", "inactive"]);
  });

  it("listTemplates orders by sort_order then call_name", () => {
    repo.createTemplate({
      call_name: "b",
      title: "B",
      target_provider: "codex",
      prompt_template: "x",
      sort_order: 20,
    });
    const c = repo.createTemplate({
      call_name: "c",
      title: "C",
      target_provider: "codex",
      prompt_template: "x",
      sort_order: 10,
    });
    repo.createTemplate({
      call_name: "a",
      title: "A",
      target_provider: "codex",
      prompt_template: "x",
      sort_order: 20,
    });
    expect(repo.listTemplates().map((t) => t.call_name)).toEqual(["c", "a", "b"]);
    expect(repo.updateTemplate(c.id, { sort_order: 30 })?.sort_order).toBe(30);
    expect(repo.listTemplates().map((t) => t.call_name)).toEqual(["a", "b", "c"]);
  });

  it("updateTemplate patches fields", () => {
    const t = repo.createTemplate({
      call_name: "u",
      title: "old",
      target_provider: "codex",
      prompt_template: "x",
    });
    const updated = repo.updateTemplate(t.id, { title: "new", target_provider: "claude" });
    expect(updated?.title).toBe("new");
    expect(updated?.target_provider).toBe("claude");
  });

  it("persists model and allows clearing it to null", () => {
    const t = repo.createTemplate({
      call_name: "m",
      title: "M",
      target_provider: "codex",
      model: "gpt-5.5",
      prompt_template: "x",
    });
    expect(t.model).toBe("gpt-5.5");
    expect(repo.findTemplateByCallName("m")?.model).toBe("gpt-5.5");
    // 更新で別モデルに
    expect(repo.updateTemplate(t.id, { model: "claude-opus-4-8" })?.model).toBe("claude-opus-4-8");
    // null クリアできる (?? でなく !== undefined 分岐のため)
    expect(repo.updateTemplate(t.id, { model: null })?.model).toBeNull();
    // model 未指定の patch は既存値を保持
    repo.updateTemplate(t.id, { model: "gpt-5.5" });
    expect(repo.updateTemplate(t.id, { title: "M2" })?.model).toBe("gpt-5.5");
  });

  it("defaults model to null when not provided", () => {
    const t = repo.createTemplate({
      call_name: "nomodel",
      title: "N",
      target_provider: "codex",
      prompt_template: "x",
    });
    expect(t.model).toBeNull();
  });

  it("parseInputSchema rejects bad shape", () => {
    expect(parseInputSchema("not-json")).toEqual([]);
    expect(parseInputSchema("[{\"name\":\"x\",\"type\":\"string\",\"required\":true}]"))
      .toEqual([{ name: "x", type: "string", required: true }]);
    expect(parseInputSchema("[{\"name\":\"y\",\"type\":\"badtype\",\"required\":true}]")).toEqual([]);
  });
});

describe("DelegationRepo / runs", () => {
  it("creates a run with a pre-allocated id", () => {
    const id = "11111111-1111-1111-1111-111111111111";
    const run = repo.createRun({
      id,
      template_id: null,
      call_name: "foo",
      target_provider: "codex",
      args: { a: 1 },
      rendered_prompt: "p",
      prompt_file_path: "/tmp/p.md",
      spawn_pid: 42,
      spawn_command: ["wt.exe", "lictor", "codex"],
      triggered_by: "claude",
      status: "spawned",
    });
    expect(run.id).toBe(id);
    expect(repo.findRun(id)?.spawn_pid).toBe(42);
  });

  it("recentRuns returns rows in created_at desc", async () => {
    repo.createRun({
      template_id: null, call_name: "a", target_provider: "codex",
      args: {}, rendered_prompt: "", prompt_file_path: "/p1",
      spawn_pid: null, spawn_command: null, triggered_by: null, status: "pending",
    });
    await new Promise((r) => setTimeout(r, 5));
    repo.createRun({
      template_id: null, call_name: "b", target_provider: "codex",
      args: {}, rendered_prompt: "", prompt_file_path: "/p2",
      spawn_pid: null, spawn_command: null, triggered_by: null, status: "pending",
    });
    const runs = repo.recentRuns(10);
    expect(runs.length).toBe(2);
    expect(runs[0]?.call_name).toBe("b");
  });

  it("records terminal effort outcomes for later policy decisions", () => {
    const run = repo.createRun({
      template_id: null, call_name: "learn", target_provider: "claude",
      args: {}, rendered_prompt: "implement api", prompt_file_path: "/learn",
      spawn_pid: 1, spawn_command: ["claude"], triggered_by: null, status: "spawned",
      effort_level: "medium", effort_source: "auto-baseline", effort_bucket: "implementation",
      effective_model: "sonnet",
      fast_mode: true,
      spawn_cwd: "/work/Concordia",
      spawn_branch: "fix/runtime-card",
      spawn_worktree_path: "/work/Concordia-wt",
      spawn_worktree_created: true,
    });
    const completed = repo.updateRunStatus(run.id, "completed");
    expect(completed?.finished_at).toEqual(expect.any(Number));
    expect(completed).toMatchObject({
      effort_level: "medium",
      effort_source: "auto-baseline",
      effort_bucket: "implementation",
      effective_model: "sonnet",
      fast_mode: 1,
      spawn_cwd: "/work/Concordia",
      spawn_branch: "fix/runtime-card",
      spawn_worktree_path: "/work/Concordia-wt",
      spawn_worktree_created: 1,
    });
  });
});
