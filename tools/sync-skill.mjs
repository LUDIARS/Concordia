#!/usr/bin/env node
/**
 * src/skills/concordia.md → .claude/skills/concordia/SKILL.md にコピーする.
 *
 * Concordia repo 自体を「Claude Code が開く repo」として扱ったとき、
 * .claude/skills/concordia/SKILL.md があれば per-repo skill として読まれる.
 * src/ が source-of-truth で、 ここはそこからの自動生成. 手で編集しないこと.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const src = join(repoRoot, "src", "skills", "concordia.md");
const dst = join(repoRoot, ".claude", "skills", "concordia", "SKILL.md");

if (!existsSync(src)) {
  console.error(`[sync-skill] source not found: ${src}`);
  process.exit(1);
}

mkdirSync(dirname(dst), { recursive: true });

const banner =
  "<!-- AUTO-GENERATED from src/skills/concordia.md by tools/sync-skill.mjs. " +
  "Edit the source, then run `npm run sync:skill`. -->\n";
const content = readFileSync(src, "utf8");
const out = banner + content;

const prev = existsSync(dst) ? readFileSync(dst, "utf8") : null;
if (prev === out) {
  console.log(`[sync-skill] up to date: ${dst}`);
  process.exit(0);
}
writeFileSync(dst, out, "utf8");
console.log(`[sync-skill] wrote ${dst}`);
