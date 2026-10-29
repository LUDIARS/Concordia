import { expect, it, vi } from "vitest";
import { runStatusPreflightCli } from "./status-preflight-cli.js";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

// vite-node does not provide import.meta.resolve; resolve the tsx loader through Node instead.
const tsxLoader = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

it("reads the specified file once, emits only metadata and uses exit 0/1", async () => {
  const read = vi.fn(async () => JSON.stringify({ status: "failed", result: "秘密" }));
  expect(await runStatusPreflightCli(["報告.json"], read)).toEqual({ exitCode: 0,
    stdout: '{"valid":true,"issues":[]}\n', stderr: "" });
  expect(read).toHaveBeenCalledExactlyOnceWith("報告.json");
  const rejected = await runStatusPreflightCli(["報告.json"], async () => '{"secret":');
  expect(rejected.exitCode).toBe(1);
  expect(rejected.stdout).toBe("");
  expect(JSON.parse(rejected.stderr).issues).toEqual([{ field: "$", code: "invalid_json" }]);
});

it("redacts read errors and paths, with exit 2", async () => {
  const result = await runStatusPreflightCli(["SECRET_PATH"], async () => { throw new Error("SECRET_PATH / PRIVATE_TOKEN"); });
  expect(result.exitCode).toBe(2);
  expect(result.stderr).not.toMatch(/SECRET_PATH|PRIVATE_TOKEN/);
  expect(JSON.parse(result.stderr).issues[0].code).toBe("read_failed");
});

it.each([[], ["-secret"], ["a", "b"]].map(args => ({ args })))("rejects arguments without reading or repeating them: $args", async ({ args }) => {
  const read = vi.fn();
  const result = await runStatusPreflightCli(args, read);
  expect(result.exitCode).toBe(2);
  expect(result.stderr).not.toContain("-secret");
  expect(read).not.toHaveBeenCalled();
});

it("the standalone CLI preserves its directory and inherited service log path", () => {
  const directory = mkdtempSync(join(tmpdir(), "cc-status-preflight-"));
  const report = join(directory, "report.json");
  const serviceLog = join(directory, "service.log");
  try {
    writeFileSync(report, JSON.stringify({ status: "failed", detail: "PRIVATE_TOKEN" }), "utf8");
    writeFileSync(serviceLog, "unchanged", "utf8");
    const child = spawnSync(process.execPath, ["--import", tsxLoader,
      resolve("tools/delegation-status-preflight.mjs"), report], {
      cwd: directory, encoding: "utf8", timeout: 30_000, windowsHide: true,
      env: { ...process.env, CONCORDIA_LOG_FILE: "1", CONCORDIA_LOG_FILE_PATH: serviceLog,
        CONCORDIA_VESTIGIUM: "1", VESTIGIUM_LOGS_DIR: join(directory, "logs") },
    });
    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toEqual({ valid: true, issues: [] });
    expect(child.stderr).toBe("");
    expect(readdirSync(directory).sort()).toEqual(["report.json", "service.log"]);
    expect(readFileSync(serviceLog, "utf8")).toBe("unchanged");
    expect(JSON.parse(readFileSync(report, "utf8")).detail).toBe("PRIVATE_TOKEN");
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
