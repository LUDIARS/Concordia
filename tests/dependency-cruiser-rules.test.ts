// .dependency-cruiser.cjs の no-circular 規則の振る舞いを、小さな TS ファイル一式で確かめる。
// 型だけで閉じる輪 (import type は出力で消える) は通し、実行時の import だけでできた輪は止める。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cruise } from "dependency-cruiser";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const config = require("../.dependency-cruiser.cjs") as { forbidden: Array<{ name: string }> };
const noCircular = config.forbidden.find((rule) => rule.name === "no-circular");

let root: string | undefined;
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function circularViolations(files: Record<string, string>): Promise<string[]> {
  root = await mkdtemp(join(tmpdir(), "cc-depcruise-"));
  await mkdir(join(root, "src"));
  for (const [name, body] of Object.entries(files)) await writeFile(join(root, "src", name), body, "utf8");
  const result = await cruise(["src"], {
    baseDir: root,
    tsPreCompilationDeps: true,
    validate: true,
    ruleSet: { forbidden: [noCircular!] } as never,
  });
  const output = result.output as { summary: { violations: Array<{ rule: { name: string }; from: string }> } };
  return output.summary.violations.filter((v) => v.rule.name === "no-circular").map((v) => v.from);
}

describe("no-circular (.dependency-cruiser.cjs)", () => {
  it("is defined", () => {
    expect(noCircular).toBeDefined();
  });

  it("allows a cycle that is closed by a type-only import", async () => {
    expect(await circularViolations({
      "a.ts": 'import { b } from "./b";\nexport interface A { n: number }\nexport const a = (): number => b();\n',
      "b.ts": 'import type { A } from "./a";\nexport const b = (): number => ({ n: 1 } satisfies A).n;\n',
    })).toEqual([]);
  }, 30_000);

  it("still rejects a cycle made only of runtime imports", async () => {
    const violations = await circularViolations({
      "a.ts": 'import { b } from "./b";\nexport const a = (): number => b() + 1;\n',
      "b.ts": 'import { a } from "./a";\nexport const b = (): number => (typeof a === "function" ? 1 : 0);\n',
    });
    expect(violations.length).toBeGreaterThan(0);
  }, 30_000);
});
