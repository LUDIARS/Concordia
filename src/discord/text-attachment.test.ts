import { describe, expect, it } from "vitest";
import { discordTextAttachmentName } from "./text-attachment.js";

const ESC = 0x1b;
const NUL = 0x00;

describe("Discord text attachments", () => {
  it.each(["資料.md", "REPORT.JSON", "script.ts", "output.log"])("makes %s expandable without altering text", (name) => {
    const data = Buffer.from("# 日本語\r\n```ts\n@everyone\n```\n", "utf8");
    const original = Buffer.from(data);
    expect(discordTextAttachmentName(name, data)).toBe(`${name}.txt`);
    expect(data.equals(original)).toBe(true);
  });

  it("keeps plain text names and full large payloads", () => {
    const data = Buffer.from("本文".repeat(30_000));
    expect(discordTextAttachmentName("long.txt", data)).toBe("long.txt");
    expect(discordTextAttachmentName("long.md", data)).toBe("long.md.txt");
    expect(data.length).toBe(180_000);
  });

  it("treats an existing .txt name case-insensitively and leaves extensionless names alone", () => {
    const data = Buffer.from("本文\n", "utf8");
    expect(discordTextAttachmentName("REPORT.TXT", data)).toBe("REPORT.TXT");
    expect(discordTextAttachmentName("README", data)).toBe("README");
    expect(discordTextAttachmentName(".gitignore", data)).toBe(".gitignore");
  });

  it("keeps tabs, LF and CR as text but rejects other control bytes", () => {
    expect(discordTextAttachmentName("table.tsv", Buffer.from("a\tb\r\nc\td\n"))).toBe("table.tsv.txt");
    // ESC / NUL など、 タブ・改行以外の制御文字を含むものは元の名前を維持する。
    const escaped = Buffer.concat([Buffer.from([ESC]), Buffer.from("[31mred\n")]);
    expect(discordTextAttachmentName("escape.log", escaped)).toBe("escape.log");
    const withNul = Buffer.concat([Buffer.from("text"), Buffer.from([NUL]), Buffer.from("more")]);
    expect(discordTextAttachmentName("nul.md", withNul)).toBe("nul.md");
  });

  it("does not relabel binary, invalid UTF-8, or unknown formats", () => {
    expect(discordTextAttachmentName("binary.md", Buffer.from([0, 1, 2]))).toBe("binary.md");
    expect(discordTextAttachmentName("legacy.md", Buffer.from([0x82, 0xa0]))).toBe("legacy.md");
    expect(discordTextAttachmentName("image.svg", Buffer.from("<svg/>"))).toBe("image.svg");
    expect(discordTextAttachmentName("document.pdf", Buffer.from("%PDF"))).toBe("document.pdf");
  });
});
