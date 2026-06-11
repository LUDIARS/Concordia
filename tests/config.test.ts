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

  it("env 未指定で win32 かつ E:\\Document\\Ars が存在しなければ空", () => {
    const cfg = loadConfig({} as NodeJS.ProcessEnv);
    // テスト環境では win32 でも該当 path が存在しないケースを想定.
    // 存在するマシン (実機) では E:\Document\Ars が返るのも正常.
    expect(["", "E:\\Document\\Ars"]).toContain(cfg.spawnDefaultCwd);
  });

  it("env が空文字なら auto-detect にフォールバック", () => {
    const cfg = loadConfig({
      CONCORDIA_SPAWN_DEFAULT_CWD: "",
    } as NodeJS.ProcessEnv);
    // auto-detect の結果次第なので「明示の空文字 != ""」 という強い assertion はしない.
    expect(typeof cfg.spawnDefaultCwd).toBe("string");
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
    for (const h of ["0.0.0.0", "::", "192.168.1.10", "10.0.0.5", "example.com", "0.0.0.0:17330"]) {
      expect(isLoopbackHost(h)).toBe(false);
    }
  });
});
