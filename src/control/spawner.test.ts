import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveSpawnCwd } from "./spawner.js";

describe("resolveSpawnCwd", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "spawncwd-")); });
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

  it("requested の実在文字列をそのまま採用", () => {
    expect(resolveSpawnCwd(dir, undefined)).toBe(dir);
  });

  it("未展開の ${var} は無効扱い → defaultCwd (実在) へフォールバック", () => {
    // テンプレ default_cwd の展開漏れで "${target_repo}" が来ても wt に渡さない。
    expect(resolveSpawnCwd("${target_repo}", dir)).toBe(dir);
  });

  it("${var} で defaultCwd も無ければ undefined", () => {
    expect(resolveSpawnCwd("${target_repo}", undefined)).toBeUndefined();
    expect(resolveSpawnCwd("C:\\repo\\${name}", "")).toBeUndefined();
  });

  it("空/非文字列 requested は defaultCwd へ", () => {
    expect(resolveSpawnCwd("", dir)).toBe(dir);
    expect(resolveSpawnCwd(undefined, dir)).toBe(dir);
    expect(resolveSpawnCwd(null, dir)).toBe(dir);
  });

  it("defaultCwd が実在しなければ undefined", () => {
    expect(resolveSpawnCwd(undefined, join(dir, "does-not-exist"))).toBeUndefined();
  });
});
