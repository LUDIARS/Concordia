import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readAttachmentFiles } from "./attachment-files.js";

describe("readAttachmentFiles", () => {
  let dir: string;
  beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), "attach-read-")); });
  afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

  it("reads files under the allowed roots and skips the ones over the size limit", async () => {
    const small = path.join(dir, "small.txt");
    const large = path.join(dir, "large.bin");
    fs.writeFileSync(small, "ok");
    fs.writeFileSync(large, Buffer.alloc(32));
    const warn = vi.fn();

    const files = await readAttachmentFiles([small, large], { label: "t", log: { warn }, workspaceRoots: [], maxBytes: 16 });

    expect(files).toEqual([{ data: Buffer.from("ok"), name: "small.txt" }]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("too large"));
  });
});
