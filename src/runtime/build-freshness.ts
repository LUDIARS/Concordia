import type { Stats } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `dist/` が `src/` のビルド後に生成されたかを確認する。
 *
 * 背景: Concordia は Excubitor 管理下で `node dist/server.js` を実行する。
 * `restart_policy` はクラッシュ時にしか再起動しないので、 **ソースを直して main へ
 * 入れただけではプロセスは古い dist を動かし続ける**。 サービスは止まらないため、
 * 「main に入っているのに直らない」という形の事故になり、 コードからは検知できない。
 *
 * 実例 (Memoria #1996): PR #1291 が main に入っているのに `dist/server.js` が
 * `src/db/schema.ts` より古く、 migration 82 が走らないまま稼働していた。
 * `delegation_templates.review_only` 列が作られず、 vulnerability-response-daily の
 * completed 報告が完了証跡ガードで failed 化され続けた。 毎回 dist と src の mtime を
 * 手で比べて気づいている。
 *
 * 判定は**警告どまりで起動は止めない**。 fail-fast の対象は設定不備であって、
 * ビルド鮮度は運用上の警告のため。 実装の写し元は Genius の
 * `src/runtime/build-freshness.ts` (SPEC-GENIUS-BUILD-FRESHNESS)。
 *
 * @implements SPEC-CONCORDIA-BUILD-FRESHNESS
 */
export interface BuildFreshnessResult {
  readonly stale: boolean;
  /** 最初に見つかった「出力が無い、または src の方が新しい」ファイルの相対パス。 */
  readonly staleSample: string | null;
}

const SRC_DIR = fileURLToPath(new URL("../../src", import.meta.url));
const DIST_DIR = fileURLToPath(new URL("../../dist", import.meta.url));

/**
 * `src/**\/*.ts` のうち TypeScript のビルド対象について、対応する `dist/**\/*.js` が
 * 無いか、 mtime が新しいものを探す。
 *
 * `dist/` が丸ごと無い (ビルド未実行) 場合は stale 判定しない。 それは別のエラー
 * (そもそも起動できない) として顕在化するので、 ここで二重に報せる意味がない。
 *
 * 最初の 1 件で打ち切る。 何件古いかは運用の判断を変えず、 「古い」ことだけが判れば
 * 対処 (`npm run build` + 再起動) は同じため。
 */
export async function checkBuildFreshness(
  srcDir: string = SRC_DIR,
  distDir: string = DIST_DIR,
): Promise<BuildFreshnessResult> {
  if (await statIfExists(distDir) === null) {
    return { stale: false, staleSample: null };
  }

  for (const srcFile of await listFiles(srcDir)) {
    // tsconfig.json で除外され、出力を持たない型定義とテストは比較対象にしない。
    // ここで test を含めると、常に対応する dist が無いため毎回 stale になる。
    if (
      !srcFile.endsWith(".ts") ||
      srcFile.endsWith(".d.ts") ||
      srcFile.endsWith(".test.ts")
    ) continue;
    const relPath = relative(srcDir, srcFile);
    const distFile = join(distDir, relPath.replace(/\.ts$/, ".js"));
    const [srcStat, distStat] = await Promise.all([stat(srcFile), statIfExists(distFile)]);
    if (distStat === null || srcStat.mtimeMs > distStat.mtimeMs) {
      return { stale: true, staleSample: relPath };
    }
  }
  return { stale: false, staleSample: null };
}

async function listFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    // src が読めない構成 (配布物だけを置いた環境等) では判定しない。
    if (isNodeError(error) && error.code === "ENOENT") return out;
    throw error;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) out.push(...(await listFiles(full)));
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

async function statIfExists(path: string): Promise<Stats | null> {
  try {
    return await stat(path);
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return null;
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export function formatBuildFreshnessWarning(result: BuildFreshnessResult): string {
  // Git permits control characters in filenames on some platforms. Quote the relative path so
  // an unusual repository entry cannot forge an additional log line.
  const sample = JSON.stringify(result.staleSample);
  return (
    `[build] dist/ が src/ より古い (例: ${sample})。` +
    " npm run build のあと Excubitor 経由で再起動してください。" +
    " 稼働中のコードが main と一致していない可能性があります。"
  );
}
