import { ChannelType } from "discord.js";
import type { ButtonInteraction, ChatInputCommandInteraction, ModalSubmitInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PrivateConsultationService } from "../consultation/private-consultation-service.js";
import { DepartmentsRepo } from "../db/departments-repo.js";
import { PrivateConsultationsRepo } from "../db/private-consultations-repo.js";
import { DepartmentSettingsSchema } from "../departments/settings.js";
import {
  handleConsultApproval,
  handleConsultMembership,
  handleConsultModalSubmit,
  handleConsultWrap,
  type ConsultFlowDeps,
} from "./consult-flow.js";

function setup(options: { launchers?: string[]; createFails?: boolean } = {}) {
  const db = makeTestDb();
  const departments = new DepartmentsRepo(db);
  const store = new PrivateConsultationsRepo(db);
  const department = departments.create({
    subsidiary_id: null,
    name: "技術相談課",
    slug: "tech-consulting",
    settings: DepartmentSettingsSchema.parse({ private: { enabled: true } }),
  });
  const launchers = new Set(options.launchers ?? ["900"]);
  const service = new PrivateConsultationService({
    store,
    department: (id) => departments.find(id),
    approvers: () => ["900"],
    canLaunch: (userId) => launchers.has(userId),
  });
  const sent: Array<Record<string, unknown>> = [];
  const created: Array<Record<string, unknown>> = [];
  const channel = {
    id: "chan-1",
    type: ChannelType.GuildText,
    send: vi.fn(async (message: Record<string, unknown>) => { sent.push(message); }),
    permissionOverwrites: { edit: vi.fn(async () => undefined), delete: vi.fn(async () => undefined), cache: new Map() },
  };
  let categoryId: string | null = null;
  const guild = {
    id: "guild-1",
    client: { user: { id: "bot-1" } },
    roles: { everyone: { id: "everyone-role" } },
    channels: {
      cache: { find: () => undefined },
      fetch: vi.fn(async () => null),
      create: vi.fn(async (input: Record<string, unknown>) => {
        created.push(input);
        if (input.type === ChannelType.GuildCategory) return { id: "cat-1", type: ChannelType.GuildCategory };
        if (options.createFails) throw new Error("Missing Permissions");
        return channel;
      }),
    },
  };
  const spawn = vi.fn(async () => ({ ok: true as const }));
  const deps: ConsultFlowDeps = {
    service,
    store,
    runtimeSubsidiaryId: null,
    categoryStore: { categoryId: () => categoryId, setCategoryId: (id) => { categoryId = id; } },
    spawn,
    now: () => new Date("2026-09-30T00:00:00Z"),
    log: { info: vi.fn(), warn: vi.fn() },
  };
  return { deps, store, department, guild, channel, sent, created, spawn };
}

function modal(guild: unknown, departmentId: string, userId = "111") {
  const values: Record<string, string> = { topic: "評価の伝え方", skill_level: "初級", role_title: "マネージャー", purpose: "" };
  const replies: Array<Record<string, unknown>> = [];
  const interaction = {
    customId: `consult:modal:${departmentId}`,
    guild,
    user: { id: userId, displayName: "neco" },
    fields: { getTextInputValue: (id: string) => values[id] ?? "" },
    reply: vi.fn(async (message: Record<string, unknown>) => { replies.push(message); }),
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async (message: Record<string, unknown>) => { replies.push(message); }),
  } as unknown as ModalSubmitInteraction;
  return { interaction, replies };
}

describe("handleConsultModalSubmit", () => {
  it("creates a closed channel and launches when the requester may launch", async () => {
    const ctx = setup({ launchers: ["900", "111"] });
    const { interaction, replies } = modal(ctx.guild, ctx.department.id);
    await handleConsultModalSubmit(interaction, ctx.deps);

    const channelRequest = ctx.created.find((c) => c.type === ChannelType.GuildText)!;
    expect(channelRequest.name).toMatch(/^相談-20260930-/);
    expect((channelRequest.permissionOverwrites as Array<{ id: string }>).map((o) => o.id))
      .toEqual(["everyone-role", "111", "900", "bot-1"]);
    const consultation = ctx.store.findByChannel("chan-1")!;
    expect(consultation.status).toBe("open");
    expect(ctx.spawn).toHaveBeenCalledWith(expect.objectContaining({
      channelId: "chan-1",
      guildId: "guild-1",
      intake: { topic: "評価の伝え方", skill_level: "初級", role_title: "マネージャー", purpose: "" },
    }));
    expect(ctx.sent[0]).not.toHaveProperty("components");
    expect(String(replies.at(-1)?.content)).toContain("セッションを起動しました");
  });

  it("waits for an approver when the requester cannot launch", async () => {
    const ctx = setup();
    const { interaction, replies } = modal(ctx.guild, ctx.department.id);
    await handleConsultModalSubmit(interaction, ctx.deps);
    expect(ctx.spawn).not.toHaveBeenCalled();
    expect(ctx.sent[0]).toHaveProperty("components");
    expect(String(replies.at(-1)?.content)).toContain("承認後");
  });

  it("answers only to the requester when the department refuses", async () => {
    const ctx = setup();
    const { interaction, replies } = modal(ctx.guild, "dept_missing");
    await handleConsultModalSubmit(interaction, ctx.deps);
    expect(replies[0]).toMatchObject({ ephemeral: true, content: "部署が見つかりません。" });
    expect(ctx.created).toHaveLength(0);
  });

  it("closes the consultation when the channel cannot be created", async () => {
    const ctx = setup({ createFails: true });
    const { interaction, replies } = modal(ctx.guild, ctx.department.id);
    await handleConsultModalSubmit(interaction, ctx.deps);
    expect(String(replies.at(-1)?.content)).toContain("チャンネルを作れませんでした");
    expect(ctx.spawn).not.toHaveBeenCalled();
  });
});

