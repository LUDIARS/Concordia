import { describe, expect, it } from "vitest";
import { serviceVersionsRouter } from "./service-versions.js";
import type { ProjectCodeLookup } from "../service-versions/service-selectors.js";
import type { ServiceVersionResult } from "../service-versions/revisor-versions-client.js";

const ROWS = [
  { code: "Rv", project: "Revisor", repo_path: "E:/Document/Ars/Revisor", repo_origin: "LUDIARS/Revisor" },
  { code: "Cc", project: "Concordia", repo_path: "E:/Document/Ars/Concordia", repo_origin: "LUDIARS/Concordia" },
];

const projectCodes: ProjectCodeLookup = {
  list: () => ROWS,
  findByCode: (code) => ROWS.find((row) => row.code === code) ?? null,
  findByRepoOrigin: (origin) =>
    ROWS.find((row) => row.repo_origin?.toLowerCase() === origin.toLowerCase()) ?? null,
};

function versionOf(service: string): ServiceVersionResult {
  return {
    requested: service,
    found: true,
    services: [{
      service: service.toLowerCase(),
      name: service,
      repository: `LUDIARS/${service}`,
      port: 4240,
      version: "0.8.0",
      running: { reachable: true, version: "0.8.0", error: null },
      packageVersion: "0.1.0",
      releaseVersion: "0.8.0",
      releaseStatus: "ready",
    }],
  };
}

function setup(options: {
  versions?: (services: readonly string[]) => Promise<ServiceVersionResult[]>;
  repoOrigin?: string | null;
  repoPath?: string;
  omitReader?: boolean;
} = {}) {
  const asked: string[][] = [];
  return {
    asked,
    app: serviceVersionsRouter({
      projectCodes,
      versions: options.omitReader ? undefined : {
        versions: async (services) => {
          asked.push([...services]);
          return options.versions
            ? options.versions(services)
            : services.map((service) => versionOf(service));
        },
      },
      inspectRepo: async (cwd) => {
        if (cwd.includes("broken")) throw new Error("cwd must be an absolute repository path");
        return {
          repoPath: options.repoPath ?? cwd,
          repoOrigin: options.repoOrigin === undefined ? "LUDIARS/Revisor" : options.repoOrigin,
        };
      },
    }),
  };
}

describe("GET /v1/service-versions", () => {
  it("明示指定した複数サービスの版を返す", async () => {
    const { app, asked } = setup();
    const res = await app.request("/?service=Rv&service=Cc");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("explicit");
    expect(body.requested).toEqual(["Revisor", "Concordia"]);
    expect(asked).toEqual([["Revisor", "Concordia"]]);
    expect(body.versions[0].services[0].version).toBe("0.8.0");
  });

  // 明示指定なしは「いまの関連プロジェクト」。 worktree でも origin で本体へ寄る。
  it("明示指定が無ければ現在地のプロジェクトを聞く", async () => {
    const { app, asked } = setup({ repoPath: "E:/Document/Ars/.worktrees/Revisor-x" });
    const res = await app.request("/?cwd=E%3A%2FDocument%2FArs%2F.worktrees%2FRevisor-x");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.scope).toBe("current_project");
    expect(asked).toEqual([["Revisor"]]);
  });

  // 何を聞きたいのか決まらないまま全サービスへ広げない。
  it("service も cwd も無ければ 400 で止める", async () => {
    const { app, asked } = setup();
    const res = await app.request("/");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("service_or_cwd_required");
    expect(asked).toEqual([]);
  });

  it("未登録のプロジェクトでは推測せず明示指定を促す", async () => {
    const { app } = setup({ repoOrigin: null, repoPath: "E:/Document/Ars/Unknown" });
    const res = await app.request("/?cwd=E%3A%2FDocument%2FArs%2FUnknown");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("project_not_registered");
  });

  it("cwd が repository でなければ 400", async () => {
    const { app } = setup();
    const res = await app.request("/?cwd=broken");
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("invalid_cwd");
  });

  // Revisor が正本なので、 届かないときに Cc が別経路で版を作らない。
  it("Revisor へ届かなければ 502 を返す", async () => {
    const { app } = setup({
      versions: async () => { throw new Error("connect ECONNREFUSED 127.0.0.1:4240"); },
    });
    const res = await app.request("/?service=Rv");
    expect(res.status).toBe(502);
    expect((await res.json()).error).toBe("revisor_request_failed");
  });

  it("版照会が未設定なら 503", async () => {
    const { app } = setup({ omitReader: true });
    const res = await app.request("/?service=Rv");
    expect(res.status).toBe(503);
  });
});
