/**
 * portable.ts の export round-trip + parsePortable 入力検証テスト。
 *
 * spec/plan/tasks/phase-0.md#t0-4
 */

import { describe, it, expect } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import type { SubsidiaryDelegationRow } from "../db/subsidiary-repo.js";
import {
  PORTABLE_KIND,
  PORTABLE_VERSION,
  templateToPortable,
  ownedToPortable,
  parsePortable,
} from "./portable.js";

describe("portable constants", () => {
  it("PORTABLE_KIND is 'concordia.delegation'", () => {
    expect(PORTABLE_KIND).toBe("concordia.delegation");
  });

  it("PORTABLE_VERSION is 1", () => {
    expect(PORTABLE_VERSION).toBe(1);
  });
});

describe("templateToPortable", () => {
  it("sets kind and version on output", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const tpl = repo.createTemplate({
      call_name: "greet",
      title: "Greet",
      target_provider: "codex",
      prompt_template: "Hello ${name}",
      input_schema: [{ name: "name", type: "string", required: true }],
    });
    const p = templateToPortable(tpl);
    expect(p.kind).toBe(PORTABLE_KIND);
    expect(p.version).toBe(PORTABLE_VERSION);
  });

  it("round-trips call_name, title, target_provider, prompt_template, input_schema", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const tpl = repo.createTemplate({
      call_name: "greet",
      title: "Greet",
      target_provider: "codex",
      prompt_template: "Hello ${name}",
      input_schema: [{ name: "name", type: "string", required: true }],
    });
    const p = templateToPortable(tpl);
    expect(p.call_name).toBe("greet");
    expect(p.title).toBe("Greet");
    expect(p.target_provider).toBe("codex-sdk");
    expect(p.prompt_template).toBe("Hello ${name}");
    expect(p.input_schema).toEqual([{ name: "name", type: "string", required: true }]);
  });

  it("preserves model, runtime_options, default_cwd, project, emoji", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const tpl = repo.createTemplate({
      call_name: "with-extras",
      title: "With Extras",
      target_provider: "claude",
      model: "claude-opus-4",
      runtime_options: { model_reasoning_effort: "high" },
      prompt_template: "Do ${task}",
      input_schema: [],
      default_cwd: "/home/user/project",
      project: "my-project",
      emoji: "🤖",
    });
    const p = templateToPortable(tpl);
    expect(p.model).toBe("claude-opus-4");
    expect(p.runtime_options).toEqual({ model_reasoning_effort: "high" });
    expect(p.default_cwd).toBe("/home/user/project");
    expect(p.project).toBe("my-project");
    expect(p.emoji).toBe("🤖");
  });

  it("model=null round-trips as null", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const tpl = repo.createTemplate({
      call_name: "no-model",
      title: "No Model",
      target_provider: "codex",
      model: null,
      prompt_template: "Simple",
      input_schema: [],
    });
    expect(templateToPortable(tpl).model).toBeNull();
  });
});

describe("ownedToPortable", () => {
  const makeRow = (overrides: Partial<SubsidiaryDelegationRow> = {}): SubsidiaryDelegationRow => ({
    subsidiary_id: "sub-1",
    call_name: "greet",
    is_default: 0,
    title: "Greet",
    description: "",
    target_provider: "codex",
    model: null,
    prompt_template: "Hello ${name}",
    input_schema: JSON.stringify([{ name: "name", type: "string", required: true }]),
    default_cwd: null,
    project: null,
    emoji: "",
    created_at: 0,
    updated_at: 0,
    ...overrides,
  });

  it("sets kind and version on output", () => {
    const p = ownedToPortable(makeRow());
    expect(p.kind).toBe(PORTABLE_KIND);
    expect(p.version).toBe(PORTABLE_VERSION);
  });

  it("round-trips call_name, title, target_provider, prompt_template, input_schema", () => {
    const p = ownedToPortable(makeRow());
    expect(p.call_name).toBe("greet");
    expect(p.title).toBe("Greet");
    expect(p.target_provider).toBe("codex");
    expect(p.prompt_template).toBe("Hello ${name}");
    expect(p.input_schema).toEqual([{ name: "name", type: "string", required: true }]);
  });

  it("runtime_options is always empty for owned delegations (no runtime_options_json in row)", () => {
    const p = ownedToPortable(makeRow());
    expect(p.runtime_options).toEqual({});
  });

  it("preserves model, default_cwd, project, emoji", () => {
    const p = ownedToPortable(
      makeRow({
        model: "gpt-5",
        default_cwd: "/repos/foo",
        project: "foo-proj",
        emoji: "⚡",
      }),
    );
    expect(p.model).toBe("gpt-5");
    expect(p.default_cwd).toBe("/repos/foo");
    expect(p.project).toBe("foo-proj");
    expect(p.emoji).toBe("⚡");
  });
});

