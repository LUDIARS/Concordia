import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect } from "vitest";
import {
  classifyReactionWorkflow,
  defaultReactionEmojiMap,
  isReservedNonActionEmoji,
  isWorkflowAction,
  planWorkflow,
  reactionAckText,
  ReactionWorkflowRunner,
  WORKFLOW_ACTIONS,
  WORKFLOW_ACTION_HELP,
  type ReactionWorkflowInput,
  type WorkflowAction,
  type WorkflowContext,
} from "./reaction-workflow.js";

const baseCtx: WorkflowContext = {
  messageText: "新しいキャッシュ層を入れる提案。LRU で 1000 件、TTL 5 分。",
  authorLabel: "設計担当",
  repoPath: "E:/Document/Ars/Memoria",
  sessionActive: true,
  memoriaPath: "E:/Document/Ars/Memoria",
  reactorId: "u123",
};

describe("classifyReactionWorkflow", () => {
  it.each([
    ["👍", "start-impl"],
    ["🧠", "context"],
    ["🆗", "start-impl"],
    ["🙏", "enumerate-remaining"],
    ["🫶", "memoria-remaining"],
    ["😴", "memoria-remaining"],
    ["✨", "memoria-remaining"],
    ["📲", "status-check"],
    ["🆙", "status-check"],
    ["👆", "status-check"],
    ["😄", "repo-memory-good"],
    ["😀", "repo-memory-good"],
    ["👀", "memoria-note"],
    ["👈", "memoria-note"],
    ["📓", "memoria-note"],
    ["✏️", "memoria-note"],
    ["📝", "memoria-task"],
    ["✅", "memoria-task"],
    ["✔️", "memoria-task"],
    ["😡", "repo-memory-bad"],
    ["👎", "repo-memory-bad"],
    ["⏭️", "defer-impl"],
    ["📤", "defer-impl"],
    ["🗂️", "defer-impl"],
    ["🙄", "force-enter"],
    ["🤝", "delegate-task"],
    ["🫱", "delegate-task"],
    ["👋", "handoff-document"],
    ["▶️", "resume-work"],
    ["⏩", "resume-work"],
    ["🔀", "merge-pr"],
    ["🚀", "merge-pr"],
    ["🔄", "sync-project-main-after-merge"],
    ["🔃", "sync-project-main-after-merge"],
  ] as const)("maps %s → %s", (emoji, action) => {
    expect(classifyReactionWorkflow(emoji)).toBe(action);
  });

  it("returns null for unmapped emoji", () => {
    expect(classifyReactionWorkflow("👌")).toBeNull();
    expect(classifyReactionWorkflow("🎉")).toBeNull();
    expect(classifyReactionWorkflow("🍕")).toBeNull();
  });

  it("ignores surrounding whitespace", () => {
    expect(classifyReactionWorkflow(" 👍 ")).toBe("start-impl");
  });

  it("custom overrides take precedence over defaults; add new emoji", () => {
    const overrides = { "👍": "memoria-note" as const, "🔥": "start-impl" as const };
    expect(classifyReactionWorkflow("👍", overrides)).toBe("memoria-note"); // 上書き
    expect(classifyReactionWorkflow("🔥", overrides)).toBe("start-impl");   // 新規
    expect(classifyReactionWorkflow("🫶", overrides)).toBe("memoria-remaining"); // 上書きなし=既定
    expect(classifyReactionWorkflow("🎉", overrides)).toBeNull();
  });

  it("reserves 👌 as non-action even when an override attempts to assign it", () => {
    for (const emoji of ["👌", "👌️", "👌🏻", "👌🏼", "👌🏽", "👌🏾", "👌🏿"]) {
      expect(isReservedNonActionEmoji(` ${emoji} `)).toBe(true);
      expect(classifyReactionWorkflow(emoji, { [emoji]: "handoff-document" })).toBeNull();
    }
  });
});

