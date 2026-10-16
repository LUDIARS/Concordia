import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatRepo } from "../db/chat-repo.js";
import { makeChatMessageReactionsRepo, makeDiscordMessageMapRepo } from "../db/discord-repo.js";
import { RuleConversationsRepo } from "../db/rule-conversations-repo.js";
import { RuleRunsRepo } from "../db/rule-runs-repo.js";
import { RuleServiceEventsRepo } from "../db/rule-service-events-repo.js";
import { RulesRepo, type RuleRow } from "../db/rules-repo.js";
import { applyMigrations } from "../db/schema.js";
import { MaterialSourceRegistry } from "./material-registry.js";
import { MaterialSourceError, type Material, type MaterialSource } from "./material-types.js";
import { parseActionConfig } from "./patrol-config.js";
import { PATROL_RETRY_AFTER_FAILURE_SEC, retryDelaySec, runPatrolCycle } from "./patrol-cycle.js";
import { acceptInbound } from "./patrol-inbound.js";
import { reconcileDeliveries, recoverStaleRuns } from "./patrol-maintenance.js";
import { DELIVERY_UNKNOWN_AFTER_SEC, PATROL_LEASE_SEC, type PatrolPorts } from "./patrol-ports.js";
import type { RenderInput, RenderResult } from "./render-patrol.js";

const open: Database.Database[] = [];
afterEach(() => { for (const db of open.splice(0)) db.close(); });

const T0 = Date.parse("2026-10-15T12:00:00Z");

function material(id: string): Material {
  return {
    sourceId: "fake", itemId: id, version: `${id}:1`, kind: "trend", serviceCode: "Td", featureKey: "tech",
    occurredAt: new Date(T0 - 60_000).toISOString(), observedAt: new Date(T0).toISOString(),
    title: `topic ${id}`, excerpt: "e", url: `https://example.com/${id}`, scopeKey: "public", shareableTo: ["*"], tags: ["tech"],
  };
}

