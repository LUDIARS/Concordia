import { describe, expect, it, vi } from "vitest";
import { consultationTranscript, createConsultationClosure } from "./consult-closure-wiring.js";

describe("consultationTranscript", () => {
  it("相談者の発言 (Discord) と最終回答だけを並べ、 指令や途中の発言は渡さない", () => {
    const messages = {
      list: vi.fn(() => [
        { author_type: "user", author_platform: "discord", content: "Q", metadata: null },
        { author_type: "user", author_platform: null, content: "[Cc policy update] ...", metadata: null },
        { author_type: "task", author_platform: null, content: "task", metadata: null },
        { author_type: "assistant", author_platform: null, content: "考え中", metadata: { phase: "commentary" } },
        { author_type: "assistant", author_platform: null, content: "A", metadata: { phase: "final_answer" } },
      ]),
    };
    expect(consultationTranscript(messages as never, "sess-1")).toEqual([
      { role: "user", text: "Q" },
      { role: "assistant", text: "A" },
    ]);
  });
});

describe("createConsultationClosure", () => {
  function wiring(guild: unknown) {
    return createConsultationClosure({
      consultations: {} as never,
      publications: { listForConsultation: () => [] },
      sessionMessages: { list: () => [] },
      callConcordia: vi.fn(async () => ({ error: "boom" })),
      runHeadless: vi.fn(async () => ({ ok: true, stdout: "{}", exit_code: 0 })),
      confidentialTermsPath: "missing.json",
      projectNames: () => [],
      guild: () => guild as never,
      log: { info: vi.fn(), warn: vi.fn() },
    });
  }

  it("builds the closure service from the bot resources", () => {
    expect(wiring(null)).toBeDefined();
  });
});
