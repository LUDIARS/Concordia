import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "./schema.js";
import { PersonasRepo } from "./personas-repo.js";
import { seedPersonas, PERSONA_SEEDS } from "../personas/seeds.js";
import { makeTestDb } from "../../tests/helpers/db.js";

// ---- seed/assign/release テスト (tests/personas-repo.test.ts から統合) ----

describe("PersonasRepo", () => {
  let repo: PersonasRepo;
  beforeEach(() => {
    repo = new PersonasRepo(makeTestDb());
    seedPersonas(repo);
  });

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
    const db2 = makeTestDb();
    const r2 = new PersonasRepo(db2);
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

// ---- createGenerated / assign vs generated テスト (元々の co-located テスト) ----

let db: Database.Database;
let personas: PersonasRepo;

beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db);
  personas = new PersonasRepo(db);
  seedPersonas(personas);
});

afterEach(() => {
  db.close();
});

const DRAFT = {
  name: "テスト魂",
  display_name: "Concordia番",
  description: "Concordia を主戦場にするテスト気質.",
  traits: ["Concordia 中心", "テスト"],
  speech_style: "簡潔に話す.",
  skill_template: "# Persona: テスト魂\n...",
};

describe("PersonasRepo.createGenerated", () => {
  it("creates a generated persona and assigns it to the session", () => {
    const { persona, reused } = personas.createGenerated(DRAFT, "sess-1");
    expect(reused).toBe(false);
    expect(persona.id).toBe("gen-sess-1");
    expect(persona.generated).toBe(1);
    expect(persona.origin_session_id).toBe("sess-1");

    const active = personas.findActiveBySession("sess-1");
    expect(active?.persona_id).toBe("gen-sess-1");
  });

  it("upserts the same row on re-generation (no persona bloat)", () => {
    personas.createGenerated(DRAFT, "sess-1");
    const before = personas.list().length;
    const r2 = personas.createGenerated({ ...DRAFT, description: "更新後" }, "sess-1");
    expect(r2.reused).toBe(true);
    expect(personas.list().length).toBe(before); // 行数は増えない
    expect(personas.find("gen-sess-1")?.description).toBe("更新後");
  });

  it("switches a session from its seed persona to the generated one", () => {
    const seeded = personas.assign("sess-2");
    expect(seeded?.persona.generated).toBe(0);
    personas.createGenerated(DRAFT, "sess-2");
    const active = personas.findActiveBySession("sess-2");
    expect(active?.persona_id).toBe("gen-sess-2");
    // 旧 seed assignment は release されている (active は 1 件のみ)
    expect(personas.listActiveAssignments().filter((a) => a.session_id === "sess-2")).toHaveLength(1);
  });
});

describe("PersonasRepo.assign vs generated personas", () => {
  it("never hands a generated persona to another session via the random pool", () => {
    personas.createGenerated(DRAFT, "sess-1"); // gen-sess-1 を作る (origin = sess-1)
    personas.release("sess-1"); // free にしておく — それでも他人には配られないはず
    // 各回 release して seed プール (10体) を枯渔させない. gen は常に除外されるはず.
    for (let i = 0; i < 30; i++) {
      const a = personas.assign(`other-${i}`);
      expect(a).not.toBeNull();
      expect(a?.persona.id).not.toBe("gen-sess-1");
      expect(a?.persona.generated).toBe(0);
      personas.release(`other-${i}`);
    }
  });

  it("re-assigns the generated persona back to its origin session via history", () => {
    personas.createGenerated(DRAFT, "sess-1");
    personas.release("sess-1");
    const again = personas.assign("sess-1");
    expect(again?.persona.id).toBe("gen-sess-1"); // 履歴優先で本人には戻る
    expect(again?.reused).toBe(true);
  });
});
