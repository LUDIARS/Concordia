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

  it("replaces the Opus 4.8 implementation template with Opus 5", () => {
    const repo = new DelegationRepo(makeTestDb());
    repo.createTemplate({
      call_name: "claude-opus-4-8-impl",
      title: "Old Opus",
      target_provider: "claude",
      model: "claude-opus-4-8",
      prompt_template: "old",
    });

    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("claude-opus-4-8-impl")?.is_active).toBe(0);
    const opus5 = repo.findTemplateByCallName("claude-opus-5-impl");
    expect(opus5?.is_active).toBe(1);
    expect(opus5?.model).toBe("claude-opus-5");
  });

  it("uses Opus 5 across implementation, analysis, and review delegations", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("claude-opus-5-impl")?.model).toBe("claude-opus-5");
    expect(repo.findTemplateByCallName("design-analysis-opus")?.model).toBe("claude-opus-5");

    for (const callName of ["review-duo", "ludiars-review-daily-dual"]) {
      const prompt = repo.findTemplateByCallName(callName)?.prompt_template ?? "";
      expect(prompt).toContain("claude-opus-5");
      expect(prompt).not.toContain("claude-opus-4-8");
    }
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
    // Test Forum の投稿検知で Cc が自動起動する検証タスク (spec/feature/revisor-test-forum-sync.md)。
    expect(repo.findTemplateByCallName("test-qa")?.category).toBe("test-qa");
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

  it("seeds the ludiars-review-daily-dual Sol Ultra template", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const tpl = repo.findTemplateByCallName("ludiars-review-daily-dual");
    expect(tpl?.is_active).toBe(1);
    expect(tpl?.category).toBe("parttimer");
    expect(tpl?.target_provider).toBe("codex");
    expect(tpl?.model).toBe("gpt-5.6-sol");
    expect(JSON.parse(tpl?.runtime_options_json ?? "null")).toEqual({ model_reasoning_effort: "ultra" });
    // プロンプト正本 (LUDIARS/docs/REVIEW-PROMPTS.md) を参照させる — 本文の二重管理をしない。
    expect(tpl?.prompt_template).toContain("REVIEW-PROMPTS.md");
    expect(tpl?.prompt_template).toContain("service-map.json");
    // 配置フォルダは Review/ が正本 (2026-07-17 neco 指示)。git 操作はしない。
    expect(tpl?.prompt_template).toContain("E:\\Document\\Ars\\Review\\<repo>\\${date}\\");
    expect(tpl?.prompt_template).toContain("`git add` / `git commit` / `git push` は行わない");
    expect(tpl?.prompt_template).not.toContain("E:\\Document\\Ars\\reviews\\");
    // 2026-07-28: 最新の正本は GitHub/origin ではなくローカル main。
    expect(tpl?.prompt_template).toContain("git rev-parse refs/heads/<default-branch>");
    expect(tpl?.prompt_template).toContain("detached の一時 review worktree");
    expect(tpl?.prompt_template).toContain("--since=<前回レビュー日時>");
    expect(tpl?.prompt_template).toContain("latest.json");
    expect(tpl?.prompt_template).toContain("reviewed_at");
    expect(tpl?.prompt_template).toContain("一時 worktree は全経路で削除");
    expect(tpl?.prompt_template).toContain("GitHub へのアクセス");
    expect(tpl?.prompt_template).not.toContain("git fetch origin");
    expect(tpl?.prompt_template).not.toContain("git rev-parse origin/");
    expect(tpl?.prompt_template).not.toContain("GitHub Issue");
    // 範囲逆転 (今回 HEAD が前回 HEAD の祖先) を検出したら早期 skip し、レビュアーへ投げない。
    expect(tpl?.prompt_template).toContain("merge-base --is-ancestor");
    expect(tpl?.prompt_template).toContain("range_reversed");
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
    expect(duo?.prompt_template).toContain("claude-opus-5");
    expect(duo?.prompt_template).not.toContain("claude-opus-4-8");
    expect(duo?.prompt_template).toContain("gpt-5.6-sol");
    expect(duo?.prompt_template).toContain("xhigh");
    expect(duo?.prompt_template).toContain("E:\\Document\\Ars\\Review\\");
    expect(duo?.prompt_template).toContain("worktree の生成・ブランチ切り替えは行わない");
    expect(duo?.prompt_template).toContain("追加指示 (inject)");

    expect(repo.findTemplateByCallName("review-sonnet5")?.is_active).toBe(0);
  });

  it("reactivates the single-AI Claude definition as the daily cron default", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const claude = repo.findTemplateByCallName("ludiars-review-daily");
    expect(claude?.target_provider).toBe("claude");
    expect(claude?.title).toBe("毎日レビュー");
    expect(claude?.is_active).toBe(1);
    expect(claude?.model).toBe("claude-sonnet-5");
    expect(claude?.prompt_template).toContain("service-map.json");
    expect(claude?.prompt_template).toContain("daily_review: true");
    expect(claude?.prompt_template).toContain("別AIは起動しない");
    expect(claude?.prompt_template).not.toContain("2 レビュアー");
    expect(claude?.prompt_template).toContain("E:\\Document\\Ars\\Review\\<repo>\\${date}\\");
    expect(claude?.prompt_template).not.toContain("E:\\Document\\Ars\\reviews\\");
    expect(claude?.prompt_template).toContain("refs/heads/<default-branch>");
    expect(claude?.prompt_template).toContain("reviewed_at");
    expect(claude?.prompt_template).not.toContain("git fetch origin");
  });

  it("seeds the Genius ingest templates for the cron jobs", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    for (const callName of ["genius-ingest-daily", "genius-ingest-tier2-nightly"]) {
      const tpl = repo.findTemplateByCallName(callName);
      expect(tpl?.is_active).toBe(1);
      // 時限起動なので parttimer (spec/feature/delegation.md の category 表)。
      expect(tpl?.category).toBe("parttimer");
      expect(tpl?.target_provider).toBe("claude");
      expect(tpl?.model).toBe("claude-sonnet-5");
      expect(tpl?.default_cwd).toBe("E:\\Document\\Ars\\Genius");
      expect(JSON.parse(tpl?.input_schema ?? "null")).toEqual([
        { name: "date", type: "string", required: true, description: "実行日 (YYYY-MM-DD)" },
      ]);

      const prompt = tpl?.prompt_template ?? "";
      // 完了条件は completed と completed-with-errors の両方 (後者は失敗扱いにしない)。
      expect(prompt).toContain("`GET http://127.0.0.1:4230/api/clone/ingest/runs/<run id>`");
      expect(prompt).toContain("`completed-with-errors`");
      expect(prompt).toContain("失敗扱いにしない");
      // 自動リトライ禁止 (retry-failed は 1 回だけ / それ以外は人間へ)。
      expect(prompt).toContain("--retry-failed");
      expect(prompt).toContain("**1 回だけ**");
      // 運用ジョブなので起動・再起動・テスト実行は指示しない。
      expect(prompt).toContain("起動・再起動は Excubitor / 人間の担当");
      expect(prompt).toContain("テスト実行");
      expect(prompt).not.toContain("npm test");
      // 通知の環流対策: 本文・絶対パスの転記禁止。
      expect(prompt).toContain("**文書本文・カード本文・絶対パスは報告に載せない**");
    }
  });

  it("keeps the Genius Tier 1 and Tier 2 ingest commands in separate templates", () => {
    const repo = new DelegationRepo(makeTestDb());
    seedDelegationTemplates(repo);

    const daily = repo.findTemplateByCallName("genius-ingest-daily")?.prompt_template ?? "";
    const nightly = repo.findTemplateByCallName("genius-ingest-tier2-nightly")?.prompt_template ?? "";

    expect(daily).toContain("`node dist/cli.js ingest` を実行する");
    expect(daily).not.toContain("ingest:tier2-nightly");
    expect(nightly).toContain("`npm run ingest:tier2-nightly`");
    // budget は Genius 側で撤廃済み。テンプレに上限値を書き戻さない。
    expect(nightly).not.toContain("--budget-files");
    // Tier 2 の全量 run は Tier 1 の 4:10 を跨ぎうる (Concordia に同時実行制限は無い)。
    // Tier 1 側で「実行中なら見送る」判断を持たせて重複 ingest を防ぐ。
    expect(daily).toContain("重ねて起動せず");
    expect(daily).toContain("見送り");
  });

  it("deactivates the replaced daily-review-reconciliation call name", () => {
    const repo = new DelegationRepo(makeTestDb());
    repo.createTemplate({
      call_name: "daily-review-reconciliation",
      title: "Old dual review",
      target_provider: "claude",
      prompt_template: "old",
    });

    seedDelegationTemplates(repo);

    expect(repo.findTemplateByCallName("daily-review-reconciliation")?.is_active).toBe(0);
    expect(repo.findTemplateByCallName("ludiars-review-daily-dual")).toMatchObject({
      is_active: 1,
      title: "毎日レビューちょいつよ版",
    });
  });
});
