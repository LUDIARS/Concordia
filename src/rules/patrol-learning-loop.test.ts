import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepo } from "../db/chat-repo.js";
import { PatrolLearningRepo } from "../db/patrol-learning-repo.js";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleVersionsRepo } from "../db/rule-versions-repo.js";
import { RulesRepo, type RuleRow } from "../db/rules-repo.js";
import { applyMigrations } from "../db/schema.js";
import { runLearningPass, type LearningLoopDeps } from "./patrol-learning-loop.js";
import { PATROL_LEARNING_JOURNAL_SOURCE, createLearningJournalSync } from "./patrol-learning-journal.js";
import type { ReviewResult } from "./review.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const CHANNEL = "1546109590930853962";
/** 実行日の翌日のローカル時刻 (秒)。 chat 行の ts は実時刻なので、 2 日の窓に収まる日にする。 */
const TOMORROW = new Date(Date.now() + 86400_000);
const at = (h: number, m = 0) =>
  Math.floor(new Date(TOMORROW.getFullYear(), TOMORROW.getMonth(), TOMORROW.getDate(), h, m).getTime() / 1000);

const EXTRACT = JSON.stringify({ genres: ["game"], sentiment: "positive", request: "もっとゲームの話", tone: null });
const PROPOSAL = JSON.stringify({
  summary: "ゲームに寄せる", prefer_genres: ["game"], prefer_ratio: 0.8, learned_instructions: "新作ゲームは具体名を挙げる",
});

function setup(opts: { runner?: LearningLoopDeps["runner"]; validate?: (rule: RuleRow) => ReviewResult; learning?: boolean } = {}) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const rules = new RulesRepo(db);
  const chat = new ChatRepo(db);
  const conversations = new RuleConversationsRepo(db);
  const versions = new RuleVersionsRepo(db);
  const repo = new PatrolLearningRepo(db);
  const rule = rules.insert({
    id: "glab", description: "d", trigger_type: "tick", tick_sec: 1800, event_kind: null, conditions: "[]",
    instructions: "短く", target: "chitchat", cooldown_sec: 1800, added_by: "human", enabled: true,
    config_version: 2, execution_mode: "patrol",
    action_config: JSON.stringify({
      kind: "material-chat", source_ids: ["tendentia-public-trends"], scope_key: "public", discord_channel_id: CHANNEL,
      ...(opts.learning === false ? { learning: { enabled: false } } : {}),
    }),
  });
  const clock = { sec: at(3) };
  const runner = vi.fn(opts.runner ?? (async (prompt: string) => ({
    ok: true, stderr: "", stdout: prompt.includes("取り出す係") ? EXTRACT : PROPOSAL,
  })));
  let seq = 0;
  const deps: LearningLoopDeps = {
    repo, rules, versions, reactions: { reactorsByMessage: () => ({ distinct: 2, fine: 2, bad: 0 }) },
    runner,
    validate: (r) => opts.validate?.(r) ?? { ok: true },
    inherit: () => null,
    ruleForChannel: (id) => (id === CHANNEL ? rules.find("glab") : null),
    nowMs: () => clock.sec * 1000,
    newId: () => `run-${++seq}`,
  };
  /** 巡回の投稿 + 人間の返信 1 件 + 返信でない会話 1 件。 */
  const conversation = (n: number) => {
    const root = chat.insert({ channel: "chitchat", session_id: null, author_label: "噂坂 聞 (巡回)", text: "話題", in_reply_to: null, is_actionable: false, metadata: JSON.stringify({ source: "patrol", patrol_discord_channel_id: CHANNEL }) });
    conversations.open({ conversation_id: `c${n}`, rule_id: "glab", rule_revision: 1, root_chat_id: root.id, channel: "chitchat", scope_key: "public", source_ref: null, expires_at: clock.sec + 60, now: clock.sec });
    const reply = chat.insert({ channel: "chitchat", session_id: null, author_label: "部員", text: `秘密の本文 ${n}`, in_reply_to: root.id, is_actionable: false, metadata: JSON.stringify({ source: "discord", discord_user_id: "u1", patrol_discord_channel_id: CHANNEL }) });
    conversations.recordInbound(reply.id, `c${n}`, clock.sec);
    chat.insert({ channel: "chitchat", session_id: null, author_label: "部員", text: `雑談 ${n}`, in_reply_to: null, is_actionable: false, metadata: JSON.stringify({ source: "discord", discord_user_id: "u2", patrol_discord_channel_id: CHANNEL }) });
  };
  return { db, rules, versions, repo, conversations, deps, clock, runner, conversation, rule };
}

