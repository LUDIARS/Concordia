import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, it, expect } from "vitest";
import type { SkillCatalogEntry } from "../skills/catalog.js";
import type { InjectionProvenance } from "../shared/injection-provenance.js";
import {
  classifyReactionWorkflow,
  defaultReactionEmojiMap,
  isReservedNonActionEmoji,
  isWorkflowAction,
  migrateBuiltinWorkflowsToSkills,
  planWorkflow,
  reactionAckText,
  ReactionWorkflowRunner,
  writeCustomWorkflows,
  WORKFLOW_ACTIONS,
  WORKFLOW_ACTION_HELP,
  type ReactionWorkflowInput,
  type RwfSkillCatalogPort,
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
    // 設計 §9.2 C-7: ドメイン情報の投稿とドメインレビューの開始。
    ["📑", "domain-report"],
    ["🪬", "domain-review"],
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
    expect(isWorkflowAction("domain-review")).toBe(true);
    expect(isWorkflowAction("nope")).toBe(false);
    expect(isWorkflowAction(123)).toBe(false);
  });

  it("語彙の一覧と組み込み写像のキーが一致する (どちらかだけ足したら落ちる)", () => {
    expect(Object.keys(defaultReactionEmojiMap()).length).toBeGreaterThan(0);
    const actionsInMap = new Set(Object.values(defaultReactionEmojiMap()));
    for (const action of WORKFLOW_ACTIONS) expect(actionsInMap.has(action)).toBe(true);
    for (const action of actionsInMap) expect(WORKFLOW_ACTIONS).toContain(action);
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

// ─── planWorkflow: 組み込み据え置きだけが本文を持つ (設計 §11.2 の 2) ──────────
describe("planWorkflow (スキル移設後の残り)", () => {
  it("force-enter → inject CR (session に関係なく)", () => {
    for (const sessionActive of [true, false]) {
      const plan = planWorkflow("force-enter", { ...baseCtx, sessionActive });
      expect(plan.mode).toBe("inject");
      expect(plan.prompt).toBe("\r");
    }
  });

  it("context は read model が使えない構成のための inject 文だけを持つ", () => {
    const plan = planWorkflow("context", baseCtx);
    expect(plan.mode).toBe("inject");
    expect(plan.prompt).toContain("コンテキスト残量");
  });

  it("スキルへ移設したアクションは組み込みプロンプトを持たない", () => {
    for (const action of [
      "start-impl", "enumerate-remaining", "memoria-remaining", "status-check",
      "repo-memory-good", "repo-memory-bad", "memoria-note", "memoria-task",
      "defer-impl", "delegate-task", "reschedule-non-goal", "run-goal-tasks",
      "handoff-document", "resume-work", "merge-pr", "sync-project-main-after-merge",
      "add-as-workflow", "domain-report", "domain-review",
    ] as const) {
      expect(planWorkflow(action, baseCtx).prompt).toBe("");
    }
  });
});

// ─── Runner ────────────────────────────────────────────────────────────────
// 移行後は「絵文字 → スキル」が実行経路なので、 スキル一覧と割り当て JSON を
// 実際に用意して回す (移設漏れがあればここで落ちる)。

const SKILL_BODIES: Record<string, string> = {
  "memoria-note": "# メモを Memoria に記録する\n投稿内容をそのまま記録する。",
  "remaining-enumerate": "# 残作業を洗い出す\n未完了の作業を列挙する。",
  "sync-main-after-merge": "# 対応マージ後に main 最新化\ngit pull --ff-only で同期する。",
  "codex-delegate": "# タスク委託\nテンプレートを選んで invoke する。",
  "handoff": "# 引継ぎ資料\nsession-logs に書き出す。",
  "domain-review": "# ドメインレビュー\nAnatomia から business-domain-view を取る。",
  "merge-clean-pr": "# PR をマージする\ngh pr merge --squash。",
  "impl": "# 実装着手\n提案をそのまま実装する。",
};

const CATALOG: SkillCatalogEntry[] = [
  entry("context-report", ["🧠"], "context", "inject", "opus", "repo"),
  entry("impl", ["👍", "🆗"], "start-impl", "inject", null, "repo"),
  entry("remaining-enumerate", ["🙏"], "enumerate-remaining", "inject", "sonnet", "repo"),
  entry("memoria-record", ["🫶", "😴", "✨"], "memoria-remaining", "headless", "sonnet", "memoria"),
  entry("pulse", ["📲", "🆙", "👆"], "status-check", "inject", "sonnet", "repo"),
  entry("repo-memory-good", ["😄", "😀", "😃", "😊", "🙂", "😁"], "repo-memory-good", "headless", "haiku", "repo"),
  entry("repo-memory-bad", ["😡", "💢", "👿", "😠", "👎"], "repo-memory-bad", "inject", "haiku", "repo"),
  entry("memoria-note", ["👀", "👁️", "👁", "👈", "📓", "✏️", "✏"], "memoria-note", "headless", "haiku", "memoria"),
  entry("memoria-task", ["📝", "🗒️", "🗒", "✅", "☑️", "✔️", "✔"], "memoria-task", "headless", "sonnet", "memoria"),
  entry("defer-impl", ["⏭️", "⏭", "📤", "🗂️", "🗂"], "defer-impl", "headless", "sonnet", "memoria"),
  entry("codex-delegate", ["🤝", "🫱"], "delegate-task", "inject", "haiku", "repo"),
  entry("reschedule-non-goal", ["📅", "🗓️", "🗓"], "reschedule-non-goal", "headless", "sonnet", "memoria"),
  entry("memoria-work", ["🎯"], "run-goal-tasks", "inject", "sonnet", "repo"),
  entry("handoff", ["👋"], "handoff-document", "inject", "sonnet", "repo"),
  entry("resume", ["▶️", "▶", "⏩", "⏯️", "⏯"], "resume-work", "inject", "sonnet", "repo"),
  entry("merge-clean-pr", ["🔀", "🚀"], "merge-pr", "inject", "sonnet", "repo"),
  entry("sync-main-after-merge", ["🔄", "🔃"], "sync-project-main-after-merge", "headless", "sonnet", "castra"),
  entry("add-as-workflow", ["🛠️", "🛠"], "add-as-workflow", "headless", "haiku", "repo"),
  {
    name: "domain-review",
    description: "ドメインレビュー。",
    path: "E:/Document/Ars/.claude/skills/domain-review/SKILL.md",
    source: "skills",
    rwf: [
      { emoji: ["📑"], action: "domain-report", args: "--report-only", mode: "headless", model: "sonnet", cwd: "repo" },
      { emoji: ["🪬"], action: "domain-review", args: null, mode: "inject", model: "opus", cwd: "repo" },
    ],
  },
];

function entry(
  name: string,
  emoji: string[],
  action: string,
  mode: "inject" | "headless",
  model: string | null,
  cwd: string | null,
): SkillCatalogEntry {
  return {
    name,
    description: `${name} のスキル。`,
    path: `E:/Document/Ars/.claude/skills/${name}/SKILL.md`,
    source: "skills",
    rwf: [{ emoji, action, args: null, mode, model, cwd }],
  };
}

const skillsPort: RwfSkillCatalogPort = {
  list: () => CATALOG,
  find: (name) => CATALOG.find((e) => e.name === name) ?? null,
  readBody: async (e) => SKILL_BODIES[e.name] ?? `# ${e.name}\n本文。`,
};

describe("ReactionWorkflowRunner.handle (絵文字 → スキル)", () => {
  let temp = "";
  let customWorkflowsPath = "";

  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "concordia-reaction-workflow-"));
    customWorkflowsPath = join(temp, "custom-reaction-workflows.json");
    // 移行そのものを通して JSON を作る = seed → 実行 が繋がっていることを確かめる。
    const seed = await migrateBuiltinWorkflowsToSkills({
      workspaceRoot: temp,
      catalog: CATALOG,
      customWorkflowsPath,
    });
    expect(seed.uncovered).toEqual([]);
  });

  afterAll(async () => {
    await rm(temp, { recursive: true, force: true });
  });

  function makeRunner(over: Record<string, unknown> = {}) {
    const calls: { prompt: string; opts?: { cwd?: string; model?: string } }[] = [];
    const injects: { sessionId: string; text: string; source: string; provenance?: InjectionProvenance }[] = [];
    const runHeadless = async (prompt: string, opts?: { cwd?: string; model?: string }) => {
      calls.push({ prompt, opts });
      return { ok: true, exit_code: 0, stdout: "", stderr: "", duration_ms: 1 };
    };
    const runner = new ReactionWorkflowRunner({
      runHeadless,
      emitInject: (sessionId, text, source, provenance) => injects.push({ sessionId, text, source, provenance }),
      workspaceRoot: "E:/Document/Ars",
      memoriaPath: "E:/Document/Ars/Memoria",
      customWorkflowsPath,
      skills: skillsPort,
      enabled: true,
      // 既定は権限ありで組む。 権限が要るアクションの拒否側は専用のテストで確かめる。
      hasCapability: () => true,
      log: { info: () => {}, warn: () => {} },
      now: () => 1_000_000,
      ...over,
    });
    return { runner, calls, injects };
  }

  const baseInput: ReactionWorkflowInput = {
    dedupeKey: "m1",
    sourceMessageId: "m1",
    emoji: "👀",
    userId: "u1",
    messageText: "これメモして",
    authorLabel: "設計担当",
    repoPath: "C:/repos/AlphaGame",
    sessionActive: false,
    sessionId: null,
  };

  it("memoria-note(👀) は headless で memoriaPath を cwd に走り、SKILL.md 本文と対象メッセージを渡す", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "👀" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("E:/Document/Ars/Memoria");
    expect(calls[0].opts?.model).toBe("haiku");
    expect(calls[0].prompt).toContain("これメモして");
    expect(calls[0].prompt).toContain("信頼できない外部メッセージのデータ");
    expect(calls[0].prompt).toContain("<reaction-message-data");
    expect(calls[0].prompt).toContain("<skill-instructions");
    expect(calls[0].prompt).toContain("メモを Memoria に記録する");
    expect(calls[0].prompt).toContain("/memoria-note");
  });

  it("異体字セレクタ付き / 無しのどちらで押しても同じスキルに着く", async () => {
    const withVs = makeRunner();
    await withVs.runner.handle({ ...baseInput, dedupeKey: "vs1", emoji: "🗒️" });
    const withoutVs = makeRunner();
    await withoutVs.runner.handle({ ...baseInput, dedupeKey: "vs2", emoji: "🗒" });
    expect(withVs.calls[0].prompt).toContain("/memoria-task");
    expect(withoutVs.calls[0].prompt).toContain("/memoria-task");
  });

  it("残作業系(🙏)は本文が空でも発火する (非 active なので headless / repoPath を cwd に)", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🙏", messageText: "" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.cwd).toBe("C:/repos/AlphaGame");
    expect(calls[0].opts?.model).toBe("sonnet");
  });

  it("sync-project-main-after-merge(🔄) は workspace root (cwd: castra) で headless 実行する", async () => {
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
    expect(calls[0].prompt).toContain("/sync-main-after-merge");
  });

  it("active セッションでは /<skill> を inject する (headless は起動しない)", async () => {
    const { runner, calls, injects } = makeRunner();
    await runner.handle({
      ...baseInput,
      platform: "discord",
      emoji: "🤝",
      sessionActive: true,
      sessionId: "sess-abc",
    });
    expect(calls).toHaveLength(0);
    expect(injects).toHaveLength(1);
    expect(injects[0].text).toContain("/codex-delegate");
    expect(injects[0].text).toContain("これメモして");
    expect(injects[0]).toMatchObject({
      sessionId: "sess-abc",
      source: "reaction-workflow",
      provenance: {
        kind: "reaction-workflow",
        action: "delegate-task",
        platform: "discord",
        emoji: "🤝",
        sourceMessageId: "m1",
        actorId: "u1",
      },
    });
  });

  it("headless では --model を必ず固定する (既定任せにしない)", async () => {
    const { runner, calls } = makeRunner();
    for (const [i, emoji] of ["👀", "🙏", "🔄", "📑"].entries()) {
      await runner.handle({ ...baseInput, dedupeKey: `model-${i}`, emoji });
    }
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.opts?.model).toBeTruthy();
  });

  it("スキル割り当てが無い絵文字は実行せず、何が足りないかを返す", async () => {
    const empty = join(temp, "empty.json");
    await writeFile(empty, "[]", "utf-8");
    const { runner, calls } = makeRunner({ customWorkflowsPath: empty });
    const results: { ok: boolean; text: string }[] = [];
    await runner.handle({ ...baseInput, dedupeKey: "no-skill", emoji: "👀" }, undefined, (_a, r) => results.push(r));
    expect(calls).toHaveLength(0);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.text).toContain("migrate-builtin");
  });

  it("スキル本文が読めない headless は実行せず理由を返す", async () => {
    const { runner, calls } = makeRunner({
      skills: { ...skillsPort, readBody: async () => null },
    });
    const results: { ok: boolean; text: string }[] = [];
    await runner.handle({ ...baseInput, dedupeKey: "no-body", emoji: "👀" }, undefined, (_a, r) => results.push(r));
    expect(calls).toHaveLength(0);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.text).toContain("memoria-note");
  });

  it("無効 (enabled=false) なら何もしない", async () => {
    const { runner, calls } = makeRunner({ enabled: false });
    await runner.handle({ ...baseInput });
    expect(calls).toHaveLength(0);
  });

  it("同一 dedupeKey+emoji+userId は cooldown 内で1回だけ発火", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, dedupeKey: "dedupe-1" });
    await runner.handle({ ...baseInput, dedupeKey: "dedupe-1" });
    expect(calls).toHaveLength(1);
  });

  it("ワークフロー対象外の絵文字は無処理", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, emoji: "🍕" });
    expect(calls).toHaveLength(0);
  });

  it("予約済みの 👌 は custom mapping と custom workflow JSON の両方を遮断する", async () => {
    const reserved = join(temp, "reserved.json");
    await writeFile(reserved, JSON.stringify([{
      emoji: "👌🏽",
      label: "x",
      prompt: "must not run",
      model: "sonnet",
    }]), "utf8");
    const overridden = makeRunner({ customMappings: () => ({ "👌": "handoff-document" }) });
    const customized = makeRunner({ customWorkflowsPath: reserved });
    const accepted: WorkflowAction[] = [];
    await overridden.runner.handle({ ...baseInput, emoji: "👌" }, (action) => accepted.push(action));
    await customized.runner.handle(
      { ...baseInput, dedupeKey: "m-custom", emoji: "👌🏽" },
      (action) => accepted.push(action),
    );
    expect(overridden.calls).toHaveLength(0);
    expect(customized.calls).toHaveLength(0);
    expect(accepted).toHaveLength(0);
  });

  it("自由プロンプトのカスタムワークフローは従来どおり動く (スキル未割り当ての絵文字)", async () => {
    const mixed = join(temp, "mixed.json");
    await writeFile(mixed, JSON.stringify([
      { emoji: "🔥", label: "custom", prompt: "自由プロンプト本文", model: "sonnet" },
    ]), "utf8");
    const { runner, calls } = makeRunner({ customWorkflowsPath: mixed });
    await runner.handle({ ...baseInput, dedupeKey: "custom-prompt", emoji: "🔥" });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).toBe("自由プロンプト本文");
  });

  it("発火確定時に onAccept が action 付きで1回だけ呼ばれる", async () => {
    const { runner } = makeRunner();
    const accepted: WorkflowAction[] = [];
    await runner.handle({ ...baseInput, dedupeKey: "accept-1", emoji: "🙏", messageText: "" }, (a) => accepted.push(a));
    expect(accepted).toEqual(["enumerate-remaining"]);
  });

  it("無効 / 対象外 / dedup-skip では onAccept は呼ばれない", async () => {
    const accepted: WorkflowAction[] = [];
    const onAccept = (a: WorkflowAction) => accepted.push(a);

    const disabled = makeRunner({ enabled: false });
    await disabled.runner.handle({ ...baseInput }, onAccept);
    expect(accepted).toHaveLength(0);

    const unmapped = makeRunner();
    await unmapped.runner.handle({ ...baseInput, emoji: "🍕" }, onAccept);
    expect(accepted).toHaveLength(0);

    const dup = makeRunner();
    await dup.runner.handle({ ...baseInput, dedupeKey: "accept-dup" }, onAccept);
    await dup.runner.handle({ ...baseInput, dedupeKey: "accept-dup" }, onAccept);
    expect(accepted).toHaveLength(1);
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
      { ...baseInput, dedupeKey: "handoff-1", emoji: "👋", sessionActive: false },
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
      runHeadless: async () => ({ ok: true, exit_code: 0, stdout: "完了", stderr: "", duration_ms: 1 }),
    });
    const results: unknown[] = [];
    await runner.handle(
      { ...baseInput, dedupeKey: "quiet-1", emoji: "👀" },
      undefined,
      (_action, result) => results.push(result),
    );
    expect(results).toHaveLength(0);
  });

  it("reactionAckText は 絵文字 + ラベル + 受付文 を返す", () => {
    expect(reactionAckText("enumerate-remaining", "🙏")).toBe("🙏 残作業の洗い出しを受け付けました");
  });

  // ─── 🧠 context: read model が先、 無ければスキル (設計 §11.1 の但し書き) ──
  it("context(🧠) は read model があればそれで答える (LLM を起動しない)", async () => {
    const { runner, calls, injects } = makeRunner({
      contextReport: async () => "占有 42% / 残量 58%",
    });
    const results: { ok: boolean; text: string }[] = [];
    await runner.handle(
      { ...baseInput, dedupeKey: "ctx-1", emoji: "🧠", sessionId: "sess-1", sessionActive: true },
      undefined,
      (_a, r) => results.push(r),
    );
    expect(calls).toHaveLength(0);
    expect(injects).toHaveLength(0);
    expect(results[0]).toEqual({ ok: true, text: "占有 42% / 残量 58%" });
  });

  it("context(🧠) は read model が無ければスキル context-report の inject へ落ちる", async () => {
    const { runner, injects } = makeRunner();
    await runner.handle({
      ...baseInput, dedupeKey: "ctx-2", emoji: "🧠", sessionId: "sess-2", sessionActive: true,
    });
    expect(injects).toHaveLength(1);
    expect(injects[0].text).toContain("/context-report");
  });

  // ─── 📑 / 🪬 の写像 (設計 §9.2 C-7) ─────────────────────────────────────
  it("📑 は headless sonnet で domain-review --report-only を回す", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, dedupeKey: "dom-1", emoji: "📑" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.model).toBe("sonnet");
    expect(calls[0].opts?.cwd).toBe("C:/repos/AlphaGame");
    expect(calls[0].prompt).toContain("/domain-review --report-only");
  });

  it("🪬 は active セッションへ inject する (model は headless 落ち時の opus)", async () => {
    const { runner, injects } = makeRunner();
    await runner.handle({
      ...baseInput, dedupeKey: "dom-2", emoji: "🪬", sessionActive: true, sessionId: "sess-dom",
    });
    expect(injects).toHaveLength(1);
    expect(injects[0].text).toContain("/domain-review");
  });

  it("🪬 は非 active なら headless opus で起動する", async () => {
    const { runner, calls } = makeRunner();
    await runner.handle({ ...baseInput, dedupeKey: "dom-3", emoji: "🪬" });
    expect(calls).toHaveLength(1);
    expect(calls[0].opts?.model).toBe("opus");
  });

  it("domain_review が OFF のプロジェクトでは 🪬 は実行せず理由を返し、📑 は動く", async () => {
    const { runner, calls } = makeRunner({ domainReviewEnabled: () => false });
    const results: { ok: boolean; text: string }[] = [];
    await runner.handle({ ...baseInput, dedupeKey: "dom-off-1", emoji: "🪬" }, undefined, (_a, r) => results.push(r));
    expect(calls).toHaveLength(0);
    expect(results[0]?.ok).toBe(false);
    expect(results[0]?.text).toContain("設定 OFF");

    await runner.handle({ ...baseInput, dedupeKey: "dom-off-2", emoji: "📑" });
    expect(calls).toHaveLength(1);
  });

  it("domain_review 列が無い環境 (unknown) では 🪬 を止めない", async () => {
    const { runner, calls } = makeRunner({ domainReviewEnabled: () => "unknown" });
    await runner.handle({ ...baseInput, dedupeKey: "dom-unknown", emoji: "🪬" });
    expect(calls).toHaveLength(1);
  });
});

