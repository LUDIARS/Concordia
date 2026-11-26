import Database from "better-sqlite3";
import { ChannelType, Collection, type Guild, type Message } from "discord.js";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { teamDiscussionConversationMigration } from "../db/team-discussion-conversation-migration.js";
import { discussionFacilitator, type DiscussionRunner } from "../team-discussion-conversation/conversation.js";
import { DISCUSSION_QUIET_MS, parseDiscussionDecision } from "../team-discussion-conversation/policy.js";
import { DiscussionFacilitationRepository } from "../team-discussion-conversation/repository.js";
import { readTeamDiscussionHistory } from "./team-discussion-history.js";
import { discordDiscussionDelivery, discussionPostOptions } from "./team-discussion-delivery.js";
import { collectTeamMessage } from "./team-discussion.js";

const firstAt = 1_800_000_000_000;
const surface = { id: "ideas", parentId: "category", type: ChannelType.GuildText, isThread: () => false };
const state = (db: Database.Database) => db.prepare(
  "SELECT state, current_summary, delivered_through, evaluated_through, receipt_ids FROM team_discussion_facilitation",
).get();
const diff = { ok: true, stdout: JSON.stringify({ has_diff: true, summary: "追加案", current_summary: "移動と追加案" }) };
const noDiff = { ok: true, stdout: '{"has_diff":false,"summary":""}' };
let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  db.exec(`
    CREATE TABLE teams(id TEXT PRIMARY KEY, subsidiary_id TEXT, discord_category_id TEXT);
    CREATE TABLE team_surfaces(team_id TEXT, channel_id TEXT, surface TEXT);
    CREATE TABLE team_discussion_messages(team_id TEXT, channel_id TEXT, message_id TEXT, author_id TEXT, content TEXT,
      revision INTEGER, PRIMARY KEY(team_id, message_id));
    INSERT INTO teams VALUES ('team',NULL,'category'),('other','sub','other-category');
    INSERT INTO team_surfaces VALUES ('team','ideas','企画相談'),('other','other-ideas','企画相談');
  `);
  teamDiscussionConversationMigration.up(db);
});
afterEach(() => db.close());

type MessageOverrides = Partial<Pick<Message, "editedTimestamp" | "channel" | "author" | "webhookId" | "system">>;

function message(id: string, createdTimestamp = firstAt, overrides: MessageOverrides = {}): Message {
  return { id, createdTimestamp, guildId: "guild", channel: surface, inGuild: () => true,
    author: { id: "human" }, content: `post ${id}`, ...overrides } as unknown as Message;
}

function setup() {
  let now = firstAt + DISCUSSION_QUIET_MS;
  let recovered = true;
  const ownsTeam = (id: string) => id === "team";
  const run = vi.fn<DiscussionRunner>().mockResolvedValue(diff);
  const deliver = vi.fn().mockResolvedValue({ id: "discord-1", last: true });
  const repo = new DiscussionFacilitationRepository(db, "guild", null);
  const newWorker = () => discussionFacilitator({
    repo, ownsTeam, historyReady: () => recovered, now: () => now,
    run, deliver, warn: vi.fn(),
  });
  return { run, deliver, newWorker, setNow: (value: number) => { now = value; },
    setRecovered: (value: boolean) => { recovered = value; },
    collect: (input: Message) => collectTeamMessage(db, ownsTeam, input) };
}

it("waits five minutes from the latest human post, claims once and publishes once", async () => {
  const h = setup();
  const worker = h.newWorker();
  h.collect(message("9"));
  h.collect(message("10", firstAt + 1000));
  h.setNow(firstAt + 1000 + DISCUSSION_QUIET_MS - 1);
  await worker.tick();
  expect(h.run).not.toHaveBeenCalled();
  h.setNow(firstAt + 1000 + DISCUSSION_QUIET_MS);
  await Promise.all([worker.tick(), worker.tick()]);
  expect(h.run).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/"id":"9".*"id":"10"/),
    expect.objectContaining({ conversationOnly: true, recordPrompt: false }));
  expect(h.deliver).not.toHaveBeenCalled();
  await worker.tick();
  expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channelId: "ideas", through: "10", delta: "追加案", part: 0 }),
    expect.any(AbortSignal));
  expect(state(db)).toEqual({ state: "done", current_summary: "移動と追加案", delivered_through: "10",
    evaluated_through: "10", receipt_ids: '["discord-1"]' });
  h.collect(message("10", firstAt + 1000, { editedTimestamp: firstAt + 90_000 }));
  await worker.stop();
  await h.newWorker().tick();
  expect(h.run).toHaveBeenCalledTimes(1);
  expect(h.deliver).toHaveBeenCalledTimes(1);
});

