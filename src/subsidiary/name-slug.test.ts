import { describe, it, expect, vi } from "vitest";
import {
  NAME_RE,
  slugifySubsidiaryName,
  buildSlugPrompt,
  parseSlugFromClaude,
  resolveSubsidiaryName,
} from "./name-slug.js";

describe("slugifySubsidiaryName", () => {
  it("正規 slug はそのまま", () => {
    expect(slugifySubsidiaryName("acme")).toBe("acme");
    expect(slugifySubsidiaryName("acme_corp-1")).toBe("acme_corp-1");
  });
  it("大文字/空白/記号を決定的に slug 化", () => {
    expect(slugifySubsidiaryName("Test Sub")).toBe("test-sub");
    expect(slugifySubsidiaryName("  Foo / Bar! ")).toBe("foo-bar");
  });
  it("数字始まりは s- を前置", () => {
    expect(slugifySubsidiaryName("123corp")).toBe("s-123corp");
  });
  it("slug 化できない (日本語のみ) は空", () => {
    expect(slugifySubsidiaryName("子会社")).toBe("");
    expect(slugifySubsidiaryName("")).toBe("");
  });
  it("生成物は必ず NAME_RE に合致", () => {
    for (const s of ["Test Sub", "123corp", "acme_corp-1", "@@@x@@@"]) {
      const out = slugifySubsidiaryName(s);
      if (out) expect(NAME_RE.test(out)).toBe(true);
    }
  });
});

describe("parseSlugFromClaude", () => {
  it("JSON から slug を取り出し再正規化", () => {
    expect(parseSlugFromClaude('{"slug":"tesuto-kogaisha"}')).toBe("tesuto-kogaisha");
    expect(parseSlugFromClaude('前置き\n{"slug":"Tesuto Sub"}\n後置き')).toBe("tesuto-sub");
  });
  it("不正出力は空", () => {
    expect(parseSlugFromClaude("not json")).toBe("");
    expect(parseSlugFromClaude('{"x":1}')).toBe("");
  });
});

describe("buildSlugPrompt", () => {
  it("名前と表示名を含む", () => {
    const p = buildSlugPrompt("子会社", "テスト");
    expect(p).toContain("子会社");
    expect(p).toContain("テスト");
    expect(p).toContain("slug");
  });
});

describe("resolveSubsidiaryName", () => {
  const noExist = () => false;

  it("既に正規 slug は補正しない (Haiku を呼ばない)", async () => {
    const runClaude = vi.fn();
    const r = await resolveSubsidiaryName("acme", undefined, { exists: noExist, runClaude });
    expect(r).toEqual({ name: "acme", normalized: false, source: "raw" });
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("ASCII は決定的に slug 化し Haiku を呼ばない", async () => {
    const runClaude = vi.fn();
    const r = await resolveSubsidiaryName("Test Sub", undefined, { exists: noExist, runClaude });
    expect(r.name).toBe("test-sub");
    expect(r.normalized).toBe(true);
    expect(r.source).toBe("slug");
    expect(runClaude).not.toHaveBeenCalled();
  });

  it("日本語は Haiku でローマ字 slug 化", async () => {
    const runClaude = vi.fn().mockResolvedValue({ ok: true, stdout: '{"slug":"tesuto-kogaisha"}', stderr: "" });
    const r = await resolveSubsidiaryName("テスト子会社", undefined, { exists: noExist, runClaude });
    expect(r).toEqual({ name: "tesuto-kogaisha", normalized: true, source: "haiku" });
    expect(runClaude).toHaveBeenCalledOnce();
  });

  it("Haiku 失敗時は表示名 slug に fallback", async () => {
    const runClaude = vi.fn().mockResolvedValue({ ok: false, stdout: "", stderr: "boom" });
    const warn = vi.fn();
    const r = await resolveSubsidiaryName("子会社", "My Branch", { exists: noExist, runClaude, log: { warn } });
    expect(r.name).toBe("my-branch");
    expect(r.source).toBe("slug");
    expect(warn).toHaveBeenCalled();
  });

  it("全て不能ならランダム fallback (必ず正規 slug)", async () => {
    const r = await resolveSubsidiaryName("子会社", "会社", { exists: noExist });
    expect(r.source).toBe("random");
    expect(NAME_RE.test(r.name)).toBe(true);
  });

  it("補正経路は自動一意化する", async () => {
    const taken = new Set(["test-sub", "test-sub-2"]);
    const r = await resolveSubsidiaryName("Test Sub", undefined, { exists: (n) => taken.has(n) });
    expect(r.name).toBe("test-sub-3");
  });
});
