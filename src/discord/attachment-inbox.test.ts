import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildDiscordFileInjectText,
  decodeTextFile,
  publicDiscordFileError,
  safeAttachmentFileName,
  storeDiscordFiles,
  type DiscordFileAttachment,
} from "./attachment-inbox.js";

const PDF = Buffer.from("%PDF-1.7\n\u0000binary", "latin1");
const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cc-discord-file-test-"));
  tempRoots.push(root);
  return root;
}

function file(overrides: Partial<DiscordFileAttachment> = {}): DiscordFileAttachment {
  return {
    contentType: "application/pdf",
    name: "企画書.pdf",
    size: PDF.length,
    url: "https://cdn.discordapp.com/attachments/1/2/plan.pdf",
    ...overrides,
  };
}

describe("Discord file inbox", () => {
  it("画像以外の添付も種類を問わず保存し、 元の名前を残す", async () => {
    const root = await temporaryRoot();
    const files = await storeDiscordFiles({
      attachments: [file()],
      fetchImpl: async () => new Response(PDF, { headers: { "content-type": "application/pdf" } }),
      inboxRoot: root,
      messageId: "message-1",
      sessionId: "session-1",
    });
    expect(files).toEqual([{
      path: join(root, "session-1-message-1-1-企画書.pdf"),
      name: "企画書.pdf",
      size: PDF.length,
      text: null,
      textTruncated: false,
    }]);
    expect(await readFile(files[0].path)).toEqual(PDF);
  });

  it("文字のファイルは本文も返す (ファイルを開けないセッションへ添えるため)", async () => {
    const root = await temporaryRoot();
    const csv = "名前,点数\nA,10\n";
    const files = await storeDiscordFiles({
      attachments: [file({ name: "score.csv", contentType: "text/csv", size: null })],
      fetchImpl: async () => new Response(csv),
      inboxRoot: root,
      messageId: "m",
      sessionId: "s",
    });
    expect(files[0]).toMatchObject({ text: csv, textTruncated: false });
  });

  it("Discord の CDN 以外・大きすぎる添付は保存しない", async () => {
    const root = await temporaryRoot();
    const fetchImpl = vi.fn(async () => new Response(PDF));
    await expect(storeDiscordFiles({
      attachments: [file({ url: "https://example.com/a.pdf" })], fetchImpl, inboxRoot: root, messageId: "m", sessionId: "s",
    })).rejects.toSatisfy((error) => publicDiscordFileError(error).includes("Discord CDN"));
    await expect(storeDiscordFiles({
      attachments: [file({ size: 26 * 1024 * 1024 })], fetchImpl, inboxRoot: root, messageId: "m", sessionId: "s",
    })).rejects.toSatisfy((error) => publicDiscordFileError(error).includes("大きすぎます"));
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("途中の 1 件が失敗したら、 その投稿で保存した分を消す", async () => {
    const root = await temporaryRoot();
    let calls = 0;
    await expect(storeDiscordFiles({
      attachments: [file({ name: "a.txt" }), file({ name: "b.txt" })],
      fetchImpl: async () => (calls++ === 0 ? new Response("ok") : new Response("", { status: 404 })),
      inboxRoot: root,
      messageId: "m",
      sessionId: "s",
    })).rejects.toSatisfy((error) => publicDiscordFileError(error).includes("HTTP 404"));
    await expect(readFile(join(root, "s-m-1-a.txt"))).rejects.toThrow();
  });
});

describe("safeAttachmentFileName / decodeTextFile", () => {
  it("パスの文字・Windows で使えない名前を落とす", () => {
    expect(safeAttachmentFileName("../../evil.txt")).toBe("evil.txt");
    expect(safeAttachmentFileName("a:b?.md")).toBe("a_b_.md");
    expect(safeAttachmentFileName("CON.txt")).toBe("file.txt");
    expect(safeAttachmentFileName(null)).toBe("file");
  });

  it("UTF-8 の文字だけを本文として読む", () => {
    expect(decodeTextFile(Buffer.from("﻿こんにちは"))).toBe("こんにちは");
    expect(decodeTextFile(PDF)).toBeNull();
    expect(decodeTextFile(Buffer.from([0xff, 0xfe, 0x41]))).toBeNull();
  });
});

describe("buildDiscordFileInjectText", () => {
  const stored = [
    { path: "/inbox/s-m-1-memo.txt", name: "memo.txt", size: 12, text: "メモの本文", textTruncated: false },
    { path: "/inbox/s-m-2-plan.pdf", name: "plan.pdf", size: 3 * 1024 * 1024, text: null, textTruncated: false },
  ];

  it("保存先と元の名前を並べ、 本文の無い投稿にも指示を入れる", () => {
    const text = buildDiscordFileInjectText("", stored);
    expect(text).toContain("添付ファイルの内容を読み取って対応してください。");
    expect(text).toContain("- /inbox/s-m-1-memo.txt (元の名前: memo.txt、12 B)");
    expect(text).toContain("- /inbox/s-m-2-plan.pdf (元の名前: plan.pdf、3.0 MiB)");
    expect(text).not.toContain("メモの本文");
  });

  it("inlineText のときは文字のファイルの本文を資料の囲みで添える", () => {
    const text = buildDiscordFileInjectText("見てください", stored, { inlineText: true });
    expect(text.startsWith("見てください")).toBe(true);
    expect(text).toContain("添付ファイル「memo.txt」の本文ここから");
    expect(text).toContain("メモの本文");
    expect(text).not.toContain("添付ファイル「plan.pdf」の本文");
  });
});
