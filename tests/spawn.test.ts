import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureSpawnToken,
  extractBearer,
  readSpawnToken,
  spawnTokenPath,
  tokenMatches,
} from "../src/control/token.js";
import { buildWtArgs, validateCwd } from "../src/control/spawner.js";
import { spawnRouter } from "../src/api/spawn.js";

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

  it("tokenMatches is constant-time and rejects mismatches", () => {
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
  it("default tab mode", () => {
    expect(buildWtArgs({ provider: "claude" })).toEqual([
      "--window",
      "0",
      "new-tab",
      "cmd.exe",
      "/d",
      "/s",
      "/c",
      "lictor",
      "claude",
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
      "lictor",
      "codex",
      "--continue",
      "--model",
      "o3",
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

  it("GET /info is open and exposes token path", async () => {
    const app = spawnRouter({ cwd });
    const res = await app.request("/info");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token_path: string; platform_supported: boolean };
    expect(body.token_path).toBe(join(cwd, ".spawn.token"));
    expect(typeof body.platform_supported).toBe("boolean");
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

  it("POST /preview with token returns the wt argv (dry-run, no spawn)", async () => {
    const app = spawnRouter({ cwd });
    const token = readFileSync(join(cwd, ".spawn.token"), "utf8").trim();
    const res = await app.request("/preview", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ provider: "claude", mode: "tab", title: "[Cr] preview" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { command: string[] };
    expect(body.command[0]).toBe("wt.exe");
    expect(body.command).toContain("--title");
    expect(body.command).toContain("[Cr] preview");
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
  });

  it("GET /recent is empty initially, populates after preview is skipped (only real /post adds)", async () => {
    const app = spawnRouter({ cwd });
    const token = readFileSync(join(cwd, ".spawn.token"), "utf8").trim();
    const res = await app.request("/recent", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { spawns: unknown[] };
    expect(Array.isArray(body.spawns)).toBe(true);
  });
});