function harness(opts: {
  items?: Material[];
  sourceError?: MaterialSourceError;
  render?: (i: RenderInput) => Promise<RenderResult>;
  quietHours?: { start: string; end: string };
  owners?: PatrolPorts["owners"];
} = {}) {
  const db = new Database(":memory:");
  open.push(db);
  applyMigrations(db);
  const chat = new ChatRepo(db);
  const rules = new RulesRepo(db);
  const runs = new RuleRunsRepo(db);
  const conversations = new RuleConversationsRepo(db);
  const events = new RuleServiceEventsRepo(db);
  const reactions = makeChatMessageReactionsRepo(db);
  const messageMap = makeDiscordMessageMapRepo(db);
  const source: MaterialSource = {
    list: vi.fn(async () => {
      if (opts.sourceError) throw opts.sourceError;
      const items = opts.items ?? [material("a"), material("b")];
      return { items, cursor: null, observedAt: new Date(T0).toISOString(), status: items.length ? "ready" as const : "empty" as const };
    }),
  };
  const sources = new MaterialSourceRegistry([
    { sourceId: "fake", label: "fake", kind: "trend", serviceCode: "Td", scopes: ["*"], unavailable: null, source },
  ]);
  const clock = { ms: T0 };
  const posted: number[] = [];
  const render = vi.fn(opts.render ?? (async (i: RenderInput): Promise<RenderResult> => ({
    ok: true, text: `[${i.kind}] ${i.material?.title ?? ""}`, persona: i.persona ?? "噂坂 聞", llmCalls: 1,
  })));
  let disabled = false;
  let seq = 0;
  const ports: PatrolPorts = {
    ...(opts.owners ? { owners: opts.owners } : {}),
    rules, runs, conversations, events, sources,
    chat: {
      insert: (input) => chat.insert({
        channel: input.channel as "chitchat", session_id: null, author_label: input.author_label ?? "巡回チャット", text: input.text,
        in_reply_to: input.in_reply_to, is_actionable: false, metadata: JSON.stringify(input.metadata),
      }),
      findById: (id) => chat.findById(id),
      countHumanAfter: (channel, afterId, externalChannelId) => chat.countHumanAfter(channel, afterId, externalChannelId),
    },
    reactions,
    delivery: { findExternalId: (id) => messageMap.findDiscordId(id) },
    render,
    emitChatPosted: (msg) => posted.push(msg.id),
    runtimeDisabled: () => disabled,
    nowMs: () => clock.ms,
    random: () => 0.5,
    newId: () => `id-${++seq}`,
    leaseOwner: "owner-test",
  };
  const rule = rules.insert({
    id: "patrol", description: "d", trigger_type: "tick", tick_sec: 600, event_kind: null, conditions: "[]",
    instructions: "短く", target: "chitchat", cooldown_sec: 60, added_by: "human", enabled: true,
    config_version: 2, execution_mode: "patrol",
    action_config: JSON.stringify({
      kind: "material-chat", source_ids: ["fake"], scope_key: "hq",
      followup: { min_wait_sec: 600, reaction_threshold: 2, later_message_threshold: 2 },
      // 実行環境のタイムゾーンで既定の時間帯に入らないよう、 時間帯の検証は専用のテストで行う
      quiet_hours: opts.quietHours ?? null,
    }),
  });
  const humanPost = (text: string, inReplyTo: number | null, user = "u1") =>
    chat.insert({
      channel: "chitchat", session_id: null, author_label: "human", text, in_reply_to: inReplyTo, is_actionable: false,
      metadata: JSON.stringify({ source: "discord", discord_user_id: user, discord_message_id: `d-${text}` }),
    });
  const current = (): RuleRow => rules.find("patrol")!;
  /** 次の定期期日まで時間を進めて 1 周期回す。 */
  const tick = async () => {
    await runPatrolCycle(ports, current(), { frequency: 1 }); // 初回は期日を決めるだけ
    clock.ms = (current().next_due_at! + 1) * 1000;
    return runPatrolCycle(ports, current(), { frequency: 1 });
  };
  return {
    db, chat, rules, runs, conversations, events, reactions, messageMap, source, sources, ports, clock, posted, render, rule,
    humanPost, current, tick, setDisabled: (v: boolean) => { disabled = v; },
  };
}

