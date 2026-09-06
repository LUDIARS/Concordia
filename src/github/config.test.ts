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
  it("reads the JSON array the settings registry writes", () => {
    // 設定 > すべて から保存すると kind: string-list は JSON で入る。 区切り文字として
    // 読むと `["nyangame"]` が 1 人の login になり、 本人が承認待ちへ落ちる。
    expect(parseActorList('["nyangame"]')).toEqual(["nyangame"]);
    expect(parseActorList('["Neco", "other"]')).toEqual(["neco", "other"]);
    expect(parseActorList("[]")).toEqual([]);
  });

  it("still reads the delimiter form that env uses", () => {
    expect(parseActorList("neco, other")).toEqual(["neco", "other"]);
  });

  it("fails closed when the JSON form is broken or contains non-strings", () => {
    expect(parseActorList('["neco", attacker')).toEqual([]);
    expect(parseActorList('["neco", 42]')).toEqual([]);
  });

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

describe("repository webhook secrets", () => {
  /** テスト値 (実物ではない)。 流出検査に引っかからない語形で置く。 */
  const REPO_SECRET = "repo-webhook-secret-value";
  const OTHER_REPO_SECRET = "other-repo-webhook-secret-value";
  const SHARED_SECRET = "shared-webhook-secret-value";

  it("リポジトリ別に別々の secret を持ち、 表記揺れを畳んで引ける", () => {
    const { db, config } = harness();
    config.setRepoWebhookSecret("LUDIARS/Concordia", REPO_SECRET);
    config.setRepoWebhookSecret("MELPOT/MakaiNuiPictor", OTHER_REPO_SECRET);

    // URL 表記でも小文字でも同じリポジトリとして引ける (project_codes 側は URL 表記)。
    expect(config.repoWebhookSecret("https://github.com/LUDIARS/Concordia.git")).toBe(REPO_SECRET);
    expect(config.repoWebhookSecret("ludiars/concordia")).toBe(REPO_SECRET);
    expect(config.repoWebhookSecret("MELPOT/MakaiNuiPictor")).toBe(OTHER_REPO_SECRET);
    expect(config.hasRepoWebhookSecret("LUDIARS/Concordia")).toBe(true);
    db.close();
  });

  it("平文で保存せず、 共通 secret とは別の値として持つ", () => {
    const { db, config } = harness();
    config.setWebhookSecret(SHARED_SECRET);
    config.setRepoWebhookSecret("LUDIARS/Concordia", REPO_SECRET);

    // 共通は「リポ別が無いとき」のフォールバックであって、 上書き関係にはしない。
    expect(config.webhookSecret()).toBe(SHARED_SECRET);
    expect(config.repoWebhookSecret("LUDIARS/Concordia")).toBe(REPO_SECRET);
    const raw = db.prepare("SELECT value FROM github_config WHERE key LIKE ?")
      .all("webhook_secret_enc:%") as Array<{ value: string }>;
    expect(raw).toHaveLength(1);
    expect(raw[0].value).not.toContain(REPO_SECRET);
    db.close();
  });

  it("未設定のリポジトリは null (呼び出し側が共通へ落ちる)", () => {
    const { db, config } = harness();
    expect(config.repoWebhookSecret("LUDIARS/Concordia")).toBeNull();
    expect(config.hasRepoWebhookSecret("LUDIARS/Concordia")).toBe(false);
    // 空の repo 名で「接頭辞だけのキー」を作らない。
    expect(config.repoWebhookSecret("")).toBeNull();
    expect(() => config.setRepoWebhookSecret("", REPO_SECRET)).toThrow();
    db.close();
  });

  it("削除はそのリポジトリだけを消す", () => {
    const { db, config } = harness();
    config.setRepoWebhookSecret("LUDIARS/Concordia", REPO_SECRET);
    config.setRepoWebhookSecret("MELPOT/MakaiNuiPictor", OTHER_REPO_SECRET);
    config.clearRepoWebhookSecret("LUDIARS/Concordia");

    expect(config.repoWebhookSecret("LUDIARS/Concordia")).toBeNull();
    expect(config.repoWebhookSecret("MELPOT/MakaiNuiPictor")).toBe(OTHER_REPO_SECRET);
    db.close();
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
      "github.trusted_actors": '["neco"]',
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
