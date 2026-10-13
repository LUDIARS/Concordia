import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it, vi } from "vitest";
import { AnatomiaDomainClient, matchProjectId, parseReviewNotesResult } from "./anatomia-client.js";

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

describe("parseReviewNotesResult", () => {
  it("形の合わない proposal / rejected を落とし、理由の無い rejected は unknown にする", () => {
    expect(parseReviewNotesResult({
      proposals: [{ proposalId: "p-1", affectedDomainIds: ["combat", 3] }, { proposalId: "" }, "x"],
      rejected: [{ index: 0, reviewRef: "cc-domain-review-answer:1" }, null],
    })).toEqual({
      proposals: [{ proposalId: "p-1", affectedDomainIds: ["combat"] }],
      rejected: [{ index: 0, reviewRef: "cc-domain-review-answer:1", reason: "unknown" }],
    });
    expect(parseReviewNotesResult(null)).toEqual({ proposals: [], rejected: [] });
  });
});

describe("AnatomiaDomainClient.submitReviewNotes", () => {
  it("review-notes へ notes を POST し、応答を絞り込んで返す", async () => {
    let received: { method?: string; url?: string; body: string } = { body: "" };
    const server = createServer((req, res) => {
      let body = "";
      req.setEncoding("utf8");
      req.on("data", (chunk: string) => { body += chunk; });
      req.on("end", () => {
        received = { method: req.method, url: req.url, body };
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ proposals: [{ proposalId: "p-9", kind: "review-note", affectedDomainIds: [] }], rejected: [] }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as AddressInfo).port;
      const client = new AnatomiaDomainClient({ baseUrl: `http://127.0.0.1:${port}` });
      const result = await client.submitReviewNotes("concordia", [{ note: "全体の指摘", reviewRef: "cc-domain-review-answer:7", kind: "other" }]);
      expect(result).toEqual({ ok: true, data: { proposals: [{ proposalId: "p-9", affectedDomainIds: [] }], rejected: [] } });
      expect(received.method).toBe("POST");
      expect(received.url).toBe("/api/projects/concordia/domain-organization/proposals/review-notes");
      expect(JSON.parse(received.body)).toEqual({ notes: [{ note: "全体の指摘", reviewRef: "cc-domain-review-answer:7", kind: "other" }] });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
