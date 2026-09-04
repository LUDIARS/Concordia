import { describe, it, expect } from "vitest";
import {
  isMainPushAllowlisted,
  mainPushTargetPaths,
  parseMainPushAllowlist,
} from "./main-push-allowlist.js";

describe("parseMainPushAllowlist", () => {
  it("カンマ / 改行区切りを分解し空白を落とす", () => {
    expect(parseMainPushAllowlist(" AlphaGame , BetaGame ")).toEqual(["AlphaGame", "BetaGame"]);
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
        command: "git -C C:/repos/AlphaGame push origin main",
      }),
    ).toEqual(["c:/repos/alphagame"]);
  });

  it("引用符付き (空白を含む) パスも拾う", () => {
    expect(mainPushTargetPaths({ command: 'git -C "C:/My Repos/BetaGame" push' })).toEqual(["c:/my repos/betagame"]);
  });

  it("相対 -C を cwd 基準で解決し、`.` / `..` を正規化する", () => {
    expect(mainPushTargetPaths({
      command: "git -C ./AlphaGame/tools/.. push origin main",
      cwd: "C:/repos",
    })).toEqual(["c:/repos/alphagame"]);
  });

  it("-C が無ければ cwd のみ", () => {
    expect(mainPushTargetPaths({ command: "git push origin main", cwd: "/x/AlphaGame" })).toEqual(["/x/alphagame"]);
    expect(mainPushTargetPaths({ command: "git push origin main" })).toEqual([]);
  });

  it("複合コマンドは decoy の -C と push 対象を安全に対応付けられないため拒否する", () => {
    expect(mainPushTargetPaths({
      command: "git -C C:/repos/AlphaGame status && git push origin main",
      cwd: "C:/repos/Figmentum",
    })).toEqual([]);
    expect(mainPushTargetPaths({
      command: "git -C C:/repos/AlphaGame status < <(git push origin main)",
      cwd: "C:/repos/Figmentum",
    })).toEqual([]);
  });

  it("別リポを指す --git-dir / --work-tree は fail-closed にする", () => {
    expect(mainPushTargetPaths({
      command: "git --git-dir=C:/repos/Figmentum/.git push origin main",
      cwd: "C:/repos/AlphaGame",
    })).toEqual([]);
    expect(mainPushTargetPaths({
      command: "git --work-tree C:/repos/Figmentum push origin main",
      cwd: "C:/repos/AlphaGame",
    })).toEqual([]);
  });

  it("inline alias など追加の Git global option は fail-closed にする", () => {
    expect(mainPushTargetPaths({
      command: 'git -C C:/repos/AlphaGame -c "alias.x=!git -C C:/repos/Figmentum push origin main" x',
      cwd: "C:/repos/Concordia",
    })).toEqual([]);
  });
});

describe("isMainPushAllowlisted", () => {
  // 判定規則のテストなので、既定シードの中身には依存させない。
  const allowlist = ["AlphaGame", "BetaGame"];

  it("ディレクトリ名エントリはパス区切り単位で一致する (Windows / POSIX 両方)", () => {
    expect(isMainPushAllowlisted({ cwd: "C:\\repos\\AlphaGame" }, allowlist)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "/home/x/betagame/sub/dir" }, allowlist)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/Figmentum" }, allowlist)).toBe(false);
  });

  it("部分文字列では一致しない (セグメント境界を守る)", () => {
    expect(isMainPushAllowlisted({ cwd: "C:/repos/AlphaGameX" }, allowlist)).toBe(false);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/.wt-AlphaGame-x" }, allowlist)).toBe(false);
  });

  it("絶対パスエントリは完全一致とその配下に効く", () => {
    const abs = ["C:\\repos\\AlphaGame"];
    expect(isMainPushAllowlisted({ cwd: "c:/repos/alphagame" }, abs)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/AlphaGame/tools" }, abs)).toBe(true);
    expect(isMainPushAllowlisted({ cwd: "C:/other/AlphaGame" }, abs)).toBe(false);
  });

  it("`..` で許可リポ外へ出るパスを許可しない", () => {
    expect(isMainPushAllowlisted({
      command: "git -C C:/repos/AlphaGame/../Figmentum push origin main",
      cwd: "C:/repos/Concordia",
    }, ["AlphaGame", "C:/repos/AlphaGame"])).toBe(false);
  });

  it("git -C の対象リポでも判定する (cwd が別リポでも許可)", () => {
    expect(
      isMainPushAllowlisted(
        { cwd: "C:/repos/Concordia", command: "git -C C:/repos/AlphaGame push origin main" },
        allowlist,
      ),
    ).toBe(true);
  });

  it("別リポの push に allowlisted な -C を混ぜても許可しない", () => {
    expect(isMainPushAllowlisted({
      cwd: "C:/repos/Figmentum",
      command: "git -C C:/repos/AlphaGame status && git push origin main",
    }, allowlist)).toBe(false);
  });

  it("許可リストが空なら常に false", () => {
    expect(isMainPushAllowlisted({ cwd: "C:/repos/AlphaGame" }, [])).toBe(false);
    expect(isMainPushAllowlisted({ cwd: "C:/repos/AlphaGame" }, ["  "])).toBe(false);
  });

  it("相対パスや `.` / `..` は許可エントリとして受け付けない", () => {
    expect(isMainPushAllowlisted({ command: "git -C repos/AlphaGame push" }, ["repos/AlphaGame"])).toBe(false);
    expect(isMainPushAllowlisted({ command: "git -C . push", cwd: "." }, ["."])).toBe(false);
    expect(
      isMainPushAllowlisted({ command: "git -C .. push", cwd: ".." }, [".."]),
    ).toBe(false);
  });
});
