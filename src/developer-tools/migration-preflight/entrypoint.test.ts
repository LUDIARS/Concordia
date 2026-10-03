import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../../", import.meta.url));
describe("migration preflight executable", () => {
  it.each([
    { args: ["--help"], status: 0, channel: "stdout" as const },
    { args: ["--unsupported"], status: 2, channel: "stderr" as const },
  ])("wires arguments, output and exit code: $args", ({ args, status, channel }) => {
    const result = spawnSync(process.execPath, ["--import", "tsx", "tools/migration-preflight.mjs", ...args], {
      cwd: root, encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(status);
    expect(result[channel]).toContain("Usage:");
    expect(result[channel === "stdout" ? "stderr" : "stdout"]).toBe("");
  });
});
