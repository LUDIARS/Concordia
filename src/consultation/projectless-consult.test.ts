import { describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  PROJECTLESS_CONSULT_CLAUDE_ARGS,
  isProjectlessConsultDepartment,
  projectlessConsultWorkspace,
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

describe("projectlessConsultWorkspace", () => {
  it("子会社ごとのディレクトリを root 直下に作る", () => {
    expect(projectlessConsultWorkspace("/srv/cw", "be9848ab-06ae")).toBe(join("/srv/cw", "be9848ab-06ae"));
  });

  it("パス区切りや .. を含む id でも root の外へ出ない", () => {
    expect(projectlessConsultWorkspace("/srv/cw", "../../etc")).toBe(join("/srv/cw", "______etc"));
    expect(projectlessConsultWorkspace("/srv/cw", "")).toBe(join("/srv/cw", "_"));
  });
});

describe("PROJECTLESS_CONSULT_CLAUDE_ARGS", () => {
  it("組み込みツールを Web 検索と ToDo に絞り、 MCP とスキルを読ませない", () => {
    expect(PROJECTLESS_CONSULT_CLAUDE_ARGS).toEqual([
      "--tools=WebSearch,TodoWrite",
      "--strict-mcp-config",
      "--disable-slash-commands",
    ]);
  });
});
