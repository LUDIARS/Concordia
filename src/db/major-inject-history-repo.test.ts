import { expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { MajorInjectHistoryRepo } from "./major-inject-history-repo.js";

it("keeps immutable baseline and descendant content while file intents live in a separate journal", () => {
  const db = makeTestDb();
  const history = new MajorInjectHistoryRepo(db);
  const baseline = history.ensureBaseline("session.work_policy", "human text", "revision-1");
  expect(history.ensureBaseline("session.work_policy", "different default", "revision-2")).toEqual(baseline);
  const edited = history.append({ target_id: baseline.target_id, parent_version_id: baseline.version_id,
    revision: "revision-2", content: "new text", actor: "unknown", change_kind: "edit", created_at: 2,
    operation_id: null });
  expect(history.list(baseline.target_id, null, 10).map((version) => version.version_id))
    .toEqual([edited.version_id, baseline.version_id]);
  expect(history.version(baseline.target_id, baseline.version_id)?.content).toBe("human text");
  const fileBaseline = history.ensureBaseline("rules.session_work", "file text", "file-revision-1");
  history.addOperation({ operation_id: "file-op-1", target_id: "rules.session_work",
    parent_version_id: fileBaseline.version_id, expected_revision: "file-revision-1", desired_revision: "revision-2",
    content: "new text", actor: "unknown", change_kind: "edit", created_at: 3 });
  expect(history.pending("rules.session_work")?.status).toBe("pending");
  history.setOperationStatus("file-op-1", "uncertain", "file_outcome_unconfirmed");
  expect(history.pending("rules.session_work")?.status).toBe("uncertain");
  expect(history.list("rules.session_work", null, 10)).toEqual([fileBaseline]);
});