describe("patrol pick (CC-PATROL-01/02/03)", () => {
  it("does not fire on first sight, then posts one short message with its source and opens a conversation", async () => {
    const h = harness();
    const first = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(first.kind).toBe("idle");
    expect(h.current().next_due_at).toBeGreaterThan(T0 / 1000);
    const outcome = await h.tick();
    expect(outcome).toMatchObject({ kind: "acted", action: "pick", outcome: { status: "posted" } });
    const [run] = h.runs.list({ rule_id: "patrol" }).runs;
    expect(run).toMatchObject({ status: "delivery_pending", action_kind: "pick", rule_revision: 1, seed: expect.any(Number) });
    expect(JSON.parse(run.decision!).candidateCount).toBe(2);
    expect(h.posted).toEqual([run.chat_message_id]);
    const msg = h.chat.findById(run.chat_message_id!)!;
    expect(JSON.parse(msg.metadata!)).toMatchObject({ source: "patrol", rule_id: "patrol", run_id: run.run_id });
    expect(h.conversations.findByBotMessage(msg.id)?.root_chat_id).toBe(msg.id);
    expect(h.render).toHaveBeenCalledTimes(1);
    expect(h.current().last_posted_at).not.toBeNull();
  });

  it("marks a post for an individually specified Discord channel", async () => {
    const h = harness();
    h.rules.updateWithRevision("patrol", 1, {
      action_config: JSON.stringify({
        kind: "material-chat", source_ids: ["fake"], scope_key: "public", discord_channel_id: "1546109590930853962",
      }),
    });
    await h.tick();
    const [run] = h.runs.list({}).runs;
    const msg = h.chat.findById(run.chat_message_id!)!;
    expect(JSON.parse(msg.metadata!)).toMatchObject({
      source: "patrol", patrol_discord_channel_id: "1546109590930853962", webhook_username: "噂坂 聞 (巡回)",
    });
  });

  it("posts under the generated name and keeps it in the run", async () => {
    const h = harness();
    await h.tick();
    const [run] = h.runs.list({}).runs;
    expect(h.render.mock.calls[0][0].persona).toBeNull();
    expect(JSON.parse(run.decision!)).toMatchObject({ persona: "噂坂 聞", candidateCount: 2 });
    const msg = h.chat.findById(run.chat_message_id!)!;
    expect(msg.author_label).toBe("噂坂 聞 (巡回)");
    expect(JSON.parse(msg.metadata!)).toMatchObject({ patrol_persona: "噂坂 聞", webhook_username: "噂坂 聞 (巡回)" });
  });

  it("does not post twice for the same due time", async () => {
    const h = harness();
    await h.tick();
    // 期日を同じ値へ戻しても trigger_key が同じなので再受理しない。
    const due = h.runs.list({}).runs[0].trigger_key.split(":").pop()!;
    h.rules.setNextDue("patrol", Number(due));
    const again = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(again).toMatchObject({ kind: "acted", outcome: { status: "duplicate" } });
    expect(h.posted).toHaveLength(1);
  });

  it("records no-material and source errors as separate states without posting (CC-PATROL-09)", async () => {
    const empty = harness({ items: [] });
    await empty.tick();
    expect(empty.runs.list({}).runs[0]).toMatchObject({ status: "skipped", reason: "no material" });
    const broken = harness({ sourceError: new MaterialSourceError("auth", "403") });
    await broken.tick();
    expect(broken.runs.list({}).runs[0]).toMatchObject({ status: "failed", error_code: "source_error:auth" });
    expect(broken.sources.statuses()[0].lastError).toMatch(/auth/);
    expect(empty.posted).toHaveLength(0);
    expect(broken.posted).toHaveLength(0);
  });

  it("keeps the render failure as failed and does not fall back silently", async () => {
    const h = harness({ render: async () => ({ ok: false, error: "render failed: timeout", llmCalls: 1 }) });
    await h.tick();
    expect(h.runs.list({}).runs[0]).toMatchObject({ status: "failed", error_code: "render_failed", llm_calls: 1 });
    expect(h.posted).toHaveLength(0);
  });

  it("retries a failed render after a short wait instead of the whole interval", async () => {
    let fail = true;
    const h = harness({
      render: async (i) => fail
        ? { ok: false, error: "render failed: claude -p failed", llmCalls: 1 }
        : { ok: true, text: `[${i.kind}] ${i.material?.title ?? ""}`, persona: "噂坂 聞", llmCalls: 1 },
    });
    h.db.prepare("UPDATE rules SET tick_sec = 10800 WHERE id = 'patrol'").run();
    await h.tick();
    const failedAt = Math.floor(h.clock.ms / 1000);
    expect(h.current().next_due_at).toBe(failedAt + PATROL_RETRY_AFTER_FAILURE_SEC);
    fail = false;
    h.clock.ms = (h.current().next_due_at! + 1) * 1000;
    const r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "pick", outcome: { status: "posted" } });
    // 成功したら通常の間隔に戻る
    expect(h.current().next_due_at! - Math.floor(h.clock.ms / 1000)).toBeGreaterThan(PATROL_RETRY_AFTER_FAILURE_SEC);
  });

  it("doubles the wait while failures continue, capped at the interval (usage limit lasts hours)", async () => {
    const h = harness({ render: async () => ({ ok: false, error: "render failed: stdout: usage limit", llmCalls: 1 }) });
    h.db.prepare("UPDATE rules SET tick_sec = 10800 WHERE id = 'patrol'").run();
    await h.tick();
    const waits: number[] = [];
    for (let i = 0; i < 2; i += 1) {
      waits.push(h.current().next_due_at! - Math.floor(h.clock.ms / 1000));
      h.clock.ms = (h.current().next_due_at! + 1) * 1000;
      await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    }
    expect(waits).toEqual([900, 1800]);
    expect([1, 2, 3, 4, 5, 9].map((n) => retryDelaySec(n, 10800))).toEqual([900, 1800, 3600, 7200, 10800, 10800]);
    expect(retryDelaySec(1, 600)).toBe(600);
  });

  it("stops before sending when the rule is disabled during rendering (CC-PATROL-06/08)", async () => {
    let h!: ReturnType<typeof harness>;
    h = harness({
      render: async () => {
        h.rules.toggle("patrol", false);
        return { ok: true, text: "生成済み", persona: "噂坂 聞", llmCalls: 1 };
      },
    });
    await h.tick();
    const [run] = h.runs.list({}).runs;
    expect(run).toMatchObject({ status: "skipped", rendered_text: "生成済み", chat_message_id: null });
    expect(h.chat.list({})).toHaveLength(0);
  });

  it("does not start when runtime is disabled and advances the due time", async () => {
    const h = harness();
    h.setDisabled(true);
    const r = await h.tick();
    expect(r.kind).toBe("stopped");
    expect(h.runs.list({}).runs).toHaveLength(0);
    expect(h.current().next_due_at! * 1000).toBeGreaterThan(h.clock.ms);
  });
});

