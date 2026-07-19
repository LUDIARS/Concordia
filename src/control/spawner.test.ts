import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildSpawnIdentityEnv,
  CONCORDIA_SPAWN_CWD_MODE_ENV,
  CONCORDIA_SPAWN_ID_ENV,
  resolveSpawnCwd,
  resolveAgentHomeCwd,
  resolveCastraDefaultCwd,
  sanitizeSpawnEnv,
  validateProjectCwd,
} from "./spawner.js";

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

describe("project cwd three-out guard", () => {
  it("does not infer Castra from a workspace root", () => {
    expect(resolveCastraDefaultCwd("E:/Document/Ars", {})).toBe("");
    expect(resolveAgentHomeCwd("codex", undefined, "E:/Document/Ars")).toBeUndefined();
  });

  it("rejects omitted cwd and every configured workspace root", () => {
    expect(validateProjectCwd(undefined, ["E:/Document/Ars"])).toContain("project cwd is required");
    expect(validateProjectCwd("E:\\Document\\Ars", ["E:/Document/Ars"])).toContain("workspace root");
    expect(validateProjectCwd("E:/Document/Ars/Concordia", ["E:/Document/Ars"])).toBeNull();
  });
});

describe("sanitizeSpawnEnv (CWE-78 env 注入対策)", () => {
  it("allowlist prefix (LICTOR_ / CONCORDIA_) の key だけ通す", () => {
    expect(sanitizeSpawnEnv({ LICTOR_LOCAL_MODEL: "gemma4:12b" })).toEqual({
      LICTOR_LOCAL_MODEL: "gemma4:12b",
    });
    expect(sanitizeSpawnEnv({ CONCORDIA_FOO: "x" })).toEqual({ CONCORDIA_FOO: "x" });
  });

  it("危険な loader/実行系 env は全て捨てる", () => {
    expect(
      sanitizeSpawnEnv({
        NODE_OPTIONS: "--require=/tmp/evil.js",
        LD_PRELOAD: "/tmp/evil.so",
        PATH: "/tmp/evil",
        ELECTRON_RUN_AS_NODE: "1",
        DYLD_INSERT_LIBRARIES: "/tmp/evil.dylib",
      }),
    ).toEqual({});
  });

  it("allowlist key と危険 key の混在 → allowlist のみ残る", () => {
    expect(
      sanitizeSpawnEnv({ LICTOR_LOCAL_MODEL: "m", NODE_OPTIONS: "--require=x" }),
    ).toEqual({ LICTOR_LOCAL_MODEL: "m" });
  });

  it("undefined / 非文字列値は空または無視", () => {
    expect(sanitizeSpawnEnv(undefined)).toEqual({});
    expect(sanitizeSpawnEnv({ LICTOR_X: 1 as unknown as string })).toEqual({});
  });
});

describe("buildSpawnIdentityEnv", () => {
  it("marks an intentional cwd as provided", () => {
    expect(buildSpawnIdentityEnv({ cwd: "E:/Document/Ars/Lictor" }, "spawn-1")).toEqual({
      [CONCORDIA_SPAWN_ID_ENV]: "spawn-1",
      [CONCORDIA_SPAWN_CWD_MODE_ENV]: "provided",
    });
  });

  it("keeps default launcher cwd distinct from a caller-provided cwd", () => {
    expect(
      buildSpawnIdentityEnv(
        { cwd: "E:/Document/Ars/Castra", cwdProvided: false },
        "spawn-2",
      ),
    ).toEqual({
      [CONCORDIA_SPAWN_ID_ENV]: "spawn-2",
      [CONCORDIA_SPAWN_CWD_MODE_ENV]: "omitted",
    });
  });
});
