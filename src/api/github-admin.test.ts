import { describe, expect, it } from "vitest";
import type { GithubActorRow } from "../db/github-actors-repo.js";
import type { GithubWorkflowConfig } from "../github/config.js";
import { normalizeRepoOrigin } from "../pr/normalize.js";
import { githubAdminRouter } from "./github-admin.js";

function config(repoSecrets: Record<string, string> = {}): GithubWorkflowConfig {
  const forRepo = (repoOrigin: string): string | null =>
    repoSecrets[normalizeRepoOrigin(repoOrigin).toLowerCase()] ?? null;
  return {
    label: () => "Cc",
    trustedActors: () => ["NECO"],
    pollIntervalMs: () => 300_000,
    baseBranch: () => "main",
    fixCallName: () => "github-issue-fix",
    webhookSecret: () => "never-return-this-secret",
    setWebhookSecret: () => {},
    clearWebhookSecret: () => {},
    repoWebhookSecret: forRepo,
    setRepoWebhookSecret: () => {},
    clearRepoWebhookSecret: () => {},
    hasRepoWebhookSecret: (repoOrigin: string) => forRepo(repoOrigin) !== null,
  };
}

/** テスト値 (実物ではない)。 */
const REPO_SECRET = "repo-webhook-secret-value";

const ACTOR: GithubActorRow = {
  login: "neco",
  display_login: "Neco",
  last_kind: "author",
  last_repo: "LUDIARS/Concordia",
  last_issue_number: 1426,
  seen_count: 1,
  first_seen_at: 1,
  last_seen_at: 2,
};

describe("GET /v1/admin/github", () => {
  it("returns the observed actor roster with case-insensitive trust state", async () => {
    let requestedLimit: number | null = null;
    const app = githubAdminRouter({
      config: config(),
      optedInProjects: () => [],
      actors: (limit) => {
        requestedLimit = limit;
        return [ACTOR];
      },
    });

    const response = await app.request("/");
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(requestedLimit).toBe(100);
    expect(body.actors).toEqual([{ ...ACTOR, trusted: true }]);
    expect(body.webhook_secret_set).toBe(true);
    expect(JSON.stringify(body)).not.toContain("never-return-this-secret");
  });

  it("リポジトリ別 secret の有無をプロジェクトごとに返し、値は返さない", async () => {
    const app = githubAdminRouter({
      config: config({ "ludiars/concordia": REPO_SECRET }),
      optedInProjects: () => [
        { code: "Cc", project: "Concordia", repo_origin: "https://github.com/LUDIARS/Concordia.git" },
        { code: "Mp", project: "MakaiNuiPictor", repo_origin: "https://github.com/MELPOT/MakaiNuiPictor.git" },
        { code: "X", project: "NoRemote", repo_origin: null },
      ],
    });

    const response = await app.request("/");
    const body = await response.json() as { projects: Array<{ code: string; webhook_secret_set: boolean }> };

    // 専用 secret を入れたリポだけ true。 remote 未登録は引きようがないので false。
    expect(body.projects.map((project) => [project.code, project.webhook_secret_set])).toEqual([
      ["Cc", true],
      ["Mp", false],
      ["X", false],
    ]);
    expect(JSON.stringify(body)).not.toContain(REPO_SECRET);
  });
});

describe("PUT/DELETE /v1/admin/github/webhook-secret", () => {
  /** set/clear の宛先だけを記録するルータ。 secret の値は保存しない。 */
  function recording() {
    const calls: Array<[string, string | null]> = [];
    const app = githubAdminRouter({
      config: {
        ...config(),
        setWebhookSecret: () => calls.push(["set:shared", null]),
        clearWebhookSecret: () => calls.push(["clear:shared", null]),
        setRepoWebhookSecret: (repoOrigin: string) => calls.push(["set:repo", repoOrigin]),
        clearRepoWebhookSecret: (repoOrigin: string) => calls.push(["clear:repo", repoOrigin]),
      },
      optedInProjects: () => [],
    });
    return { app, calls };
  }

  it("repo を渡すとリポジトリ別へ書き、 URL 表記は owner/name へ畳む", async () => {
    const { app, calls } = recording();

    const response = await app.request("/webhook-secret", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ repo: "https://github.com/LUDIARS/Concordia.git" }),
    });
    const body = await response.json() as { secret: string | null };

    expect(response.status).toBe(200);
    expect(calls).toEqual([["set:repo", "LUDIARS/Concordia"]]);
    // 生成した値はこの応答でだけ出す。
    expect(body.secret).toBeTruthy();
  });

  it("repo 省略なら共通 secret を書く", async () => {
    const { app, calls } = recording();

    const response = await app.request("/webhook-secret", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(200);
    expect(calls).toEqual([["set:shared", null]]);
  });

  it("owner/name へ畳めない repo は 400 で弾く (引かれない secret を作らない)", async () => {
    const { app, calls } = recording();

    for (const repo of ["not-a-repo", "C:/path/to/Repo"]) {
      const response = await app.request("/webhook-secret", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ repo }),
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_repo" });
    }
    expect(calls).toEqual([]);
  });

  /** 渡した値そのものを記録するルータ。 貼り付け経路だけが使う。 */
  function recordingValues() {
    const written: Array<[string, string]> = [];
    const app = githubAdminRouter({
      config: {
        ...config(),
        setWebhookSecret: (secret: string) => written.push(["shared", secret]),
        setRepoWebhookSecret: (repoOrigin: string, secret: string) => written.push([repoOrigin, secret]),
      },
      optedInProjects: () => [],
    });
    return { app, written };
  }

  it("渡した値をそのまま保存し、 応答では返さない (貼り付け経路)", async () => {
    const { app, written } = recordingValues();

    const response = await app.request("/webhook-secret", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: REPO_SECRET, repo: "https://github.com/LUDIARS/Concordia.git" }),
    });
    const body = await response.json() as { secret: string | null };

    expect(response.status).toBe(200);
    expect(written).toEqual([["LUDIARS/Concordia", REPO_SECRET]]);
    // 渡された値は相手が既に持っている。 返すと出す必要のない所へ写るだけ。
    expect(body.secret).toBeNull();
  });

  it("短すぎる secret は保存しない", async () => {
    const { app, written } = recordingValues();

    const response = await app.request("/webhook-secret", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret: "short", repo: "LUDIARS/Concordia" }),
    });

    expect(response.status).toBe(400);
    expect(written).toEqual([]);
  });

  it("削除は ?repo= の有無で宛先を分け、 畳めない repo は消さない", async () => {
    const { app, calls } = recording();

    expect((await app.request("/webhook-secret?repo=LUDIARS%2FConcordia", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/webhook-secret", { method: "DELETE" })).status).toBe(200);
    expect((await app.request("/webhook-secret?repo=not-a-repo", { method: "DELETE" })).status).toBe(400);

    expect(calls).toEqual([["clear:repo", "LUDIARS/Concordia"], ["clear:shared", null]]);
  });
});
