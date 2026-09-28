import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseCommonCommands, readCatalogProcess } from "./command-catalog.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

describe("root command listing parser", () => {
  it("retains usage and description without executing an operation", () => {
    expect(parseCommonCommands("LUDIARS command runner — list\n\n  git:unlock [--repo <path>]\n      Unlock stale git lock\n  rv:prs\n      List local PRs\n"))
      .toEqual([
        { name: "git:unlock", usage: "git:unlock [--repo <path>]", description: "Unlock stale git lock" },
        { name: "rv:prs", usage: "rv:prs", description: "List local PRs" },
      ]);
  });
  it("rejects an incomplete or malformed pair instead of showing a partial catalog", () => {
    expect(() => parseCommonCommands("LUDIARS command runner\n  rv:prs\n      List\n  Broken! arg\n      Bad\n"))
      .toThrow("command_catalog_format_changed");
    expect(() => parseCommonCommands("LUDIARS command runner\n  rv:prs\n      List\n      Orphan\n"))
      .toThrow("command_catalog_format_changed");
  });
});

it("bounds child output and runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-command-catalog-"));
  temporary.push(root);
  const verbose = join(root, "verbose.mjs");
  const slow = join(root, "slow.mjs");
  await writeFile(verbose, 'process.stdout.write("x".repeat(300000));');
  await writeFile(slow, 'setInterval(() => {}, 1000);');
  await expect(readCatalogProcess(verbose, [], root)).rejects.toThrow();
  await expect(readCatalogProcess(slow, [], root)).rejects.toThrow();
  const valid = join(root, "valid.mjs");
  await writeFile(valid, 'process.stdout.write("ok");');
  expect(await readCatalogProcess(valid, [], root)).toBe("ok");
}, 12_000);

it("caps concurrent readers and releases capacity after failures", async () => {
  const root = await mkdtemp(join(tmpdir(), "cc-command-concurrency-"));
  temporary.push(root);
  const slow = join(root, "slow.mjs");
  await writeFile(slow, 'setInterval(() => {}, 1000);');
  const first = readCatalogProcess(slow, [], root);
  const second = readCatalogProcess(slow, [], root);
  await expect(readCatalogProcess(slow, [], root)).rejects.toThrow("catalog_reader_busy");
  await Promise.allSettled([first, second]);
  const valid = join(root, "valid.mjs");
  await writeFile(valid, 'process.stdout.write("ready");');
  expect(await readCatalogProcess(valid, [], root)).toBe("ready");
}, 12_000);
