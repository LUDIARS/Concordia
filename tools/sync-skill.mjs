#!/usr/bin/env node
/**
 * src/skills/*.md を実行時配布先と repo-local skill へ同期する.
 *
 * Concordia repo 自体を「Claude Code が開く repo」として扱ったとき、
 * .claude/skills/concordia/SKILL.md があれば per-repo skill として読まれる.
 * dist/skills/*.md は build 後の API が読む runtime asset。src/ が source-of-truth で、
 * どちらの出力も自動生成されるため手で編集しないこと.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const sourceDir = join(repoRoot, "src", "skills");
const concordiaSource = join(sourceDir, "concordia.md");
const repoSkillTarget = join(repoRoot, ".claude", "skills", "concordia", "SKILL.md");
const runtimeTargetDir = join(repoRoot, "dist", "skills");

if (!existsSync(concordiaSource)) {
  console.error(`[sync-skill] source not found: ${concordiaSource}`);
  process.exit(1);
}

const banner =
  "<!-- AUTO-GENERATED from src/skills/concordia.md by tools/sync-skill.mjs. " +
  "Edit the source, then run `npm run sync:skill`. -->\n";
syncFile(repoSkillTarget, banner + readFileSync(concordiaSource, "utf8"));

const markdownFiles = readdirSync(sourceDir, { withFileTypes: true })
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name)
  .sort();
if (markdownFiles.length === 0) {
  console.error(`[sync-skill] no Markdown sources found: ${sourceDir}`);
  process.exit(1);
}
for (const fileName of markdownFiles) {
  syncFile(
    join(runtimeTargetDir, fileName),
    readFileSync(join(sourceDir, fileName), "utf8"),
  );
}

function syncFile(target, content) {
  mkdirSync(dirname(target), { recursive: true });
  const previous = existsSync(target) ? readFileSync(target, "utf8") : null;
  if (previous === content) {
    console.log(`[sync-skill] up to date: ${target}`);
    return;
  }
  writeFileSync(target, content, "utf8");
  console.log(`[sync-skill] wrote ${target}`);
}
