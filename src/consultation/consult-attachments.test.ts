import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  claudeAbsolutePathRule,
  consultAttachmentClaudeArgs,
  consultAttachmentDir,
  consultWorkspaceReadDenyRule,
  isConsultAttachmentPath,
  requesterFromSessionMetadata,
} from "./consult-attachments.js";
import { consultationToolAllowed } from "./safety-policy.js";

describe("consultAttachmentDir", () => {
  it("相談者ごとの置き場所を一時フォルダの下に作る。 数字以外の ID はパスにしない", () => {
    expect(consultAttachmentDir("/tmp", "123456789012345678"))
      .toBe(join("/tmp", "concordia-consult-attachments", "123456789012345678"));
    expect(consultAttachmentDir("/tmp", "../etc")).toBeNull();
    expect(consultAttachmentDir("/tmp", null)).toBeNull();
  });

  it("セッションの metadata から相談者を読む。 壊れた metadata は null", () => {
    expect(requesterFromSessionMetadata(JSON.stringify({ discord_requester_user_id: "123456789" }))).toBe("123456789");
    expect(requesterFromSessionMetadata("{")).toBeNull();
    expect(requesterFromSessionMetadata(null)).toBeNull();
  });
});

describe("isConsultAttachmentPath (CC-CONSULT-INV-12)", () => {
  const dir = "C:\\Temp\\concordia-consult-attachments\\123456789";

  it("置き場所の中のファイルだけを通す (区切り・大文字小文字の違いは同じとみなす)", () => {
    expect(isConsultAttachmentPath("C:/Temp/concordia-consult-attachments/123456789/a.pdf", dir)).toBe(true);
    expect(isConsultAttachmentPath("c:\\temp\\CONCORDIA-consult-attachments\\123456789\\a.pdf", dir)).toBe(true);
  });

  it("他の相談者の置き場所・置き場所そのもの・.. で抜けるパス・相談フォルダは通さない", () => {
    expect(isConsultAttachmentPath("C:/Temp/concordia-consult-attachments/987654321/a.pdf", dir)).toBe(false);
    expect(isConsultAttachmentPath("C:/Temp/concordia-consult-attachments/123456789", dir)).toBe(false);
    expect(isConsultAttachmentPath("C:/Temp/concordia-consult-attachments/123456789/../987654321/a.pdf", dir)).toBe(false);
    expect(isConsultAttachmentPath("E:/Document/Consult/planner/123456789/memo.md", dir)).toBe(false);
    expect(isConsultAttachmentPath("C:/Temp/concordia-consult-attachments/1234567890/a.pdf", dir)).toBe(false);
    expect(isConsultAttachmentPath("C:/Temp/x.pdf", null)).toBe(false);
  });
});

describe("Claude の権限規則", () => {
  it("Windows のパスは //<ドライブ小文字>/... の形にする", () => {
    expect(claudeAbsolutePathRule("C:\\Users\\a\\AppData\\Local\\Temp\\x")).toBe("//c/Users/a/AppData/Local/Temp/x");
    expect(claudeAbsolutePathRule("/tmp/x/")).toBe("//tmp/x");
  });

  it("添付の置き場所の Read だけを起動引数で許し、 相談フォルダ全体の Read は拒否する", () => {
    expect(consultAttachmentClaudeArgs("C:/Temp/concordia-consult-attachments/123456789"))
      .toEqual(["--allowedTools", "Read(//c/Temp/concordia-consult-attachments/123456789/**)"]);
    expect(consultAttachmentClaudeArgs(null)).toEqual([]);
    expect(consultWorkspaceReadDenyRule("E:/Document/Consult")).toBe("Read(//e/Document/Consult/**)");
  });
});

describe("consultationToolAllowed の読み取り", () => {
  const dir = "C:/Temp/concordia-consult-attachments/123456789";

  it("Read と view_image は相談者の添付の置き場所の中だけ通す", () => {
    expect(consultationToolAllowed("Read", `${dir}/a.pdf`, dir)).toBe(true);
    expect(consultationToolAllowed("view_image", `${dir}/a.png`, dir)).toBe(true);
    expect(consultationToolAllowed("Read", "E:/Document/Consult/planner/AGENTS.md", dir)).toBe(false);
    expect(consultationToolAllowed("Read", `${dir}/a.pdf`, null)).toBe(false);
  });

  it("読み取りを足しても、 シェルは公開リンクの取得コマンドだけのまま", () => {
    expect(consultationToolAllowed("Bash", `cat ${dir}/a.txt`, dir)).toBe(false);
    expect(consultationToolAllowed("Grep", `${dir}/a.txt`, dir)).toBe(false);
  });
});