describe("patrol replies and followups (CC-PATROL-04/07)", () => {
  async function posted() {
    const h = harness();
    await h.tick();
    const root = h.runs.list({}).runs[0].chat_message_id!;
    return { h, root };
  }

  it("answers a direct human reply once, without waiting for the tick", async () => {
    const { h, root } = await posted();
    const reply = h.humanPost("それ気になる", root);
    expect(acceptInbound(h.ports, reply.id)).toMatchObject({ accepted: true });
    expect(acceptInbound(h.ports, reply.id)).toMatchObject({ accepted: false, reason: "already received" });
    const r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "reply", outcome: { status: "posted" } });
    const replyRun = h.runs.list({}).runs[0];
    expect(h.chat.findById(replyRun.chat_message_id!)!.in_reply_to).toBe(reply.id);
    expect(h.render.mock.calls.at(-1)![0]).toMatchObject({ kind: "reply", replies: ["それ気になる"], persona: "噂坂 聞" });
    // 会話の人格も引き継ぐ (最初の投稿で seed から選んだもの)
    const rootCharacter = h.render.mock.calls[0][0].character;
    expect(rootCharacter).toBeTruthy();
    expect(h.render.mock.calls.at(-1)![0].character).toEqual(rootCharacter);
    expect(h.chat.findById(replyRun.chat_message_id!)!.author_label).toBe("噂坂 聞 (巡回)");
    // 同じ返信へ二度応答しない。
    const again = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(again.kind).toBe("idle");
  });

  it("ignores its own output, bots and other destinations as replies", async () => {
    const { h, root } = await posted();
    const own = h.chat.insert({
      channel: "chitchat", session_id: null, author_label: "巡回チャット", text: "self", in_reply_to: root,
      is_actionable: false, metadata: JSON.stringify({ source: "patrol" }),
    });
    expect(acceptInbound(h.ports, own.id)).toMatchObject({ accepted: false, reason: "not a human message" });
    const sessionBot = h.chat.insert({ channel: "chitchat", session_id: "s1", author_label: "claude", text: "ai", in_reply_to: root, is_actionable: false });
    expect(acceptInbound(h.ports, sessionBot.id).accepted).toBe(false);
    const elsewhere = h.chat.insert({
      channel: "ぼやき", session_id: null, author_label: "human", text: "x", in_reply_to: root, is_actionable: false,
      metadata: JSON.stringify({ source: "discord", discord_user_id: "u1" }),
    });
    expect(acceptInbound(h.ports, elsewhere.id)).toMatchObject({ accepted: false, reason: "different destination" });
  });

  it("follows up once when distinct reactors pass the threshold after the wait", async () => {
    const { h, root } = await posted();
    h.reactions.add({ message_id: root, discord_user_id: "u1", kind: "fine" });
    h.reactions.add({ message_id: root, discord_user_id: "u1", kind: "raw:🔥" });
    h.clock.ms += 700_000;
    let r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    // 同じ人の 2 つの絵文字は 1 人として数える。
    expect(r.kind === "acted" && r.action).not.toBe("followup");
    h.reactions.add({ message_id: root, discord_user_id: "u2", kind: "fine" });
    r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "followup", outcome: { status: "posted" } });
    h.clock.ms += 700_000;
    const conv = h.conversations.findByBotMessage(root)!;
    expect(conv.unprompted_count).toBe(1);
    const followupRuns = h.runs.list({}).runs.filter((x) => x.action_kind === "followup");
    expect(followupRuns).toHaveLength(1);
  });

  it("counts later human posts but not its own or bot posts", async () => {
    const { h, root } = await posted();
    h.chat.insert({ channel: "chitchat", session_id: "s", author_label: "ai", text: "bot", in_reply_to: null, is_actionable: false });
    h.humanPost("one", null, "u1");
    h.clock.ms += 700_000;
    let r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r.kind === "acted" && r.action).not.toBe("followup");
    h.humanPost("two", null, "u2");
    r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "followup" });
    expect(root).toBeGreaterThan(0);
  });
});

