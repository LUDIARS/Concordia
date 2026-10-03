import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import { DelegationRepo } from "./delegation-repo.js";
import { runMigrations } from "./migrator.js";
import { MIGRATIONS } from "./schema.js";

describe("migration 128 delegation-sol-6-1", () => {
  it("gpt-6-sol の委託テンプレートを gpt-6.1-sol にそろえ、ほかのモデルは触らない", () => {
    const db = new Database(":memory:");
    try {
      // runMigrations は渡した migration を全部当てるので、 127 までに絞って「128 適用前の DB」を作る。
      runMigrations(db, MIGRATIONS.filter((migration) => migration.version <= 127), 127);
      const repo = new DelegationRepo(db);
      // seed に無い (GUI で作った) テンプレートも対象 (2026-10-03 neco 指示「Delegation の Sol を 6.1 に」)。
      const custom = repo.createTemplate({ call_name: "notion-ai-note", title: "n", target_provider: "codex-sdk", model: "gpt-6-sol", prompt_template: "x" });
      const astra = repo.createTemplate({ call_name: "astra-mid", title: "a", target_provider: "codex", model: "gpt-6-astra", prompt_template: "x" });
      const pinned = repo.createTemplate({ call_name: "old-sol", title: "o", target_provider: "codex", model: "gpt-5.6-sol", prompt_template: "x" });

      runMigrations(db, MIGRATIONS, 128);

      expect(repo.findTemplate(custom.id)?.model).toBe("gpt-6.1-sol");
      expect(repo.findTemplate(astra.id)?.model).toBe("gpt-6-astra");
      expect(repo.findTemplate(pinned.id)?.model).toBe("gpt-5.6-sol");
    } finally {
      db.close();
    }
  });
});
