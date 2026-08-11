import { describe, it, expect } from "vitest";
import {
  DEFAULT_MAIN_PUSH_ALLOWLIST,
  isMainPushAllowlisted,
  mainPushTargetPaths,
  parseMainPushAllowlist,
} from "./main-push-allowlist.js";

describe("parseMainPushAllowlist", () => {
  it("カンマ / 改行区切りを分解し空白を落とす", () => {
    expect(parseMainPushAllowlist(" KuzuSurvivors , MakaiNui ")).toEqual(["KuzuSurvivors", "MakaiNui"]);
    expect(parseMainPushAllowlist("A\nB")).toEqual(["A", "B"]);
  });

  it("未設定 / 空文字は null (= 呼び出し側のフォールバックへ)", () => {
    expect(parseMainPushAllowlist(undefined)).toBeNull();
    expect(parseMainPushAllowlist(null)).toBeNull();
    expect(parseMainPushAllowlist("  ,  ")).toBeNull();
  });
});

describe("mainPushTargetPaths", () => {
  it("git -C があれば cwd ではなく push の実対象を返す (正規化済み)", () => {
    expect(
      mainPushTargetPaths({
        cwd: "C:\\repos\\Figmentum\\",
        command: "git -C C:/repos/KuzuSurvivors push origin main",
      }),
    ).toEqual(["c:/repos/kuzusurvivors"]);
  });

  it("引用符付き (空白を含む) パスも拾う", () => {
    expect(mainPushTargetPaths({ command: 'git -C "C:/My Repos/MakaiNui" push' })).toEqual(["c:/my repos/makainui"]);
  });

  it("相対 -C を cwd 基準で解決し、`.` / `..` を正規化する", () => {
    expect(mainPushTargetPaths({
      command: "git -C ./KuzuSurvivors/tools/.. push origin main",
      cwd: "C:/repos",
    })).toEqual(["c:/repos/kuzusurvivors"]);
  });

  it("-C が無ければ cwd のみ", () => {
    expect(mainPushTargetPaths({ command: "git push origin main", cwd: "/x/KuzuSurvivors" })).toEqual(["/x/kuzusurvivors"]);
    expect(mainPushTargetPaths({ command: "git push origin main" })).toEqual([]);
  });

  it("複合コマンドは decoy の -C と push 対象を安全に対応付けられないため拒否する", () => {
    expect(mainPushTargetPaths({
      command: "git -C C:/repos/KuzuSurvivors status && git push origin main",
      cwd: "C:/repos/Figmentum",
    })).toEqual([]);
    expect(mainPushTargetPaths({
      command: "git -C C:/repos/KuzuSurvivors status < <(git push origin main)",
      cwd: "C:/repos/Figmentum",
    })).toEqual([]);
  });

  it("別リポを指す --git-dir / --work-tree は fail-closed にする", () => {
    expect(mainPushTargetPaths({
      command: "git --git-dir=C:/repos/Figmentum/.git push origin main",
      cwd: "C:/repos/KuzuSurvivors",
    })).toEqual([]);
    expect(mainPushTargetPaths({
      command: "git --work-tree C:/repos/Figmentum push origin main",
      cwd: "C:/repos/KuzuSurvivors",
    })).toEqual([]);
  });

  it("inline alias など追加の Git global option は fail-closed にする", () => {
    expect(mainPushTargetPaths({
      command: 'git -C C:/repos/KuzuSurvivors -c "alias.x=!git -C C:/repos/Figmentum push origin main" x',
      cwd: "C:/repos/Concordia",
    })).toEqual([]);
  });
});

describe("isMainPushAllowlisted", () => {
  const allowlist = [...DEFAULT_MAIN_PUSH_ALLOWLIST];

  it("ディレクトリ名エントリはパス区切り単位で一致する (Windows / POSIX 両方)", () => {
    expect(isMainPushAllowlisted({ cwd: "C:\\repos\\KuzuSurvivors" }, allowlist)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "/home/x/makainui/sub/dir" }, allowlist)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/Figmentum" }, allowlist)).toBe(false);
  });

  it("部分文字列では一致しない (セグメント境界を守る)", () => {
    expect(isMainPushAllowlisted({ cwd: "C:/repos/KuzuSurvivorsX" }, allowlist)).toBe(false);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/.wt-KuzuSurvivors-x" }, allowlist)).toBe(false);
  });

  it("絶対パスエントリは完全一致とその配下に効く", () => {
    const abs = ["C:\\repos\\KuzuSurvivors"];
    expect(isMainPushAllowlisted({ cwd: "c:/repos/kuzusurvivors" }, abs)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/KuzuSurvivors/tools" }, abs)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/other/KuzuSurvivors" }, abs)).toBe(false);
  });

  it("`..` で許可リポ外へ出るパスを許可しない", () => {
    expect(isMainPushAllowlisted({
      command: "git -C C:/repos/KuzuSurvivors/../Figmentum push origin main",
      cwd: "C:/repos/Concordia",
    }, ["KuzuSurvivors", "C:/repos/KuzuSurvivors"])).toBe(false);
  });

  it("git -C の対象リポでも判定する (cwd が別リポでも許可)", () => {
    expect(
      isMainPushAllowlisted(
        { cwd: "C:/repos/Concordia", command: "git -C C:/repos/KuzuSurvivors push origin main" },
        allowlist,
      ),
    ).toBe(true);
  });

  it("別リポの push に allowlisted な -C を混ぜても許可しない", () => {
    expect(isMainPushAllowlisted({
      cwd: "C:/repos/Figmentum",
      command: "git -C C:/repos/KuzuSurvivors status && git push origin main",
    }, allowlist)).toBe(false);
  });

  it("許可リストが空なら常に false", () => {
    expect(isMainPushAllowlisted({ cwd: "C:/repos/KuzuSurvivors" }, [])).toBe(false);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/KuzuSurvivors" }, ["  "])).toBe(false);
  });

  it("相対パスや `.` / `..` は許可エントリとして受け付けない", () => {
    expect(isMainPushAllowlisted({ command: "git -C repos/KuzuSurvivors push" }, ["repos/KuzuSurvivors"])).toBe(false);
    expect(isMainPushAllowlisted({ command: "git -C . push", cwd: "." }, ["."])).toBe(false);
    expect(
      isMainPushAllowlisted({ command: "git -C .. push", cwd: ".." }, [".."]),
    ).toBe(false);
  });
});