it("waits for history and evaluates recovered posts together in the original public thread", async () => {
  const h = setup();
  h.setRecovered(false);
  const worker = h.newWorker();
  const thread = { id: "topic", parent: surface, parentId: "ideas", type: ChannelType.PublicThread, isThread: () => true,
    messages: { fetch: vi.fn().mockResolvedValue(new Map()) } };
  thread.messages.fetch.mockResolvedValue(new Map([
    ["9", message("9", firstAt, { channel: thread as unknown as Message["channel"] })],
    ["8", message("8", firstAt, { channel: thread as unknown as Message["channel"] })],
  ]));
  const text = { ...surface, messages: { fetch: vi.fn().mockResolvedValue(new Map()) },
    threads: { fetchActive: async () => ({ threads: new Map([["topic", thread]]) }),
      fetchArchived: async () => ({ threads: new Collection(), hasMore: false }) } };
  await readTeamDiscussionHistory(db, { channels: { fetch: async () => text } } as unknown as Guild, "team", () => false);
  await worker.tick();
  expect(h.run).not.toHaveBeenCalled();
  h.setRecovered(true);
  await worker.tick();
  await worker.tick();
  expect(h.run).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/"id":"8".*"id":"9"/), expect.anything());
  expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ channelId: "topic", surfaceId: "ideas", through: "9" }),
    expect.anything());
});

it("evaluates a no-diff range once and keeps the last delivered checkpoint for later discussion", async () => {
  const h = setup();
  const worker = h.newWorker();
  h.collect(message("1"));
  await worker.tick();
  await worker.tick();
  h.run.mockResolvedValueOnce(noDiff);
  h.collect(message("2"));
  await worker.tick();
  await worker.tick();
  expect(state(db)).toMatchObject({ state: "done", current_summary: "移動と追加案", delivered_through: "1", evaluated_through: "2" });
  expect(h.deliver).toHaveBeenCalledTimes(1);
  h.collect(message("3"));
  await worker.tick();
  const [prompt] = h.run.mock.calls[2]!;
  expect(prompt).toContain('"current_summary":"移動と追加案","posts":[{"id":"3"');
  expect(h.run).toHaveBeenCalledTimes(3);
});

it("excludes bots, webhooks, system posts, private threads and channels owned by another runtime", async () => {
  const h = setup();
  const privateThread = { ...surface, type: ChannelType.PrivateThread, parent: surface, isThread: () => true };
  for (const [index, override] of [
    { author: { id: "bot", bot: true } }, { webhookId: "webhook" }, { system: true },
    { channel: privateThread }, { channel: { ...surface, id: "other-ideas", parentId: "other-category" } },
  ].entries()) {
    expect(h.collect(message(String(index), firstAt, override as MessageOverrides))).toBe(false);
  }
  expect(collectTeamMessage(db, id => id === "other", message("100", firstAt, {
    channel: { ...surface, id: "other-ideas", parentId: "other-category" } as unknown as Message["channel"],
  }))).toBe(true);
  await h.newWorker().tick();
  expect(h.run).not.toHaveBeenCalled();
});

it.each([
  { ok: false, stdout: diff.stdout },
  { ok: true, stdout: 'not JSON' },
])("preserves the checkpoint after unsuccessful generation", async result => {
  const h = setup();
  const worker = h.newWorker();
  h.collect(message("1"));
  await worker.tick();
  await worker.tick();
  h.collect(message("2"));
  h.run.mockResolvedValueOnce(result);
  await worker.tick();
  await worker.tick();
  expect(h.run).toHaveBeenCalledTimes(2);
  expect(h.deliver).toHaveBeenCalledTimes(1);
  expect(state(db)).toMatchObject({ state: "failed", current_summary: "移動と追加案", delivered_through: "1", evaluated_through: "1" });
  h.collect(message("3"));
  await worker.tick();
  expect(h.run.mock.calls[2]?.[0]).toMatch(/"id":"2".*"id":"3"/);
});