describe("defaultReactionEmojiMap / isWorkflowAction", () => {
  it("flattens defaults and every value is a valid action", () => {
    const map = defaultReactionEmojiMap();
    expect(map["🙏"]).toBe("enumerate-remaining");
    expect(map["🫶"]).toBe("memoria-remaining");
    expect(map["📲"]).toBe("status-check");
    expect(map).not.toHaveProperty("👌");
    for (const action of Object.values(map)) expect(isWorkflowAction(action)).toBe(true);
  });

  it("isWorkflowAction rejects unknown strings", () => {
    expect(isWorkflowAction("start-impl")).toBe(true);
    expect(isWorkflowAction("nope")).toBe(false);
    expect(isWorkflowAction(123)).toBe(false);
  });
});

describe("WORKFLOW_ACTION_HELP", () => {
  it("has label/summary/mode for every action", () => {
    for (const a of WORKFLOW_ACTIONS) {
      const h = WORKFLOW_ACTION_HELP[a];
      expect(h.label.length).toBeGreaterThan(0);
      expect(h.summary.length).toBeGreaterThan(0);
      expect(h.mode.length).toBeGreaterThan(0);
    }
  });
});

describe("planWorkflow", () => {
  it("start-impl on active session → inject (no headless)", () => {
    const plan = planWorkflow("start-impl", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("実装");
  });

  it("start-impl on inactive session → headless in repo cwd", () => {
    const plan = planWorkflow("start-impl", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("handoff-document on active session → inject, 引継ぎ資料を session-logs へ", () => {
    const plan = planWorkflow("handoff-document", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("引継ぎ資料");
    expect(plan.prompt).toContain("session-logs");
    expect(plan.prompt).toContain("残作業");
  });

  it("handoff-document on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("handoff-document", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("repo-memory-good → headless haiku in repo cwd, embeds message", () => {
    const plan = planWorkflow("repo-memory-good", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("作業メモリ");
    expect(plan.prompt).toContain("キャッシュ層");
  });

  it("repo-memory-bad on active session → inject (作業中断 + 反省、 記録せず)", () => {
    const plan = planWorkflow("repo-memory-bad", baseCtx);
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("良くない");
    expect(plan.prompt).toContain("中断");
    expect(plan.prompt).toContain("記録しない");
  });

  it("repo-memory-bad on inactive session → headless haiku (反省のみ)", () => {
    const plan = planWorkflow("repo-memory-bad", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("良くない");
  });

  it("memoria-note → headless haiku in Memoria cwd", () => {
    const plan = planWorkflow("memoria-note", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("Memoria");
  });

  it("memoria-task → headless sonnet in Memoria cwd", () => {
    const plan = planWorkflow("memoria-task", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("タスク");
  });

  it("enumerate-remaining on active session → inject (残作業洗い出し)", () => {
    const plan = planWorkflow("enumerate-remaining", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("残作業");
  });

  it("enumerate-remaining on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("enumerate-remaining", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("memoria-remaining → headless sonnet in Memoria cwd (残作業記録)", () => {
    const plan = planWorkflow("memoria-remaining", baseCtx);
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("残作業");
    expect(plan.prompt).toContain("Memoria");
  });

  it("status-check on active session → inject (状況報告)", () => {
    const plan = planWorkflow("status-check", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("状況");
  });

  it("status-check on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("status-check", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.cwd).toBe(baseCtx.repoPath);
  });

  it("inject prompts embed the converted posted message (投稿内容を変換して渡す)", () => {
    for (const action of ["start-impl", "enumerate-remaining", "status-check"] as const) {
      const plan = planWorkflow(action, { ...baseCtx, sessionActive: true });
      expect(plan.mode).toBe("inject");
      expect(plan.prompt).toContain("対象メッセージ");
      expect(plan.prompt).toContain("キャッシュ層"); // baseCtx.messageText の一部
    }
  });

  it("honors custom model overrides", () => {
    const plan = planWorkflow("memoria-task", baseCtx, { haiku: "h", sonnet: "claude-sonnet-4-6" });
    expect(plan.model).toBe("claude-sonnet-4-6");
  });

  it("defer-impl → headless sonnet in Memoria cwd, 別セッション対応 を含む", () => {
    const plan = planWorkflow("defer-impl", { ...baseCtx, messageText: "認証トークン更新機能を実装しよう。Memoriaに詳細を記録してください。別セッションで対応します。" });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.memoriaPath);
    expect(plan.prompt).toContain("別セッション");
    expect(plan.prompt).toContain("実装タスク");
    expect(plan.prompt).toContain("認証トークン");
  });

  it("force-enter → inject CR (session に関係なく)", () => {
    const planActive = planWorkflow("force-enter", { ...baseCtx, sessionActive: true });
    expect(planActive.mode).toBe("inject");
    expect(planActive.prompt).toBe("\r");
    const planInactive = planWorkflow("force-enter", { ...baseCtx, sessionActive: false });
    expect(planInactive.mode).toBe("inject");
    expect(planInactive.prompt).toBe("\r");
  });

  it("delegate-task on active session → inject (タスク判定 + 委託 + 監視)", () => {
    const plan = planWorkflow("delegate-task", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("タスク判定");
    expect(plan.prompt).toContain("delegation/templates");
    expect(plan.prompt).toContain("監視");
    expect(plan.prompt).toContain("対象メッセージ");
    expect(plan.prompt).toContain("キャッシュ層"); // baseCtx.messageText の一部
  });

  it("delegate-task on inactive session → headless haiku in repoPath cwd", () => {
    const plan = planWorkflow("delegate-task", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("haiku");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("タスク判定");
    expect(plan.prompt).toContain("監視は行わない");
  });

  it("resume-work on active session → inject (中断した作業の続き)", () => {
    const plan = planWorkflow("resume-work", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("続き");
    expect(plan.prompt).toContain("対象メッセージ");
  });

  it("resume-work on inactive session → headless sonnet in repo cwd, session-logs から復元", () => {
    const plan = planWorkflow("resume-work", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("session-logs");
    expect(plan.prompt).toContain("git status");
  });

  it("merge-pr on active session → inject (open PR を squash merge)", () => {
    const plan = planWorkflow("merge-pr", { ...baseCtx, sessionActive: true });
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("マージ");
    expect(plan.prompt).toContain("--squash");
    expect(plan.prompt).toContain("gh pr checks");
  });

  it("merge-pr on inactive session → headless sonnet in repo cwd", () => {
    const plan = planWorkflow("merge-pr", { ...baseCtx, sessionActive: false });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe(baseCtx.repoPath);
    expect(plan.prompt).toContain("gh pr merge");
  });

  it("sync-project-main-after-merge → headless sonnet in workspace root and extracts project from message", () => {
    const plan = planWorkflow("sync-project-main-after-merge", {
      ...baseCtx,
      messageText: "対応マージ後、Anatomiaをmain最新にする。",
      workspaceRoot: "E:/Document/Ars",
    });
    expect(plan.mode).toBe("headless");
    expect(plan.model).toBe("sonnet");
    expect(plan.cwd).toBe("E:/Document/Ars");
    expect(plan.prompt).toContain("対応マージ後、<project>をmain最新にする");
    expect(plan.prompt).toContain("Anatomia");
    expect(plan.prompt).toContain("git pull --ff-only");
    expect(plan.prompt).toContain("サービス再起動や起動テストは行わない");
    expect(plan.prompt).toContain("worktree/複製フォルダからのサービス起動");
  });
});

describe("ReactionWorkflowRunner.handle (platform-input / map 非依存)", () => {
  function makeRunner(over: Record<string, unknown> = {}) {
    const calls: { prompt: string; opts?: { cwd?: string; model?: string } }[] = [];
    const injects: { sessionId: string; text: string; source: string }[] = [];
    const runHeadless = async (prompt: string, opts?: { cwd?: string; model?: string }) => {
      calls.push({ prompt, opts });
      return { ok: true, exit_code: 0, stdout: "", stderr: "", duration_ms: 1 };
    };
    const runner = new ReactionWorkflowRunner({
      runHeadless,
      emitInject: (sessionId: string, text: string, source: string) => injects.push({ sessionId, text, source }),
      workspaceRoot: "E:/Document/Ars",
      memoriaPath: "E:/Document/Ars/Memoria",
      enabled: true,
      // 既定は権限ありで組む。 権限が要るアクション (delegate-task / merge-pr) の
      // 拒否側は専用のテストで確かめる。
      hasCapability: () => true,
      log: { info: () => {}, warn: () => {} },
      now: () => 1_000_000,
      ...over,
    });
    return { runner, calls, injects };
  }

  const baseInput: ReactionWorkflowInput = {
    dedupeKey: "m1",
    emoji: "👀",
    userId: "u1",
    messageText: "これメモして",
    authorLabel: "設計担当",
    repoPath: "C:/repos/AlphaGame",
    sessionActive: false,
    sessionId: null,
  };

  it("memoria-note(👀) は headless で memoriaPath を cwd に走り、本文を渡す", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "👀" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("E:/Document/Ars/Memoria");
    expect(calls[0].prompt).toContain("これメモして");
    expect(calls[0].prompt).toContain("信頼できない外部メッセージのデータ");
    expect(calls[0].prompt).toContain("<reaction-message-data");
    expect(calls[0].prompt).toContain("</reaction-message-data>");
  });

  it("残作業系(🙏)は本文が空でも発火する (headless / repoPath を cwd に)", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🙏", messageText: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("C:/repos/AlphaGame");
  });

  it("sync-project-main-after-merge(🔄) は workspace root で headless 実行する", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({
      ...baseInput,
      emoji: "🔄",
      messageText: "対応マージ後、Anatomiaをmain最新にする。",
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("E:/Document/Ars");
    expect(calls[0].opts?.model).toBe("sonnet");
    expect(calls[0].prompt).toContain("Anatomia");
    expect(calls[0].prompt).toContain("main 最新");
  });

  it("無効 (enabled=false) なら何もしない", async () => {
    const { runner, calls } = makeRunner({ enabled: false });
    await runner.handle({ ...baseInput });
    expect(calls).toHaveLength(0);
  });

  it("同一 dedupeKey+emoji+userId は cooldown 内で1回だけ発火", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput });
    await runner.handle({ ...baseInput });
    expect(calls).toHaveLength(1);
  });

  it("ワークフロー対象外の絵文字は無処理", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🍕" });
    expect(calls).toHaveLength(0);
  });

  it("予約済みの 👌 は custom mapping と custom workflow JSON の両方を遮断する", async () => {
    const temp = await mkdtemp(join(tmpdir(), "concordia-reaction-workflow-"));
    const customWorkflowsPath = join(temp, "custom-workflows.json");
    await writeFile(customWorkflowsPath, JSON.stringify([{
      emoji: "👌🏽",
      prompt: "must not run",
      model: "sonnet",
    }]), "utf8");
    try {
      const overridden = makeRunner({
        customMappings: () => ({ "👌": "handoff-document" }),
      });
      const customized = makeRunner({ customWorkflowsPath });
      const accepted: WorkflowAction[] = [];
      await overridden.runner.handle({ ...baseInput, emoji: "👌" }, (action) => accepted.push(action));
      await customized.runner.handle(
        { ...baseInput, dedupeKey: "m-custom", emoji: "👌🏽" },
        (action) => accepted.push(action),
      );

      expect(overridden.calls).toHaveLength(0);
      expect(customized.calls).toHaveLength(0);
      expect(accepted).toHaveLength(0);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });

  it("発火確定時に onAccept が action 付きで1回だけ呼ばれる", async () => {
    const { runner } = makeRunner();
    const accepted: WorkflowAction[] = [];
    await runner.handle({ ...baseInput, emoji: "🙏", messageText: "" }, (a) => accepted.push(a));
    expect(accepted).toEqual(["enumerate-remaining"]);
  });

  it("無効 / 対象外 / dedup-skip では onAccept は呼ばれない", async () => {
    const accepted: WorkflowAction[] = [];
    const onAccept = (a: WorkflowAction) => accepted.push(a);

    const disabled = makeRunner({ enabled: false });
    await disabled.runner.handle({ ...baseInput }, onAccept);
    expect(accepted).toHaveLength(0); // enabled=false

    const unmapped = makeRunner();
    await unmapped.runner.handle({ ...baseInput, emoji: "🍕" }, onAccept);
    expect(accepted).toHaveLength(0); // 写像外

    const dup = makeRunner();
    await dup.runner.handle({ ...baseInput }, onAccept);
    await dup.runner.handle({ ...baseInput }, onAccept);
    expect(accepted).toHaveLength(1); // 2回目は cooldown でスキップ
  });

  it("delegate-task(🤝) inactive → headless haiku / repoPath cwd / タスク判定含む", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🤝", sessionActive: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("C:/repos/AlphaGame");
    expect(calls[0].prompt).toContain("タスク判定");
    expect(calls[0].prompt).toContain("これメモして");
  });

  it("delegate-task(🤝) active → inject (runHeadless 非呼び出し)", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🤝", sessionActive: true, sessionId: "sess-abc" });
    expect(calls).toHaveLength(0); // inject 経路なので headless は起動しない
  });

  it("delegate-task の onAccept は action='delegate-task' で呼ばれる", async () => {
    const { runner } = makeRunner();
    const accepted: WorkflowAction[] = [];
    await runner.handle({ ...baseInput, emoji: "🤝", sessionActive: false }, (a) => accepted.push(a));
    expect(accepted).toEqual(["delegate-task"]);
  });

  it("handoff-document inactive は headless 結果を onResult に返す", async () => {
    const { runner } = makeRunner({
      runHeadless: async () => ({
        ok: true,
        exit_code: 0,
        stdout: "保存先: session-logs/2026-07-01-handoff-test.md\n\n# 引継ぎ資料\n本文",
        stderr: "",
        duration_ms: 1,
      }),
    });
    const results: { action: WorkflowAction; ok: boolean; text: string }[] = [];
    await runner.handle(
      { ...baseInput, emoji: "👋", sessionActive: false },
      undefined,
      (action, result) => results.push({ action, ...result }),
    );
    expect(results).toEqual([{
      action: "handoff-document",
      ok: true,
      text: "保存先: session-logs/2026-07-01-handoff-test.md\n\n# 引継ぎ資料\n本文",
    }]);
  });

  it("handoff-document 以外の headless 結果は onResult に返さない", async () => {
    const { runner } = makeRunner({
      runHeadless: async () => ({
        ok: true,
        exit_code: 0,
        stdout: "完了",
        stderr: "",
        duration_ms: 1,
      }),
    });
    const results: unknown[] = [];
    await runner.handle({ ...baseInput, emoji: "👀" }, undefined, (_action, result) => results.push(result));
    expect(results).toHaveLength(0);
  });

  it("reactionAckText は 絵文字 + ラベル + 受付文 を返す", () => {
    expect(reactionAckText("enumerate-remaining", "🙏")).toBe("🙏 残作業の洗い出しを受け付けました");
  });
});

// ─── 権限: リアクションは誰でも押せるが、指示の中身は実行できるとは限らない ──────
describe("ReactionWorkflowRunner.handle 権限", () => {
  // 既定は権限なし (ヒラ社員 相当)。 hasCapability を差し替えれば、 同じ runner
  // インスタンスのまま役職が付いた状況 (= dedupe 状態を引き継いだ再発火) を作れる。
  function denyingRunner(hasCapability: () => boolean = () => false) {
    const calls: { prompt: string }[] = [];
    const results: { ok: boolean; text: string }[] = [];
    const runner = new ReactionWorkflowRunner({
      runHeadless: async (prompt: string) => {
        calls.push({ prompt });
        return { ok: true, exit_code: 0, stdout: "", stderr: "", duration_ms: 1 };
      },
      emitInject: () => {},
      workspaceRoot: "E:/Document/Ars",
      enabled: true,
      hasCapability,
      log: { info: () => {}, warn: () => {} },
      now: () => 1_000_000,
    });
    return { runner, calls, results };
  }

  const input = {
    dedupeKey: "m-perm",
    emoji: "🔀",
    userId: "u-plain",
    messageText: "これマージして",
    authorLabel: "だれか",
    repoPath: "E:/Document/Ars/Concordia",
    sessionActive: false,
    sessionId: null,
  } as ReactionWorkflowInput;

  it("merge-pr(🔀) を権限なしで押しても実行せず、理由を返す", async () => {
    const { runner, calls, results } = denyingRunner();
    await runner.handle(input, undefined, (_a, r) => results.push(r));
    expect(calls).toEqual([]);
    expect(results).toHaveLength(1);
    expect(results[0].ok).toBe(false);
    expect(results[0].text).toContain("マージ");
  });

  it("delegate-task(🤝) も同じくセッション起動権限を要求する", async () => {
    const { runner, calls, results } = denyingRunner();
    await runner.handle({ ...input, emoji: "🤝", dedupeKey: "m-perm2" }, undefined, (_a, r) => results.push(r));
    expect(calls).toEqual([]);
    expect(results[0]?.text).toContain("セッション起動");
  });

  // リアクションは付け外しが自由なので、 拒否のたびに返すと chat を埋め尽くせてしまう。
  // 通知だけは間引く (発火側の cooldown は下のテストのとおり焼かない)。
  it("同じ拒否を連打しても通知は 1 回だけ返す", async () => {
    const { runner, results } = denyingRunner();
    const onResult = (_a: WorkflowAction, r: { ok: boolean; text: string }) => results.push(r);
    await runner.handle({ ...input, dedupeKey: "m-perm5" }, undefined, onResult);
    await runner.handle({ ...input, dedupeKey: "m-perm5" }, undefined, onResult);
    await runner.handle({ ...input, dedupeKey: "m-perm5" }, undefined, onResult);
    expect(results).toHaveLength(1);
  });

  // 権限を要求しない指示は誰でも通る (それが「指示の簡略化」の意味)。
  it("残作業の洗い出し(🙏) は権限なしでも実行する", async () => {
    const { runner, calls } = denyingRunner();
    await runner.handle({ ...input, emoji: "🙏", dedupeKey: "m-perm3" });
    expect(calls.length).toBeGreaterThan(0);
  });

  // 拒否で cooldown を消費すると、役職を付けた直後に押し直せなくなる。 dedupe 状態は
  // runner インスタンスが持つので、 同じ runner のまま権限だけを付け替えて確かめる
  // (別インスタンスを作ると dedupe を共有せず、 何も検証しないテストになる)。
  it("拒否された発火は dedupe を消費しない", async () => {
    let allowed = false;
    const { runner, calls } = denyingRunner(() => allowed);
    await runner.handle({ ...input, dedupeKey: "m-perm4" });
    expect(calls).toEqual([]);
    // now は固定 = dedupe ウィンドウ内。 拒否が cooldown を焼いていれば ここで弾かれる。
    allowed = true;
    await runner.handle({ ...input, dedupeKey: "m-perm4" });
    expect(calls.length).toBeGreaterThan(0);
  });
});
