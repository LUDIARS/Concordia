import { describe, expect, it } from "vitest";
import {
  readFlagDefaultOff,
  readFlagDefaultOn,
  splitSemicolonList,
  stripTrailingSlashes,
  trimmedEnv,
} from "./env-parse.js";

describe("trimmedEnv", () => {
  it("未設定と空文字と空白のみを undefined に揃える", () => {
    expect(trimmedEnv(undefined)).toBeUndefined();
    expect(trimmedEnv("")).toBeUndefined();
    expect(trimmedEnv("   ")).toBeUndefined();
  });

  it("前後空白を落として返す", () => {
    expect(trimmedEnv("  E:\\Document\\Ars  ")).toBe("E:\\Document\\Ars");
  });
});

describe("readFlagDefaultOn", () => {
  it('"0" のときだけ OFF', () => {
    expect(readFlagDefaultOn("0")).toBe(false);
    expect(readFlagDefaultOn(undefined)).toBe(true);
    expect(readFlagDefaultOn("")).toBe(true);
    expect(readFlagDefaultOn("1")).toBe(true);
    expect(readFlagDefaultOn("false")).toBe(true);
  });
});

describe("readFlagDefaultOff", () => {
  it('"1" のときだけ ON', () => {
    expect(readFlagDefaultOff("1")).toBe(true);
    expect(readFlagDefaultOff(undefined)).toBe(false);
    expect(readFlagDefaultOff("")).toBe(false);
    expect(readFlagDefaultOff("0")).toBe(false);
    expect(readFlagDefaultOff("true")).toBe(false);
  });
});

describe("splitSemicolonList", () => {
  it("trim して空要素を落とす", () => {
    expect(splitSemicolonList(" a ; ; b;")).toEqual(["a", "b"]);
  });

  it("未設定・空は空配列", () => {
    expect(splitSemicolonList(undefined)).toEqual([]);
    expect(splitSemicolonList("")).toEqual([]);
  });
});

describe("stripTrailingSlashes", () => {
  it("末尾スラッシュを全て落とす", () => {
    expect(stripTrailingSlashes("http://h:1///")).toBe("http://h:1");
    expect(stripTrailingSlashes("http://h:1")).toBe("http://h:1");
  });
});
