import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../db/schema.js";
import { makeGithubConfigRepo } from "../db/github-config-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import { createGithubWorkflowConfig, parseActorList } from "./config.js";

function harness(overrides: Record<string, string> = {}, withBox = true) {
  const db = new Database(":memory:");
  applyMigrations(db);
  const values = new Map(Object.entries(overrides));
  const config = createGithubWorkflowConfig({
    store: { get: (key) => values.get(key) ?? null },
    config: makeGithubConfigRepo(db),
    secretBox: withBox ? new SecretBox(Buffer.alloc(32, 7)) : undefined,
    env: {},
  });
  return { db, config };
}

describe("parseActorList", () => {
  it("splits on commas, spaces and newlines and folds case", () => {
    expect(parseActorList("Neco, other\nthird")).toEqual(["neco", "other", "third"]);
  });

  it("drops the wildcard so the list can never mean everybody", () => {
    expect(parseActorList("*")).toEqual([]);
    expect(parseActorList("neco, *")).toEqual(["neco"]);
  });

  it("treats an unset value as an empty list", () => {
    expect(parseActorList(null)).toEqual([]);
  });
});

describe("createGithubWorkflowConfig", () => {
  it("falls back to the documented defaults", () => {
    const { db, config } = harness();
    expect(config.label()).toBe("Cc");
    expect(config.baseBranch()).toBe("main");
    expect(config.fixCallName()).toBe("github-issue-fix");
    expect(config.pollIntervalMs()).toBe(300_000);
    expect(config.webhookSecret()).toBeNull();
    db.close();
  });

  it("takes stored overrides", () => {
    const { db, config } = harness({
      "github.issue_label": "自動修正",
      "github.base_branch": "develop",
      "github.trusted_actors": "neco",
    });
    expect(config.label()).toBe("自動修正");
    expect(config.baseBranch()).toBe("develop");
    expect(config.trustedActors()).toEqual(["neco"]);
    db.close();
  });

  it("ignores a poll interval that would busy-loop", () => {
    const { db, config } = harness({ "github.poll_interval_min": "0" });
    expect(config.pollIntervalMs()).toBe(300_000);
    db.close();
  });

  it("stores the webhook secret encrypted and reads it back", () => {
    const { db, config } = harness();
    config.setWebhookSecret("shared-secret-value");
    const stored = db.prepare("SELECT value FROM github_config WHERE key = 'webhook_secret_enc'")
      .get() as { value: string };
    expect(stored.value).not.toContain("shared-secret-value");
    expect(config.webhookSecret()).toBe("shared-secret-value");
    config.clearWebhookSecret();
    expect(config.webhookSecret()).toBeNull();
    db.close();
  });

  it("refuses to store a secret without the secret box rather than writing plaintext", () => {
    const { db, config } = harness({}, false);
    expect(() => config.setWebhookSecret("shared-secret-value")).toThrow(/secret box/);
    db.close();
  });
});
