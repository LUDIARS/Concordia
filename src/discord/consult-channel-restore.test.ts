import { describe, expect, it, vi } from "vitest";
import { ChannelType, OverwriteType, type Guild } from "discord.js";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { restoreConsultChannel, restoredTranscriptPosts } from "./consult-channel-restore.js";

function setup(status: "open" | "closed" = "closed") {
  const db = makeTestDb();
  const store = new PrivateConsultationsRepo(db);
  const consultation = store.create({
    subsidiary_id: "sub-1", department_id: "dept_qa", requester_user_id: "111", status: "pending_approval", intake_json: "{}",
  }, Date.UTC(2026, 9, 4));
  store.setChannel(consultation.id, "old-chan");
  store.setSession(consultation.id, "sess-1");
  store.addMember({ consultation_id: consultation.id, platform_user_id: "111", reason: "requester", added_by: "111" });
  store.addMember({ consultation_id: consultation.id, platform_user_id: "900", reason: "approver", added_by: "111" });
  store.addMember({ consultation_id: consultation.id, platform_user_id: "777", reason: "invited", added_by: "111" });
  store.removeMember(consultation.id, "777");
  store.markOpen(consultation.id, "111");
  if (status === "closed") store.markClosed(consultation.id);
  store.markChannelDeleted(consultation.id);

  const sent: Array<Record<string, unknown>> = [];
  const lockEdits: string[] = [];
  const created: Array<Record<string, unknown>> = [];
  const overwrites = new Map<string, { id: string; type: OverwriteType }>();
  const channel = {
    id: "new-chan",
    type: ChannelType.GuildText,
    guild: null as unknown,
    send: vi.fn(async (message: Record<string, unknown>) => { sent.push(message); }),
    permissionOverwrites: {
      cache: overwrites,
      edit: vi.fn(async (id: string) => { lockEdits.push(id); }),
    },
  };
  const order: string[] = [];
  channel.send = vi.fn(async (message: Record<string, unknown>) => { sent.push(message); order.push("send"); });
  channel.permissionOverwrites.edit = vi.fn(async (id: string) => { lockEdits.push(id); order.push("lock"); });
  const guild = {
    id: "guild-1",
    client: { user: { id: "bot-1" } },
    members: { me: { id: "bot-1" } },
    roles: { everyone: { id: "everyone-role" } },
    channels: {
      cache: { find: () => undefined },
      fetch: vi.fn(async (id: string) => (id === "new-chan" ? channel : null)),
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        if (input.type === ChannelType.GuildCategory) return { id: "cat-1", type: ChannelType.GuildCategory };
        for (const o of input.permissionOverwrites as Array<{ id: string; type: OverwriteType }>) overwrites.set(o.id, o);
        return channel;
      }),
    },
  } as unknown as Guild;
  channel.guild = guild;
  const sessionMessages = {
    list: vi.fn(() => [
      { author_type: "user", author_platform: "discord", content: "評価の伝え方は?", metadata: null },
      { author_type: "assistant", author_platform: null, content: "途中の発言", metadata: null },
      { author_type: "assistant", author_platform: null, content: "事実から伝える", metadata: { phase: "final_answer" } },
    ]),
  };
  let categoryId: string | null = null;
  const deps = {
    guild,
    store,
    categoryStore: { categoryId: () => categoryId, setCategoryId: (id: string) => { categoryId = id; } },
    sessionMessages: sessionMessages as never,
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { deps, store, id: consultation.id, sent, created, lockEdits, order };
}

describe("restoreConsultChannel", () => {
  it("rebuilds a deleted channel for the remaining members, re-posts the conversation and re-offers the buttons", async () => {
    const h = setup();
    await expect(restoreConsultChannel(h.deps, h.id)).resolves.toBe("restored");
    const text = h.created.find((c) => c.type === ChannelType.GuildText)!;
    expect(text.name).toBe(`相談-20261004-${h.id.slice(3, 9)}`);
    expect((text.permissionOverwrites as Array<{ id: string }>).map((o) => o.id)).toEqual(["everyone-role", "111", "900", "bot-1"]);
    expect(h.store.find(h.id)).toMatchObject({ channel_id: "new-chan", channel_deleted_at: null });
    // 終了済みなので削除前と同じく書き込みを止める (Bot 以外の member overwrite)。
    expect(h.lockEdits).toEqual(["111", "900"]);
    const contents = h.sent.map((m) => String(m.content));
    expect(contents.join("\n")).toContain("評価の伝え方は?");
    expect(contents.join("\n")).toContain("事実から伝える");
    expect(contents.join("\n")).not.toContain("途中の発言");
    expect(h.sent.at(-1)?.components).toBeDefined();
    // 中身を先に入れ、書き込みの停止は最後 (止まっても中身は残る)。
    expect(h.order.indexOf("lock")).toBeGreaterThan(h.order.lastIndexOf("send"));
  });

  it("re-posts the content into an already rebuilt channel (repost) and refuses a missing channel", async () => {
    const h = setup();
    await expect(restoreConsultChannel(h.deps, h.id, "repost")).resolves.toBe("channel_missing");
    await restoreConsultChannel(h.deps, h.id);
    const before = h.sent.length;
    await expect(restoreConsultChannel(h.deps, h.id, "repost")).resolves.toBe("reposted");
    expect(h.created.filter((c) => c.type === ChannelType.GuildText)).toHaveLength(1);
    expect(h.sent.slice(before).map((m) => String(m.content)).join("\n")).toContain("事実から伝える");
  });

  it("does nothing for a consultation whose channel was not deleted or does not exist", async () => {
    const h = setup();
    await restoreConsultChannel(h.deps, h.id);
    await expect(restoreConsultChannel(h.deps, h.id)).resolves.toBe("not_deleted");
    await expect(restoreConsultChannel(h.deps, "pc_missing")).resolves.toBe("not_found");
  });

  it("splits a long conversation into posts within Discord's limit", () => {
    const posts = restoredTranscriptPosts([{ role: "user", text: "a".repeat(4000) }, { role: "assistant", text: "b" }]);
    expect(posts.every((post) => post.length <= 1800)).toBe(true);
    expect(posts.join("")).toContain("**回答**");
  });
});
