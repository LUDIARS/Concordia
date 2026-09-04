import { mkdtemp, mkdir, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkBuildFreshness, formatBuildFreshnessWarning } from "./build-freshness.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

/**
 * mtime は秒精度で丸められる環境があるので、明示的に離す。
 * 「1 ミリ秒だけ新しい」を作って falsy な比較に頼らない。
 */
async function fixture(files: { path: string; at: number }[]): Promise<{ src: string; dist: string }> {
  const root = await mkdtemp(join(tmpdir(), "cc-freshness-"));
  roots.push(root);
  const src = join(root, "src");
  const dist = join(root, "dist");
  await mkdir(src, { recursive: true });
  for (const file of files) {
    const full = join(root, file.path);
    await mkdir(join(full, ".."), { recursive: true });
    await writeFile(full, "// fixture\n");
    await utimes(full, new Date(file.at), new Date(file.at));
  }
  return { src, dist };
}

const OLD = Date.UTC(2026, 8, 1);
const NEW = Date.UTC(2026, 8, 4);

describe("checkBuildFreshness", () => {
  it("dist が src より新しければ stale ではない", async () => {
    const { src, dist } = await fixture([
      { path: "src/server.ts", at: OLD },
      { path: "dist/server.js", at: NEW },
    ]);

    expect(await checkBuildFreshness(src, dist)).toEqual({ stale: false, staleSample: null });
  });

  it("src のほうが新しければ stale として、どのファイルかを返す", async () => {
    const { src, dist } = await fixture([
      { path: "src/db/schema.ts", at: NEW },
      { path: "dist/db/schema.js", at: OLD },
    ]);

    const result = await checkBuildFreshness(src, dist);
    expect(result.stale).toBe(true);
    // 対処 (npm run build + 再起動) は同じなので件数は要らないが、
    // どこを見れば確かめられるかは示す。
    expect(result.staleSample).toBe(join("db", "schema.ts"));
  });

  it("対応する出力が無いファイルも stale として扱う", async () => {
    const { src, dist } = await fixture([
      { path: "src/added-later.ts", at: OLD },
      { path: "dist/server.js", at: NEW },
    ]);

    expect((await checkBuildFreshness(src, dist)).stale).toBe(true);
  });

  it("dist が丸ごと無いときは stale にしない", async () => {
    // 未ビルドは「そもそも起動できない」という別のエラーで顕在化する。
    // ここで二重に報せても運用の判断は変わらない。
    const { src, dist } = await fixture([{ path: "src/server.ts", at: NEW }]);

    expect(await checkBuildFreshness(src, dist)).toEqual({ stale: false, staleSample: null });
  });

  it("型定義は出力を持たないので比較しない", async () => {
    const { src, dist } = await fixture([
      { path: "src/types.d.ts", at: NEW },
      { path: "dist/server.js", at: NEW },
      { path: "src/server.ts", at: OLD },
    ]);

    expect((await checkBuildFreshness(src, dist)).stale).toBe(false);
  });

  it("ビルド対象外のテストは出力を持たないので比較しない", async () => {
    const { src, dist } = await fixture([
      { path: "src/runtime/check.test.ts", at: NEW },
      { path: "src/server.ts", at: OLD },
      { path: "dist/server.js", at: NEW },
    ]);

    expect((await checkBuildFreshness(src, dist)).stale).toBe(false);
  });

  it("src が読めない構成では判定しない", async () => {
    // 配布物だけを置いた環境で誤って stale を出さない。
    const { dist } = await fixture([{ path: "dist/server.js", at: NEW }]);

    expect(await checkBuildFreshness(join(dist, "..", "no-such-src"), dist))
      .toEqual({ stale: false, staleSample: null });
  });

  it("警告文が対処方法まで書いている", () => {
    const message = formatBuildFreshnessWarning({ stale: true, staleSample: "db/schema.ts" });

    expect(message).toContain("db/schema.ts");
    expect(message).toContain("npm run build");
    expect(message).toContain("再起動");
  });

  it("警告へ載せるパスの制御文字をエスケープする", () => {
    const message = formatBuildFreshnessWarning({
      stale: true,
      staleSample: "db/schema.ts\nforged log line",
    });

    expect(message).toContain("db/schema.ts\\nforged log line");
    expect(message).not.toContain("db/schema.ts\nforged log line");
  });
});