it("validates the decision structure and reports no delta for ambiguous output", () => {
  for (const stdout of ['[]', 'null', '{"has_diff":"true","summary":"added"}', '{"has_diff":true,"summary":"added"}',
    '{"has_diff":false,"summary":"unexpected"}', '{"has_diff":true,"summary":" ","current_summary":"overview"}']) {
    expect(parseDiscussionDecision(stdout, true)).toBeNull();
  }
});

it("keeps a partially sent result unconfirmed and does not retry an uncertain send", async () => {
  const h = setup();
  const worker = h.newWorker();
  h.collect(message("1"));
  h.deliver.mockResolvedValueOnce({ id: "first-part", last: false }).mockRejectedValueOnce(new Error("transport timeout"));
  await worker.tick();
  await worker.tick();
  expect(state(db)).toMatchObject({ state: "ready", current_summary: "", delivered_through: "", receipt_ids: '["first-part"]' });
  await worker.tick();
  await worker.stop();
  h.collect(message("2"));
  await h.newWorker().tick();
  expect(h.deliver).toHaveBeenCalledTimes(2);
  expect(state(db)).toMatchObject({ state: "unknown", current_summary: "", delivered_through: "", receipt_ids: '["first-part"]' });
});

it("saves interrupted generation and preserves an acknowledged send during graceful shutdown", async () => {
  const h = setup();
  const worker = h.newWorker();
  h.collect(message("1"));
  h.run.mockImplementationOnce(async (_prompt, options) => {
    await new Promise<void>(resolve => options.signal.addEventListener("abort", () => resolve(), { once: true }));
    return diff;
  });
  const interrupted = worker.tick();
  await worker.stop();
  await interrupted;
  expect(state(db)).toMatchObject({ state: "failed", delivered_through: "" });
  const resumed = h.newWorker();
  h.collect(message("2"));
  await resumed.tick();
  let confirmSend!: () => void;
  h.deliver.mockImplementationOnce(() => new Promise(resolve => {
    confirmSend = () => resolve({ id: "stop-receipt", last: true });
  }));
  const sending = resumed.tick();
  const stopping = resumed.stop();
  confirmSend();
  await Promise.all([sending, stopping]);
  expect(state(db)).toMatchObject({ state: "done", delivered_through: "2", receipt_ids: '["stop-receipt"]' });
});

it.each([["running", "failed"], ["sending", "unknown"]])("recovers %s as %s without duplicate work", async (from, expected) => {
  const h = setup();
  h.collect(message("1"));
  db.prepare(`INSERT INTO team_discussion_facilitation(guild_id, team_id, channel_id, surface_id, attempt_through, state)
    VALUES ('guild','team','ideas','ideas','1',?)`).run(from);
  await h.newWorker().tick();
  expect(state(db)).toMatchObject({ state: expected, delivered_through: "" });
  expect(h.run).not.toHaveBeenCalled();
  expect(h.deliver).not.toHaveBeenCalled();
});

it("sends only to the validated channel, splits at 2000 characters and suppresses mentions", async () => {
  const send = vi.fn().mockResolvedValue({ id: "discord-id" });
  const guild = { channels: { fetch: vi.fn().mockResolvedValue({ ...surface, isSendable: () => true, send }) } } as unknown as Guild;
  const adapter = discordDiscussionDelivery({ guild, ownerOf: () => "team", ownsTeam: id => id === "team" });
  const delta = "@everyone" + "案".repeat(2050);
  const job = { teamId: "team", channelId: "ideas", surfaceId: "ideas", through: "1", delta };
  const { signal } = new AbortController();
  expect(await adapter({ ...job, part: 0 }, signal)).toEqual({ id: "discord-id", last: false });
  expect(await adapter({ ...job, part: 1 }, signal)).toEqual({ id: "discord-id", last: true });
  expect(send.mock.calls.map(([options]) => options.content).join("")).toBe(delta);
  const first = discussionPostOptions(job.channelId, job.through, 0, delta.slice(0, 2000));
  expect(send.mock.calls[0]?.[0]).toEqual(first);
  expect(first.allowedMentions).toEqual({ parse: [] });
  expect(first.nonce).not.toEqual(send.mock.calls[1]?.[0].nonce);
});
