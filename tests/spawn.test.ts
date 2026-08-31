import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSpawnToken,
  extractBearer,
  readSpawnToken,
  spawnTokenPath,
  tokenMatches,
} from "../src/control/token.js";
import {
  buildConcordiaAddressEnv,
  buildWtArgs,
  escapeCmdArg,
  resolveAgentHomeCwd,
  resolveCastraDefaultCwd,
  resolveSpawnCwd,
  validateCwd,
} from "../src/control/spawner.js";
import { spawnRouter } from "../src/api/spawn.js";
import { TeamsRepo } from "../src/db/teams-repo.js";
import { makeTestDb } from "./helpers/db.js";

describe("spawn token", () => {
  let cwd: string;
  let savedEnv: string | undefined;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "concordia-spawn-"));
    savedEnv = process.env.CONCORDIA_SPAWN_TOKEN_PATH;
    delete process.env.CONCORDIA_SPAWN_TOKEN_PATH;
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
    if (savedEnv === undefined) delete process.env.CONCORDIA_SPAWN_TOKEN_PATH;
    else process.env.CONCORDIA_SPAWN_TOKEN_PATH = savedEnv;
  });

  it("spawnTokenPath defaults to cwd/.spawn.token", () => {
    expect(spawnTokenPath(cwd)).toBe(join(cwd, ".spawn.token"));
  });

  it("CONCORDIA_SPAWN_TOKEN_PATH overrides location", () => {
    process.env.CONCORDIA_SPAWN_TOKEN_PATH = "C:/tmp/other.token";
    expect(spawnTokenPath(cwd)).toBe("C:/tmp/other.token");
  });

  it("ensureSpawnToken generates 64-hex on first call, idempotent on next", () => {
    const a = ensureSpawnToken(cwd);
    expect(a).toMatch(/^[a-f0-9]{64}$/);
    expect(ensureSpawnToken(cwd)).toBe(a);
  });

  it("ensureSpawnToken rotates corrupt files", () => {
    ensureSpawnToken(cwd);
    writeFileSync(spawnTokenPath(cwd), "garbage", "utf8");
    const rotated = ensureSpawnToken(cwd);
    expect(rotated).toMatch(/^[a-f0-9]{64}$/);
    expect(rotated).not.toBe("garbage");
  });

  it("readSpawnToken returns null when missing or corrupt", () => {
    expect(readSpawnToken(cwd)).toBeNull();
    ensureSpawnToken(cwd);
    writeFileSync(spawnTokenPath(cwd), "not-hex", "utf8");
    expect(readSpawnToken(cwd)).toBeNull();
  });

  it("tokenMatches rejects mismatches", () => {
    // 実装は timingSafeEqual を使っているが timing 特性はテストで検証不能。
    // ここでは機能 (一致/不一致の判定) のみを確認する。
    const a = "a".repeat(64);
    expect(tokenMatches(a, a)).toBe(true);
    expect(tokenMatches(a, "b".repeat(64))).toBe(false);
    expect(tokenMatches(a, a.slice(0, 63))).toBe(false);
    expect(tokenMatches(a, "Z".repeat(64))).toBe(false);
    expect(tokenMatches(a, "")).toBe(false);
    expect(tokenMatches(a, null)).toBe(false);
  });

  it("extractBearer parses Authorization Bearer and X-Concordia-Token", () => {
    expect(extractBearer((h) => (h === "authorization" ? "Bearer abc" : null))).toBe("abc");
    expect(extractBearer((h) => (h === "authorization" ? "bearer xyz" : null))).toBe("xyz");
    expect(extractBearer((h) => (h === "x-concordia-token" ? "tok" : null))).toBe("tok");
    expect(extractBearer(() => null)).toBeNull();
    expect(extractBearer((h) => (h === "authorization" ? "Basic creds" : null))).toBeNull();
  });
});

