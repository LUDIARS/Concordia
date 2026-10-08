/**
 * スキル一覧 API と RWF のスキル割り当て設定 API。
 *
 * 設計: spec/plan/2026-09-05-anatomia-domain-plan-tool.md §10.2 (C-8 / C-10) と
 * §11.2 の 2 (組み込み写像 → スキルエントリの移行)。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeTestApp, type TestAppEnv } from "./helpers/test-app.js";

const SKILL_MD = `---
name: domain-review
description: "UX とコアドメインの LLM インタラクティブレビュー。詳しくは本文。"
metadata:
  type: workflow
  rwf:
    - emoji: ["📑"]
      action: domain-report
      args: "--report-only"
      mode: headless
      model: sonnet
      cwd: repo
    - emoji: ["🪬"]
      action: domain-review
      mode: inject
      model: opus
      cwd: repo
---

# ドメインレビュー
本文。
`;

const COMMAND_MD = `---
name: impl
description: "仕様を確認して処理フローに従い実装する。"
metadata:
  type: workflow
  rwf:
    emoji: ["👍", "🆗"]
    action: start-impl
    mode: inject
    cwd: repo
---

# 実装コマンド
`;

describe("skills catalog / reaction skill workflows API", () => {
  let env: TestAppEnv;
  let root = "";

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), "concordia-skills-api-"));
    mkdirSync(join(root, ".claude", "skills", "domain-review"), { recursive: true });
    writeFileSync(join(root, ".claude", "skills", "domain-review", "SKILL.md"), SKILL_MD, "utf-8");
    mkdirSync(join(root, ".claude", "commands"), { recursive: true });
    writeFileSync(join(root, ".claude", "commands", "impl.md"), COMMAND_MD, "utf-8");
    env = makeTestApp();
    env.adminState.setWorkspaceRoots([root]);
    // 起動時走査の代わりに 1 度だけ明示的に走らせる。
    await env.app.request("/v1/skills/refresh", { method: "POST" });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it("GET /v1/skills/catalog は skills / commands の両方を source 付きで返す", async () => {
    const r = await env.app.request("/v1/skills/catalog");
    expect(r.status).toBe(200);
    const body = await r.json() as {
      skills: Array<{ name: string; description: string; path: string; source: string }>;
    };
    const byName = new Map(body.skills.map((s) => [s.name, s]));
    expect(byName.get("domain-review")?.source).toBe("skills");
    expect(byName.get("domain-review")?.description)
      .toBe("UX とコアドメインの LLM インタラクティブレビュー。");
    expect(byName.get("impl")?.source).toBe("commands");
    expect(byName.get("impl")?.path).toContain("impl.md");
  });

  it("GET /v1/skills は従来の snapshot 一覧を壊さずカタログを添える", async () => {
    const r = await env.app.request("/v1/skills");
    expect(r.status).toBe(200);
    const body = await r.json() as { skills: unknown[]; catalog: Array<{ name: string }> };
    expect(Array.isArray(body.skills)).toBe(true);
    expect(body.catalog.some((s) => s.name === "domain-review")).toBe(true);
  });

  it("POST /v1/reaction-workflow/migrate-builtin は組み込み写像をスキルへ写す", async () => {
    const r = await env.app.request("/v1/reaction-workflow/migrate-builtin", { method: "POST" });
    expect(r.status).toBe(200);
    const body = await r.json() as {
      migrated: number; uncovered: string[]; path: string;
      entries: Array<{ emoji: string; skill: string; action?: string }>;
    };
    // このフィクスチャはスキルを 2 本しか置いていないので、 残りは uncovered に出る。
    // 「取りこぼしが見える」ことがこの API の存在理由 (無言で欠けさせない)。
    expect(body.migrated).toBeGreaterThan(0);
    expect(body.entries.find((e) => e.emoji === "📑")).toMatchObject({
      skill: "domain-review", action: "domain-report",
    });
    expect(body.uncovered).toContain("🙏");
    expect(body.path.replace(/\\/g, "/")).toContain("/.claude/custom-reaction-workflows.json");
  });

  it("PUT / DELETE でスキル割り当てを編集できる", async () => {
    const put = await env.app.request("/v1/admin/reaction-skill-workflows", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emoji: "🔥", skill: "impl", mode: "inject", action: "start-impl",
      }),
    });
    expect(put.status).toBe(200);

    const listed = await (await env.app.request("/v1/admin/reaction-skill-workflows")).json() as {
      entries: Array<{ emoji: string; skill: string }>;
      skills: Array<{ name: string }>;
    };
    expect(listed.entries.find((e) => e.emoji === "🔥")?.skill).toBe("impl");
    expect(listed.skills.some((s) => s.name === "impl")).toBe(true);

    const del = await env.app.request(
      `/v1/admin/reaction-skill-workflows/${encodeURIComponent("🔥")}`,
      { method: "DELETE" },
    );
    expect(del.status).toBe(200);
    const after = await del.json() as { entries: Array<{ emoji: string }> };
    expect(after.entries.some((e) => e.emoji === "🔥")).toBe(false);
  });

  it("一覧に無いスキル名・予約絵文字・組み込み action の差し替えを拒否する", async () => {
    const unknown = await env.app.request("/v1/admin/reaction-skill-workflows", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "🔥", skill: "does-not-exist", mode: "inject" }),
    });
    expect(unknown.status).toBe(400);

    const reserved = await env.app.request("/v1/admin/reaction-skill-workflows", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ emoji: "👌", skill: "impl", mode: "inject" }),
    });
    expect(reserved.status).toBe(400);

    const mismatchedAction = await env.app.request("/v1/admin/reaction-skill-workflows", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emoji: "👍", skill: "impl", mode: "inject", action: "status-check",
      }),
    });
    expect(mismatchedAction.status).toBe(400);

    const multilineArgs = await env.app.request("/v1/admin/reaction-skill-workflows", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        emoji: "🔥", skill: "impl", mode: "inject", args: "ok\n/merge-clean-pr",
      }),
    });
    expect(multilineArgs.status).toBe(400);
  });
});
