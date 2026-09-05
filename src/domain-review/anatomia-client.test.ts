import { describe, expect, it, vi } from "vitest";
import { AnatomiaDomainClient, matchProjectId } from "./anatomia-client.js";

const projects = [
  { id: "concordia", rootPath: "E:\\Document\\Ars\\Concordia" },
  { id: "lictor", rootPath: "E:\\Document\\Ars\\Lictor" },
  { id: "ars", rootPath: "E:\\Document\\Ars" },
];

describe("matchProjectId", () => {
  it("区切りと大小文字の差を吸収して完全一致を採る", () => {
    expect(matchProjectId("E:/Document/Ars/Concordia", projects)).toBe("concordia");
    expect(matchProjectId("e:\\document\\ars\\concordia\\", projects)).toBe("concordia");
  });

  it("worktree は本体ではなく、それを含む最深の登録に落ちる", () => {
    // `Concordia-feat-x` は `Concordia` の下ではないので `Concordia` にはならない。
    // ワークスペース root だけが包含するため `ars` になる。
    expect(matchProjectId("E:/Document/Ars/Concordia-feat-domain-review-discord", projects)).toBe("ars");
  });

  it("登録の内側のパスは最深の登録を採る", () => {
    expect(matchProjectId("E:/Document/Ars/Concordia/src/api", projects)).toBe("concordia");
  });

  it("どの登録にも含まれなければ null", () => {
    expect(matchProjectId("D:/elsewhere/Repo", projects)).toBeNull();
    expect(matchProjectId("", projects)).toBeNull();
  });
});

describe("AnatomiaDomainClient.resolveProjectId", () => {
  it("一覧取得失敗の理由を null に潰さない", async () => {
    const client = new AnatomiaDomainClient({ baseUrl: "http://anatomia.test" });
    vi.spyOn(client, "listProjects").mockResolvedValue({ ok: false, reason: "unreachable" });

    await expect(client.resolveProjectId("E:/Document/Ars/Concordia"))
      .resolves.toEqual({ ok: false, reason: "unreachable" });
  });

  it("一覧取得成功時は project id の有無を ok で返す", async () => {
    const client = new AnatomiaDomainClient({ baseUrl: "http://anatomia.test" });
    vi.spyOn(client, "listProjects").mockResolvedValue({ ok: true, data: projects });

    await expect(client.resolveProjectId("E:/Document/Ars/Concordia"))
      .resolves.toEqual({ ok: true, data: "concordia" });
    await expect(client.resolveProjectId("D:/elsewhere/Repo"))
      .resolves.toEqual({ ok: true, data: null });
  });
});