describe("spawn arg builder", () => {
  // provider/args トークンは CWE-78 (cmd.exe メタ文字インジェクション) 対策の
  // escapeCmdArg で個別にエスケープしてから結合される (継続レビュー指摘)。
  // 期待値も同じ関数で組み立て、 エスケープ形式そのものへの依存を避ける。
  it("default tab mode", () => {
    expect(buildWtArgs({ provider: "claude" })).toEqual([
      "--window",
      "0",
      "new-tab",
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      `${escapeCmdArg("lictor")} ${escapeCmdArg("claude")} & exit 0`,
    ]);
  });

  it("window mode + codex + title + cwd + extra args", () => {
    expect(
      buildWtArgs({
        provider: "codex",
        mode: "window",
        title: "[Cx] test",
        cwd: "E:\\proj",
        args: ["--continue", "--model", "o3"],
      }),
    ).toEqual([
      "--window",
      "new",
      "new-tab",
      "--title",
      "[Cx] test",
      "-d",
      "E:\\proj",
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      `${["lictor", "codex", "--continue", "--model", "o3"].map(escapeCmdArg).join(" ")} & exit 0`,
    ]);
  });

  it("gemini provider produces `lictor gemini` argv", () => {
    expect(buildWtArgs({ provider: "gemini", mode: "tab" })).toEqual([
      "--window",
      "0",
      "new-tab",
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      `${escapeCmdArg("lictor")} ${escapeCmdArg("gemini")} & exit 0`,
    ]);
  });

  it("validateCwd accepts undefined + existing dir, rejects missing", () => {
    expect(validateCwd(undefined)).toBeNull();
    const tmp = mkdtempSync(join(tmpdir(), "concordia-spawn-cwd-"));
    expect(validateCwd(tmp)).toBeNull();
    rmSync(tmp, { recursive: true, force: true });
    const missing = join(tmpdir(), "concordia-nope-" + Date.now());
    expect(validateCwd(missing)).toMatch(/does not exist/);
  });

  describe("buildConcordiaAddressEnv", () => {
    it("stamps CONCORDIA_HOST / CONCORDIA_PORT from the listen address", () => {
      expect(buildConcordiaAddressEnv("127.0.0.1", 11111)).toEqual({
        CONCORDIA_HOST: "127.0.0.1",
        CONCORDIA_PORT: "11111",
      });
    });

    it("maps wildcard bind hosts to loopback (Lictor is same-host)", () => {
      expect(buildConcordiaAddressEnv("0.0.0.0", 11111).CONCORDIA_HOST).toBe("127.0.0.1");
      expect(buildConcordiaAddressEnv("::", 11111).CONCORDIA_HOST).toBe("127.0.0.1");
    });

    it("trims host and keeps explicit non-loopback hosts", () => {
      expect(buildConcordiaAddressEnv("  10.0.0.5  ", 18000)).toEqual({
        CONCORDIA_HOST: "10.0.0.5",
        CONCORDIA_PORT: "18000",
      });
    });

    it("omits empty host / non-positive port", () => {
      expect(buildConcordiaAddressEnv("", 11111)).toEqual({ CONCORDIA_PORT: "11111" });
      expect(buildConcordiaAddressEnv("127.0.0.1", 0)).toEqual({ CONCORDIA_HOST: "127.0.0.1" });
      expect(buildConcordiaAddressEnv("127.0.0.1", Number.NaN)).toEqual({
        CONCORDIA_HOST: "127.0.0.1",
      });
    });
  });

  describe("resolveSpawnCwd", () => {
    it("prefers requested cwd when it's a non-empty string", () => {
      const tmp = mkdtempSync(join(tmpdir(), "concordia-resolve-"));
      expect(resolveSpawnCwd(tmp, "/some/default")).toBe(tmp);
      rmSync(tmp, { recursive: true, force: true });
    });

    it("trims whitespace from requested cwd", () => {
      const tmp = mkdtempSync(join(tmpdir(), "concordia-resolve-"));
      expect(resolveSpawnCwd(`  ${tmp}  `, "")).toBe(tmp);
      rmSync(tmp, { recursive: true, force: true });
    });

    it("falls back to default when requested is empty/undefined and default exists", () => {
      const tmp = mkdtempSync(join(tmpdir(), "concordia-resolve-"));
      expect(resolveSpawnCwd(undefined, tmp)).toBe(tmp);
      expect(resolveSpawnCwd("", tmp)).toBe(tmp);
      expect(resolveSpawnCwd("   ", tmp)).toBe(tmp);
      expect(resolveSpawnCwd(null, tmp)).toBe(tmp);
      rmSync(tmp, { recursive: true, force: true });
    });

    it("returns undefined when default points at a missing dir", () => {
      const missing = join(tmpdir(), "concordia-resolve-missing-" + Date.now());
      expect(resolveSpawnCwd(undefined, missing)).toBeUndefined();
    });

    it("returns undefined when default is empty/whitespace", () => {
      expect(resolveSpawnCwd(undefined, "")).toBeUndefined();
      expect(resolveSpawnCwd(undefined, "   ")).toBeUndefined();
      expect(resolveSpawnCwd(undefined, undefined)).toBeUndefined();
    });

    it("requested non-string types are treated as missing", () => {
      const tmp = mkdtempSync(join(tmpdir(), "concordia-resolve-"));
      expect(resolveSpawnCwd(42, tmp)).toBe(tmp);
      expect(resolveSpawnCwd({}, tmp)).toBe(tmp);
      expect(resolveSpawnCwd([], tmp)).toBe(tmp);
      rmSync(tmp, { recursive: true, force: true });
    });
  });

  describe("resolveAgentHomeCwd", () => {
    it("does not infer workspace/Castra for Claude or Codex", () => {
      const root = mkdtempSync(join(tmpdir(), "concordia-castra-"));
      const castra = join(root, "Castra");
      mkdirSync(castra);
      try {
        expect(resolveCastraDefaultCwd(root)).toBe("");
        expect(resolveAgentHomeCwd("claude", undefined, root)).toBeUndefined();
        expect(resolveAgentHomeCwd("codex", undefined, root)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("keeps explicit cwd and rejects missing cwd for every provider", () => {
      const root = mkdtempSync(join(tmpdir(), "concordia-castra-"));
      const requested = mkdtempSync(join(tmpdir(), "concordia-requested-"));
      mkdirSync(join(root, "Castra"));
      try {
        expect(resolveAgentHomeCwd("claude", requested, root)).toBe(requested);
        expect(resolveAgentHomeCwd("gemini", undefined, root)).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(requested, { recursive: true, force: true });
      }
    });
  });
});

describe("spawn router (Hono)", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "concordia-spawn-router-"));
    process.env.CONCORDIA_SPAWN_TOKEN_PATH = join(cwd, ".spawn.token");
  });

  afterEach(() => {
    delete process.env.CONCORDIA_SPAWN_TOKEN_PATH;
    rmSync(cwd, { recursive: true, force: true });
  });

  it("GET /info is open and exposes token path + default_cwd", async () => {
    const app = spawnRouter({ cwd });
    const res = await app.request("/info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token_path: string;
      platform_supported: boolean;
      default_cwd: string;
    };
    expect(body.token_path).toBe(join(cwd, ".spawn.token"));
    expect(typeof body.platform_supported).toBe("boolean");
    expect(body.default_cwd).toBe("");
  });

  it("GET /info does not expose a workspace root as default_cwd", async () => {
    const app = spawnRouter({ cwd, resolveDefaultCwd: () => "D:\\LUDIARS" });
    const res = await app.request("/info");
    const body = (await res.json()) as { default_cwd: string };
    expect(body.default_cwd).toBe("");
  });

  it("POST / without token returns 401 with WWW-Authenticate", async () => {
    const app = spawnRouter({ cwd });
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ provider: "claude" }),
    });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate") ?? "").toMatch(/Bearer/);
  });

  it("POST / rejects unknown provider", async () => {
    const app = spawnRouter({ cwd });
    const token = readFileSync(join(cwd, ".spawn.token"), "utf8").trim();
    const res = await app.request("/", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "gpt-cli" }),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toMatch(/valid: claude, codex, codex-sdk, gemini/);
  });

  it("POST / rejects subsidiary-owned teams from the head-office endpoint", async () => {
    const db = makeTestDb();
    try {
      const teams = new TeamsRepo(db);
      const team = teams.create({ name: "Child", slug: "child", subsidiary_id: "sub-child" });
      const app = spawnRouter({ cwd, teams });
      const token = readFileSync(join(cwd, ".spawn.token"), "utf8").trim();

      const response = await app.request("/", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
        body: JSON.stringify({ provider: "claude", team: team.id }),
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "team_not_owned_by_head_office" });
    } finally {
      db.close();
    }
  });

});
