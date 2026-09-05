import { describe, expect, it } from "vitest";
import {
  readFlagDefaultOff,
  readFlagDefaultOn,
  readPortEnv,
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

describe("readPortEnv", () => {
  it("未設定・空文字は undefined", () => {
    expect(readPortEnv(undefined, "ANATOMIA_PORT")).toBeUndefined();
    expect(readPortEnv("  ", "ANATOMIA_PORT")).toBeUndefined();
  });

  it("十進のポート番号を数値で返す", () => {
    expect(readPortEnv(" 4312 ", "ANATOMIA_PORT")).toBe(4312);
    expect(readPortEnv("1", "ANATOMIA_PORT")).toBe(1);
    expect(readPortEnv("65535", "ANATOMIA_PORT")).toBe(65_535);
  });

  it("範囲外・数値でない指定は黙って落とさず投げる", () => {
    for (const raw of ["0", "65536", "4312/path", "-1", "80.5", "0x50"]) {
      expect(() => readPortEnv(raw, "ANATOMIA_PORT")).toThrow("ANATOMIA_PORT");
    }
  });

  it("どのキーが壊れているかを文面に出す", () => {
    expect(() => readPortEnv("nope", "OTHER_PORT")).toThrow(
      "OTHER_PORT must be an integer between 1 and 65535",
    );
  });
});
