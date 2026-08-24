import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildHeadlessCmdArgs,
  buildDirectSpawnCommand,
  buildSatellesArgs,
  buildSpawnIdentityEnv,
  escapeCmdArg,
  CONCORDIA_SPAWN_CWD_MODE_ENV,
  CONCORDIA_SPAWN_ID_ENV,
  currentSatellesCodexRuntime,
  currentSatellesLauncher,
  currentSatellesWslCodexBinary,
  currentSatellesWslDistro,
  currentSatellesWslUser,
  HEADLESS_SPAWN_PROVIDERS,
  isInteractiveSpawnPlatformSupported,
  resolveSpawnCwd,
  resolveAgentHomeCwd,
  resolveCastraDefaultCwd,
  sanitizeSpawnEnv,
  buildSessionSpawnEnvironment,
  SPAWN_PROVIDERS,
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

  it("rejects only an omitted cwd; workspace root (Castra) is an allowed Session cwd", () => {
    expect(validateProjectCwd(undefined, ["E:/Document/Ars"])).toContain("project cwd is required");
    // Castra (workspace root) itself is intentionally allowed as a Session cwd —
    // destructive git ops against it are guarded separately (session-work-policy.ts),
    // not by rejecting the cwd choice here.
    expect(validateProjectCwd("E:\\Document\\Ars", ["E:/Document/Ars"])).toBeNull();
    expect(validateProjectCwd("E:/Document/Ars/Concordia", ["E:/Document/Ars"])).toBeNull();
  });
});

