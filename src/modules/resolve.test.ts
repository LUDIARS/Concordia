/**
 * 台帳と実配線の突き合わせ。
 *
 * 目的は「無言の縮退をしない」こと。off にしたつもりが動いていた、embedded の
 * つもりが起動していなかった — どちらも気づけないまま運用が続くのが元の状態だった。
 */

import { describe, expect, it } from "vitest";
import { MODULE_MANIFEST, findModule, type ModuleMode } from "./manifest.js";
import { describeMismatches, resolveModules } from "./resolve.js";

/** 台帳のうち embedded で動きうるもの全部を「起動した」ことにする。 */
function allEmbedded(): string[] {
  return MODULE_MANIFEST.filter((m) => m.modes.includes("embedded")).map((m) => m.name);
}

describe("モジュール台帳", () => {
  it("名前が重複しない", () => {
    const names = MODULE_MANIFEST.map((m) => m.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("worker で動きうるモジュールは Excubitor code を持つ", () => {
    // worker と解決されたのに担当プロセスが分からないと、health も再起動も辿れない。
    const missing = MODULE_MANIFEST
      .filter((m) => m.modes.includes("worker") && !m.excubitorCode)
      .map((m) => m.name);
    // chat / workflow は worker 化の受け皿が未定なので、現状は例外として明示する。
    expect(missing).toEqual(["chat", "workflow"]);
  });

  it("off にできるモジュールは degraded_note を持つ", () => {
    // 何が止まり何が生き残るかを宣言しないと、運用が off を判断できない。
    for (const module of MODULE_MANIFEST.filter((m) => m.modes.includes("off"))) {
      expect(module.degradedNote.length, module.name).toBeGreaterThan(10);
    }
  });

  it("未知の名前を引いても throw しない", () => {
    expect(findModule("no-such-module")).toBeNull();
  });
});

describe("台帳と実配線の突き合わせ", () => {
  it("一致していれば不一致を出さない", () => {
    const resolved = resolveModules(
      (entry) => (entry.modeEnv ? "embedded" : entry.modes[0]),
      { startedEmbedded: allEmbedded() },
    );

    expect(describeMismatches(resolved)).toEqual([]);
  });

  it("embedded と解決されたのに起動していなければ報せる", () => {
    // 「起動したつもり」が最も気づきにくい。off にした覚えが無いのに動いていない。
    const resolved = resolveModules(
      (entry) => (entry.modeEnv ? "embedded" : entry.modes[0]),
      { startedEmbedded: allEmbedded().filter((name) => name !== "chat") },
    );

    expect(describeMismatches(resolved)).toEqual([
      "[module] chat: embedded と解決されたが backend 内で起動していない",
    ]);
  });

  it("off のはずが起動していれば報せる", () => {
    const resolved = resolveModules(
      (entry) => (entry.name === "cost" ? "off" : entry.modeEnv ? "embedded" : entry.modes[0]),
      { startedEmbedded: allEmbedded() },
    );

    expect(describeMismatches(resolved)).toEqual([
      "[module] cost: off と解決されたのに backend 内で起動している",
    ]);
  });

  it("台帳に無いモードへ解決されたら報せる", () => {
    const resolved = resolveModules(
      (entry) => (entry.name === "chat" ? ("invalid" as ModuleMode) : "off"),
      { startedEmbedded: ["core", "chat"] },
    );

    expect(describeMismatches(resolved)).toContain(
      "[module] chat: 解決されたモード invalid は台帳の modes (embedded/worker/off) に無い",
    );
  });

  it("modeEnv を持たないモジュールは台帳の先頭モードで固定される", () => {
    // core / control-jobs は環境変数で切り替えられない。 resolver が何を返しても
    // 台帳の宣言が勝つ (切り替えられないものを切り替えたことにしない)。
    const resolved = resolveModules(() => "off", { startedEmbedded: ["core"] });

    expect(resolved.find((m) => m.name === "core")?.mode).toBe("embedded");
    expect(resolved.find((m) => m.name === "control-jobs")?.mode).toBe("worker");
  });

  it("worker と解決されたのに Excubitor code が無ければ報せる", () => {
    const resolved = resolveModules(
      (entry) => (entry.name === "chat" ? "worker" : entry.modeEnv ? "embedded" : entry.modes[0]),
      { startedEmbedded: allEmbedded().filter((name) => name !== "chat") },
    );

    expect(describeMismatches(resolved)).toContain(
      "[module] chat: worker と解決されたが台帳に Excubitor code が無い",
    );
  });

  it("mismatches は常に配列で返る", () => {
    // キーの有無で分岐させると、呼び出し側が「不一致が無い」と「まだ調べていない」を
    // 取り違える。
    const resolved = resolveModules(
      (entry) => (entry.modeEnv ? "embedded" : entry.modes[0]),
      { startedEmbedded: allEmbedded() },
    );

    for (const module of resolved) expect(Array.isArray(module.mismatches)).toBe(true);
  });
});
