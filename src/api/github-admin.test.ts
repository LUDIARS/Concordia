import { describe, expect, it } from "vitest";
import type { GithubActorRow } from "../db/github-actors-repo.js";
import type { GithubWorkflowConfig } from "../github/config.js";
import { githubAdminRouter } from "./github-admin.js";

function config(): GithubWorkflowConfig {
  return {
    label: () => "Cc",
    trustedActors: () => ["NECO"],
    pollIntervalMs: () => 300_000,
    baseBranch: () => "main",
    fixCallName: () => "github-issue-fix",
    webhookSecret: () => "never-return-this-secret",
    setWebhookSecret: () => {},
    clearWebhookSecret: () => {},
  };
}

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
});
