import { describe, expect, it } from "vitest";
import { makeOkfTags, normalizeTag, parseLlmOkf } from "./okf.js";

describe("OKF タグ", () => {
  it("タグの表記ゆれを畳む", () => {
    expect(normalizeTag(" #Rest API ")).toBe("rest-api");
    expect(normalizeTag("ＵＮＩＴＹ")).toBe("unity");
    expect(normalizeTag(" # ")).toBeNull();
  });
  it("重複を除き上限で切る。分類外の type は note", () => {
    const okf = makeOkfTags({ type: "unknown", title: " t ", tags: ["A", "a", "b", "c", "d", "e", "f", "g", "h"], roles: ["PM", "PM", " "] });
    expect(okf).toEqual({ type: "note", title: "t", domain: null, tags: ["a", "b", "c", "d", "e", "f", "g"], roles: ["PM"] });
  });
  it("LLM の応答から JSON を読み、タグが無ければ null", () => {
    expect(parseLlmOkf('結果\n```json\n{"type":"feature","domain":"Rendering","tags":["Vulkan"],"roles":["プログラマ"]}\n```', "題"))
      .toEqual({ type: "feature", title: "題", domain: "rendering", tags: ["vulkan"], roles: ["プログラマ"] });
    expect(parseLlmOkf('{"type":"feature","tags":[]}', "題")).toBeNull();
    expect(parseLlmOkf("壊れた応答", "題")).toBeNull();
  });
});
