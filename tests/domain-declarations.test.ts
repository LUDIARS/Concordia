/**
 * `spec/domains/*.domain.json` が機械に読める形であることの回帰テスト。
 *
 * 2026-09-04 時点で 37 件のうち 1 件 (`checkout-published-deploy.domain.json`) が
 * **不正な JSON** だった。`pathPattern` に `"(\.test)?\.ts$"` と書かれており、
 * JSON では `\.` が無効なエスケープになる (リテラルのバックスラッシュには `\\.` が要る)。
 *
 * 壊れていても誰も気づかなかったのは検査が無かったから。Anatomia がその宣言を
 * 読めないので `src/deploy/` 配下はドメイン未所属として扱われ、
 * **「宣言を書いたのに効いていない」**という分かりにくい詰まり方をする。
 * 宣言は増え続けるので、同じ取りこぼしは検査が無ければ必ず再発する。
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const DOMAINS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..", "spec", "domains");

function declarationFiles(): string[] {
  return readdirSync(DOMAINS_DIR).filter((f) => f.endsWith(".domain.json")).sort();
}

describe("spec/domains のドメイン宣言", () => {
  it("すべて JSON として読める", () => {
    const broken: string[] = [];
    for (const file of declarationFiles()) {
      try {
        JSON.parse(readFileSync(resolve(DOMAINS_DIR, file), "utf8"));
      } catch (error) {
        broken[broken.length] = `${file}: ${(error as Error).message}`;
      }
    }
    expect(broken).toEqual([]);
  });

  it("membership のパターンが正規表現として妥当", () => {
    // JSON として読めても、パターン自体が壊れていれば同じく効かない。
    // membership はファイルパスで指定する `pathPattern` と、シンボル名で指定する
    // `namePattern` の 2 通りがある (どちらも正規表現)。
    const broken: string[] = [];
    for (const file of declarationFiles()) {
      let parsed: { membership?: Record<string, unknown>[] };
      try {
        parsed = JSON.parse(readFileSync(resolve(DOMAINS_DIR, file), "utf8"));
      } catch {
        continue; // 上のテストが報告する。
      }
      for (const entry of parsed.membership ?? []) {
        const patterns = (["pathPattern", "namePattern"] as const)
          .map((key) => entry[key])
          .filter((value) => value !== undefined);
        if (patterns.length === 0) {
          broken[broken.length] = `${file}: pathPattern も namePattern も無い membership`;
          continue;
        }
        for (const pattern of patterns) {
          if (typeof pattern !== "string") {
            broken[broken.length] = `${file}: パターンが文字列でない (${String(pattern)})`;
            continue;
          }
          try {
            new RegExp(pattern);
          } catch (error) {
            broken[broken.length] = `${file}: ${pattern} -> ${(error as Error).message}`;
          }
        }
      }
    }
    expect(broken).toEqual([]);
  });

  it("ファイル名と name が一致する", () => {
    // 名前がずれていると、どの宣言が効いているのか追えなくなる。
    const mismatched: string[] = [];
    for (const file of declarationFiles()) {
      let parsed: { name?: unknown };
      try {
        parsed = JSON.parse(readFileSync(resolve(DOMAINS_DIR, file), "utf8"));
      } catch {
        continue;
      }
      const expected = file.replace(/\.domain\.json$/, "");
      if (parsed.name !== expected) mismatched[mismatched.length] = `${file}: name=${String(parsed.name)}`;
    }
    expect(mismatched).toEqual([]);
  });
});