describe("patrol learning fragments", () => {
  it("makes fragments from replies and non-reply channel talk without keeping the text", async () => {
    const h = setup();
    h.conversation(1);
    const r = await runLearningPass(h.deps);
    expect(r.messageFragments).toBe(2);
    const fragments = h.repo.recentFragments("glab");
    expect(fragments).toHaveLength(2);
    expect(fragments.every((f) => f.status === "ok" && !String(f.signal).includes("本文") && !String(f.signal).includes("雑談"))).toBe(true);
    expect(JSON.parse(fragments[0].signal!)).toMatchObject({ genres: ["game"], request: "もっとゲームの話" });
    // 同じ発言は 2 度抽出しない
    await runLearningPass(h.deps);
    expect(h.runner).toHaveBeenCalledTimes(2);
  });

  it("adds a deterministic fragment when a conversation closes", async () => {
    const h = setup();
    h.conversation(1);
    h.conversations.closeExpired(h.clock.sec + 120);
    const r = await runLearningPass(h.deps);
    expect(r.conversationFragments).toBe(1);
    const conv = h.repo.recentFragments("glab").find((f) => f.kind === "conversation")!;
    expect(JSON.parse(conv.signal!)).toEqual({ replies: 0, followups: 0, reactors: 2, fine: 2, bad: 0 });
  });

  it("skips extraction for rules with learning turned off", async () => {
    const h = setup({ learning: false });
    h.conversation(1);
    await runLearningPass(h.deps);
    expect(h.runner).not.toHaveBeenCalled();
    expect(h.repo.recentFragments("glab").every((f) => f.status === "failed")).toBe(true);
  });
});

describe("daily learning (auto-applied)", () => {
  async function withFragments(h: ReturnType<typeof setup>) {
    h.conversation(1);
    h.conversation(2);
    await runLearningPass(h.deps);
    await runLearningPass(h.deps);
  }

  it("waits until 04:00, then applies once per day as a new version by learning", async () => {
    const h = setup();
    await withFragments(h);
    expect((await runLearningPass(h.deps)).learned).toBeNull(); // 03:00
    h.clock.sec = at(4, 5);
    const r = await runLearningPass(h.deps);
    expect(r.learned).toMatchObject({ ruleId: "glab", status: "applied" });
    const rule = h.rules.find("glab")!;
    expect(rule.revision).toBe(2);
    const config = JSON.parse(rule.action_config!);
    expect(config.filters).toMatchObject({ prefer_genres: ["game"], prefer_ratio: 0.8 });
    expect(config.learned.instructions).toBe("新作ゲームは具体名を挙げる");
    expect(config.discord_channel_id).toBe(CHANNEL);
    expect(h.versions.list("glab").map((v) => v.actor)).toContain("learning");
    expect(h.repo.unconsumed("glab")).toHaveLength(0);
    const again = await runLearningPass(h.deps);
    expect(again.learned).toBeNull();
    expect(h.repo.listRuns("glab")).toHaveLength(1);
  });

  it("puts the day's learning into the Memoria diary once, and resends after a failure", async () => {
    const h = setup();
    await withFragments(h);
    const put = vi.fn(async () => ({ ok: false as const, kind: "unknown" as const, error: "down" }));
    h.deps.journal = createLearningJournalSync({ repo: h.repo, journal: { putDiarySection: put } });
    h.clock.sec = at(4, 5);
    await runLearningPass(h.deps);
    expect(put).toHaveBeenCalledTimes(1);
    const [day, source, body] = put.mock.calls[0] as unknown as [string, string, { title: string; markdown: string }];
    expect(source).toBe(PATROL_LEARNING_JOURNAL_SOURCE);
    expect(body.title).toBe(`巡回チャットの学習 (${day})`);
    expect(body.markdown).toContain("### glab — 反映した");
    expect(body.markdown).toContain("優先するジャンル: game");
    // 学習に使った会話 (返信と返信先の投稿) も載る。 発言者の名前は載らない
    expect(body.markdown).toContain("発言 「秘密の本文 1」 ← 返信先 「話題」");
    expect(body.markdown).toContain("発言 「雑談 2」");
    expect(body.markdown).not.toContain("部員");
    expect(h.repo.sourcesForRun(h.repo.listRuns("glab")[0].run_id)).toHaveLength(4);
    // 届かなかったので次の pass でもう一度送る。 届いたら同じ内容は送らない
    put.mockResolvedValue({ ok: true, value: {} } as never);
    await runLearningPass(h.deps);
    await runLearningPass(h.deps);
    expect(put).toHaveBeenCalledTimes(2);
  });

  it("skips the day with too few fragments", async () => {
    const h = setup();
    h.conversation(1);
    await runLearningPass(h.deps);
    h.clock.sec = at(5);
    const r = await runLearningPass(h.deps);
    expect(r.learned).toMatchObject({ status: "skipped" });
    expect(h.rules.find("glab")!.revision).toBe(1);
  });

  it("rejects proposals that fail validation and keeps the rule", async () => {
    const h = setup({ validate: () => ({ ok: false, reason: "bad" }) });
    await withFragments(h);
    h.clock.sec = at(5);
    expect((await runLearningPass(h.deps)).learned).toMatchObject({ status: "rejected", reason: "bad" });
    expect(h.rules.find("glab")!.revision).toBe(1);
  });

  it("rejects an unreadable proposal", async () => {
    const h = setup({
      runner: async (prompt) => ({ ok: true, stderr: "", stdout: prompt.includes("取り出す係") ? EXTRACT : "変えません" }),
    });
    await withFragments(h);
    h.clock.sec = at(5);
    expect((await runLearningPass(h.deps)).learned).toMatchObject({ status: "rejected", reason: "unparsable proposal" });
  });
});
