/** @implements CC-TASK-LINKED-FOLLOWUP — 関連付けできなかった参照の記録 */
import { describe, expect, it } from "vitest";
import type { SessionsRepo } from "../db/sessions-repo.js";
import { clearTaskLinkFailure, readTaskLinkFailures, recordTaskLinkFailure, SESSION_TASK_LINK_FAILURES_KEY } from "./task-link-failures.js";

function repo() {
  let metadata: Record<string, unknown> = { keep: 1 };
  const sessions = { updateMetadata: (_id: string, update: (m: Record<string, unknown>) => Record<string, unknown>) => { metadata = update(metadata); } };
  return { sessions: sessions as Pick<SessionsRepo, "updateMetadata">, metadata: () => JSON.stringify(metadata) };
}

describe("task link failures", () => {
  it("keeps the latest reason per reference and only the most recent few", () => {
    const r = repo();
    recordTaskLinkFailure(r.sessions, "s", { task_reference: "actio:A", reason: "not_found", at: 1 });
    recordTaskLinkFailure(r.sessions, "s", { task_reference: "actio:A", reason: "task_out_of_scope", at: 2 });
    expect(readTaskLinkFailures(r.metadata())).toEqual([{ task_reference: "actio:A", reason: "task_out_of_scope", at: 2 }]);
    for (const id of ["B", "C", "D", "E"]) recordTaskLinkFailure(r.sessions, "s", { task_reference: `actio:${id}`, reason: "not_found", at: 3 });
    expect(readTaskLinkFailures(r.metadata()).map((item) => item.task_reference)).toEqual(["actio:B", "actio:C", "actio:D", "actio:E"]);
    expect(JSON.parse(r.metadata()).keep).toBe(1);
  });

  it("ignores broken records and removes the key when the last failure is cleared", () => {
    expect(readTaskLinkFailures("not json")).toEqual([]);
    expect(readTaskLinkFailures(JSON.stringify({ [SESSION_TASK_LINK_FAILURES_KEY]: [{ task_reference: 1 }, { task_reference: "actio:A", reason: "task_unavailable", at: 1 }] }))).toEqual([]);
    const metadata = { keep: 1, [SESSION_TASK_LINK_FAILURES_KEY]: [{ task_reference: "actio:A", reason: "not_found", at: 1 }] };
    expect(clearTaskLinkFailure(metadata, "actio:A")).toEqual({ keep: 1 });
    expect(clearTaskLinkFailure({ keep: 1 }, "actio:A")).toEqual({ keep: 1 });
  });
});
