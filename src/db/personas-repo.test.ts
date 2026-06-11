import { describe, it, expect, beforeEach } from "vitest";
import { makeTestDb } from "../../tests/helpers/db.js";
import { PersonasRepo } from "./personas-repo.js";
import { seedPersonas } from "../personas/seeds.js";

let db: ReturnType<typeof makeTestDb>;
let personas: PersonasRepo;

beforeEach(() => {
  db = makeTestDb();
  personas = new PersonasRepo(db);
  seedPersonas(personas);
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
    // 各回 release して seed プール (10体) を枯渇させない. gen は常に除外されるはず.
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
