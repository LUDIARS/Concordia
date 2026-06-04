import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyMigrations } from "../db/schema.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { DelegationService, renderTemplate, validateArgs } from "./service.js";

describe("renderTemplate", () => {
  it("substitutes ${var}", () => {
    const r = renderTemplate("Hello ${name}!", { name: "World" }, [
      { name: "name", type: "string", required: true },
    ]);
    expect(r.rendered).toBe("Hello World!");
    expect(r.missing).toEqual([]);
  });

  it("uses ${var:default}", () => {
    const r = renderTemplate("${greet:hi} ${who}", { who: "Ada" }, [
      { name: "greet", type: "string", required: false },
      { name: "who", type: "string", required: true },
    ]);
    expect(r.rendered).toBe("hi Ada");
  });

  it("reports missing required", () => {
    const r = renderTemplate("${a} ${b}", {}, [
      { name: "a", type: "string", required: true },
      { name: "b", type: "string", required: true },
    ]);
    expect(r.missing.sort()).toEqual(["a", "b"]);
  });

  it("uses schema default when arg missing", () => {
    const r = renderTemplate("${x}", {}, [
      { name: "x", type: "string", required: false, default: "fallback" },
    ]);
    expect(r.rendered).toBe("fallback");
  });

  it("flags unknown vars referenced in template", () => {
    const r = renderTemplate("${known} ${unknown}", { known: "ok" }, [
      { name: "known", type: "string", required: true },
    ]);
    expect(r.unknown_vars).toEqual(["unknown"]);
  });
});

describe("validateArgs", () => {
  it("accepts well-typed args", () => {
    expect(validateArgs({ s: "x", n: 1, b: true }, [
      { name: "s", type: "string", required: true },
      { name: "n", type: "number", required: true },
      { name: "b", type: "boolean", required: true },
    ])).toEqual({ ok: true });
  });

  it("flags wrong types", () => {
    const r = validateArgs({ n: "string-not-number" }, [
      { name: "n", type: "number", required: true },
    ]);
    expect(r.ok).toBe(false);
  });
});

describe("DelegationService.invoke", () => {
  let db: Database.Database;
  let repo: DelegationRepo;
  let promptsDir: string;
  let svc: DelegationService;
  const spawnCalls: Array<unknown> = [];

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
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
    db.close();
    rmSync(promptsDir, { recursive: true, force: true });
  });

  it("invokes a template, writes prompt file, spawns by default", () => {
    const r = svc.invoke({ call_name: "echo", args: { msg: "hi" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.rendered_prompt).toBe("echo hi");
    expect(existsSync(r.prompt_file_path)).toBe(true);
    const file = readFileSync(r.prompt_file_path, "utf8");
    expect(file).toContain("echo hi");
    expect(file).toContain("echo");
    expect(r.spawn_pid).toBe(999);
    expect(spawnCalls.length).toBe(1);
  });

  it("file name matches run.id", () => {
    const r = svc.invoke({ call_name: "echo", args: { msg: "x" } });
    if (!r.ok) throw new Error("expected ok");
    expect(r.prompt_file_path).toContain(r.run.id);
  });

  it("spawn=false: writes file, records run, does not spawn", () => {
    const r = svc.invoke({ call_name: "echo", args: { msg: "x" }, spawn: false });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.spawn_pid).toBeNull();
    expect(spawnCalls.length).toBe(0);
    expect(r.run.status).toBe("pending");
  });

  it("returns error for unknown call_name", () => {
    const r = svc.invoke({ call_name: "nope", args: {} });
    expect(r.ok).toBe(false);
  });

  it("returns error for missing required args", () => {
    const r = svc.invoke({ call_name: "echo", args: {} });
    expect(r.ok).toBe(false);
  });

  it("passes template.model to spawn as --model args", () => {
    repo.createTemplate({
      call_name: "with-model",
      title: "With model",
      target_provider: "codex",
      model: "gpt-5.5",
      prompt_template: "do ${x}",
      input_schema: [{ name: "x", type: "string", required: true }],
    });
    const r = svc.invoke({ call_name: "with-model", args: { x: "y" } });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[]; provider: string };
    expect(req.provider).toBe("codex");
    expect(req.args).toEqual(["--model", "gpt-5.5"]);
  });

  it("omits --model args when template has no model", () => {
    const r = svc.invoke({ call_name: "echo", args: { msg: "hi" } });
    expect(r.ok).toBe(true);
    const req = spawnCalls[0] as { args?: string[] };
    expect(req.args).toBeUndefined();
  });

  it("records spawn_failed when spawner returns error", () => {
    const failing = new DelegationService({
      repo,
      promptsDir,
      spawn: () => ({ ok: false, error: "wt.exe not found" }),
    });
    const r = failing.invoke({ call_name: "echo", args: { msg: "x" } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.run.status).toBe("spawn_failed");
    expect(r.run.error).toContain("wt.exe");
  });
});