describe("handleConsultApproval", () => {
  it("launches after an approver with launch rights presses the button", async () => {
    const ctx = setup();
    await handleConsultModalSubmit(modal(ctx.guild, ctx.department.id).interaction, ctx.deps);
    const consultation = ctx.store.findByChannel("chan-1")!;
    const button = {
      customId: `consult:approve:${consultation.id}`,
      guild: ctx.guild,
      user: { id: "900" },
      reply: vi.fn(async () => undefined),
      update: vi.fn(async () => undefined),
      followUp: vi.fn(async () => undefined),
    } as unknown as ButtonInteraction;
    await handleConsultApproval(button, ctx.deps);
    expect(ctx.spawn).toHaveBeenCalledWith(expect.objectContaining({ channelId: "chan-1" }));
    expect(ctx.store.find(consultation.id)?.approved_by).toBe("900");
  });
});

describe("handleConsultMembership", () => {
  it("invites through the requester and rejects outsiders (CC-CONSULT-INV-02)", async () => {
    const ctx = setup({ launchers: ["900", "111"] });
    await handleConsultModalSubmit(modal(ctx.guild, ctx.department.id).interaction, ctx.deps);
    const command = (actorId: string) => {
      const replies: Array<Record<string, unknown>> = [];
      const interaction = {
        channelId: "chan-1",
        channel: ctx.channel,
        user: { id: actorId },
        options: { getUser: () => ({ id: "333", bot: false }) },
        reply: vi.fn(async (message: Record<string, unknown>) => { replies.push(message); }),
      } as unknown as ChatInputCommandInteraction;
      return { interaction, replies };
    };
    const outsider = command("555");
    await handleConsultMembership(outsider.interaction, ctx.deps, "invite");
    expect(outsider.replies[0]).toMatchObject({ ephemeral: true });
    expect(ctx.channel.permissionOverwrites.edit).not.toHaveBeenCalled();

    const requester = command("111");
    await handleConsultMembership(requester.interaction, ctx.deps, "invite");
    expect(ctx.channel.permissionOverwrites.edit).toHaveBeenCalledWith("333", expect.objectContaining({ ViewChannel: true }), expect.anything());
    expect(String(requester.replies[0]?.content)).toContain("閲覧者に加えました");
  });
});

describe("handleConsultWrap", () => {
  function wrap(ctx: ReturnType<typeof setup>, actorId: string) {
    const replies: Array<Record<string, unknown>> = [];
    const interaction = {
      channelId: "chan-1",
      user: { id: actorId, displayName: "neco" },
      reply: vi.fn(async (message: Record<string, unknown>) => { replies.push(message); }),
    } as unknown as ChatInputCommandInteraction;
    return { interaction, replies };
  }

  it("asks the running session for a proposal on behalf of the requester or an approver", async () => {
    const ctx = setup({ launchers: ["900", "111"] });
    const requestProposal = vi.fn(async () => ({ ok: true as const }));
    ctx.deps.requestProposal = requestProposal;
    await handleConsultModalSubmit(modal(ctx.guild, ctx.department.id).interaction, ctx.deps);
    const consultation = ctx.store.findByChannel("chan-1")!;

    const before = wrap(ctx, "111");
    await handleConsultWrap(before.interaction, ctx.deps);
    expect(String(before.replies[0]?.content)).toContain("動いていない");

    ctx.store.setSession(consultation.id, "sess-1");
    const outsider = wrap(ctx, "555");
    await handleConsultWrap(outsider.interaction, ctx.deps);
    expect(requestProposal).not.toHaveBeenCalled();

    const approver = wrap(ctx, "900");
    await handleConsultWrap(approver.interaction, ctx.deps);
    expect(requestProposal).toHaveBeenCalledWith({ sessionId: "sess-1", actorUserId: "900", actorLabel: "neco" });
    expect(approver.replies[0]).toMatchObject({ ephemeral: true });
  });
});
