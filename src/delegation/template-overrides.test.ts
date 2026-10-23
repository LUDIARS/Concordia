import { describe, expect, it } from "vitest";
import { resolveTemplateForScope } from "./template-overrides.js";
import type { DelegationCategoryDefaultRow, DelegationTemplateOverrideRow, DelegationTemplateRow } from "../db/delegation-repo.js";

const base: DelegationTemplateRow = { id: "t", call_name: "task", title: "Task", description: "", target_provider: "codex", model: null, runtime_options_json: '{"base":true}', prompt_template: "p", input_schema: "[]", default_cwd: null, project: null, is_active: 1, emoji: "", call_only: 0, forum_tag: 0, review_only: 0, category: "employee", sort_order: 1, created_at: 1, updated_at: 1 };
function row(scope_kind: "platform" | "site", scope_key: string, patch_json: string): DelegationTemplateOverrideRow { return { id: `${scope_kind}-${scope_key}`, template_id: "t", scope_kind, scope_key, patch_json, is_active: 1, created_at: 1, updated_at: 1 }; }

describe("resolveTemplateForScope", () => {
  it("returns an exact base copy when no overrides apply", () => expect(resolveTemplateForScope(base, [], { platform: "linux", siteId: null })).toEqual(base));
  it("applies scalar replacement and shallow runtime option merge", () => {
    const actual = resolveTemplateForScope(base, [row("platform", "darwin", '{"model":"m","runtime_options_json":"{\\"extra\\":1}"}')], { platform: "darwin", siteId: null });
    expect(actual.model).toBe("m"); expect(JSON.parse(actual.runtime_options_json)).toEqual({ base: true, extra: 1 });
  });
  it("lets the more specific site override win", () => expect(resolveTemplateForScope(base, [row("platform", "darwin", '{"model":"platform"}'), row("site", "tokyo", '{"model":"site"}')], { platform: "darwin", siteId: "tokyo" }).model).toBe("site"));
  it("rejects unknown patch keys", () => expect(() => resolveTemplateForScope(base, [row("platform", "darwin", '{"prompt_template":"split"}')], { platform: "darwin", siteId: null })).toThrow("unknown_template_override_patch_key"));
});

describe("resolveTemplateForScope の拠点 category 既定 (SPEC-DELEGATION-SITE-CATEGORY-DEFAULTS)", () => {
  const parttimer: DelegationTemplateRow = { ...base, category: "parttimer" };
  const siteDefault = (scope_key: string, is_active: number): DelegationCategoryDefaultRow =>
    ({ scope_kind: "site", scope_key, category: "parttimer", is_active, updated_at: 1 });

  it("拠点ではパートタイマーが既定でオフ", () => {
    expect(resolveTemplateForScope(parttimer, [], { platform: "win32", siteId: "melpot" }).is_active).toBe(0);
  });
  it("本社 (site ID なし) と parttimer 以外は既定で止めない", () => {
    expect(resolveTemplateForScope(parttimer, [], { platform: "win32", siteId: null }).is_active).toBe(1);
    expect(resolveTemplateForScope(base, [], { platform: "win32", siteId: "melpot" }).is_active).toBe(1);
  });
  it("テンプレ別の site override (例外) が既定に勝つ", () => {
    expect(resolveTemplateForScope(parttimer, [row("site", "melpot", '{"is_active":1}')], { platform: null, siteId: "melpot" }).is_active).toBe(1);
  });
  it("拠点の既定をオンにすると、例外オフ以外は動く", () => {
    const defaults = [siteDefault("melpot", 1)];
    expect(resolveTemplateForScope(parttimer, [], { platform: null, siteId: "melpot" }, defaults).is_active).toBe(1);
    expect(resolveTemplateForScope(parttimer, [row("site", "melpot", '{"is_active":0}')], { platform: null, siteId: "melpot" }, defaults).is_active).toBe(0);
  });
  it("既定オンでもテンプレ自体が無効なら動かさない", () => {
    expect(resolveTemplateForScope({ ...parttimer, is_active: 0 }, [], { platform: null, siteId: "melpot" }, [siteDefault("melpot", 1)]).is_active).toBe(0);
  });
  it("別拠点の既定は効かない", () => {
    expect(resolveTemplateForScope(parttimer, [], { platform: null, siteId: "tokyo" }, [siteDefault("melpot", 1)]).is_active).toBe(0);
  });
});
