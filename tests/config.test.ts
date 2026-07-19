import { describe, it, expect } from "vitest";
import { loadConfig, isLoopbackHost } from "../src/shared/config.js";

describe("loadConfig spawnDefaultCwd resolution", () => {
  it("env CONCORDIA_SPAWN_DEFAULT_CWD が最優先", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "D:\\custom\\path",
      LUDIARS_ROOT: "D:\\LUDIARS",
    } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("D:\\custom\\path");
  });

  it("env の前後 whitespace は trim される", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "  D:\\custom\\path  ",
    } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("D:\\custom\\path");
  });

  it("CONCORDIA_SPAWN_DEFAULT_CWD 未設定なら LUDIARS_ROOT を spawn cwd に使わない", () => {
    const cfg = loadConfig({ LUDIARS_ROOT: "D:\\LUDIARS" } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("");
  });

  it("LUDIARS_ROOT は workspaceRoot として前後 whitespace を trim する", () => {
    const cfg = loadConfig({ LUDIARS_ROOT: "  E:/Document/Ars  " } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("");
    expect(cfg.workspaceRoot).toBe("E:/Document/Ars");
  });

  it("どちらの env も無ければ空 (ドライブを焼き込まない)", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("");
  });

  it("env が空文字でも LUDIARS_ROOT にフォールバックしない", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "",
      LUDIARS_ROOT: "D:\\LUDIARS",
    } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("");
  });

  it("workspaceRoot は CONCORDIA_WORKSPACE_ROOT > spawnDefaultCwd(=LUDIARS_ROOT)", () => {
    expect(loadConfig({ LUDIARS_ROOT: "D:\\LUDIARS" } as NodeJS.ProcessEnv).workspaceRoot).toBe("D:\\LUDIARS");
    expect(
      loadConfig({ LUDIARS_ROOT: "D:\\LUDIARS", CONCORDIA_WORKSPACE_ROOT: "D:\\OTHER" } as NodeJS.ProcessEnv).workspaceRoot,
    ).toBe("D:\\OTHER");
  });

  it("LUDIARS_ROOT があれば githubOrg は LUDIARS、 無ければ空", () => {
    expect(loadConfig({ LUDIARS_ROOT: "D:\\LUDIARS" } as NodeJS.ProcessEnv).githubOrg).toBe("LUDIARS");
    expect(loadConfig({} as NodeJS.ProcessEnv).githubOrg).toBe("");
  });
});

describe("loadConfig adminToken", () => {
  it("既定は空文字列", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    expect(cfg.adminToken).toBe("");
  });

  it("CONCORDIA_ADMIN_TOKEN を trim して読む", () => {
    const cfg = loadConfig({ CONCORDIA_ADMIN_TOKEN: "  s3cr3t  " } as NodeJS.ProcessEnv);
    expect(cfg.adminToken).toBe("s3cr3t");
  });
});

describe("loadConfig reaper lost grace", () => {
  it("defaults to five minutes", () => {
    expect(loadConfig({} as NodeJS.ProcessEnv).reaperLostGraceSec).toBe(300);
  });

  it("reads CONCORDIA_REAPER_LOST_GRACE_SEC", () => {
    expect(loadConfig({ CONCORDIA_REAPER_LOST_GRACE_SEC: "900" } as NodeJS.ProcessEnv).reaperLostGraceSec).toBe(900);
  });
});

describe("isLoopbackHost", () => {
  it("loopback とみなすもの", () => {
    for (const h of ["", "127.0.0.1", "127.1.2.3", "::1", "[::1]", "localhost", "LOCALHOST", "  127.0.0.1  "]) {
      expect(isLoopbackHost(h)).toBe(true);
    }
  });

  it("非 loopback とみなすもの", () => {
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", "0.0.0.0:11111"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
