import { describe, expect, it } from "vitest";
import { checkRepoOrigin, repoDirNameOf, repoNameOf } from "./origin-identity.js";

describe("checkRepoOrigin", () => {
  it("owner/repo をそのまま受ける", () => {
    expect(checkRepoOrigin("LUDIARS/Concordia")).toEqual({ ok: true, origin: "LUDIARS/Concordia" });
  });

  it("userinfo の無い URL / SSH は owner/repo へ正規化する", () => {
    expect(checkRepoOrigin("https://github.com/LUDIARS/Concordia.git")).toEqual({
      ok: true, origin: "LUDIARS/Concordia",
    });
    expect(checkRepoOrigin("git@github.com:LUDIARS/Concordia.git")).toEqual({
      ok: true, origin: "LUDIARS/Concordia",
    });
  });

  it("資格情報付き URL は受け取らない (ログ・イベントへ流さないため)", () => {
    expect(checkRepoOrigin("https://user:ghp_secret@github.com/LUDIARS/Concordia.git")).toEqual({
      ok: false, reason: "credentials_present",
    });
    expect(checkRepoOrigin("https://ghp_secret@github.com/LUDIARS/Concordia")).toEqual({
      ok: false, reason: "credentials_present",
    });
    expect(checkRepoOrigin("user:pass@github.com:LUDIARS/Concordia.git")).toEqual({
      ok: false, reason: "credentials_present",
    });
  });

  it("owner/repo に落とせない識別子は拒否する", () => {
    expect(checkRepoOrigin("E:/Document/Ars/Concordia")).toEqual({ ok: false, reason: "not_canonical" });
    expect(checkRepoOrigin("   ")).toEqual({ ok: false, reason: "empty" });
    expect(checkRepoOrigin(undefined)).toEqual({ ok: false, reason: "empty" });
  });
});

describe("repo 名の取り出し", () => {
  it("origin の repo 名を小文字で返す", () => {
    expect(repoNameOf("LUDIARS/Concordia")).toBe("concordia");
  });

  it("checkout パスの末尾ディレクトリ名を返す (区切り揺れ・末尾スラッシュを吸収)", () => {
    expect(repoDirNameOf("E:\\Document\\Ars\\Concordia\\")).toBe("concordia");
    expect(repoDirNameOf("E:/Document/Ars/Concordia")).toBe("concordia");
  });
});
