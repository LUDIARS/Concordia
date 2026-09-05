import { describe, expect, it } from "vitest";
import type { DelegationTemplateRow } from "../db/delegation-repo.js";
import { createIssueModelResolver } from "./model-resolver.js";

function template(overrides: Partial<DelegationTemplateRow>): DelegationTemplateRow {
  return {
    id: overrides.call_name ?? "t",
    call_name: "opus-mid",
    title: "実装委託",
    description: "",
    target_provider: "claude",
    model: "claude-opus-5",
    runtime_options_json: "{}",
    prompt_template: "",
    input_schema: "[]",
    default_cwd: null,
    project: null,
    is_active: 1,
    emoji: "",
    call_only: 0,
    forum_tag: 0,
    review_only: 0,
    category: "employee",
    sort_order: 0,
    ...overrides,
  } as DelegationTemplateRow;
}

const TEMPLATES = [
  template({ call_name: "opus-mid" }),
  template({ call_name: "sol-mid", target_provider: "codex", model: "gpt-5.6-sol" }),
];

const log = { warn: () => {} };

describe("createIssueModelResolver", () => {
  // SQLite の is_active は number。 boolean へ寄せ損ねると候補が 0 件になり、
  // 「常にテンプレ既定」に黙って落ちる。
  it("resolves candidates from the delegation templates", async () => {
    const resolve = createIssueModelResolver({
      listTemplates: () => TEMPLATES,
      log,
      collectUsage: async () => ({
        codexWeekly: { usedPct: 10, resetAtSec: null },
        claudeWeekly: { usedPct: 99, resetAtSec: null },
        fableUsedPct: null,
      }),
    });
    const picked = await resolve({ issueBody: "直して" });
    expect(picked).toMatchObject({ nick: "sol", model: "gpt-5.6-sol", source: "usage_balance" });
  });

  it("keeps the issue body's own choice", async () => {
    const resolve = createIssueModelResolver({
      listTemplates: () => TEMPLATES,
      log,
      collectUsage: async () => { throw new Error("usage must not be fetched for an explicit choice"); },
    });
    const picked = await resolve({ issueBody: "model: opus\n\n直して" });
    expect(picked).toMatchObject({ nick: "opus", model: "claude-opus-5", source: "issue_body" });
  });

  it("returns null when the catalog has no usable template", async () => {
    const resolve = createIssueModelResolver({
      listTemplates: () => [template({ call_name: "opus-mid", is_active: 0 })],
      log,
      collectUsage: async () => ({ codexWeekly: null, claudeWeekly: null, fableUsedPct: null }),
    });
    expect(await resolve({ issueBody: "b" })).toBeNull();
  });
});