describe("sanitizeSpawnEnv (CWE-78 env 注入対策)", () => {
  it("allowlist prefix と Claude thinking の専用 key だけ通す", () => {
    expect(sanitizeSpawnEnv({ LICTOR_LOCAL_MODEL: "gemma4:12b" })).toEqual({
      LICTOR_LOCAL_MODEL: "gemma4:12b",
    });
    expect(sanitizeSpawnEnv({ CONCORDIA_FOO: "x" })).toEqual({ CONCORDIA_FOO: "x" });
    expect(sanitizeSpawnEnv({ CLAUDE_CODE_DISABLE_THINKING: "1" })).toEqual({
      CLAUDE_CODE_DISABLE_THINKING: "1",
    });
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

describe("buildSessionSpawnEnvironment", () => {
  it("never passes Revisor service credentials to an interactive session", () => {
    const inherited = {
      CONCORDIA_REVISOR_WORKFLOW_TOKEN: "workflow-secret",
      CONCORDIA_REVISOR_TOKEN: "trigger-secret",
      concordia_revisor_workflow_token: "differently-cased-workflow-secret",
      concordia_revisor_token: "differently-cased-trigger-secret",
      KEEP: "yes",
    };
    const environment = buildSessionSpawnEnvironment(
      {
        provider: "codex",
        env: {
          CONCORDIA_REVISOR_WORKFLOW_TOKEN: "explicit-workflow-secret",
          CONCORDIA_REVISOR_TOKEN: "explicit-trigger-secret",
        },
      },
      inherited,
      "spawn-1",
    );

    expect(environment).toEqual(expect.objectContaining({
      KEEP: "yes",
      CONCORDIA_SPAWN_ID: "spawn-1",
    }));
    expect(environment).not.toHaveProperty("CONCORDIA_REVISOR_WORKFLOW_TOKEN");
    expect(environment).not.toHaveProperty("CONCORDIA_REVISOR_TOKEN");
    expect(environment).not.toHaveProperty("concordia_revisor_workflow_token");
    expect(environment).not.toHaveProperty("concordia_revisor_token");
  });

  it("codex-sdk + runtime既定(native): SATELLES_* を一切注入しない (完全後方互換)", () => {
    const environment = buildSessionSpawnEnvironment(
      { provider: "codex-sdk" },
      { KEEP: "yes" } as unknown as NodeJS.ProcessEnv,
      "spawn-native",
    );
    expect(environment).not.toHaveProperty("SATELLES_CODEX_RUNTIME");
    expect(environment).not.toHaveProperty("SATELLES_WSL_DISTRO");
    expect(environment).not.toHaveProperty("SATELLES_WSL_USER");
    expect(environment).not.toHaveProperty("SATELLES_WSL_CODEX_BINARY");
  });

  it("codex-sdk: operator の sandbox 制約を継承し、request からの権限上書きを拒否する", () => {
    const environment = buildSessionSpawnEnvironment(
      {
        provider: "codex-sdk",
        env: { SATELLES_CODEX_SANDBOX: "danger-full-access" },
      },
      { SATELLES_CODEX_SANDBOX: "workspace-write" } as unknown as NodeJS.ProcessEnv,
      "spawn-sandboxed",
    );
    expect(environment.SATELLES_CODEX_SANDBOX).toBe("workspace-write");
  });

  it("codex-sdk + runtime=wsl: SATELLES_* 4変数を子envに注入する", () => {
    const environment = buildSessionSpawnEnvironment(
      { provider: "codex-sdk" },
      {
        CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl",
        CONCORDIA_SATELLES_WSL_DISTRO: "Debian",
        CONCORDIA_SATELLES_WSL_USER: "dev",
        CONCORDIA_SATELLES_WSL_CODEX_BINARY: "/usr/local/bin/codex",
      } as unknown as NodeJS.ProcessEnv,
      "spawn-wsl",
    );
    expect(environment).toEqual(expect.objectContaining({
      SATELLES_CODEX_RUNTIME: "wsl",
      SATELLES_WSL_DISTRO: "Debian",
      SATELLES_WSL_USER: "dev",
      SATELLES_WSL_CODEX_BINARY: "/usr/local/bin/codex",
    }));
  });

  it("codex-sdk + runtime=wsl: 大文字小文字の異なる継承値で明示設定を上書きさせない", () => {
    const environment = buildSessionSpawnEnvironment(
      { provider: "codex-sdk" },
      {
        CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl",
        CONCORDIA_SATELLES_WSL_USER: "configured-user",
        satelles_wsl_user: "inherited-user",
      } as unknown as NodeJS.ProcessEnv,
      "spawn-wsl-case-insensitive",
    );
    expect(environment.SATELLES_WSL_USER).toBe("configured-user");
    expect(environment).not.toHaveProperty("satelles_wsl_user");
  });

  it("codex-sdk + runtime=wsl + 既定値: distro/user/binary は既定にフォールバック", () => {
    const environment = buildSessionSpawnEnvironment(
      { provider: "codex-sdk" },
      { CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl" } as unknown as NodeJS.ProcessEnv,
      "spawn-wsl-defaults",
    );
    expect(environment).toEqual(expect.objectContaining({
      SATELLES_CODEX_RUNTIME: "wsl",
      SATELLES_WSL_DISTRO: "Ubuntu",
      SATELLES_WSL_USER: "ubuntu",
      SATELLES_WSL_CODEX_BINARY: "codex",
    }));
  });

  it("codex-sdk 以外の provider は runtime=wsl でも SATELLES_* を混入しない", () => {
    const environment = buildSessionSpawnEnvironment(
      { provider: "claude" },
      { CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl" } as unknown as NodeJS.ProcessEnv,
      "spawn-claude",
    );
    expect(environment).not.toHaveProperty("SATELLES_CODEX_RUNTIME");
    expect(environment).not.toHaveProperty("SATELLES_WSL_DISTRO");
    expect(environment).not.toHaveProperty("SATELLES_WSL_USER");
    expect(environment).not.toHaveProperty("SATELLES_WSL_CODEX_BINARY");
  });

  it("不正な CONCORDIA_SATELLES_CODEX_RUNTIME は spawn env 構築時に例外", () => {
    expect(() =>
      buildSessionSpawnEnvironment(
        { provider: "codex-sdk" },
        { CONCORDIA_SATELLES_CODEX_RUNTIME: "linux" } as unknown as NodeJS.ProcessEnv,
        "spawn-bad-runtime",
      ),
    ).toThrow(/^invalid CONCORDIA_SATELLES_CODEX_RUNTIME \(expected "native" or "wsl"\)$/);
  });

  it("不正な distro/user/codex binary は spawn env 構築時に例外", () => {
    expect(() =>
      buildSessionSpawnEnvironment(
        { provider: "codex-sdk" },
        {
          CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl",
          CONCORDIA_SATELLES_WSL_DISTRO: "Ubuntu & calc.exe",
        } as unknown as NodeJS.ProcessEnv,
        "spawn-bad-distro",
      ),
    ).toThrow(/^unsafe character in CONCORDIA_SATELLES_WSL_DISTRO$/);
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

describe("codex-sdk (Satelles headless) spawn plumbing", () => {
  it("buildSatellesArgs: 委託 env があれば run、無ければ serve", () => {
    expect(
      buildSatellesArgs(
        {
          provider: "codex-sdk",
          args: ["--model", "gpt-5.6-sol", "--effort", "xhigh"],
          env: { CONCORDIA_DELEGATION_PROMPT_FILE: "E:/tmp/prompt.md" },
        },
        ["satelles"],
      ),
    ).toEqual(["satelles", "run", "--model", "gpt-5.6-sol", "--effort", "xhigh"]);
    expect(
      buildSatellesArgs({ provider: "codex-sdk", args: ["--model", "gpt-5.6"] }, ["satelles"]),
    ).toEqual(["satelles", "serve", "--model", "gpt-5.6"]);
  });

  it("currentSatellesLauncher: 既定は PATH の satelles、env でトークン列を差し替え", () => {
    expect(currentSatellesLauncher({} as NodeJS.ProcessEnv)).toEqual(["satelles"]);
    expect(
      currentSatellesLauncher({
        CONCORDIA_SATELLES_LAUNCHER: "node;E:/Document/Ars/Satelles/bin/satelles.mjs",
      } as NodeJS.ProcessEnv),
    ).toEqual(["node", "E:/Document/Ars/Satelles/bin/satelles.mjs"]);
    expect(
      currentSatellesLauncher({ CONCORDIA_SATELLES_LAUNCHER: " ; ; " } as NodeJS.ProcessEnv),
    ).toEqual(["satelles"]);
  });

  it("currentSatellesCodexRuntime: 既定 native、明示 wsl を受理、不正値は例外", () => {
    expect(currentSatellesCodexRuntime({} as NodeJS.ProcessEnv)).toBe("native");
    expect(
      currentSatellesCodexRuntime({ CONCORDIA_SATELLES_CODEX_RUNTIME: "wsl" } as NodeJS.ProcessEnv),
    ).toBe("wsl");
    expect(() =>
      currentSatellesCodexRuntime({ CONCORDIA_SATELLES_CODEX_RUNTIME: "docker" } as NodeJS.ProcessEnv),
    ).toThrow(/^invalid CONCORDIA_SATELLES_CODEX_RUNTIME \(expected "native" or "wsl"\)$/);
  });

  it("currentSatellesWslDistro/User/CodexBinary: 既定値と危険文字の拒否", () => {
    expect(currentSatellesWslDistro({} as NodeJS.ProcessEnv)).toBe("Ubuntu");
    expect(currentSatellesWslUser({} as NodeJS.ProcessEnv)).toBe("ubuntu");
    expect(currentSatellesWslCodexBinary({} as NodeJS.ProcessEnv)).toBe("codex");
    expect(
      currentSatellesWslDistro({ CONCORDIA_SATELLES_WSL_DISTRO: "Debian" } as NodeJS.ProcessEnv),
    ).toBe("Debian");
    expect(() =>
      currentSatellesWslUser({ CONCORDIA_SATELLES_WSL_USER: "user & whoami" } as NodeJS.ProcessEnv),
    ).toThrow(/^unsafe character in CONCORDIA_SATELLES_WSL_USER$/);
    expect(() =>
      currentSatellesWslCodexBinary(
        { CONCORDIA_SATELLES_WSL_CODEX_BINARY: "codex\ninject" } as NodeJS.ProcessEnv,
      ),
    ).toThrow(/^unsafe character in CONCORDIA_SATELLES_WSL_CODEX_BINARY$/);
  });

  it("buildHeadlessCmdArgs: wt.exe 経路と同じ escapeCmdArg で cmd.exe へ渡す", () => {
    const tokens = ["C:/Program Files/Satelles/satelles.cmd", "run", "--model", "gpt-5.6"];
    const args = buildHeadlessCmdArgs(tokens);
    expect(args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
    expect(args[3]).toBe(tokens.map(escapeCmdArg).join(" "));
    // 先頭が引用符でない = cmd.exe の `/s` (先頭と末尾の引用符を剥がす) に触れないので、
    // 空白入り launcher パスでも起動コマンドが壊れない。
    expect(args[3]?.startsWith('"')).toBe(false);
  });

  it("HEADLESS_SPAWN_PROVIDERS: codex-sdk のみ headless", () => {
    expect(HEADLESS_SPAWN_PROVIDERS.has("codex-sdk")).toBe(true);
    expect(HEADLESS_SPAWN_PROVIDERS.has("codex")).toBe(false);
    expect(SPAWN_PROVIDERS).toContain("codex-sdk");
  });
});

describe("macOS direct spawn plumbing", () => {
  it("marks Windows and macOS as supported interactive spawn platforms", () => {
    expect(isInteractiveSpawnPlatformSupported("win32")).toBe(true);
    expect(isInteractiveSpawnPlatformSupported("darwin")).toBe(true);
    expect(isInteractiveSpawnPlatformSupported("linux")).toBe(false);
  });

  it("keeps launcher, provider, and user args as separate argv tokens", () => {
    expect(
      buildDirectSpawnCommand(
        { provider: "codex", args: ["--model", "gpt-5.6-sol", "a & b"] },
        ["/usr/local/bin/node", "/workspace/Lictor/bin/lictor.mjs"],
      ),
    ).toEqual([
      "/usr/local/bin/node",
      "/workspace/Lictor/bin/lictor.mjs",
      "codex",
      "--model",
      "gpt-5.6-sol",
      "a & b",
    ]);
  });
});
