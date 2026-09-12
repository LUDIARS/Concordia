#!/usr/bin/env node
/**
 * tsc は tsconfig の include (src 配下の .ts) だけを dist へ出す。 src に手書きの
 * JavaScript を置くと typecheck も test も通るのに dist から丸ごと消え、 起動時に
 * 初めて ERR_MODULE_NOT_FOUND になる。 Augur の contract predicate 注入がこの形を
 * 作るので、 ビルド前に検出して .ts へ直させる。
 */
import { readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative } from "node:path";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

function collect(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...collect(full));
    else if (/[.](?:js|mjs|cjs)$/.test(entry)) found.push(full);
  }
  return found;
}

const offenders = collect(SRC).map(path => relative(SRC, path).split("\\").join("/"));
if (offenders.length) {
  console.error("src に JavaScript ファイルがあります。 tsc は dist へ出さないので実行時に ERR_MODULE_NOT_FOUND になります。");
  for (const path of offenders) console.error(`  src/${path}`);
  console.error("同じ内容を .ts として書き直し、 .js と手書きの .d.ts を消してください。");
  process.exit(1);
}
