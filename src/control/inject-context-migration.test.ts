import { describe, expect, it } from "vitest";
import { migrateKnownContextFragment, stripKnownPersonaFragment } from "./inject-context-migration.js";
import { LEGACY_DOMAIN_REPORT } from "./major-inject-catalog.js";

describe("known context migration", () => {
  it("never edits arbitrary human wording or an unknown revision", () => {
    expect(migrateKnownContextFragment("session.work_policy", "My DDD instructions are intentional.")).toBeNull();
    expect(migrateKnownContextFragment("unknown", "DDD")).toBeNull();
  });

  it("separates only the exact legacy An lines and report from persona prose", () => {
    const old = "手動の前文\n- コードの配置・既存実装・影響範囲は **Anatomia の解析グラフ**から引きます\n  (`/anatomia-analyze` の supply → CLI の `find` / `where` / `context`)。 事前の調査報告は要りません。\n手動の後文\n" + LEGACY_DOMAIN_REPORT;
    const migrated = stripKnownPersonaFragment(old);
    expect(migrated).toContain("手動の前文");
    expect(migrated).toContain("手動の後文");
    expect(migrated).not.toContain("Anatomia");
    expect(migrated).not.toContain("Pf 仕様");
    expect(stripKnownPersonaFragment(old.replace("**Anatomia", "**独自Anatomia"))).toBeNull();
  });
});
