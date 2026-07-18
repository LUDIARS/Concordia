import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { seedDelegationTemplates } from "./seed.js";

describe("seedDelegationTemplates", () => {
  it("replaces the Sonnet 4.6 implementation template with Sonnet 5", () => {
    const repo = new DelegationRepo(makeTestDb());
    repo.createTemplate({
      call_name: "claude-sonnet-4-6-impl",
      title: "Old Sonnet",
      target_provider: "claude",
      model: "claude-sonnet-4-6",
      prompt_template: "old",
    });

    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("claude-sonnet-4-6-impl")?.is_active).toBe(0);
    const sonnet5 = repo.findTemplateByCallName("claude-sonnet-5-impl");
    expect(sonnet5?.is_active).toBe(1);
    expect(sonnet5?.model).toBe("claude-sonnet-5");
  });

  it("assigns employment categories to every seed template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    // 代表例: spawn ワーカー = employee / caller 特化 = freelancer / 時限起動 = parttimer
    expect(repo.findTemplateByCallName("claude-sonnet-5-impl")?.category).toBe("employee");
    expect(repo.findTemplateByCallName("codex-5-6-sol")?.category).toBe("employee");
    expect(repo.findTemplateByCallName("impl-from-design")?.category).toBe("freelancer");
    expect(repo.findTemplateByCallName("review-sonnet5")?.category).toBe("freelancer");
    expect(repo.findTemplateByCallName("morning-tasks")?.category).toBe("parttimer");
    expect(repo.findTemplateByCallName("ludiars-review-daily")?.category).toBe("parttimer");
  });

  it("seeds argument-free launch templates for Session forum posts", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const claude = repo.findTemplateByCallName("forum-claude-session");
    const codex = repo.findTemplateByCallName("forum-codex-session");

    expect(claude).toMatchObject({
      title: "Claude起動",
      target_provider: "claude",
      is_active: 1,
      forum_tag: 1,
    });
    expect(codex).toMatchObject({
      title: "Codex起動",
      target_provider: "codex",
      is_active: 1,
      forum_tag: 1,
    });
    expect(JSON.parse(claude?.input_schema ?? "null")).toEqual([]);
    expect(JSON.parse(codex?.input_schema ?? "null")).toEqual([]);
  });

  it("merges custom forum templates with the default forum tags instead of disabling the defaults", () => {
    // 継続レビュー指摘: 以前はカスタム forum template が1件でもあると既定2件の
    // forum_tag が false に上書きされ、 Discord 側の既存タグと不整合を起こしていた。
    // 既定2件は常に forum spawn の入口として維持し、 カスタムはそれに「追加」される
    // (合計上限10件の検証は forum-template-tags.ts の validateForumTemplateTags が
    // sync 時に明示エラーで担当する — ここでは先回りして間引かない)。
    const repo = new DelegationRepo(makeTestDb());
    repo.createTemplate({
      call_name: "custom-forum",
      title: "Custom forum",
      target_provider: "claude",
      prompt_template: "Handle the forum post",
      input_schema: [],
      forum_tag: true,
    });

    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("custom-forum")?.forum_tag).toBe(1);
    expect(repo.findTemplateByCallName("forum-claude-session")?.forum_tag).toBe(1);
    expect(repo.findTemplateByCallName("forum-codex-session")?.forum_tag).toBe(1);
  });

  it("seeds the daily-review-reconciliation parttimer template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const tpl = repo.findTemplateByCallName("daily-review-reconciliation");
    expect(tpl?.is_active).toBe(1);
    expect(tpl?.category).toBe("parttimer");
    expect(tpl?.target_provider).toBe("claude");
    // プロンプト正本 (LUDIARS/docs/REVIEW-PROMPTS.md) を参照させる — 本文の二重管理をしない。
    expect(tpl?.prompt_template).toContain("REVIEW-PROMPTS.md");
    expect(tpl?.prompt_template).toContain("service-map.json");
    // 配置フォルダは Review/ が正本 (2026-07-17 neco 指示)。git 操作はしない。
    expect(tpl?.prompt_template).toContain("E:\\Document\\Ars\\Review\\<repo>\\${date}\\");
    expect(tpl?.prompt_template).toContain("`git add` / `git commit` / `git push` は行わない");
    expect(tpl?.prompt_template).not.toContain("E:\\Document\\Ars\\reviews\\");
  });

  it("codex Sol defaults to high + fast and Sol Ultra is explicit (2026-07-17)", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const sol = repo.findTemplateByCallName("codex-5-6-sol");
    expect(JSON.parse(sol?.runtime_options_json ?? "null")).toMatchObject({
      model_reasoning_effort: "high",
      fast_mode: true,
    });

    const ultra = repo.findTemplateByCallName("codex-5-6-sol-ultra");
    expect(ultra?.is_active).toBe(1);
    expect(ultra?.model).toBe("gpt-5.6-sol");
    expect(JSON.parse(ultra?.runtime_options_json ?? "null")).toMatchObject({
      model_reasoning_effort: "ultra",
    });
  });

  it("review launch is consolidated into review-duo (Opus x Sol xhigh)", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const duo = repo.findTemplateByCallName("review-duo");
    expect(duo?.is_active).toBe(1);
    expect(duo?.prompt_template).toContain("claude-opus-4-8");
    expect(duo?.prompt_template).toContain("gpt-5.6-sol");
    expect(duo?.prompt_template).toContain("xhigh");
    expect(duo?.prompt_template).toContain("E:\\Document\\Ars\\Review\\");
    expect(duo?.prompt_template).toContain("worktree の生成・ブランチ切り替えは行わない");
    expect(duo?.prompt_template).toContain("追加指示 (inject)");

    expect(repo.findTemplateByCallName("review-sonnet5")?.is_active).toBe(0);
  });

  it("keeps the legacy daily review local-only during migration", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const tpl = repo.findTemplateByCallName("ludiars-review-daily");
    expect(tpl?.prompt_template).toContain("E:\\Document\\Ars\\Review\\<repo>\\${date}\\");
    expect(tpl?.prompt_template).not.toContain("E:\\Document\\Ars\\reviews\\");
  });
});
