import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contract } from "./ontime-runtime.js";

const directories: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
const spec = { contractId: "example", id: "marker", where: "test", rule: "contract-wrap", mode: "observe" as const, sample: 1 };
describe("CLI contract observation", () => {
  it("does not evaluate instrumentation without an explicit log directory", () => {
    vi.stubEnv("VESTIGIUM_LOGS_DIR", "");
    const post = vi.fn();
    expect(contract((x: number) => x + 1, { ...spec, post })(3)).toBe(4);
    expect(post).not.toHaveBeenCalled();
  });
  it("records pass and violation without arguments or schema bodies", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-migration-evidence-"));
    directories.push(directory);
    vi.stubEnv("VESTIGIUM_LOGS_DIR", directory);
    contract((x: string) => x, { ...spec, post: () => true })("private schema");
    contract((x: string) => x, { ...spec, post: () => false })("private schema");
    const log = readFileSync(join(directory, "migration-preflight-contracts.jsonl"), "utf8");
    expect(log).not.toContain("private schema");
    expect(log.trim().split("\n").map(line => JSON.parse(line).msg)).toEqual(["contract observed", "contract violated"]);
  });
  it("preserves results when evidence cannot be written", () => {
    const directory = mkdtempSync(join(tmpdir(), "cc-migration-evidence-"));
    directories.push(directory);
    const file = join(directory, "file");
    writeFileSync(file, "occupied", "utf8");
    vi.stubEnv("VESTIGIUM_LOGS_DIR", file);
    expect(contract(() => 42, { ...spec, post: () => true })()).toBe(42);
  });
});
