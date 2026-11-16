import { describe, expect, it } from "vitest";
import { parseBulkCommand } from "./bulk-command.js";

describe("parseBulkCommand", () => {
  it("reads a bulk instruction for every active session", () => {
    expect(parseBulkCommand("一括: 今の状況を報告してください")).toEqual({ projectCodes: [], text: "今の状況を報告してください" });
    expect(parseBulkCommand("一括指示：手を止めて待機")).toEqual({ projectCodes: [], text: "手を止めて待機" });
  });

  it("reads project code filters", () => {
    expect(parseBulkCommand("一括[Cc, At]: main を取り込んで")).toEqual({ projectCodes: ["Cc", "At"], text: "main を取り込んで" });
    expect(parseBulkCommand("一括指示［Cc、Cc］：x")).toEqual({ projectCodes: ["Cc"], text: "x" });
  });

  it("treats other posts as status questions", () => {
    expect(parseBulkCommand("今止まっているのは？")).toBeNull();
    expect(parseBulkCommand("一括で止めて")).toBeNull();
    expect(parseBulkCommand("一括:   ")).toBeNull();
  });
});
