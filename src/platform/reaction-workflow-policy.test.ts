import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { SkillCatalogEntry } from "../skills/catalog.js";
import { ReactionWorkflowRunner, writeCustomWorkflows } from "./reaction-workflow.js";

// 2026-09-02 neco 指示: 本社限定アクションを子会社 runtime で遮断し、
// 要求権限もポリシーで上書きできる。
//
// 移行後 (設計 §11.2) の RWF は「絵文字 → スキル」で実行するので、 ポリシー判定の
// 前後だけを見るこのテストにも最小のスキル割り当てを用意する — 実行段まで進んだこと
// (= ポリシーで止まっていないこと) を確かめるため。

function skill(
  name: string,
  emoji: string[],
  action: string,
  mode: "inject" | "headless",
  model: string,
  cwd: string,
): SkillCatalogEntry {
  return {
    name,
    description: `${name} のスキル。`,
    path: `E:/tmp/.claude/skills/${name}/SKILL.md`,
    source: "skills",
    rwf: [{ emoji, action, args: null, mode, model, cwd }],
  };
}

const CATALOG: SkillCatalogEntry[] = [
  skill("memoria-task", ["📝"], "memoria-task", "headless", "sonnet", "memoria"),
  skill("merge-clean-pr", ["🔀"], "merge-pr", "inject", "sonnet", "repo"),
];

let tempDir = "";
let customWorkflowsPath = "";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "concordia-rwf-policy-"));
  customWorkflowsPath = join(tempDir, "custom-reaction-workflows.json");
  await writeCustomWorkflows(customWorkflowsPath, [
    {
      kind: "skill", emoji: "📝", skill: "memoria-task",
      mode: "headless", model: "sonnet", cwd: "memoria", action: "memoria-task",
    },
    {
      kind: "skill", emoji: "🔀", skill: "merge-clean-pr",
      mode: "inject", model: "sonnet", cwd: "repo", action: "merge-pr",
    },
  ]);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function makeRunner(overrides: Record<string, unknown> = {}) {
  const results: Array<{ action: string; ok: boolean; text?: string }> = [];
  const runHeadless = vi.fn(async () => undefined);
  const emitInject = vi.fn();
  const logInfo = vi.fn();
  const runner = new ReactionWorkflowRunner({
    runHeadless,
    emitInject,
    contextReport: vi.fn(async () => "report"),
    workspaceRoot: "E:/tmp",
    memoriaPath: "E:/tmp/Memoria",
    customWorkflowsPath,
    skills: {
      list: () => CATALOG,
      find: (name: string) => CATALOG.find((e) => e.name === name) ?? null,
      readBody: async (entry: SkillCatalogEntry) => `# ${entry.name}\n本文。`,
    },
    enabled: () => true,
    hasCapability: () => true,
    log: { info: logInfo, warn: vi.fn() },
    ...overrides,
  } as never);
  const handle = (emoji: string) => runner.handle(
    {
      emoji,
      userId: "user-1",
      dedupeKey: `k-${Math.random()}`,
      sessionId: "s1",
      messageText: "対象メッセージ",
      authorLabel: "テスト投稿者",
    } as never,
    undefined,
    (action, result) => { results.push({ action, ok: result.ok, text: result.text }); },
  );
  return { runner, handle, results, runHeadless, emitInject, logInfo };
}

describe("ReactionWorkflowRunner subsidiary policy", () => {
  it("子会社 runtime では Memoria 記録系はそもそも発火しない (返信も無し)", async () => {
    // 2026-09-02 neco 指示: 対応外の絵文字と同じ扱い。監査ログのみ残す。
    const { handle, results, runHeadless, emitInject, logInfo } = makeRunner({ subsidiary: true });
    await handle("📝"); // memoria-task の既定絵文字
    expect(runHeadless).not.toHaveBeenCalled();
    expect(emitInject).not.toHaveBeenCalled();
    expect(results).toHaveLength(0);
    expect(logInfo).toHaveBeenCalledWith("reaction-workflow: skipped (hq-only) action=memoria-task user=user-1");
  });

  it("ポリシーで子会社にも開放できる", async () => {
    const { handle, results, runHeadless } = makeRunner({
      subsidiary: true,
      resolveActionPolicies: () => ({ "memoria-task": { subsidiary: true } }),
    });
    await handle("📝");
    // 遮断されず実行段へ進む (deny の onResult は呼ばれない)。
    expect(results.filter((r) => !r.ok)).toHaveLength(0);
    expect(runHeadless).toHaveBeenCalled();
  });

  it("本社 runtime は既定どおり遮断しない", async () => {
    const { handle, results, runHeadless } = makeRunner({ subsidiary: false });
    await handle("📝");
    expect(results.filter((r) => !r.ok)).toHaveLength(0);
    expect(runHeadless).toHaveBeenCalled();
  });

  it("要求権限のポリシー上書き (none) で権限チェックを外せる", async () => {
    const hasCapability = vi.fn(() => false);
    const { handle, results } = makeRunner({
      hasCapability,
      resolveActionPolicies: () => ({ "merge-pr": { capability: "none" } }),
    });
    await handle("🔀"); // merge-pr の既定絵文字
    expect(hasCapability).not.toHaveBeenCalled();
    // prOperations 未注入の実行失敗は返るが、権限による拒否は無い。
    expect(results.filter((r) => !r.ok && r.text?.includes("権限"))).toHaveLength(0);
  });
});
