import { describe, it, expect, vi } from "vitest";
import {
  classifyReactionWorkflow,
  primaryEmojiForAction,
  ReactionWorkflowRunner,
  type ReactionWorkflowInput,
  type ReactionWorkflowDeps,
  type WorkflowAction,
  type WorkflowResultRelay,
} from "./reaction-workflow.js";
import type { RwfPrMergeOutcome, RwfPrSubmitOutcome } from "./reaction-workflow-pr.js";

const PR = { id: "lpr-1", number: 12, repository: "LUDIARS/Concordia", headRef: "feat/x" };

interface Harness {
  runner: ReactionWorkflowRunner;
  results: Array<{ action: WorkflowAction; result: WorkflowResultRelay }>;
  injects: Array<{ sessionId: string; text: string }>;
  headless: Array<{ prompt: string; cwd?: string }>;
  submit: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  submit?: RwfPrSubmitOutcome;
  merge?: RwfPrMergeOutcome;
  withOperations?: boolean;
  hasCapability?: boolean;
} = {}): Harness {
  const results: Harness["results"] = [];
  const injects: Harness["injects"] = [];
  const headless: Harness["headless"] = [];
  const submit = vi.fn(async () => options.submit ?? { ok: true, kind: "submitted", pullRequest: PR } as RwfPrSubmitOutcome);
  const merge = vi.fn(async () => options.merge ?? { ok: true, kind: "merged", pullRequest: PR, authorizerRole: "管理職" } as RwfPrMergeOutcome);

  const deps: ReactionWorkflowDeps = {
    runHeadless: async (prompt, opts) => {
      headless.push({ prompt, cwd: opts?.cwd });
      return { ok: true, stdout: "done", exit_code: 0, stderr: "", duration_ms: 1 };
    },
    emitInject: (sessionId, text) => injects.push({ sessionId, text }),
    workspaceRoot: "E:/Document/Ars",
    enabled: true,
    hasCapability: () => options.hasCapability ?? true,
    ...(options.withOperations === false
      ? {}
      : { prOperations: { submitLocalPr: submit, mergeLocalPr: merge } }),
    log: { info: () => { /* silent */ }, warn: () => { /* silent */ } },
  };
  const runner = new ReactionWorkflowRunner(deps);
  return { runner, results, injects, headless, submit, merge };
}

function input(emoji: string, overrides: Partial<ReactionWorkflowInput> = {}): ReactionWorkflowInput {
  return {
    dedupeKey: `msg-${emoji}-${Math.random()}`,
    emoji,
    userId: "u-1",
    messageText: "実装が終わりました",
    authorLabel: "impl",
    repoPath: "E:/Document/Ars/Concordia",
    sessionActive: true,
    sessionId: "sess-1",
    ...overrides,
  };
}

async function run(h: Harness, in_: ReactionWorkflowInput): Promise<void> {
  await h.runner.handle(in_, undefined, (action, result) => h.results.push({ action, result }));
}

