/** Browser-rendered Notion reading. Canalis owns rendering; this adapter owns the Cc page contract. */
import { createHash } from "node:crypto";
import { normalizeNotionId } from "./notion-map-rules.js";
import { NotionSourceUnavailable, type NotionPageRef, type NotionPageSource } from "./notion-source-types.js";

export interface CanalisPageFetcher {
  fetch(url: string, options: { timeout: number; scrollDelay: number; maxScrolls: number }): Promise<{
    url: string; title: string; markdown: string; raw: { links?: string[] };
  }>;
  close(): Promise<void>;
}

/** The pinned submodule is built by bootstrap, independently of the Cc compiler. */
export async function loadCanalisFetcher(): Promise<CanalisPageFetcher> {
  try {
    const moduleUrl = new URL("../../lib/canalis/dist/crawl/notion-public/index.js", import.meta.url);
    const module = await import(moduleUrl.href) as { PlaywrightFetcher: new () => CanalisPageFetcher };
    return new module.PlaywrightFetcher();
  } catch {
    throw new NotionSourceUnavailable("Canalis Notion reader is not installed/built; run the documented bootstrap before refreshing Notion");
  }
}

/** Fingerprint BEFORE clipping: changes beyond the prompt/storage limit must invalidate summaries. */
export function canalisPageFingerprint(title: string, markdown: string, links: readonly string[]): string {
  return "canalis-v1:" + createHash("sha256").update(JSON.stringify([
    title, markdown.replace(/\r\n/g, "\n"), [...new Set(links)].sort(),
  ]), "utf8").digest("hex");
}

export function canalisPageUrl(ref: NotionPageRef): string {
  if (ref.url) {
    const url = new URL(ref.url);
    if (url.protocol !== "https:" || !/(^|\.)notion\.(site|so|com)$/i.test(url.hostname)
      || url.username || url.password || (url.port && url.port !== "443")
      || normalizeNotionId(url.href) !== ref.id) throw new Error("Invalid Notion page URL");
    return url.href;
  }
  if (!/^[a-f0-9]{32}$/i.test(ref.id)) throw new Error("Invalid Notion page ID");
  return `https://www.notion.so/${ref.id}`;
}

export function createCanalisNotionSource(deps: {
  createFetcher?: () => Promise<CanalisPageFetcher>;
  fallback?: NotionPageSource;
  log?: { warn(message: string): void };
} = {}): NotionPageSource {
  let fetcher: CanalisPageFetcher | null = null;
  const unavailable = async (ref: NotionPageRef, limits: Parameters<NotionPageSource["fetchPage"]>[1]) => {
    if (!deps.fallback) throw new NotionSourceUnavailable("Canalis could not read the Notion body; previous content is retained");
    deps.log?.warn(`Canalis could not read Notion page ${ref.id}; using the existing MCP retrieval route`);
    return deps.fallback.fetchPage(ref, limits);
  };
  return {
    preserveRootOnFailure: true,
    async fetchPage(ref, limits) {
      const url = canalisPageUrl(ref);
      fetcher ??= await (deps.createFetcher ?? loadCanalisFetcher)();
      // Missing dependencies are configuration errors; inaccessible public content is capability loss.
      let page: Awaited<ReturnType<CanalisPageFetcher["fetch"]>>;
      try {
        page = await fetcher.fetch(url, { timeout: 30_000, scrollDelay: 800, maxScrolls: 100 });
      } catch (error) {
        if (/Executable doesn't exist|browserType\.launch|Cannot find (package|module)/i.test(String(error))) {
          throw new NotionSourceUnavailable("Canalis browser setup failed; install its pinned Chromium before refreshing Notion");
        }
        return unavailable(ref, limits);
      }
      // Empty output is never cached as unchanged, including login/challenge/failed rendering.
      if (!page.markdown.trim()) return unavailable(ref, limits);
      const links = [...new Set(page.raw.links ?? [])];
      const children: NotionPageRef[] = links.flatMap((link) => {
        const id = normalizeNotionId(link);
        if (!id || id === ref.id) return [];
        const child = { id, url: link };
        // Do not follow arbitrary links from imported documents.
        try { canalisPageUrl(child); } catch { return []; }
        return [child];
      });
      return {
        id: ref.id, title: page.title || ref.title || "(untitled)", url,
        lastEditedMs: null,
        contentFingerprint: canalisPageFingerprint(page.title, page.markdown, links),
        // The full rendered body is hashed; only the excerpt enters the knowledge store.
        text: Buffer.from(page.markdown, "utf8").subarray(0, limits.pageTextBytes).toString("utf8").replace(/�+$/, ""),
        children: children.slice(0, limits.maxChildren), links: children.map((child) => child.id), via: "public",
      };
    },
    async close() {
      const owned = fetcher;
      fetcher = null;
      await owned?.close();
    },
  };
}
