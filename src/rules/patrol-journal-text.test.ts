import { describe, expect, it } from "vitest";
import { journalText } from "./patrol-journal-text.js";

describe("journalText", () => {
  it("keeps Japanese text and removes external HTML/Markdown syntax", () => {
    expect(journalText("日本語\n 次の行")).toBe("日本語 次の行");
    expect(journalText('<img src=x onerror="alert(1)">')).toBe('&#60;img src=x onerror=&#34;alert(1)&#34;&#62;');
    expect(journalText('[link](javascript:alert(1)) `code` &lt;img&gt;'))
      .toBe('&#91;link&#93;(javascript:alert(1)) &#96;code&#96; &#38;lt;img&#38;gt;');
  });
});
