import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

  afterEach(() => {
    vi.unstubAllEnvs();
    db.close();
  });

  // env フォールバックは廃止。 出所が 2 系統あると「設定画面は設定済みなのに一部の
  // 経路だけ 401」という不整合になるため、 正本を DB 1 本に固定してある。
  it("env は読まない (未設定なら空文字)", () => {
    vi.stubEnv("CONCORDIA_REVISOR_WORKFLOW_TOKEN", "from-env");
    expect(resolveRevisorWorkflowToken(repo, box)).toBe("");

    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    expect(resolveRevisorWorkflowToken(repo, box)).toBe("from-db");
  });

  it("平文では保存しない (secret-box で暗号化)", () => {
    setRevisorConfig(repo, box, { workflowToken: "super-secret" });
    const stored = repo.get("workflow_token_enc");
    expect(stored).not.toBeNull();
    expect(stored).not.toContain("super-secret");
    // 復号すれば元に戻る。
    expect(resolveRevisorWorkflowToken(repo, box)).toBe("super-secret");
  });

  it("空文字でクリアすると未設定に戻る (env は拾わない)", () => {
    vi.stubEnv("CONCORDIA_REVISOR_WORKFLOW_TOKEN", "from-env");
    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    setRevisorConfig(repo, box, { workflowToken: "" });
    expect(resolveRevisorWorkflowToken(repo, box)).toBe("");
  });

  it("undefined は据え置き (誤って消さない)", () => {
    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    setRevisorConfig(repo, box, {});
    expect(resolveRevisorWorkflowToken(repo, box)).toBe("from-db");
  });

  it("status は値を返さず出所だけ示す (db か none の 2 値)", () => {
    vi.stubEnv("CONCORDIA_REVISOR_WORKFLOW_TOKEN", "x");
    expect(revisorConfigStatus(repo, box)).toEqual({ workflow_token_set: false, source: "none" });

    setRevisorConfig(repo, box, { workflowToken: "from-db" });
    const status = revisorConfigStatus(repo, box);
    expect(status).toEqual({ workflow_token_set: true, source: "db" });
    expect(JSON.stringify(status)).not.toContain("from-db");
  });
});
