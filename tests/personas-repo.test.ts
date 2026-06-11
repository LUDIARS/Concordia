import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "./helpers/db.js";
import { PersonasRepo } from "../src/db/personas-repo.js";
import { seedPersonas, PERSONA_SEEDS } from "../src/personas/seeds.js";

function fresh(): PersonasRepo {
  const db = makeTestDb();
  return new PersonasRepo(db);
}

describe("PersonasRepo", () => {
  let repo: PersonasRepo;
  beforeEach(() => { repo = fresh(); seedPersonas(repo); });

  it("seeds all base personas", () => {
    const list = repo.list();
    expect(list).toHaveLength(PERSONA_SEEDS.length);
    expect(list.find((p) => p.id === "architect-sensei")?.name).toBe("アーキテクト先生");
  });

  it("seedPersonas is idempotent (insert OR IGNORE)", () => {
    seedPersonas(repo);
    seedPersonas(repo);
    expect(repo.list()).toHaveLength(PERSONA_SEEDS.length);
  });

  it("assign returns one persona and prevents duplicate active assignment", () => {
    const a = repo.assign("session-A", () => 0.0);
    expect(a).toBeTruthy();
    const personaId = a!.persona.id;

    // 別 session に同 persona は付かない (排他)
    const seen = new Set<string>([personaId]);
    for (let i = 0; i < PERSONA_SEEDS.length - 1; i++) {
      const r = repo.assign(`session-${i}`, () => 0.0);
      expect(r).toBeTruthy();
      expect(seen.has(r!.persona.id)).toBe(false);
      seen.add(r!.persona.id);
    }
  });

  it("assign returns null when all personas are taken", () => {
    for (let i = 0; i < PERSONA_SEEDS.length; i++) {
      expect(repo.assign(`s${i}`, () => 0.0)).toBeTruthy();
    }
    expect(repo.assign("overflow", () => 0.0)).toBeNull();
  });

  it("assign reuses existing assignment for same session", () => {
    const a = repo.assign("session-X", () => 0.0);
    const b = repo.assign("session-X", () => 0.0);
    expect(a!.persona.id).toBe(b!.persona.id);
    expect(b!.reused).toBe(true);
  });

  it("release frees the persona for re-assignment", () => {
    const a = repo.assign("session-X", () => 0.0)!;
    const released = repo.release("session-X");
    expect(released?.persona_id).toBe(a.persona.id);

    // 同 persona が別 session に取れる
    const taken = new Set<string>();
    for (let i = 0; i < PERSONA_SEEDS.length; i++) {
      taken.add(repo.assign(`s${i}`, () => 0.0)!.persona.id);
    }
    expect(taken.has(a.persona.id)).toBe(true);
  });

  it("re-assign returns the same persona that was previously assigned to the session", () => {
    // 最初の assign は rng=0.5 (10 個中 5 番目)
    const first = repo.assign("session-Y", () => 0.5)!;
    const firstId = first.persona.id;
    repo.release("session-Y");

    // 再 assign 時は rng が違っても 同じ persona が戻る
    const second = repo.assign("session-Y", () => 0.99)!;
    expect(second.persona.id).toBe(firstId);
    expect(second.reused).toBe(true);
  });

  it("falls back to a fresh persona when historical persona is taken", () => {
    const a = repo.assign("session-A", () => 0.5)!;
    repo.release("session-A");
    // 別 session が同 persona を奪う
    const stolen = repo.assign("session-B", () => 0.5)!;
    expect(stolen.persona.id).toBe(a.persona.id);
    // session-A が再 assign 要求 → 元 persona は taken なので別人格になる
    const reassign = repo.assign("session-A", () => 0.0)!;
    expect(reassign.persona.id).not.toBe(a.persona.id);
  });

  it("listActiveAssignments returns only active rows", () => {
    repo.assign("s1", () => 0.0);
    repo.assign("s2", () => 0.5);
    repo.release("s1");
    const active = repo.listActiveAssignments();
    expect(active).toHaveLength(1);
    expect(active[0].session_id).toBe("s2");
  });

  it("appendLearnedNote keeps recent 50 only", () => {
    const id = "architect-sensei";
    for (let i = 0; i < 60; i++) repo.appendLearnedNote(id, `note ${i}`);
    const p = repo.find(id)!;
    const arr = JSON.parse(p.learned_notes) as string[];
    expect(arr).toHaveLength(50);
    expect(arr[0]).toBe("note 10");
    expect(arr[49]).toBe("note 59");
  });

  it("appendFeedback + recentFeedback round-trip", () => {
    repo.appendFeedback({ persona_id: "handyman", session_id: "s1", kind: "session-end", delta: "control test" });
    repo.appendFeedback({ persona_id: "handyman", session_id: "s2", kind: "manual", delta: "edited" });
    const recent = repo.recentFeedback("handyman");
    expect(recent).toHaveLength(2);
    expect(recent[0].kind).toBe("manual");
  });

  it("update edits persona fields", () => {
    repo.update("speed-freak", { description: "now faster" });
    expect(repo.find("speed-freak")?.description).toBe("now faster");
  });

  it("seedPersonas seeds display_name for each persona", () => {
    expect(repo.find("test-soul")?.display_name).toBe("境野 詰");
    expect(repo.find("handyman")?.display_name).toBe("谷垣 段");
    // 10 seed すべてに非空 display_name が入っている
    for (const p of repo.list()) {
      expect(p.display_name).not.toBe("");
    }
  });

  it("update can patch display_name", () => {
    const ok = repo.update("test-soul", { display_name: "別名 太郎" });
    expect(ok).toBe(true);
    expect(repo.find("test-soul")?.display_name).toBe("別名 太郎");
  });

  it("seedPersonas backfills display_name on existing rows with empty display_name", () => {
    // 旧 DB を模擬: insertOrIgnore で display_name 空を入れた後、 seedPersonas で seed を上書き反映させる
    const db = makeTestDb();
    const r2 = new PersonasRepo(db);
    r2.insertOrIgnore({
      id: "test-soul",
      name: "テスト魂",
      description: "x",
      traits: "[]",
      speech_style: "x",
      skill_template: "x",
      // display_name は付けず空のまま
    });
    expect(r2.find("test-soul")?.display_name).toBe("");
    seedPersonas(r2);
    expect(r2.find("test-soul")?.display_name).toBe("境野 詰");
  });
});
