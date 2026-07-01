#!/usr/bin/env node
/**
 * spec/**\/*.md の OKF frontmatter を集約して spec/index.jsonl を生成する.
 *
 * 出力形式: 1 行 = 1 ファイルの frontmatter JSON
 *   { "file": "feature/discord-ui.md", "type": "feature", "domain": "...", "tags": [...], ... }
 *
 * 使い方:
 *   node tools/build-spec-index.mjs
 *   npm run build:spec-index
 *
 * AUTO-GENERATED — このファイルは spec/**\/*.md が正本。手で編集しないこと。
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { fileURLToPath } from "node:url";
import yaml from "js-yaml";

const here = new URL(".", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1");
const repoRoot = join(here, "..");
const specDir = join(repoRoot, "spec");
const outPath = join(repoRoot, "spec-index.jsonl");

/** spec/ 配下の .md ファイルを再帰収集 */
function collectMdFiles(dir) {
  const results = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectMdFiles(full));
    } else if (entry.isFile() && extname(entry.name) === ".md") {
      results.push(full);
    }
  }
  return results;
}

/** --- ... --- の frontmatter を抽出して js-yaml でパース */
function parseFrontmatter(content, filePath) {
  if (!content.startsWith("---")) return null;
  const end = content.indexOf("\n---", 3);
  if (end === -1) return null;
  const raw = content.slice(3, end).trim();
  try {
    return yaml.load(raw);
  } catch (e) {
    console.warn(`[build-spec-index] YAML parse error in ${filePath}: ${e.message}`);
    return null;
  }
}

const files = collectMdFiles(specDir)
  .sort();
const lines = [];
let skipped = 0;

for (const absPath of files) {
  const content = readFileSync(absPath, "utf8");
  const fm = parseFrontmatter(content, absPath);
  if (!fm || !fm.type) {
    skipped++;
    continue;
  }
  // ファイルパスは spec/ からの相対パス (スラッシュ統一)
  const relPath = relative(specDir, absPath).replace(/\\/g, "/");
  const entry = { file: relPath, ...fm };
  lines.push(JSON.stringify(entry));
}

writeFileSync(outPath, lines.join("\n") + "\n", "utf8");

console.log(
  `[build-spec-index] wrote ${lines.length} entries → spec-index.jsonl` +
    (skipped > 0 ? ` (${skipped} files skipped: no frontmatter)` : "")
);
