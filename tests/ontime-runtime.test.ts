import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { contract } from "../tools/ontime-runtime.js";

const priorLogsDir = process.env.VESTIGIUM_LOGS_DIR;
const directories: string[] = [];

afterEach(() => {
  if (priorLogsDir === undefined) delete process.env.VESTIGIUM_LOGS_DIR;
  else process.env.VESTIGIUM_LOGS_DIR = priorLogsDir;
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("contract", () => {
  it("records a passing observed contract", () => {
    const directory = mkdtempSync(resolve(tmpdir(), "concordia-contract-"));
    directories.push(directory);
    process.env.VESTIGIUM_LOGS_DIR = directory;

    const observed = contract(() => "registered", {
      contractId: "C-test",
      post: (result: string) => result === "registered",
    });

    expect(observed()).toBe("registered");
    expect(readFileSync(resolve(directory, "augur-contracts.jsonl"), "utf8")).toContain("contract observed");
  });
});
