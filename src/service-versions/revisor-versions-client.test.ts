import { describe, expect, it } from "vitest";
import { RevisorServiceVersionsClient } from "./revisor-versions-client.js";

const BASE_URL = "http://127.0.0.1:4240";

function clientFor(body: unknown, status = 200) {
  const calls: string[] = [];
  const client = new RevisorServiceVersionsClient({
    revisor: { baseUrl: async () => BASE_URL },
    fetchImpl: (async (url: string) => {
      calls.push(String(url));
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as Response;
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const REVISOR_ROW = {
  requested: "Concordia",
  found: true,
  services: [{
    service: "concordia",
    name: "Concordia (AI 協調)",
    repository: "LUDIARS/Concordia",
    cwd: "E:/Document/Ars/Concordia",
    port: 11111,
    version: "2.4.0",
    running: { reachable: true, version: "0.1.0", error: null },
    packageVersion: "0.1.0",
    releaseVersion: null,
    releaseStatus: "uninitialized",
    latestReleaseTag: "v2.4.0",
    unreleasedCommits: 333,
    drift: ["running_differs_from_release", "unreleased_commits"],
  }],
};

describe("RevisorServiceVersionsClient", () => {
  // 公開済み版とズレの根拠は latestReleaseTag / unreleasedCommits / drift にしかない。
  // 中継で落とすと「2.4.0 だがプロセスは 0.1.0」という肝心の答えが消える。
  it("公開済み版とズレの情報を落とさずに写す", async () => {
    const { client } = clientFor({ versions: [REVISOR_ROW] });
    const [result] = await client.versions(["Concordia"]);
    expect(result.services[0]).toMatchObject({
      version: "2.4.0",
      latestReleaseTag: "v2.4.0",
      unreleasedCommits: 333,
      releaseStatus: "uninitialized",
      drift: ["running_differs_from_release", "unreleased_commits"],
    });
  });

  // 宣言したフィールドだけを写す。 Revisor 内部の値 (ローカルパス) を Cc の応答経由で
  // ブラウザへ素通しさせない。
  it("未知フィールドは通さない", async () => {
    const { client } = clientFor({ versions: [REVISOR_ROW] });
    const [result] = await client.versions(["Concordia"]);
    expect(result.services[0]).not.toHaveProperty("cwd");
  });

  it("サービスごとにクエリを積む", async () => {
    const { client, calls } = clientFor({ versions: [] });
    await client.versions(["Revisor", "Concordia"]);
    expect(calls[0]).toBe(`${BASE_URL}/v1/service-versions?service=Revisor&service=Concordia`);
  });

  it("サービスを 1 つも指定しない呼び出しは投げる", async () => {
    const { client, calls } = clientFor({ versions: [] });
    await expect(client.versions([])).rejects.toThrow(/At least one service/);
    expect(calls).toEqual([]);
  });

  it("Revisor のエラー応答を理由つきで投げ直す", async () => {
    const { client } = clientFor({ error: "At least one service must be named." }, 400);
    await expect(client.versions(["Revisor"])).rejects.toThrow(/\(400\): At least one service/);
  });

  it("壊れた行を捨てて残りを返す", async () => {
    const { client } = clientFor({
      versions: [REVISOR_ROW, { found: true, services: [] }, null],
    });
    const results = await client.versions(["Concordia"]);
    expect(results).toHaveLength(1);
    expect(results[0].requested).toBe("Concordia");
  });
});
