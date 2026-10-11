import { describe, expect, it } from "vitest";
import { rebaseSeedCwd, SEED_ARS_ROOT } from "./seed-cwd-rebase.js";

const existing = (...paths: string[]) => (path: string) => paths.includes(path);

describe("rebaseSeedCwd", () => {
  it("keeps a seed path that exists on this PC (HQ)", () => {
    const cwd = `${SEED_ARS_ROOT}\\Concordia`;
    expect(rebaseSeedCwd(cwd, ["D:\\LUDIARS"], existing(cwd, "D:\\LUDIARS\\Concordia"))).toBe(cwd);
  });

  it("rebases a missing seed path onto the first workspace root that has it", () => {
    const exists = existing("D:\\MELPOT\\Quaestor");
    expect(rebaseSeedCwd("E:/Document/Ars/Quaestor/", ["D:\\LUDIARS\\", "D:\\MELPOT"], exists)).toBe("D:\\MELPOT\\Quaestor");
    expect(rebaseSeedCwd("e:\\document\\ars", ["D:\\LUDIARS"], existing("D:\\LUDIARS"))).toBe("D:\\LUDIARS");
  });

  it("returns the original path when no root has it or it is not a seed path", () => {
    expect(rebaseSeedCwd(`${SEED_ARS_ROOT}\\Vultus`, ["D:\\LUDIARS"], existing())).toBe(`${SEED_ARS_ROOT}\\Vultus`);
    expect(rebaseSeedCwd("C:\\work\\Other", ["D:\\LUDIARS"], existing("D:\\LUDIARS\\Other"))).toBe("C:\\work\\Other");
    expect(rebaseSeedCwd(`${SEED_ARS_ROOT}Extra\\X`, ["D:\\LUDIARS"], existing("D:\\LUDIARS\\X"))).toBe(`${SEED_ARS_ROOT}Extra\\X`);
    expect(rebaseSeedCwd(`${SEED_ARS_ROOT}\\Concordia`, ["  "], existing())).toBe(`${SEED_ARS_ROOT}\\Concordia`);
  });
});
