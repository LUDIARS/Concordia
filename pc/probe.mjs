import { pathToFileURL } from "node:url";

export async function probe(url, binary, readPage) {
  if (!url || !binary) throw new Error("Provide a public article URL and set CC_KNOWLEDGE_CANALIS");
  const page = await readPage(url, binary);
  return { url: page.url, title: page.title, hash: page.hash, length: page.text.length, fetchedAt: page.fetchedAt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { readPage } = await import("../dist/knowledge-flow/article-analysis.js");
  const result = await probe(process.argv[2], process.env.CC_KNOWLEDGE_CANALIS, readPage);
  process.stdout.write(JSON.stringify(result) + "\n");
}
