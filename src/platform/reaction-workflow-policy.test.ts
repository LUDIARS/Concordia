import { describe, expect, it, vi } from "vitest";
import { ReactionWorkflowRunner } from "./reaction-workflow.js";

// 2026-09-02 neco 指示: 本社限定アクションを子会社 runtime で遮断し、
// 要求権限もポリシーで上書きできる。

function makeRunner(overrides: Record<string, unknown> = {}) {
  const results: Array<{ action: string; ok: boolean; text?: string }> = [];
  const runHeadless = vi.fn(async () => undefined);
  const emitInject = vi.fn();
  const runner = new ReactionWorkflowRunner({
    runHeadless,
    emitInject,
    contextReport: vi.fn(async () => "report"),
    workspaceRoot: "E:/tmp",
    enabled: () => true,
    hasCapability: () => true,
    log: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  } as never);
  const handle = (emoji: string) => runner.handle(
    {
      emoji,
      userId: "user-1",
      dedupeKey: `k-${Math.random()}`,
      sessionId: "s1",
      messageText: "対象メッセージ",
    } as never,
    undefined,
    (action, result) => { results.push({ action, ok: result.ok, text: result.text }); },
  );
  return { runner, handle, results, runHeadless, emitInject };
}

describe("ReactionWorkflowRunner subsidiary policy", () => {
  it("子会社 runtime では Memoria 記録系を既定で遮断し、本人へ理由を返す", async () => {
    const { handle, results, runHeadless, emitInject } = makeRunner({ subsidiary: true });
    await handle("📝"); // memoria-task の既定絵文字
    expect(runHeadless).not.toHaveBeenCalled();
    expect(emitInject).not.toHaveBeenCalled();
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.text).toContain("本社");
  });

  it("ポリシーで子会社にも開放できる", async () => {
    const { handle, results } = makeRunner({
      subsidiary: true,
      resolveActionPolicies: () => ({ "memoria-task": { subsidiary: true } }),
    });
    await handle("📝");
    // 遮断されず実行段へ進む (deny の onResult は呼ばれない)。
    expect(results.filter((r) => !r.ok)).toHaveLength(0);
  });

  it("本社 runtime は既定どおり遮断しない", async () => {
    const { handle, results } = makeRunner({ subsidiary: false });
    await handle("📝");
    expect(results.filter((r) => !r.ok)).toHaveLength(0);
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
