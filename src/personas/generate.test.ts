import { describe, it, expect } from "vitest";
import { generatePersonaDraft } from "./generate.js";
import type { PersonaSignals } from "./signals.js";

function signals(over: Partial<PersonaSignals> = {}): PersonaSignals {
  return {
    session_id: "s1",
    role_label: "テスト魂",
    provider: "claude-code",
    repo_base: "Concordia",
    branch: "feat/x",
    current_task: "persona 実装",
    prompt_count: 2,
    edit_count: 9,
    dominant_tools: ["Bash", "Edit"],
    file_focus: ["test", "src"],
    voices: ["境野 詰"],
    chat_samples: ["[chitchat] 境野 詰: そこ穴ある"],
    ...over,
  };
}

describe("generatePersonaDraft (heuristic fallback)", () => {

  it("always returns a valid draft with all fields populated", async () => {
    const d = await generatePersonaDraft(signals());
    expect(d.name).toBeTruthy();
    expect(d.description).toBeTruthy();
    expect(d.speech_style).toBeTruthy();
    expect(d.traits.length).toBeGreaterThan(0);
    expect(d.skill_template).toContain("# Persona:");
  });

  it("reflects the repo and role in the heuristic persona", async () => {
    const d = await generatePersonaDraft(signals());
    expect(d.name).toBe("テスト魂");
    expect(d.display_name).toBe("Concordia番");
    expect(d.description).toContain("Concordia");
  });

  it("derives tempo from edit/prompt ratio", async () => {
    const fast = await generatePersonaDraft(signals({ prompt_count: 1, edit_count: 20 }));
    expect(fast.traits).toContain("手数で押す");
    const slow = await generatePersonaDraft(signals({ prompt_count: 10, edit_count: 1 }));
    expect(slow.traits).toContain("考えてから動く");
  });
});