describe("submit-pr (📮)", () => {
  it("maps 📮 / 📬 to submit-pr", () => {
    expect(classifyReactionWorkflow("📮")).toBe("submit-pr");
    expect(classifyReactionWorkflow("📬")).toBe("submit-pr");
    expect(primaryEmojiForAction("submit-pr")).toBe("📮");
  });

  it("submits the session branch as a Revisor local PR", async () => {
    const h = makeHarness();
    await run(h, input("📮"));

    expect(h.submit).toHaveBeenCalledWith({ sessionId: "sess-1", actor: { userId: "u-1" } });
    expect(h.results).toHaveLength(1);
    expect(h.results[0].action).toBe("submit-pr");
    expect(h.results[0].result.ok).toBe(true);
    expect(h.results[0].result.text).toContain("local PR #12");
    expect(h.results[0].result.text).toContain("提出しました");
    // 実行者を必ず残す (破壊的でないので権限は問わないが、誰が押したかは記録する)。
    expect(h.results[0].result.text).toContain("<@u-1>");
    // headless / inject 経路は通らない (API 実体を直接呼ぶ)。
    expect(h.headless).toHaveLength(0);
    expect(h.injects).toHaveLength(0);
  });

  it.each([
    ["no_branch", "作業ブランチが記録されていません"],
    ["repository_not_registered", "Revisor に登録されていません"],
    ["no_commits", "コミットがありません"],
    ["already_open", "既に open です"],
  ])("reports why it did not submit (%s)", async (reason, expected) => {
    const h = makeHarness({ submit: { ok: false, kind: "skipped", reason } });
    await run(h, input("📮"));

    expect(h.results).toHaveLength(1);
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain(expected);
  });

  it("reports an unknown skip reason instead of staying silent", async () => {
    const h = makeHarness({ submit: { ok: false, kind: "skipped", reason: "weird_new_reason" } });
    await run(h, input("📮"));
    expect(h.results[0].result.text).toContain("weird_new_reason");
  });

  it("reports when the reaction is not on a session channel", async () => {
    const h = makeHarness();
    await run(h, input("📮", { sessionId: null }));

    expect(h.submit).not.toHaveBeenCalled();
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("セッションチャンネル");
  });

  it("reports when the submission route is not wired", async () => {
    const h = makeHarness({ withOperations: false });
    await run(h, input("📮"));
    expect(h.results[0].result.text).toContain("有効になっていません");
  });
});

describe("merge-pr (🔀)", () => {
  it("merges the Revisor local PR and says so", async () => {
    const h = makeHarness();
    await run(h, input("🔀"));

    expect(h.merge).toHaveBeenCalledWith({ sessionId: "sess-1", actor: { userId: "u-1" } });
    const texts = h.results.map((r) => r.result.text).join("\n");
    expect(texts).toContain("Revisor local PR をマージしました");
    expect(texts).toContain("管理職");
    // local PR を消化したので GitHub 経路 (inject/headless) は走らない。
    expect(h.injects).toHaveLength(0);
    expect(h.headless).toHaveLength(0);
  });

  it("falls back to the GitHub squash merge route only when no local PR is open", async () => {
    const h = makeHarness({ merge: { ok: false, kind: "no_local_pr", detail: "open な local PR がありません" } });
    await run(h, input("🔀"));

    const texts = h.results.map((r) => r.result.text).join("\n");
    expect(texts).toContain("GitHub PR の squash merge 経路");
    // どちらを実行したかを応答に出したうえで、従来経路へ進む。
    expect(h.injects).toHaveLength(1);
    expect(h.injects[0].text).toContain("squash merge");
  });

  it("uses the headless GitHub route when the session is not active", async () => {
    const h = makeHarness({ merge: { ok: false, kind: "no_local_pr" } });
    await run(h, input("🔀", { sessionActive: false }));

    expect(h.headless).toHaveLength(1);
    expect(h.headless[0].prompt).toContain("squash merge");
  });

  it("does not fall back when the requester lacks the merge capability", async () => {
    const h = makeHarness({ hasCapability: false });
    await run(h, input("🔀"));

    expect(h.merge).not.toHaveBeenCalled();
    expect(h.injects).toHaveLength(0);
    expect(h.headless).toHaveLength(0);
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("マージ権限");
  });

  it("does not fall back to GitHub when the local PR merge is refused", async () => {
    const h = makeHarness({
      merge: { ok: false, kind: "not_authorized", detail: "PR のマージ requires 管理職 or higher" },
    });
    await run(h, input("🔀"));

    expect(h.injects).toHaveLength(0);
    expect(h.headless).toHaveLength(0);
    expect(h.results[0].result.text).toContain("マージしませんでした");
  });

  it("reports a Revisor failure without falling back", async () => {
    const h = makeHarness({ merge: { ok: false, kind: "failed", detail: "Revisor local PR merge failed" } });
    await run(h, input("🔀"));

    expect(h.injects).toHaveLength(0);
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("マージに失敗");
  });

  it("acknowledges exactly once even when it falls back", async () => {
    const h = makeHarness({ merge: { ok: false, kind: "no_local_pr" } });
    const accepted: WorkflowAction[] = [];
    await h.runner.handle(input("🔀"), (action) => accepted.push(action), () => { /* ignore */ });
    expect(accepted).toEqual(["merge-pr"]);
  });
});
