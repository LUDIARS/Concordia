import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { applyMigrations } from "../db/schema.js";
import { AdminState } from "../admin/state.js";
import { resolveLictorLauncher } from "./lictor-launcher.js";
import { buildWtArgs } from "./spawner.js";

function admin(defaults?: { lictorDevPath?: string }) {
  const db = new Database(":memory:");
  applyMigrations(db);
  return new AdminState(db, defaults);
}

describe("resolveLictorLauncher", () => {
  it("auto (default) → bare lictor", () => {
    expect(resolveLictorLauncher(admin())).toEqual(["lictor"]);
  });

  it("dev → node <devPath>/bin/lictor.mjs", () => {
    const a = admin({ lictorDevPath: "E:\\Document\\Ars\\Lictor" });
    a.setLictorMode("dev");
    const out = resolveLictorLauncher(a);
    expect(out[0]).toBe("node");
    expect(out[1]).toMatch(/Lictor[\\/]bin[\\/]lictor\.mjs$/);
  });

  it("dev with empty path → falls back to bare lictor", () => {
    const a = admin();
    a.setLictorMode("dev");
    expect(resolveLictorLauncher(a)).toEqual(["lictor"]);
  });

  it("prod → configured exe", () => {
    const a = admin();
    a.setLictorMode("prod");
    a.setLictorProdExe("C:\\tools\\lictor.exe");
    expect(resolveLictorLauncher(a)).toEqual(["C:\\tools\\lictor.exe"]);
  });

  it("prod with empty exe → falls back to bare lictor", () => {
    const a = admin();
    a.setLictorMode("prod");
    expect(resolveLictorLauncher(a)).toEqual(["lictor"]);
  });
});

describe("buildWtArgs launcher injection", () => {
  it("default launcher is lictor", () => {
    const args = buildWtArgs({ provider: "claude" });
    expect(args.join(" ")).toContain("cmd.exe /d /s /c lictor claude");
  });

  it("custom launcher replaces the lictor token", () => {
    const args = buildWtArgs({ provider: "codex", cwd: "E:\\x" }, ["node", "E:\\Lictor\\bin\\lictor.mjs"]);
    expect(args).toContain("node");
    expect(args).toContain("E:\\Lictor\\bin\\lictor.mjs");
    // launcher の直後に provider が来る
    const i = args.indexOf("E:\\Lictor\\bin\\lictor.mjs");
    expect(args[i + 1]).toBe("codex");
  });
});
