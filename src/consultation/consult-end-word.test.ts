import { describe, expect, it } from "vitest";
import { detectsConsultEndWord } from "./consult-end-word.js";

// 2026-10-03 neco 指示「相談窓口で終了と言われたら終了する」(tech-consultation.md §6.1)。
describe("detectsConsultEndWord", () => {
  it("accepts the one-word end forms with trailing punctuation", () => {
    for (const text of ["終了", "終了です", "終了します", "終わり", "おわり", "終わりです", "終了。", "終わり！", " 終了です! "]) {
      expect(detectsConsultEndWord(text)).toBe(true);
    }
  });

  it("rejects negations and mentions inside a sentence", () => {
    for (const text of ["終了しないで", "終了しない", "まだ終了は不要", "終了条件を教えて", "これで終わりですか", "終わりにしたい理由", ""]) {
      expect(detectsConsultEndWord(text)).toBe(false);
    }
  });
});
