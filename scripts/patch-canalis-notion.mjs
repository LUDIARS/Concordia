// Reproducible, fail-closed patch for the pinned Canalis reader. Never accept a scroll-limit truncation.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const FULLTEXT_SCROLL = `async function scrollToBottom(page, scrollDelay, maxScrolls) {
    let stable = 0;
    for (let i = 0; i < maxScrolls; i++) {
        const before = await page.evaluate(() => document.documentElement.scrollHeight);
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(scrollDelay);
        const after = await page.evaluate(() => document.documentElement.scrollHeight);
        stable = after === before ? stable + 1 : 0;
        if (stable >= 2) {
            await page.evaluate(() => window.scrollTo(0, 0));
            return;
        }
    }
    throw new Error("Canalis Notion full-text check reached its scroll limit");
}
`;

export function patchCanalisFetcher(source) {
  source = source.replace(/\r\n/g, "\n");
  const start = source.indexOf("async function scrollToBottom(page, scrollDelay, maxScrolls) {");
  if (start < 0 || !source.slice(start).includes("if (newHeight === prevHeight)")) {
    throw new Error("Pinned Canalis scroll implementation changed; review the patch before building");
  }
  const tail = source.slice(start).replace(/\n\/\/# sourceMappingURL=.*\s*$/, "").trim();
  if (!tail.endsWith("await page.evaluate(() => window.scrollTo(0, 0));\n}")) {
    throw new Error("Unexpected Canalis trailing code; refusing to overwrite it");
  }
  return source.slice(0, start) + FULLTEXT_SCROLL;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const target = new URL("../lib/canalis/dist/crawl/notion-public/fetcher.js", import.meta.url);
  writeFileSync(target, patchCanalisFetcher(readFileSync(target, "utf8")), "utf8");
}
