import { describe, expect, it } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { DelegationRepo } from "../db/delegation-repo.js";
import { InjectManualsRepo } from "../db/inject-manuals-repo.js";
import { MajorInjectRepo } from "../db/major-inject-repo.js";
import { LEGACY_ANATOMIA_SEED_BLOCK, LEGACY_ANATOMIA_SEED_CALL_NAMES,
  plannedSeedTemplates, seedDelegationTemplates } from "../delegation/seed.js";
import { InjectSourceError, MajorInjectEditor } from "./major-inject-editor.js";

function fixture() {
  const db = makeTestDb();
  return new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), new DelegationRepo(db));
}

describe("major Inject editing", () => {
  it("exposes basic and additive extension metadata in both catalog and source detail", async () => {
    const editor = fixture();
    const basic = editor.list().find((item) => item.id === "session.work_policy");
    const extension = editor.list().find((item) => item.id === "session.context.ddd_report");
    expect(basic?.scope_kind).toBe("basic");
    expect(extension?.scope_kind).toBe("extension");
    expect(extension?.apply_when).toContain("DDD=true");
    expect((await editor.get("session.context.ddd_report")).apply_when).toBe(extension?.apply_when);
  });

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

  it("captures an existing manual as baseline and restores an older version as a new descendant", async () => {
    const db = makeTestDb();
    const manuals = new InjectManualsRepo(db);
    manuals.upsert("レビュー", "既存の人間編集");
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), manuals, new DelegationRepo(db));
    const initial = await editor.get("delegation.manual.review");
    expect(initial.history_version_id).toBeNull();
    const baseline = (await editor.history(initial.id)).versions[0]!;
    expect(baseline).toMatchObject({ actor: "unknown", change_kind: "baseline" });
    expect((await editor.historyVersion(initial.id, baseline.version_id)).version.content).toBe("既存の人間編集");
    const changed = await editor.put(initial.id, "新しい本文", initial.revision,
      { expectedVersionId: baseline.version_id });
    expect(changed.history_version_id).not.toBe(baseline.version_id);
    const restored = await editor.restoreVersion(initial.id, baseline.version_id,
      changed.revision, changed.history_version_id);
    expect(restored.content).toBe("既存の人間編集");
    const versions = (await editor.history(initial.id)).versions;
    expect(versions.map((item) => item.change_kind)).toEqual(["restore_version", "edit", "baseline"]);
    expect((await editor.historyVersion(initial.id, versions[2]!.version_id)).version.content).toBe("既存の人間編集");
  });

  it("rejects an outdated history version even when content revision returns to the same hash", async () => {
    const editor = fixture();
    const initial = await editor.get("delegation.manual.review");
    const baseline = (await editor.history(initial.id)).versions[0]!;
    const changed = await editor.put(initial.id, "temporary edit", initial.revision,
      { expectedVersionId: baseline.version_id });
    await editor.restoreVersion(initial.id, baseline.version_id, changed.revision, changed.history_version_id);
    await expect(editor.put(initial.id, "stale edit", initial.revision,
      { expectedVersionId: baseline.version_id })).rejects.toMatchObject({ code: "revision_conflict" });
  });

  it("commits an externally changed DB source before returning a usable conflict version", async () => {
    const db = makeTestDb();
    const manuals = new InjectManualsRepo(db);
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), manuals, new DelegationRepo(db));
    const id = "delegation.manual.review";
    const initial = await editor.get(id);
    const baseline = (await editor.history(id)).versions[0]!;
    manuals.upsert("レビュー", "外部で更新された本文");
    const conflict = await editor.put(id, "自分の本文", initial.revision,
      { expectedVersionId: baseline.version_id }).then(() => null, (error: unknown) => error as InjectSourceError);
    expect(conflict?.code).toBe("revision_conflict");
    const observed = conflict?.detail as { content: string; history_version_id: number };
    expect(observed.content).toBe("外部で更新された本文");
    const imported = (await editor.history(id)).versions[0]!;
    expect(imported.change_kind).toBe("external_import");
    expect(observed.history_version_id).toBe(imported.version_id);
    const current = await editor.get(id);
    expect(current.history_version_id).toBe(imported.version_id);
    const saved = await editor.put(id, "採用後の本文", current.revision,
      { expectedVersionId: current.history_version_id });
    expect(saved.content).toBe("採用後の本文");
    manuals.upsert("レビュー", "再度の外部更新");
    const restoreConflict = await editor.restore(id, saved.revision, saved.history_version_id)
      .then(() => null, (error: unknown) => error as InjectSourceError);
    expect(restoreConflict?.code).toBe("revision_conflict");
    const observedAgain = await editor.get(id);
    expect((restoreConflict?.detail as { history_version_id: number }).history_version_id)
      .toBe(observedAgain.history_version_id);
    expect((await editor.restore(id, observedAgain.revision, observedAgain.history_version_id)).content)
      .toBe(initial.content);
  });

  it("records same-content restoration and removes a builtin override to resume default tracking", async () => {
    const db = makeTestDb();
    const overrides = new MajorInjectRepo(db);
    const editor = new MajorInjectEditor(overrides, new InjectManualsRepo(db), new DelegationRepo(db));
    const initial = await editor.get("session.work_policy");
    const changed = await editor.put(initial.id, "temporary", initial.revision);
    const backToDefault = await editor.put(initial.id, initial.content, changed.revision);
    expect(overrides.get(initial.id)?.content).toBe(initial.content);
    const restored = await editor.restore(initial.id, backToDefault.revision, backToDefault.history_version_id);
    expect(overrides.get(initial.id)).toBeNull();
    expect(restored.history_version_id).not.toBe(backToDefault.history_version_id);
    expect((await editor.history(initial.id)).versions[0]?.change_kind).toBe("restore_default");
  });

  it("migrates only an untouched known seed prompt and retains its old text as baseline", async () => {
    const db = makeTestDb();
    const templates = new DelegationRepo(db);
    const planned = plannedSeedTemplates().find((item) => LEGACY_ANATOMIA_SEED_CALL_NAMES.has(item.call_name))!;
    const oldPrompt = planned.prompt_template + LEGACY_ANATOMIA_SEED_BLOCK;
    const row = templates.upsertTemplate({ ...planned, prompt_template: oldPrompt });
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), templates);
    editor.migrateKnownSeedTemplates({});
    expect(templates.findTemplate(row.id)?.prompt_template).toBe(planned.prompt_template);
    expect(templates.isTemplatePromptEdited(row.id)).toBe(false);
    const versions = (await editor.history(`delegation.template.${row.id}`)).versions;
    expect(versions.map((item) => item.change_kind)).toEqual(["context_migration", "baseline"]);
    expect((await editor.historyVersion(`delegation.template.${row.id}`, versions[1]!.version_id)).version.content)
      .toBe(oldPrompt);
  });

  it("leaves a manually edited seed template untouched", async () => {
    const db = makeTestDb();
    const templates = new DelegationRepo(db);
    const planned = plannedSeedTemplates().find((item) => LEGACY_ANATOMIA_SEED_CALL_NAMES.has(item.call_name))!;
    const row = templates.upsertTemplate({ ...planned, prompt_template: planned.prompt_template + LEGACY_ANATOMIA_SEED_BLOCK });
    templates.updateTemplate(row.id, { prompt_template: `${row.prompt_template}\nuser note` });
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), templates);
    editor.migrateKnownSeedTemplates({});
    expect(templates.findTemplate(row.id)?.prompt_template).toBe(`${row.prompt_template}\nuser note`);
    expect((await editor.history(`delegation.template.${row.id}`)).versions[0]?.change_kind).toBe("baseline");
  });

  it("protects an unmarked legacy or manual prompt that matches neither known seed version", async () => {
    const db = makeTestDb();
    const templates = new DelegationRepo(db);
    const planned = plannedSeedTemplates().find((item) => LEGACY_ANATOMIA_SEED_CALL_NAMES.has(item.call_name))!;
    const content = `${planned.prompt_template}\nOlder human wording`;
    const row = templates.createTemplate({ ...planned, prompt_template: content });
    expect(templates.isTemplatePromptEdited(row.id)).toBe(false);
    const editor = new MajorInjectEditor(new MajorInjectRepo(db), new InjectManualsRepo(db), templates);
    editor.migrateKnownSeedTemplates({});
    seedDelegationTemplates(templates, {});
    expect(templates.isTemplatePromptEdited(row.id)).toBe(true);
    expect(templates.findTemplate(row.id)?.prompt_template).toBe(content);
    const baseline = (await editor.history(`delegation.template.${row.id}`)).versions[0]!;
    expect(baseline.change_kind).toBe("baseline");
    expect((await editor.historyVersion(`delegation.template.${row.id}`, baseline.version_id)).version.content)
      .toBe(content);
  });
});
