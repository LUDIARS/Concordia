import { describe, expect, it, vi } from "vitest";
import { resolveTeamSpawnCwd } from "./team-spawn-cwd.js";

vi.mock("node:fs/promises", () => ({
  access: vi.fn(async (path: string) => {
    if (path.endsWith("Concordia")) return;
    throw new Error("missing");
  }),
}));

describe("resolveTeamSpawnCwd", () => {
  it("resolves the sole team repository under the configured workspace roots", async () => {
    await expect(resolveTeamSpawnCwd({
      teamName: "Cc team",
      repoOrigins: ["https://github.com/LUDIARS/Concordia.git"],
      workspaceRoots: ["E:/Document/Ars"],
    })).resolves.toEqual({ ok: true, cwd: expect.stringMatching(/[\\/]Concordia$/) });
  });

  it("requires an explicit target when a team owns multiple repositories", async () => {
    await expect(resolveTeamSpawnCwd({
      teamName: "multi",
      repoOrigins: ["LUDIARS/Concordia", "LUDIARS/Lictor"],
      workspaceRoots: ["E:/Document/Ars"],
    })).resolves.toEqual({
      ok: false,
      error: "team multi has multiple repositories; specify project or cwd",
    });
  });
});
