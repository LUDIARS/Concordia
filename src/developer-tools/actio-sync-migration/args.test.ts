/** @implements spec/feature/task-workflow-v3.md — Actio task sync: migration M1-M6 dry-run (CC-TF-SYNC-06) */

import { describe, expect, it } from "vitest";
import { parseSyncMigrationArgs } from "./args.js";

const DEFAULTS = { dbPath: "C:/cc/concordia.db", out: "C:/out.json" };

describe("parseSyncMigrationArgs", () => {
  it("defaults to a dry run and takes endpoints from arguments or the environment", () => {
    expect(parseSyncMigrationArgs(["--actio-url", "http://a", "--rename", "LwP=LP"], { CONCORDIA_URL: "http://c" }, DEFAULTS))
      .toEqual({ actioUrl: "http://a", ccUrl: "http://c", dbPath: "C:/cc/concordia.db", out: "C:/out.json", renames: ["LwP=LP"], apply: null, plan: null });
  });

  it("requires endpoints instead of embedding ports", () => {
    expect(() => parseSyncMigrationArgs([], {}, DEFAULTS)).toThrow("excubitor.catalog.yaml");
  });

  it("applies only a reviewed plan", () => {
    const base = ["--actio-url", "http://a", "--cc-url", "http://c"];
    expect(() => parseSyncMigrationArgs([...base, "--apply", "M1"], {}, DEFAULTS)).toThrow("together");
    expect(parseSyncMigrationArgs([...base, "--apply", "M1,M2", "--plan", "p.json"], {}, DEFAULTS).apply).toEqual(new Set(["M1", "M2"]));
    expect(() => parseSyncMigrationArgs([...base, "--bogus"], {}, DEFAULTS)).toThrow("unknown argument");
  });
});
