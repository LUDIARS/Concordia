import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { InjectManualsRepo } from "../db/inject-manuals-repo.js";
import { MajorInjectRepo } from "../db/major-inject-repo.js";
import { MajorInjectEditor } from "./major-inject-editor.js";

function fixture() {
  const db = makeTestDb();
  return new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), new DelegationRepo(db));
}

describe("major Inject editing", () => {
  it("uses a revision to reject stale saves and restores the builtin default", async () => {
    const editor = fixture();
    const initial = await editor.get("session.work_policy");
    const changed = await editor.put(initial.id, "確認済みの文面", initial.revision);
    expect(changed.content).toBe("確認済みの文面");
    await expect(editor.put(initial.id, "古い更新", initial.revision)).rejects.toMatchObject({
      code: "revision_conflict", status: 409,
    });
    const restored = await editor.restore(initial.id, changed.revision);
    expect(restored.content).toBe(initial.content);
  });

  it("validates required and unknown placeholders before saving", async () => {
    const editor = fixture();
    const source = await editor.get("session.process_guidance");
    await expect(editor.put(source.id, "本文", source.revision)).rejects.toMatchObject({
      code: "invalid_placeholders", detail: { missing: ["steps"] },
    });
    await expect(editor.put(source.id, "[[CC:steps]] [[CC:secret]]", source.revision)).rejects.toMatchObject({
      code: "invalid_placeholders", detail: { unknown: ["secret"] },
    });
  });

  it("updates the existing kind manual row without creating a second source", async () => {
    const editor = fixture();
    const source = await editor.get("delegation.manual.review");
    const changed = await editor.put(source.id, "レビュー手順", source.revision);
    expect(changed.content).toBe("レビュー手順");
    expect((await editor.get(source.id)).origin).toBe("inject_manuals");
  });
});
