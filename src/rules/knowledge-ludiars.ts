/**
 * LUDIARS 内部の知識の取り込み器 (spec/feature/patrol-chat.md「知識」)。
 *
 * Cc のプロジェクト一覧 (略称・名前・公開範囲)、 各リポの README と spec の要点 (先頭の要約、 上限付き)。
 * 全件取得 (種類ごと置き換え)。 公開範囲はプロジェクト一覧の行から決める (knowledge-scope.ts)。
 */

import { knowledgeScopeOf, type ProjectScopeInput } from "./knowledge-scope.js";
import type { KnowledgeCollector, KnowledgeDoc } from "./knowledge-types.js";

export interface KnowledgeProject extends ProjectScopeInput {
  repoPath: string;
}

export interface LudiarsKnowledgeDeps {
  projects: () => KnowledgeProject[];
  /** 公開と明示したプロジェクト (設定 services.chat_knowledge_public_projects)。 */
  publicProjects: () => string[];
  /** ファイルの先頭 maxBytes を読む。 無ければ null。 */
  readHead: (path: string, maxBytes: number) => Promise<string | null>;
  /** ディレクトリ直下の .md の名前 (並びは呼び出し側で決める)。 無ければ空。 */
  listMarkdown: (dir: string) => Promise<string[]>;
}

export const LUDIARS_LIMITS = {
  readmeBytes: 1500,
  specBytesRead: 4096,
  specSummaryBytes: 600,
  specFilesPerRepo: 12,
  specDirs: ["spec", "spec/feature"],
} as const;

function joinPath(root: string, rel: string): string {
  return `${root.replace(/[\\/]+$/, "")}/${rel}`;
}

/** Markdown を短い地の文にする (コードブロック・画像・バッジ・HTML を落とす)。 */
export function markdownToPlain(md: string): string {
  return md
    .replace(/\r\n?/g, "\n")
    .replace(/```[\s\S]*?(```|$)/g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s*/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "・")
    .replace(/[*_`]{1,3}/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** spec の要約: frontmatter の title / description、 無ければ先頭の段落。 */
export function specSummary(md: string): { title: string | null; summary: string } {
  const text = md.replace(/\r\n?/g, "\n");
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (front) {
    const field = (name: string) => {
      const m = new RegExp(`^${name}:\\s*(.+)$`, "m").exec(front[1] ?? "");
      return m ? m[1]!.trim().replace(/^["']|["']$/g, "") : null;
    };
    const title = field("title");
    const description = field("description");
    if (description) return { title, summary: description };
    return { title, summary: firstParagraph(text.slice(front[0].length)) };
  }
  const heading = /^#\s+(.+)$/m.exec(text);
  return { title: heading ? heading[1]!.trim() : null, summary: firstParagraph(text) };
}

function firstParagraph(md: string): string {
  const plain = markdownToPlain(md);
  return plain.split(/\n\n/).map((p) => p.trim()).find((p) => p.length >= 20) ?? plain.slice(0, 200);
}

export function clipBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.length <= maxBytes) return text;
  return buf.subarray(0, maxBytes).toString("utf8").replace(/�+$/, "");
}

export function createLudiarsCollector(deps: LudiarsKnowledgeDeps): KnowledgeCollector {
  return async () => {
    const publicList = deps.publicProjects();
    const docs: KnowledgeDoc[] = [];
    for (const p of deps.projects()) {
      const scope = knowledgeScopeOf(p, publicList);
      const base = { url: null, repo: p.project, sourceUpdatedAt: null, scope };
      const readme = await deps.readHead(joinPath(p.repoPath, "README.md"), LUDIARS_LIMITS.readmeBytes * 2);
      const readmeText = readme ? clipBytes(markdownToPlain(readme), LUDIARS_LIMITS.readmeBytes) : "";
      // プロジェクト一覧の行。 説明は README の先頭の段落 (Cc の一覧に説明の列は無い)。
      docs.push({
        ...base,
        docType: "project",
        docKey: `project:${p.code}`,
        title: `${p.project} (${p.code})`,
        path: null,
        text: [
          `略称 ${p.code} は ${p.project}。`,
          scope === "public" ? "公開のプロジェクト。" : "本社限定のプロジェクト。",
          readmeText ? `説明: ${firstParagraph(readmeText)}` : "",
        ].filter(Boolean).join(" "),
      });
      if (readmeText) {
        docs.push({ ...base, docType: "readme", docKey: `repo:${p.code}:README.md`, title: `${p.project} README`, path: "README.md", text: readmeText });
      }
      let specCount = 0;
      for (const dir of LUDIARS_LIMITS.specDirs) {
        const names = (await deps.listMarkdown(joinPath(p.repoPath, dir))).slice().sort();
        for (const name of names) {
          if (specCount >= LUDIARS_LIMITS.specFilesPerRepo) break;
          const rel = `${dir}/${name}`;
          const head = await deps.readHead(joinPath(p.repoPath, rel), LUDIARS_LIMITS.specBytesRead);
          if (!head) continue;
          const { title, summary } = specSummary(head);
          if (!summary.trim()) continue;
          specCount += 1;
          docs.push({
            ...base,
            docType: "spec",
            docKey: `repo:${p.code}:${rel}`,
            title: `${p.project} ${title ?? name.replace(/\.md$/, "")}`,
            path: rel,
            text: clipBytes(summary, LUDIARS_LIMITS.specSummaryBytes),
          });
        }
      }
    }
    return { docs, full: true, cursor: null };
  };
}