// ─── 権限: リアクションは誰でも押せるが、指示の中身は実行できるとは限らない ──────
describe("ReactionWorkflowRunner.handle 権限", () => {
  let temp = "";
  let customWorkflowsPath = "";

  beforeAll(async () => {
    temp = await mkdtemp(join(tmpdir(), "concordia-reaction-perm-"));
    customWorkflowsPath = join(temp, "custom-reaction-workflows.json");
    await migrateBuiltinWorkflowsToSkills({ workspaceRoot: temp, catalog: CATALOG, customWorkflowsPath });
  });

  afterAll(async () => {
    await rm(temp, { recursive: true, force: true });
  });

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
      customWorkflowsPath,
      skills: skillsPort,
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

  it("永続 skill entry が弱い action を名乗っても組み込み絵文字の権限を迂回できない", async () => {
    await writeCustomWorkflows(customWorkflowsPath, [{
      kind: "skill",
      emoji: "🔀",
      skill: "remaining-enumerate",
      mode: "headless",
      action: "status-check",
    }]);
    try {
      const { runner, calls, results } = denyingRunner();
      await runner.handle({ ...input, dedupeKey: "m-perm-spoof" }, undefined, (_a, r) => results.push(r));
      expect(calls).toEqual([]);
      expect(results[0]?.text).toContain("マージ");
    } finally {
      await migrateBuiltinWorkflowsToSkills({ workspaceRoot: temp, catalog: CATALOG, customWorkflowsPath });
    }
  });

  it("delegate-task(🤝) も同じくセッション起動権限を要求する", async () => {
    const { runner, calls, results } = denyingRunner();
    await runner.handle({ ...input, emoji: "🤝", dedupeKey: "m-perm2" }, undefined, (_a, r) => results.push(r));
    expect(calls).toEqual([]);
    expect(results[0]?.text).toContain("セッション起動");
  });

  // リアクションは付け外しが自由なので、 拒否のたびに返すと chat を埋め尽くせてしまう。
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

  // 拒否で cooldown を消費すると、役職を付けた直後に押し直せなくなる。
  it("拒否された発火は dedupe を消費しない", async () => {
    let allowed = false;
    const { runner, calls } = denyingRunner(() => allowed);
    await runner.handle({ ...input, dedupeKey: "m-perm4" });
    expect(calls).toEqual([]);
    allowed = true;
    await runner.handle({ ...input, dedupeKey: "m-perm4" });
    expect(calls.length).toBeGreaterThan(0);
  });
});
