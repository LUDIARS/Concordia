/** @implements SPEC-CONSULT-PROJECTLESS */
/**
 * C-1: only a whole utterance of 終了 / 終了です / 終了します / 終わり / おわり / 終わりです (with trailing 。!！)
 * is an end request; negations and mentions inside a sentence are not.
 */
const END_WORDS = new Set(["終了", "終了です", "終了します", "終わり", "おわり", "終わりです"]);

export default {
  post(result: unknown, text: unknown): boolean {
    if (typeof text !== "string") return result === false;
    const normalized = text.replace(/[\s　]+/g, "").replace(/[。.!！]+$/, "");
    return result === END_WORDS.has(normalized);
  },
};
