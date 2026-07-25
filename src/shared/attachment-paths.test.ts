import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAttachmentGuard } from "./attachment-paths.js";

const testDirs: string[] = [];

afterEach(async () => {
  await Promise.all(testDirs.splice(0).map((dir) => fs.promises.rm(dir, { recursive: true, force: true })));
});

async function fixture(): Promise<{ root: string; outside: string; guard: ReturnType<typeof createAttachmentGuard> }> {
  const base = await fs.promises.mkdtemp(path.join(os.tmpdir(), "concordia-attachment-"));
  testDirs.push(base);
  const root = path.join(base, "ars");
  const outside = path.join(base, "outside");
  await Promise.all([fs.promises.mkdir(root), fs.promises.mkdir(outside)]);
  return { root, outside, guard: createAttachmentGuard({ roots: [root], enforce: true }) };
}

async function writeFile(dir: string, name: string): Promise<string> {
  const file = path.join(dir, name);
  await fs.promises.writeFile(file, "test");
  return file;
}

describe("attachment paths", () => {
  it("allows a normal file inside a workspace root", async () => {
    const { root, guard } = await fixture();
    await expect(guard.check(await writeFile(root, "capture.png"))).resolves.toMatchObject({ ok: true });
  });

  it("allows a file below the temporary-directory root", async () => {
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "concordia-attachment-tmp-"));
    testDirs.push(dir);
    const guard = createAttachmentGuard({ roots: [os.tmpdir()], enforce: true });
    await expect(guard.check(await writeFile(dir, "capture.png"))).resolves.toMatchObject({ ok: true });
  });

  it("rejects a file outside the workspace root", async () => {
    const { outside, guard } = await fixture();
    await expect(guard.check(await writeFile(outside, "outside.png"))).resolves.toEqual({ ok: false, reason: "outside_roots" });
  });

  it("rejects .env files inside a workspace root", async () => {
    const { root, guard } = await fixture();
    await expect(guard.check(await writeFile(root, ".env"))).resolves.toEqual({ ok: false, reason: "denied_name" });
  });

  it("rejects PEM files inside a workspace root", async () => {
    const { root, guard } = await fixture();
    await expect(guard.check(await writeFile(root, "certificate.pem"))).resolves.toEqual({ ok: false, reason: "denied_name" });
  });

  it("rejects .spawn.token inside a workspace root", async () => {
    const { root, guard } = await fixture();
    await expect(guard.check(await writeFile(root, ".spawn.token"))).resolves.toEqual({ ok: false, reason: "denied_name" });
  });

  it("rejects a symlink that escapes a workspace root", async () => {
    const { root, outside, guard } = await fixture();
    const target = await writeFile(outside, "outside.png");
    const link = path.join(root, "escape.png");
    try {
      await fs.promises.symlink(target, link, "file");
    } catch {
      return; // Windows environments without symlink privilege cannot exercise this case.
    }
    await expect(guard.check(link)).resolves.toMatchObject({ ok: false });
  });

  it("rejects UNC paths", async () => {
    const { guard } = await fixture();
    await expect(guard.check("\\\\server\\share\\x.png")).resolves.toEqual({ ok: false, reason: "unc" });
  });

  it("does not confuse a root with an equal string prefix", async () => {
    const { root, guard } = await fixture();
    const evilRoot = `${root}Evil`;
    await fs.promises.mkdir(evilRoot);
    await expect(guard.check(await writeFile(evilRoot, "x.png"))).resolves.toEqual({ ok: false, reason: "outside_roots" });
  });

  it("rejects relative paths", async () => {
    const { guard } = await fixture();
    await expect(guard.check("capture.png")).resolves.toEqual({ ok: false, reason: "not_absolute" });
  });
});
