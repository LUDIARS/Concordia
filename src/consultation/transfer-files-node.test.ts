import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { nodeTransferFiles } from "./transfer-files-node.js";

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "cc-transfer-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

describe("nodeTransferFiles", () => {
  it("writes a new file creating its folder and never overwrites", async () => {
    const files = nodeTransferFiles();
    const path = join(dir, "transfer", "incoming", "a.wav");
    expect(await files.writeNew(path, new Uint8Array([1]))).toBe(true);
    expect(await files.writeNew(path, new Uint8Array([2]))).toBe(false);
    expect([...await readFile(path)]).toEqual([1]);
  });

  it("lists only files with their sizes and treats a missing folder as empty", async () => {
    const files = nodeTransferFiles();
    expect(await files.list(join(dir, "missing"))).toEqual([]);
    await mkdir(join(dir, "out", "sub"), { recursive: true });
    await writeFile(join(dir, "out", "b.glb"), Buffer.from([1, 2, 3]));
    expect(await files.list(join(dir, "out"))).toEqual([{ name: "b.glb", size: 3 }]);
    expect([...await files.read(join(dir, "out", "b.glb"))]).toEqual([1, 2, 3]);
  });
});
