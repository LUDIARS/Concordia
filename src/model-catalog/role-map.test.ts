import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildRoleMap } from "./role-map.js";
import { defaultRoleMapPath, writeRoleMapFile } from "./role-map-file.js";
import { INITIAL_CLAUDE_ROLE_MODELS, INITIAL_ROLE_MODELS, type RoleSnapshot } from "./role-policy.js";

const snapshot = (role: string, modelId: string): RoleSnapshot => ({
  schemaVersion: 1, provider: "codex", role, modelId, revision: role, observedAt: "2026-11-18T00:00:00Z",
  expiresAt: "2026-11-19T00:00:00Z", source: "codex:model/list:v1", pinned: false,
  capabilities: { reasoningEfforts: ["medium"], inputModalities: ["text"] },
});

describe("buildRoleMap", () => {
  it("Codex は役割カタログの現在値、 Claude は系統ごとに sort_order 最小の有効行を採る", () => {
    const map = buildRoleMap({
      roles: [snapshot("sol", "gpt-7-sol"), snapshot("unknown", "gpt-x")],
      catalog: [
        { provider: "claude", model_id: "claude-opus-5-5", sort_order: 10, is_active: 1 },
        { provider: "claude", model_id: "claude-opus-6", sort_order: 5, is_active: 1 },
        { provider: "claude", model_id: "claude-sonnet-6", sort_order: 1, is_active: 0 },
        { provider: "codex", model_id: "claude-haiku-9", sort_order: 0, is_active: 1 },
      ],
      nowMs: Date.parse("2026-11-18T00:00:00Z"),
    });
    expect(map.roles.codex).toEqual({ ...INITIAL_ROLE_MODELS, sol: "gpt-7-sol" });
    expect(map.roles.claude).toEqual({ ...INITIAL_CLAUDE_ROLE_MODELS, opus: "claude-opus-6" });
    expect(map.generatedAt).toBe("2026-11-18T00:00:00.000Z");
  });
});

describe("role map file", () => {
  it("書き出し先は env 指定 > Windows の LOCALAPPDATA > XDG_STATE_HOME", () => {
    expect(defaultRoleMapPath({ LUDIARS_MODEL_ROLES_FILE: "x.json" }, "win32", "H")).toBe("x.json");
    expect(defaultRoleMapPath({ LOCALAPPDATA: "L" }, "win32", "H")).toBe(join("L", "LUDIARS", "model-roles.json"));
    expect(defaultRoleMapPath({}, "linux", "H")).toBe(join("H", ".local", "state", "ludiars", "model-roles.json"));
    expect(defaultRoleMapPath({ XDG_STATE_HOME: "S" }, "darwin", "H")).toBe(join("S", "ludiars", "model-roles.json"));
  });

  it("JSON を書き出し、 読み直せる", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-role-map-"));
    try {
      const path = join(dir, "nested", "model-roles.json");
      const map = buildRoleMap({ roles: [], catalog: [], nowMs: 0 });
      writeRoleMapFile(path, map);
      expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(map);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
