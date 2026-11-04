import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { verifyQsLockUpdate } from "../tools/qs-lock.mjs";

const before = JSON.parse(execFileSync("git", ["show", "d8244eb81f3a41b44ba55ec361516147ab19a8e6:package-lock.json"], { encoding: "utf8" }));
const after = JSON.parse(readFileSync(new URL("../package-lock.json", import.meta.url), "utf8"));

describe("qs の限定されたセキュリティ更新", () => {
  it("親レンジと他の依存情報を保った指定版更新を受理する", () => {
    expect(verifyQsLockUpdate(before, after)).toBe(true);
  });

  it.each(["parent", "other", "integrity"])("範囲外の変更を拒否する: %s", (change) => {
    const mutated = structuredClone(after);
    if (change === "parent") mutated.packages["node_modules/express"].dependencies.qs = "^7.0.0";
    if (change === "other") mutated.packages["node_modules/side-channel"].version = "9.0.0";
    if (change === "integrity") mutated.packages["node_modules/qs"].integrity = "sha512-invalid";
    expect(verifyQsLockUpdate(before, mutated)).toBe(false);
  });

  it("既に変更された基点を受理しない", () => {
    expect(verifyQsLockUpdate(after, after)).toBe(false);
  });
});
