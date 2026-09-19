import { describe, expect, it } from "vitest";
import { submittedPrStateReader } from "../../src/harness/reliability/task-branch-merge-state.js";
import type { PrRecordRow } from "../../src/db/pr-records-repo.js";
import type { RevisorLocalPr } from "../../src/pr/revisor-client.js";

function localPr(id: string, status: string): RevisorLocalPr {
  return { id, number: 1, repository: "LUDIARS/Excubitor", title: "fixture", author: "session", status,
    checkStatus: "test_ok", headRef: "fix/x", baseRef: "main", headSha: "abc",
    createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z" };
}

describe("submittedPrStateReader (TB-MERGED の正本照会)", () => {
  it("reads a Revisor local PR by id", async () => {
    const read = submittedPrStateReader({ revisor: { listLocalPrs: async () => [localPr("a", "merged"), localPr("b", "open")] } });
    expect(await read("a")).toBe("merged");
    expect(await read("b")).toBe("unmerged");
    expect(await read("missing")).toBe("unknown");
  });

  it("treats an unreadable, slow or unconfigured Revisor as unknown", async () => {
    expect(await submittedPrStateReader({ revisor: { listLocalPrs: async () => { throw new Error("down"); } } })("a")).toBe("unknown");
    expect(await submittedPrStateReader({ revisor: { listLocalPrs: () => new Promise(() => {}) }, timeoutMs: 20 })("a")).toBe("unknown");
    expect(await submittedPrStateReader({})("a")).toBe("unknown");
  });

  it("reads GitHub PRs from pr_records by URL and by short reference", async () => {
    const rows: Record<string, Pick<PrRecordRow, "state">> = {
      "LUDIARS/Concordia#12": { state: "merged" },
      "LUDIARS/Concordia#13": { state: "closed" },
    };
    const prs = { findByKey: (origin: string, number: number) => (rows[`${origin}#${number}`] ?? null) as unknown as PrRecordRow | null };
    const read = submittedPrStateReader({ prs });
    expect(await read("https://github.com/LUDIARS/Concordia/pull/12")).toBe("merged");
    expect(await read("LUDIARS/Concordia#12")).toBe("merged");
    expect(await read("LUDIARS/Concordia#13")).toBe("unmerged");
    expect(await read("LUDIARS/Concordia#14")).toBe("unknown");
  });
});
