import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordImageInjectText,
  isAllowedDiscordImageUrl,
  isDiscordImageAttachment,
  publicDiscordImageError,
  storeDiscordImages,
  type DiscordImageAttachment,
} from "./image-inbox.js";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("Discord image inbox", () => {
  it("stores a verified Discord CDN image under a generated local name", async () => {
    const root = await mkdtemp(join(tmpdir(), "cc-discord-image-test-"));
    tempRoots.push(root);
    const paths = await storeDiscordImages({
      attachments: [image()],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      inboxRoot: root,
      messageId: "message-1",
      sessionId: "session-1",
    });

    expect(paths).toEqual([join(root, "session-1-message-1-1.png")]);
    expect(await readFile(paths[0])).toEqual(PNG);
    if (process.platform !== "win32") {
      expect((await stat(root)).mode & 0o777).toBe(0o700);
      expect((await stat(paths[0])).mode & 0o777).toBe(0o600);
    }
  });

  it("stores an attachment whose type only the downloaded bytes reveal", async () => {
    const root = await temporaryRoot();
    const paths = await storeDiscordImages({
      attachments: [image({ contentType: null })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "application/octet-stream" } }),
      inboxRoot: root,
      messageId: "message-1",
      sessionId: "session-1",
    });

    expect(paths).toEqual([join(root, "session-1-message-1-1.png")]);
  });

  it("stores a Discord-proxied embed image without a declared size or filename", async () => {
    const root = await temporaryRoot();
    const paths = await storeDiscordImages({
      attachments: [image({
        contentType: null,
        name: null,
        size: null,
        url: "https://media.discordapp.net/external/token/image",
      })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      inboxRoot: root,
      messageId: "message-1",
      sessionId: "session-1",
    });

    expect(paths).toEqual([join(root, "session-1-message-1-1.png")]);
  });

  it("rejects bytes that disagree with the declared image type", async () => {
    await expect(storeDiscordImages({
      attachments: [image({ contentType: "image/gif", name: "capture.gif" })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/gif" } }),
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Content-Typeが一致しません");
  });

  it("removes images already written when a later image in the batch is rejected", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/png" } }))
      .mockResolvedValueOnce(new Response(PNG, { headers: { "content-type": "image/gif" } }));

    await expect(storeDiscordImages({
      attachments: [image(), image({ contentType: "image/gif", name: "capture.gif" })],
      fetchImpl,
      inboxRoot: root,
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Content-Typeが一致しません");
    await expect(readFile(join(root, "session-1-message-1-1.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a non-Discord download host", async () => {
    await expect(storeDiscordImages({
      attachments: [image({ url: "https://example.com/image.png" })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Discord CDN以外");
  });

  it("rejects credentials and non-standard ports on an otherwise allowed host", async () => {
    const fetchImpl = vi.fn();
    await expect(storeDiscordImages({
      attachments: [image({ url: "https://user@cdn.discordapp.com:4443/attachments/1/2/capture.png" })],
      fetchImpl,
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Discord CDN以外");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects credentialed and non-standard-port Discord URLs", () => {
    expect(isAllowedDiscordImageUrl("https://user:x@cdn.discordapp.com/image.png")).toBe(false);
    expect(isAllowedDiscordImageUrl("https://cdn.discordapp.com:8443/image.png")).toBe(false);
    expect(isAllowedDiscordImageUrl("https://cdn.discordapp.com/image.png")).toBe(true);
  });

  it("rejects an invalid declared attachment size", async () => {
    await expect(storeDiscordImages({
      attachments: [image({ size: Number.NaN })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("画像サイズが不正です");
  });

  it("recognizes supported and unsupported image candidates before validation", () => {
    expect(isDiscordImageAttachment(image({ contentType: null, name: "capture.PNG" }))).toBe(true);
    expect(isDiscordImageAttachment(image({ contentType: "image/svg+xml", name: "capture.svg" }))).toBe(true);
    expect(isDiscordImageAttachment(image({ contentType: null, name: "notes.txt" }))).toBe(false);
  });

  it("rejects a declared unsupported image before downloading it", async () => {
    const fetchImpl = vi.fn();
    await expect(storeDiscordImages({
      attachments: [image({ contentType: "image/svg+xml", name: "capture.svg" })],
      fetchImpl,
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("対応していない画像形式");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not expose unexpected local errors to Discord users", () => {
    expect(publicDiscordImageError(new Error("EACCES: C:\\private\\inbox")))
      .toBe("画像の取得または保存中に内部エラーが発生しました");
  });

  if (process.platform !== "win32") {
    it("rejects a symbolic-link inbox", async () => {
      const parent = await temporaryRoot();
      const actual = join(parent, "actual");
      const inbox = join(parent, "inbox");
      await mkdir(actual);
      await symlink(actual, inbox, "dir");

      await expect(storeDiscordImages({
        attachments: [image()],
        fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
        inboxRoot: inbox,
        messageId: "message-1",
        sessionId: "session-1",
      })).rejects.toThrow("画像保存先を安全に準備できませんでした");
    });
  }

  it("builds a usable instruction for an image-only message", () => {
    expect(buildDiscordImageInjectText("", ["C:\\Temp\\image.png"]))
      .toContain("添付画像の内容を読み取って対応してください。");
  });
});

function image(overrides: Partial<DiscordImageAttachment> = {}): DiscordImageAttachment {
  return {
    contentType: "image/png",
    name: "capture.png",
    size: PNG.byteLength,
    url: "https://cdn.discordapp.com/attachments/1/2/capture.png",
    ...overrides,
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cc-discord-image-test-"));
  tempRoots.push(root);
  return root;
}
