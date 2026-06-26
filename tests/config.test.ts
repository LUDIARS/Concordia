import { describe, it, expect } from "vitest";
import { loadConfig, isLoopbackHost } from "../src/shared/config.js";

describe("loadConfig spawnDefaultCwd resolution", () => {
  it("env CONCORDIA_SPAWN_DEFAULT_CWD が最優先", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "D:\\custom\\path",
    } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("D:\\custom\\path");
  });

  it("env の前後 whitespace は trim される", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "  D:\\custom\\path  ",
    } as NodeJS.ProcessEnv);
    expect(cfg.spawnDefaultCwd).toBe("D:\\custom\\path");
  });

  it("win32 + Ars dir 実在なら auto-detect で E:\\Document\\Ars", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv, { platform: "win32", exists: () => true });
    expect(cfg.spawnDefaultCwd).toBe("E:\\Document\\Ars");
  });

  it("win32 でも Ars dir が無ければ空", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv, { platform: "win32", exists: () => false });
    expect(cfg.spawnDefaultCwd).toBe("");
  });

  it("非 win32 では auto-detect しない", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv, { platform: "linux", exists: () => true });
    expect(cfg.spawnDefaultCwd).toBe("");
  });

  it("env が空文字なら auto-detect にフォールバック", () => {
    const cfg = loadConfig({ CONCORDIA_SPAWN_DEFAULT_CWD: "" } as NodeJS.ProcessEnv, { platform: "win32", exists: () => true });
    expect(cfg.spawnDefaultCwd).toBe("E:\\Document\\Ars");
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
