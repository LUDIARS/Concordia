import { describe, expect, it } from "vitest";
import { parseCheckoutPublishedNotice } from "./notice.js";

describe("checkout_published の通知読み取り", () => {
  it("イベント名からリポジトリ・PR 番号・sha を読む", () => {
    const notice = parseCheckoutPublishedNotice(
      "checkout_published: LUDIARS/Concordia#364\n本体 checkout を 1a2b3c4d5e6f へ前進させました",
    );
    expect(notice).toEqual({ repository: "LUDIARS/Concordia", prNumber: 364, sha: "1a2b3c4d5e6f" });
  });

  it("日本語文面だけでも checkout 前進として読む", () => {
    expect(parseCheckoutPublishedNotice("📥 Concordia#47 本体 checkout を cd190cb へ前進させました"))
      .toMatchObject({ repository: "Concordia", sha: "cd190cb" });
  });

  it("7 桁以上の PR 番号を sha と取り違えない", () => {
    // sha は重複抑止のキーなので、PR 番号を拾うと別の前進として二重に再起動しうる。
    expect(parseCheckoutPublishedNotice("checkout_published: Concordia#1234567 本体 checkout を deadbee へ前進させました"))
      .toEqual({ repository: "Concordia", prNumber: 1234567, sha: "deadbee" });
  });

  it("sha が PR ラベルより前に出ても拾う", () => {
    // Revisor 側の文面は未実装 (spec は draft) なので語順は決め打ちにできない。
    // 「label より後ろだけ」を見ると、この語順で sha を取りこぼして重複抑止が repo 単位に潰れる。
    expect(parseCheckoutPublishedNotice("checkout_published: 本体 checkout を 1a2b3c4 へ前進させました (LUDIARS/Concordia#364)"))
      .toEqual({ repository: "LUDIARS/Concordia", prNumber: 364, sha: "1a2b3c4" });
  });

  it("sha を読めない前進でも repository と PR 番号は返す", () => {
    expect(parseCheckoutPublishedNotice("checkout_published: LUDIARS/Concordia#364 を反映しました"))
      .toEqual({ repository: "LUDIARS/Concordia", prNumber: 364, sha: null });
  });

  it("見送り通知は deploy の起点にしない", () => {
    expect(parseCheckoutPublishedNotice("checkout_publish_skipped: Concordia#47 理由: worktree が dirty")).toBeNull();
  });

  it("無関係な Revisor 通知では null を返す", () => {
    expect(parseCheckoutPublishedNotice("🟣 Revisor PR マージ: Concordia#364")).toBeNull();
    expect(parseCheckoutPublishedNotice("")).toBeNull();
  });
});
