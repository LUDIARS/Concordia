import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect, vi } from "vitest";
import type { SkillCatalogEntry } from "../skills/catalog.js";
import {
  classifyReactionWorkflow,
  primaryEmojiForAction,
  ReactionWorkflowRunner,
  writeCustomWorkflows,
  type ReactionWorkflowInput,
  type ReactionWorkflowDeps,
  type WorkflowAction,
  type WorkflowResultRelay,
} from "./reaction-workflow.js";
import type { RwfPrListOutcome, RwfPrMergeOutcome, RwfPrSubmitOutcome } from "./reaction-workflow-pr.js";

const PR = { id: "lpr-1", number: 12, repository: "LUDIARS/Concordia", headRef: "feat/x" };

// 🔀 の GitHub 経路は移行後 (設計 §11.2) スキル `merge-clean-pr` が担う。
// local PR が無いときのフォールバックを見るために、最小の割り当てを用意する。
const MERGE_SKILL_BODY = "# PR をマージする\ngh pr merge --squash --delete-branch で squash merge する。";
const CATALOG: SkillCatalogEntry[] = [{
  name: "merge-clean-pr",
  description: "open な PR を squash merge する。",
  path: "E:/Document/Ars/.claude/commands/merge-clean-pr.md",
  source: "commands",
  rwf: [{ emoji: ["🔀", "🚀"], action: "merge-pr", args: null, mode: "inject", model: "sonnet", cwd: "repo" }],
}];

let tempDir = "";
let customWorkflowsPath = "";

beforeAll(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "concordia-rwf-pr-"));
  customWorkflowsPath = join(tempDir, "custom-reaction-workflows.json");
  await writeCustomWorkflows(customWorkflowsPath, [{
    kind: "skill", emoji: "🔀", skill: "merge-clean-pr",
    mode: "inject", model: "sonnet", cwd: "repo", action: "merge-pr",
  }]);
});

