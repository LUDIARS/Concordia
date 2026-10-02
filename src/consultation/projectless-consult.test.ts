import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  consultClaudeConfigDir,
  consultPersonalDataDir,
  consultRoleWorkspace,
  consultWorkspaceClaudeSettings,
  isProjectlessConsultDepartment,
  withConsultWorkspaceTrust,
} from "./projectless-consult.js";

const readOnly = { work_mode: "read-only", archived_at: null };

describe("isProjectlessConsultDepartment", () => {
  it("担当プロジェクトが無く読み取り専用のユースケースなら true", () => {
    expect(isProjectlessConsultDepartment({ projects: [], useCase: readOnly })).toBe(true);
  });

  it("担当プロジェクトがあれば false", () => {
    expect(isProjectlessConsultDepartment({ projects: ["Concordia"], useCase: readOnly })).toBe(false);
  });

  it("編集可のユースケース・ユースケース無し・廃止済みは false", () => {
    expect(isProjectlessConsultDepartment({ projects: [], useCase: { work_mode: "edit", archived_at: null } })).toBe(false);
    expect(isProjectlessConsultDepartment({ projects: [], useCase: null })).toBe(false);
    expect(isProjectlessConsultDepartment({ projects: [], useCase: { work_mode: "read-only", archived_at: 1 } })).toBe(false);
  });
});

describe("consultRoleWorkspace / consultPersonalDataDir", () => {
  it("役職ごとのフォルダを root 直下に置き、 読めない役職は general", () => {
    expect(consultRoleWorkspace("/srv/consult", "サウンドクリエイター")).toBe(join("/srv/consult", "sound"));
    expect(consultRoleWorkspace("/srv/consult", "エンジニア")).toBe(join("/srv/consult", "engineer"));
    expect(consultRoleWorkspace("/srv/consult", null)).toBe(join("/srv/consult", "general"));
  });

  it("相談者のデータは役職フォルダの下の Discord の個人 ID のフォルダ。 数字以外の ID はパスにしない", () => {
    expect(consultPersonalDataDir(join("/srv/consult", "sound"), "123456789012345678"))
      .toBe(join("/srv/consult", "sound", "123456789012345678"));
    expect(consultPersonalDataDir("/srv/consult/sound", "../../etc")).toBeNull();
    expect(consultPersonalDataDir("/srv/consult/sound", null)).toBeNull();
  });
});

describe("consultWorkspaceClaudeSettings", () => {
  it("上位のフォルダとデータフォルダの指示ファイルは読ませず、 役職フォルダ自身の指示ファイルは読ませる。 自動メモリは使わない", () => {
    const settings = consultWorkspaceClaudeSettings("/srv/consult/sound") as { claudeMdExcludes: string[]; autoMemoryEnabled: boolean };
    expect(settings.autoMemoryEnabled).toBe(false);
    expect(settings.claudeMdExcludes).toEqual(expect.arrayContaining([
      "/srv/consult/CLAUDE.md", "/srv/CLAUDE.md", "/srv/AGENTS.md", "/srv/consult/.claude/rules/**",
      "/srv/consult/sound/*/**/CLAUDE.md",
    ]));
    expect(settings.claudeMdExcludes).not.toContain("/srv/consult/sound/CLAUDE.md");
    expect(settings.claudeMdExcludes).not.toContain("**/CLAUDE.md");
  });
});

describe("PROJECTLESS_CONSULT_CLAUDE_ARGS", () => {
  it("組み込みツールを Web 検索・ToDo・スキルに絞り、 利用者の MCP を読ませない", () => {
    expect(PROJECTLESS_CONSULT_CLAUDE_ARGS).toEqual([
      "--tools=WebSearch,TodoWrite,Skill",
      "--strict-mcp-config",
    ]);
  });
});

describe("consultClaudeConfigDir / withConsultWorkspaceTrust", () => {
  it("相談専用の設定フォルダは置き場所の直下", () => {
    expect(consultClaudeConfigDir("/srv/consult")).toBe(join("/srv/consult", ".claude-config"));
  });

  it("役職フォルダの信頼を書き足し、 既にあれば書かない。 壊れた claude.json は触らない", () => {
    const next = withConsultWorkspaceTrust({ userID: "u", projects: { "C:/x": { a: 1 } } }, "E:\\Document\\Consult\\sound");
    expect(next).toEqual({
      userID: "u",
      projects: { "C:/x": { a: 1 }, "E:/Document/Consult/sound": { hasTrustDialogAccepted: true } },
    });
    expect(withConsultWorkspaceTrust(next, "E:/Document/Consult/sound")).toBeNull();
    expect(withConsultWorkspaceTrust(null, "E:/Document/Consult/sound")).toBeNull();
    expect(withConsultWorkspaceTrust([], "E:/Document/Consult/sound")).toBeNull();
  });
});
