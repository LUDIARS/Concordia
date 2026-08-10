import { describe, expect, it } from "vitest";
import {
  dedupeWorkspaceRoots,
  readConfiguredWorkspaceRoots,
  readExtraWorkspaceRoots,
} from "./workspace-roots.js";

describe("dedupeWorkspaceRoots", () => {
  it("区切り文字・末尾スラッシュ・大文字小文字の違いを同一視する", () => {
    expect(
      dedupeWorkspaceRoots(["E:\\Document\\Ars", "e:/document/ars/", "E:\\Document\\Other"]),
    ).toEqual(["E:\\Document\\Ars", "E:\\Document\\Other"]);
  });

  it("空・空白のみの要素を落とす", () => {
    expect(dedupeWorkspaceRoots(["", "  ", "E:\\Ars"])).toEqual(["E:\\Ars"]);
  });

  it("先頭の表記を残す", () => {
    expect(dedupeWorkspaceRoots(["e:/ars", "E:\\Ars"])).toEqual(["e:/ars"]);
  });

  it("POSIX の大文字小文字が異なるルートは別物として保持する", () => {
    expect(dedupeWorkspaceRoots(["/srv/Repo", "/srv/repo"])).toEqual([
      "/srv/Repo",
      "/srv/repo",
    ]);
  });
});

describe("readConfiguredWorkspaceRoots", () => {
  it("3 キーを結合し重複を除去する", () => {
    expect(
      readConfiguredWorkspaceRoots({
        CONCORDIA_WORKSPACE_ROOT: "E:\\Ars",
        CONCORDIA_WORKSPACE_ROOTS: "D:\\Work; E:\\Ars ",
        LUDIARS_ROOT: "E:\\Ars",
      } as NodeJS.ProcessEnv),
    ).toEqual(["E:\\Ars", "D:\\Work"]);
  });

  it("未設定なら空配列 (空文字を候補として残さない)", () => {
    expect(readConfiguredWorkspaceRoots({} as NodeJS.ProcessEnv)).toEqual([]);
  });

  it("空文字指定を未設定と同じに扱う", () => {
    expect(
      readConfiguredWorkspaceRoots({
        CONCORDIA_WORKSPACE_ROOT: "  ",
        CONCORDIA_WORKSPACE_ROOTS: "",
        LUDIARS_ROOT: "D:\\LUDIARS",
      } as NodeJS.ProcessEnv),
    ).toEqual(["D:\\LUDIARS"]);
  });
});

describe("readExtraWorkspaceRoots", () => {
  it("追加ルート列だけを返す", () => {
    expect(
      readExtraWorkspaceRoots({
        CONCORDIA_WORKSPACE_ROOT: "E:\\Ars",
        CONCORDIA_WORKSPACE_ROOTS: "D:\\A;D:\\B",
      } as NodeJS.ProcessEnv),
    ).toEqual(["D:\\A", "D:\\B"]);
  });
});
