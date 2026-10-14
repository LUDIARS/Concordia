import { join } from "node:path";
import type { ChatInputCommandInteraction } from "discord.js";
import { describe, expect, it, vi } from "vitest";
import type { PrivateConsultationRow } from "../db/private-consultations-repo.js";
import {
  DRIVE_NOT_CONFIGURED_TEXT,
  formatSessionNotice,
  formatSyncSummary,
  handleConsultFiles,
  handleConsultFilesSync,
  type ConsultDriveDeps,
} from "./consult-drive.js";

const consultation = { id: "pc_1", requester_user_id: "11111", session_id: "sess-1", status: "open" } as PrivateConsultationRow;

function interaction(options: { userId?: string; email?: string; channelId?: string } = {}) {
  const reply = vi.fn(async () => undefined);
  const deferReply = vi.fn(async () => undefined);
  const editReply = vi.fn(async () => undefined);
  const followUp = vi.fn(async () => undefined);
  const value = {
    channelId: options.channelId ?? "chan-1",
    user: { id: options.userId ?? "11111", displayName: "相談者" },
    options: { getString: () => options.email ?? "me@example.com" },
    reply, deferReply, editReply, followUp,
  } as unknown as ChatInputCommandInteraction;
  return { value, reply, deferReply, editReply, followUp };
}

function deps(overrides: Partial<ConsultDriveDeps> = {}): ConsultDriveDeps {
  return {
    findByChannel: (channelId) => (channelId === "chan-1" ? consultation : null),
    open: vi.fn(async () => ({ ok: true as const, folderUrl: "https://drive/f", created: true })),
    sync: vi.fn(async () => ({ ok: true as const, folderUrl: "https://drive/f", imported: [], delivered: [], skipped: [] })),
    notifySession: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("handleConsultFiles", () => {
  it("shares the folder and posts its link to the channel without the email address", async () => {
    const ctx = interaction();
    const d = deps();
    await handleConsultFiles(ctx.value, d);
    expect(d.open).toHaveBeenCalledWith({ consultationId: "pc_1", actorUserId: "11111", email: "me@example.com" });
    const posted = (ctx.followUp.mock.calls[0] as unknown as [{ content: string }])[0].content;
    expect(posted).toContain("https://drive/f");
    expect(posted).not.toContain("me@example.com");
  });

  it("tells the channel that the transfer is not configured", async () => {
    const ctx = interaction();
    await handleConsultFiles(ctx.value, deps({ open: vi.fn(async () => ({ ok: false as const, error: "drive_not_configured" })) }));
    expect(ctx.followUp).toHaveBeenCalledWith(expect.objectContaining({ content: DRIVE_NOT_CONFIGURED_TEXT }));
  });

  it("answers other failures only to the operator", async () => {
    const ctx = interaction({ userId: "22222" });
    await handleConsultFiles(ctx.value, deps({ open: vi.fn(async () => ({ ok: false as const, error: "not_requester" })) }));
    expect(ctx.followUp).not.toHaveBeenCalled();
    expect(ctx.editReply).toHaveBeenCalledWith({ content: "フォルダの共有は相談者本人だけが行えます。" });
  });

  it("refuses outside a consultation channel", async () => {
    const ctx = interaction({ channelId: "other" });
    const d = deps();
    await handleConsultFiles(ctx.value, d);
    expect(ctx.reply).toHaveBeenCalledWith(expect.objectContaining({ ephemeral: true }));
    expect(d.open).not.toHaveBeenCalled();
  });
});

describe("handleConsultFilesSync", () => {
  it("posts the summary and tells the running session where the files are", async () => {
    const path = join("C:", "Consult", "designer", "11111", "transfer", "incoming", "chara.fbx");
    const ctx = interaction();
    const d = deps({
      sync: vi.fn(async () => ({
        ok: true as const, folderUrl: "https://drive/f",
        imported: [{ name: "chara.fbx", path, kind: "model" as const }], delivered: [{ name: "mix.wav", kind: "audio" as const }], skipped: [],
      })),
    });
    await handleConsultFilesSync(ctx.value, d);
    const edited = (ctx.editReply.mock.calls[0] as unknown as [{ content: string; allowedMentions: unknown }])[0];
    expect(edited.content).toContain("chara.fbx");
    expect(edited.content).toContain("<@11111> 回答のファイル");
    expect(edited.allowedMentions).toEqual({ users: ["11111"] });
    expect(d.notifySession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "sess-1", actorUserId: "11111" }));
    const text = (vi.mocked(d.notifySession!).mock.calls[0]![0]).text;
    expect(text).toContain(path);
    expect(text).toContain(join("C:", "Consult", "designer", "11111", "transfer", "outgoing"));
  });

  it("does not notify when nothing was imported and shows the failure reason", async () => {
    const ctx = interaction();
    const d = deps({ sync: vi.fn(async () => ({ ok: false as const, error: "drive_not_configured" })) });
    await handleConsultFilesSync(ctx.value, d);
    expect(ctx.editReply).toHaveBeenCalledWith(expect.objectContaining({ content: DRIVE_NOT_CONFIGURED_TEXT }));
    expect(d.notifySession).not.toHaveBeenCalled();
  });
});

describe("formatSyncSummary / formatSessionNotice", () => {
  it("lists skipped files with a readable reason and fits Discord's limit", () => {
    const text = formatSyncSummary({
      folderUrl: "https://drive/f", imported: [], delivered: [],
      skipped: [{ name: "a.txt", direction: "incoming", reason: "unsupported_type" }, { name: "b.wav", direction: "incoming", reason: "already_exists" }],
    }, "11111");
    expect(text).toContain("a.txt (3D モデル・音声以外)");
    expect(text).toContain("b.wav (同じ名前が取り込み済み)");
    const long = formatSyncSummary({
      folderUrl: "https://drive/f", delivered: [], skipped: [],
      imported: Array.from({ length: 300 }, (_, i) => ({ name: `file-${i}.wav`, path: "x", kind: "audio" as const })),
    }, "11111");
    expect(long.length).toBeLessThanOrEqual(2000);
  });

  it("names the kind of each imported file", () => {
    expect(formatSessionNotice([{ name: "a.wav", path: join("d", "transfer", "incoming", "a.wav"), kind: "audio" }])).toContain("- 音声:");
  });
});