describe("patrol quiet hours", () => {
  /** T0 のローカル時刻を含む 2 時間の時間帯 (実行環境のタイムゾーンに依らない)。 */
  function windowAroundT0(): { start: string; end: string } {
    const d = new Date(T0);
    const hhmm = (h: number) => `${String((h + 24) % 24).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return { start: hhmm(d.getHours() - 1), end: hhmm(d.getHours() + 1) };
  }

  it("does not post new topics inside the window but still answers replies", async () => {
    // 時間帯なしで 1 件投稿して会話を開く
    const h = harness();
    await h.tick();
    const root = h.runs.list({}).runs[0].chat_message_id!;
    h.rules.updateWithRevision("patrol", 1, {
      action_config: JSON.stringify({ kind: "material-chat", source_ids: ["fake"], scope_key: "hq", quiet_hours: windowAroundT0() }),
    });
    // 定期の期日が来ても新規投稿しない
    h.rules.setNextDue("patrol", Math.floor(h.clock.ms / 1000));
    const held = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(held).toEqual({ kind: "idle", reason: "quiet hours (新規投稿しない時間帯)" });
    expect(h.runs.list({}).runs.filter((r) => r.action_kind === "pick")).toHaveLength(1);
    // 返信には応える
    const reply = h.humanPost("夜だけど気になる", root);
    expect(acceptInbound(h.ports, reply.id)).toMatchObject({ accepted: true });
    const answered = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(answered).toMatchObject({ kind: "acted", action: "reply", outcome: { status: "posted" } });
  });

  it("has no window for head-office rules and inherits the owner's window otherwise", () => {
    // 本社は時間帯なし、 GLab / VOB は子会社の既定値で 22:00〜09:30 (neco 2026-10-15)。
    const raw = { kind: "material-chat", source_ids: ["fake"], scope_key: "public" };
    const hq = parseActionConfig(raw);
    expect(hq.ok && hq.config.quiet_hours).toBeNull();
    const sub = parseActionConfig(raw, { quiet_hours: { start: "22:00", end: "09:30" } });
    expect(sub.ok && sub.config.quiet_hours).toEqual({ start: "22:00", end: "09:30" });
    const own = parseActionConfig({ ...raw, quiet_hours: null }, { quiet_hours: { start: "22:00", end: "09:30" } });
    expect(own.ok && own.config.quiet_hours).toBeNull();
  });
});

describe("patrol individual channel replies", () => {
  const GLAB_CHANNEL = "1546109590930853962";

  async function externalPost() {
    const h = harness();
    h.rules.updateWithRevision("patrol", 1, {
      action_config: JSON.stringify({
        kind: "material-chat", source_ids: ["fake"], scope_key: "public", discord_channel_id: GLAB_CHANNEL, quiet_hours: null,
        followup: { min_wait_sec: 600, reaction_threshold: 2, later_message_threshold: 2 },
      }),
    });
    await h.tick();
    const root = h.runs.list({}).runs[0].chat_message_id!;
    const channelPost = (text: string, inReplyTo: number | null, user = "g1") => h.chat.insert({
      channel: "chitchat", session_id: null, author_label: "部員", text, in_reply_to: inReplyTo, is_actionable: false,
      metadata: JSON.stringify({ source: "discord", discord_user_id: user, discord_message_id: `g-${text}`, patrol_discord_channel_id: GLAB_CHANNEL }),
    });
    return { h, root, channelPost };
  }

  it("answers a reply received in the individual channel", async () => {
    const { h, root, channelPost } = await externalPost();
    const reply = channelPost("それ気になる", root);
    expect(acceptInbound(h.ports, reply.id)).toMatchObject({ accepted: true });
    const r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "reply", outcome: { status: "posted" } });
    const answer = h.chat.findById(h.runs.list({}).runs[0].chat_message_id!)!;
    expect(JSON.parse(answer.metadata!)).toMatchObject({ patrol_discord_channel_id: GLAB_CHANNEL });
  });

  it("does not mix HQ and individual-channel messages in replies or follow-up counts", async () => {
    const { h, root } = await externalPost();
    // 本社の発言は、 個別チャンネルの会話への返信として受けない
    const hqReply = h.humanPost("本社から", root);
    expect(acceptInbound(h.ports, hqReply.id)).toMatchObject({ accepted: false, reason: "different destination" });
    // 本社の雑談がいくら続いても、 個別チャンネルの投稿へ追投稿しない
    h.humanPost("one", null, "u1");
    h.humanPost("two", null, "u2");
    h.humanPost("three", null, "u3");
    h.clock.ms += 700_000;
    const r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r.kind === "acted" && r.action).not.toBe("followup");
    expect(h.chat.countHumanAfter("chitchat", root, GLAB_CHANNEL)).toBe(0);
    expect(h.chat.countHumanAfter("chitchat", root, null)).toBe(4);
  });
});

describe("patrol rules owned by a subsidiary", () => {
  const SUB = "sub-glab";
  function owned(defaults: Record<string, unknown>, active = true) {
    const h = harness({ owners: { defaults: () => defaults as never, active: () => active } });
    h.db.prepare(`UPDATE rules SET subsidiary_id = ?, action_config = ? WHERE id = 'patrol'`).run(SUB, JSON.stringify({
      kind: "material-chat", source_ids: ["fake"], scope_key: "public",
      followup: { min_wait_sec: 600, reaction_threshold: 2, later_message_threshold: 2 },
    }));
    return h;
  }

  it("inherits the owner's persona hint and channel, and tags the post with the owner", async () => {
    const h = owned({ persona_hint: "学校らしく", discord_channel_id: "1546109590930853962" });
    await h.tick();
    expect(h.render.mock.calls[0][0]).toMatchObject({ personaHint: "学校らしく" });
    const msg = h.chat.findById(h.runs.list({}).runs[0].chat_message_id!)!;
    expect(JSON.parse(msg.metadata!)).toMatchObject({ patrol_subsidiary_id: SUB, patrol_discord_channel_id: "1546109590930853962" });
  });

  it("stops while the owner is paused or disabled", async () => {
    const paused = owned({ paused: true });
    expect(await paused.tick()).toMatchObject({ kind: "stopped", reason: "owner subsidiary paused" });
    const disabled = owned({}, false);
    expect(await disabled.tick()).toMatchObject({ kind: "stopped", reason: "owner subsidiary disabled" });
    expect(paused.render).not.toHaveBeenCalled();
  });

  it("holds new posts in the owner's quiet window", async () => {
    const d = new Date(T0);
    const hhmm = (h: number) => `${String((h + 24) % 24).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    const h = owned({ quiet_hours: { start: hhmm(d.getHours() - 1), end: hhmm(d.getHours() + 1) } });
    expect(await h.tick()).toEqual({ kind: "idle", reason: "quiet hours (新規投稿しない時間帯)" });
  });
});

