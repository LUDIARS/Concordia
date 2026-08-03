import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { makeRevisorConfigRepo } from "../db/revisor-config-repo.js";
import { SecretBox } from "../shared/secret-box.js";
import {
  resolveRevisorWorkflowToken,
  revisorConfigStatus,
  setRevisorConfig,
} from "./revisor-config.js";

const box = new SecretBox(Buffer.alloc(32, 7));

describe("revisor workflow token config", () => {
  let repo: ReturnType<typeof makeRevisorConfigRepo>;
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(":memory:");
    applyMigrations(db);
    repo = makeRevisorConfigRepo(db);
  });

  afterEach(() => db.close());

  it("DB 値を優先し、 無ければ env にフォールバックする", () => {
    const env = { CONCORDIA_REVISOR_WORKFLOW_TOKEN: "from-env" };
    expect(resolveRevisorWorkflowToken(repo, box, env)).toBe("from-env");

    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    expect(resolveRevisorWorkflowToken(repo, box, env)).toBe("from-db");
  });

  it("平文では保存しない (secret-box で暗号化)", () => {
    setRevisorConfig(repo, box, { workflowToken: "super-secret" });
    const stored = repo.get("workflow_token_enc");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("super-secret");
    // 復号すれば元に戻る。
    expect(resolveRevisorWorkflowToken(repo, box, {})).toBe("super-secret");
  });

  it("空文字でクリアすると env フォールバックに戻る", () => {
    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    setRevisorConfig(repo, box, { workflowToken: "" });
    expect(resolveRevisorWorkflowToken(repo, box, { CONCORDIA_REVISOR_WORKFLOW_TOKEN: "from-env" }))
      .toBe("from-env");
  });

  it("undefined は据え置き (誤って消さない)", () => {
    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    setRevisorConfig(repo, box, {});
    expect(resolveRevisorWorkflowToken(repo, box, {})).toBe("from-db");
  });

  it("status は値を返さず出所だけ示す", () => {
    expect(revisorConfigStatus(repo, box, {})).toEqual({ workflow_token_set: false, source: "none" });
    expect(revisorConfigStatus(repo, box, { CONCORDIA_REVISOR_WORKFLOW_TOKEN: "x" }))
      .toEqual({ workflow_token_set: true, source: "env" });

    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    const status = revisorConfigStatus(repo, box, {});
    expect(status).toEqual({ workflow_token_set: true, source: "db" });
    expect(JSON.stringify(status)).not.toContain("from-db");
  });
});
