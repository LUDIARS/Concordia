import { describe, expect, it } from "vitest";
import { resolveTemplateForScope } from "./template-overrides.js";
import type { DelegationTemplateOverrideRow, DelegationTemplateRow } from "../db/delegation-repo.js";

const base: DelegationTemplateRow = { id: "t", call_name: "task", title: "Task", description: "", target_provider: "codex", model: null, runtime_options_json: '{"base":true}', prompt_template: "p", input_schema: "[]", default_cwd: null, project: null, is_active: 1, emoji: "", call_only: 0, forum_tag: 0, category: "employee", sort_order: 1, created_at: 1, updated_at: 1 };
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