describe("parsePortable", () => {
  it("accepts minimal valid input (only required target_provider)", () => {
    const r = parsePortable({ target_provider: "codex" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.target_provider).toBe("codex");
  });

  it("accepts all delegation providers", () => {
    for (const provider of ["claude", "codex", "gemini", "gemma4-12"] as const) {
      const r = parsePortable({ target_provider: provider });
      expect(r.ok).toBe(true);
    }
  });

  it("ignores extra unknown keys (permissive receive)", () => {
    const r = parsePortable({ target_provider: "claude", unexpected_key: 123, another: true });
    expect(r.ok).toBe(true);
  });

  it("optional fields are omitted when not provided", () => {
    const r = parsePortable({ target_provider: "codex" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.kind).toBeUndefined();
    expect(r.data.version).toBeUndefined();
    expect(r.data.call_name).toBeUndefined();
  });

  it("rejects unknown provider value", () => {
    const r = parsePortable({ target_provider: "unknown-provider" });
    expect(r.ok).toBe(false);
  });

  it("rejects missing target_provider (required field)", () => {
    const r = parsePortable({ call_name: "greet", title: "Greet" });
    expect(r.ok).toBe(false);
  });

  it("rejects non-object input", () => {
    expect(parsePortable("not-an-object").ok).toBe(false);
    expect(parsePortable(42).ok).toBe(false);
    expect(parsePortable(null).ok).toBe(false);
  });
});

describe("export → JSON → parsePortable round-trip", () => {
  it("templateToPortable output parses cleanly and data matches", () => {
    const db = makeTestDb();
    const repo = new DelegationRepo(db);
    const tpl = repo.createTemplate({
      call_name: "roundtrip",
      title: "Round-trip",
      target_provider: "codex",
      prompt_template: "Hello ${who}",
      input_schema: [{ name: "who", type: "string", required: true }],
    });
    const exported = templateToPortable(tpl);
    // Simulate cross-process copy-paste via JSON stringify/parse
    const parsed = parsePortable(JSON.parse(JSON.stringify(exported)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.target_provider).toBe("codex-sdk");
    expect(parsed.data.call_name).toBe("roundtrip");
    expect(parsed.data.kind).toBe(PORTABLE_KIND);
    expect(parsed.data.version).toBe(PORTABLE_VERSION);
  });

  it("ownedToPortable output parses cleanly and data matches", () => {
    const row: SubsidiaryDelegationRow = {
      subsidiary_id: "sub-rt",
      call_name: "owned-rt",
      is_default: 0,
      title: "Owned RT",
      description: "desc",
      target_provider: "claude",
      model: "claude-3-5-sonnet",
      prompt_template: "Do ${x}",
      input_schema: JSON.stringify([{ name: "x", type: "string", required: true }]),
      default_cwd: null,
      project: null,
      emoji: "🔁",
      created_at: 0,
      updated_at: 0,
    };
    const exported = ownedToPortable(row);
    const parsed = parsePortable(JSON.parse(JSON.stringify(exported)));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.data.target_provider).toBe("claude");
    expect(parsed.data.call_name).toBe("owned-rt");
    expect(parsed.data.model).toBe("claude-3-5-sonnet");
  });
});