afterAll(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

interface Harness {
  runner: ReactionWorkflowRunner;
  results: Array<{ action: WorkflowAction; result: WorkflowResultRelay }>;
  injects: Array<{ sessionId: string; text: string }>;
  headless: Array<{ prompt: string; cwd?: string }>;
  submit: ReturnType<typeof vi.fn>;
  merge: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
}

function makeHarness(options: {
  submit?: RwfPrSubmitOutcome;
  merge?: RwfPrMergeOutcome;
  list?: RwfPrListOutcome;
  listError?: Error;
  withOperations?: boolean;
  withList?: boolean;
  hasCapability?: boolean;
} = {}): Harness {
  const results: Harness["results"] = [];
  const injects: Harness["injects"] = [];
  const headless: Harness["headless"] = [];
  const submit = vi.fn(async () => options.submit ?? { ok: true, kind: "submitted", pullRequest: PR } as RwfPrSubmitOutcome);
  const merge = vi.fn(async () => options.merge ?? { ok: true, kind: "merged", pullRequest: PR, authorizerRole: "管理職" } as RwfPrMergeOutcome);
  const list = vi.fn(async () => {
    if (options.listError) throw options.listError;
    return options.list ?? {
      ok: true,
      markdown: "## Revisor local PR 一覧\n- ✅ #12",
      openCount: 1,
    } as RwfPrListOutcome;
  });

  const deps: ReactionWorkflowDeps = {
    runHeadless: async (prompt, opts) => {
      headless.push({ prompt, cwd: opts?.cwd });
      return { ok: true, stdout: "done", exit_code: 0, stderr: "", duration_ms: 1 };
    },
    emitInject: (sessionId, text) => injects.push({ sessionId, text }),
    workspaceRoot: "E:/Document/Ars",
    customWorkflowsPath,
    skills: {
      list: () => CATALOG,
      find: (name) => CATALOG.find((entry) => entry.name === name) ?? null,
      readBody: async () => MERGE_SKILL_BODY,
    },
    enabled: true,
    hasCapability: () => options.hasCapability ?? true,
    ...(options.withOperations === false
      ? {}
      : {
        prOperations: {
          submitLocalPr: submit,
          mergeLocalPr: merge,
          ...(options.withList === false ? {} : { listLocalPrs: list }),
        },
      }),
    log: { info: () => { /* silent */ }, warn: () => { /* silent */ } },
  };
  const runner = new ReactionWorkflowRunner(deps);
  return { runner, results, injects, headless, submit, merge, list };
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

describe("list-local-prs (📋)", () => {
  it("maps 📋 to list-local-prs", () => {
    expect(classifyReactionWorkflow("📋")).toBe("list-local-prs");
    expect(primaryEmojiForAction("list-local-prs")).toBe("📋");
  });

  it("returns the Revisor local PR list markdown with the actor", async () => {
    const h = makeHarness();
    await run(h, input("📋"));

    expect(h.list).toHaveBeenCalledWith({ sessionId: "sess-1", actor: { userId: "u-1" } });
    expect(h.results).toHaveLength(1);
    expect(h.results[0].action).toBe("list-local-prs");
    expect(h.results[0].result.ok).toBe(true);
    expect(h.results[0].result.text).toContain("Revisor local PR 一覧");
    expect(h.results[0].result.text).toContain("<@u-1>");
    // headless / inject 経路は通らない (API 実体を直接呼ぶ)。
    expect(h.headless).toHaveLength(0);
    expect(h.injects).toHaveLength(0);
  });

  it("works outside a session channel (lists all repositories)", async () => {
    const h = makeHarness();
    await run(h, input("📋", { sessionId: null }));
    expect(h.list).toHaveBeenCalledWith({ sessionId: null, actor: { userId: "u-1" } });
    expect(h.results[0].result.ok).toBe(true);
  });

  it("reports when the listing route is not wired", async () => {
    const h = makeHarness({ withList: false });
    await run(h, input("📋"));
    expect(h.list).not.toHaveBeenCalled();
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("有効になっていません");
  });

  it("reports a listing failure instead of staying silent", async () => {
    const h = makeHarness({ list: { ok: false, kind: "unavailable", detail: "Revisor down" } });
    await run(h, input("📋"));
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("Revisor down");
  });

  it("relays the shared guidance markdown while keeping fetch failures unsuccessful", async () => {
    const h = makeHarness({
      list: {
        ok: false,
        kind: "unavailable",
        detail: "Revisor down",
        markdown: "## Revisor local PR 一覧\nGitHub PR のキューは別系統 (`/prs`)。",
      },
    });
    await run(h, input("📋"));
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).toContain("Revisor local PR 一覧");
    expect(h.results[0].result.text).toContain("GitHub PR のキューは別系統");
  });

  it("does not relay raw exceptions from the listing port", async () => {
    const h = makeHarness({ listError: new Error("sensitive-diagnostic-marker") });
    await run(h, input("📋"));
    expect(h.results[0].result.ok).toBe(false);
    expect(h.results[0].result.text).not.toContain("sensitive-diagnostic-marker");
    expect(h.results[0].result.text).toContain("エラーが発生しました");
  });

  it("clips a long listing to the platform-safe relay size", async () => {
    const h = makeHarness({
      list: { ok: true, markdown: "x".repeat(3_000), openCount: 20 },
    });
    await run(h, input("📋"));
    expect(h.results[0].result.text.length).toBeLessThanOrEqual(1_750);
    expect(h.results[0].result.text).toContain("truncated");
    expect(h.results[0].result.text).toContain("<@u-1>");
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
    // どちらを実行したかを応答に出したうえで、従来経路 (スキル merge-clean-pr) へ進む。
    expect(h.injects).toHaveLength(1);
    expect(h.injects[0].text).toContain("/merge-clean-pr");
  });

  it("uses the headless GitHub route when the session is not active", async () => {
    const h = makeHarness({ merge: { ok: false, kind: "no_local_pr" } });
    await run(h, input("🔀", { sessionActive: false }));

    expect(h.headless).toHaveLength(1);
    // headless では SKILL.md 本文をシステム文脈として渡す (skill 名だけでは解決されない)。
    expect(h.headless[0].prompt).toContain("squash merge");
    expect(h.headless[0].prompt).toContain("/merge-clean-pr");
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
