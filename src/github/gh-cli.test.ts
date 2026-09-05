import { describe, expect, it } from "vitest";
import { createGithubGateway, type GhRunner } from "./gh-cli.js";

describe("GithubGateway.findLabelActor", () => {
  it("uses the latest matching label event actor", async () => {
    const calls: string[][] = [];
    const runner: GhRunner = {
      run: async (args) => {
        calls.push([...args]);
        return JSON.stringify([[
          { event: "labeled", label: { name: "Cc" }, actor: { login: "first" } },
          { event: "unlabeled", label: { name: "Cc" }, actor: { login: "other" } },
          { event: "labeled", label: { name: "cc" }, actor: { login: "latest" } },
        ]]);
      },
    };
    const gateway = createGithubGateway(runner);
    expect(await gateway.findLabelActor("LUDIARS/Concordia", 42, "Cc")).toBe("latest");
    expect(calls[0]).toContain("repos/LUDIARS/Concordia/issues/42/events");
    expect(calls[0]).toContain("--slurp");
  });

  it("fails closed when no matching label event has an actor", async () => {
    const gateway = createGithubGateway({
      run: async () => JSON.stringify([[{ event: "labeled", label: { name: "bug" } }]]),
    });
    expect(await gateway.findLabelActor("LUDIARS/Concordia", 42, "Cc")).toBeNull();
  });
});
