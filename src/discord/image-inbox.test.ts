import { mkdir, mkdtemp, readFile, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildDiscordImageInjectText,
  isReadableDiscordImage,
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

  it("rejects bytes that disagree with the declared image type", async () => {
    await expect(storeDiscordImages({
      attachments: [image({ contentType: "image/gif", name: "capture.gif" })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/gif" } }),
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Content-Typeが一致しません");
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

  it("rejects a non-standard port on an allowed Discord host", async () => {
    await expect(storeDiscordImages({
      attachments: [image({ url: "https://cdn.discordapp.com:4443/attachments/1/2/capture.png" })],
      fetchImpl: async () => new Response(PNG, { headers: { "content-type": "image/png" } }),
      inboxRoot: await temporaryRoot(),
      messageId: "message-1",
      sessionId: "session-1",
    })).rejects.toThrow("Discord CDN以外");
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
      })).rejects.toThrow("安全なディレクトリではありません");
    });
  }

  it("recognizes an image filename when Discord omitted contentType", () => {
    expect(isReadableDiscordImage(image({ contentType: null, name: "capture.PNG" }))).toBe(true);
    expect(isReadableDiscordImage(image({ contentType: null, name: "notes.txt" }))).toBe(false);
  });

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