describe("patrol service events", () => {
  it("posts a short report for a matching event once", async () => {
    const h = harness();
    h.rules.updateWithRevision("patrol", 1, {
      trigger_type: "event", tick_sec: null, event_kind: "service.event",
      action_config: JSON.stringify({ kind: "material-chat", source_ids: [], scope_key: "hq", renderer: "template", filters: { service_codes: ["Mm"] }, quiet_hours: null }),
    });
    h.events.receive({ source_event_id: "x:1", service_code: "Mm", feature_key: null, event_kind: "release", title: "Memoria 1.2", summary: "s", url: null, scope_key: "hq", occurred_at: 1 }, 1);
    h.events.receive({ source_event_id: "x:2", service_code: "Ac", feature_key: null, event_kind: "release", title: "other", summary: "", url: null, scope_key: "hq", occurred_at: 1 }, 1);
    const r = await runPatrolCycle(h.ports, h.current(), { frequency: 1 });
    expect(r).toMatchObject({ kind: "acted", action: "event", outcome: { status: "posted" } });
    expect(h.events.pending().map((e) => e.service_code)).toEqual(["Ac"]);
    expect((await runPatrolCycle(h.ports, h.current(), { frequency: 1 })).kind).toBe("idle");
  });
});

describe("patrol recovery and delivery (CC-PATROL-02/03/09)", () => {
  it("commits a stale rendered run with its saved text instead of re-rendering", async () => {
    const h = harness();
    const now = Math.floor(h.clock.ms / 1000);
    h.runs.claim({
      run_id: "stale", rule_id: "patrol", rule_revision: 1, trigger_key: "tick:patrol:1", action_kind: "pick",
      conversation_id: null, scope_key: "hq", channel: "chitchat", lease_owner: "dead", lease_until: now - 1, now: now - 200,
    });
    h.db.prepare(`UPDATE rule_runs SET status = 'rendered', rendered_text = '保存済み本文', decision = '{"persona":"拾井 種"}' WHERE run_id = 'stale'`).run();
    h.runs.claim({
      run_id: "rendering", rule_id: "patrol", rule_revision: 1, trigger_key: "tick:patrol:2", action_kind: "pick",
      conversation_id: null, scope_key: "hq", channel: "chitchat", lease_owner: "dead", lease_until: now - 1, now: now - 100,
    });
    h.db.prepare(`UPDATE rule_runs SET status = 'rendering' WHERE run_id = 'rendering'`).run();
    const report = recoverStaleRuns(h.ports);
    expect(report).toEqual({ failed: 1, committed: 1, skipped: 0 });
    expect(h.render).not.toHaveBeenCalled();
    const committed = h.runs.find("stale")!;
    expect(h.chat.findById(committed.chat_message_id!)!).toMatchObject({ text: "保存済み本文", author_label: "拾井 種 (巡回)" });
    expect(h.runs.find("rendering")).toMatchObject({ status: "failed", error_code: "render_interrupted" });
    expect(PATROL_LEASE_SEC).toBeGreaterThan(30);
  });

  it("marks delivered only from a platform record and never resends", async () => {
    const h = harness();
    await h.tick();
    const run = h.runs.list({}).runs[0];
    h.clock.ms += (DELIVERY_UNKNOWN_AFTER_SEC + 1) * 1000;
    expect(reconcileDeliveries(h.ports)).toEqual({ delivered: 0, unknown: 1 });
    expect(h.runs.find(run.run_id)!.status).toBe("delivery_unknown");
    expect(h.posted).toHaveLength(1);
    h.messageMap.put("discord-123", run.chat_message_id!);
    expect(reconcileDeliveries(h.ports)).toEqual({ delivered: 1, unknown: 0 });
    expect(h.runs.find(run.run_id)).toMatchObject({ status: "delivered", delivery_ref: "discord:discord-123" });
  });
});
