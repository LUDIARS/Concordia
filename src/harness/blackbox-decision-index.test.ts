/**
 * blackbox_decisions の (domain, id) 索引 (FS-11 P0-a) と /context の stats 専用経路 (FS-11 P0-b) の裏取り。
 * vitest は registry 共有 (isolate:false) でモジュールモックが効かないため、 実 DB + インスタンス spy で書く。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { BLACKBOX_DECISIONS_DOMAIN_ID_INDEX, ensureBlackboxDecisionDomainIdIndex } from "./blackbox-decision-index.js";
import { createHarnessBlackbox, HARNESS_BLACKBOX_DOMAINS } from "./blackbox-engine.js";
import { withMainPushAllowlist, type HarnessAction } from "./predicates.js";
import { evaluateAction } from "./session-gate.js";

const GATE = HARNESS_BLACKBOX_DOMAINS.gate;

/** @ludiars/blackbox の SqliteDecisionLedger.listRecent と同じ SQL (dist/store-sqlite.js)。 */
const LIST_RECENT_SQL = "SELECT * FROM blackbox_decisions WHERE domain = ? ORDER BY id DESC LIMIT ?";

afterEach(() => {
  vi.restoreAllMocks();
});

function planDetails(db: ReturnType<typeof makeTestDb>): string[] {
  const rows = db.prepare(`EXPLAIN QUERY PLAN ${LIST_RECENT_SQL}`).all(GATE, 50) as Array<{ detail: string }>;
  return rows.map((r) => r.detail);
}

describe("blackbox_decisions (domain, id) 索引", () => {
  it("createHarnessBlackbox の後は listRecent が新索引を使い、 TEMP B-TREE で並べ替えない", () => {
    const db = makeTestDb();
    createHarnessBlackbox(db);
    const details = planDetails(db);
    expect(details.some((d) => d.includes(BLACKBOX_DECISIONS_DOMAIN_ID_INDEX))).toBe(true);
    expect(details.some((d) => d.includes("TEMP B-TREE"))).toBe(false);
    expect(details.some((d) => /^SCAN\b/.test(d))).toBe(false);
  });

  it("何度 ensure しても索引は 1 本だけ (IF NOT EXISTS)", () => {
    const db = makeTestDb();
    createHarnessBlackbox(db);
    ensureBlackboxDecisionDomainIdIndex(db);
    createHarnessBlackbox(db);
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?")
      .all(BLACKBOX_DECISIONS_DOMAIN_ID_INDEX);
    expect(rows).toHaveLength(1);
  });
});

describe("HarnessBlackboxService.stats (stats 専用経路)", () => {
  it("snapshot を組まずに snapshot().stats と同じ値を返す", async () => {
    const db = makeTestDb();
    const service = createHarnessBlackbox(db);
    const action: HarnessAction = { tool: "Bash", command: "git push", branch: "main" };
    await service.decideGate({ action, editedRepos: [], verdict: evaluateAction(action, withMainPushAllowlist([])) });
    const expected = service.snapshot(GATE, 25).stats;
    const snapshotSpy = vi.spyOn(service, "snapshot");
    const stats = service.stats(GATE, 25);
    expect(snapshotSpy).not.toHaveBeenCalled();
    expect(stats).toEqual(expected);
  });
});
