/**
 * ナレッジ検索の HTML 添付 (spec/feature/slack-knowledge-search.md KS-9)。
 *
 * テンプレートで組み、 値はすべてエスケープする。 外部スクリプト・外部 CSS は読まない。
 * SRP: 回答 → HTML 文字列 (純関数)。
 */

import type { KnowledgeAnswer } from "./answer.js";

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** http(s) の URL だけをリンクにする (javascript: 等を出さない)。 */
function safeHref(url: string | null): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "http:" || u.protocol === "https:" ? u.toString() : null;
  } catch { return null; }
}

const SOURCE_LABEL: Record<string, string> = { "knowledge-flow": "ナレッジフロー", notion: "Notion", ludiars: "LUDIARS" };

const STYLE = `:root{--bg:#fff;--fg:#1f2328;--muted:#59636e;--line:#d1d9e0;--chip:#eef2f6}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#9198a1;--line:#3d444d;--chip:#21262d}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.7 system-ui,"Hiragino Sans","Yu Gothic UI",sans-serif}
main{max-width:860px;margin:0 auto;padding:24px 16px}h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:13px}.summary{border-left:3px solid var(--line);padding:4px 12px;white-space:pre-wrap}
.roles{display:grid;gap:12px;grid-template-columns:repeat(auto-fill,minmax(240px,1fr))}
.role{border:1px solid var(--line);border-radius:8px;padding:12px}.role h3{margin:0 0 6px;font-size:15px}
.role h4{margin:8px 0 2px;font-size:13px;color:var(--muted)}ul{margin:0;padding-left:20px}
.chip{display:inline-block;background:var(--chip);border-radius:10px;padding:0 8px;margin:2px 4px 0 0;font-size:12px}
a{color:inherit}`;

export function renderKnowledgeHtml(input: { query: string; requestId: number; createdAt: Date; answer: KnowledgeAnswer }): string {
  const { answer } = input;
  const list = (items: string[]) => items.length ? `<ul>${items.map((s) => `<li>${escapeHtml(s)}</li>`).join("")}</ul>` : "<p class=\"meta\">なし</p>";
  const roles = answer.roles.length
    ? `<div class="roles">${answer.roles.map((r) => `<section class="role"><h3>${escapeHtml(r.role)}</h3><h4>技術スキル</h4>${list(r.skills)}<h4>技術内容</h4>${list(r.technical)}</section>`).join("")}</div>`
    : "<p class=\"meta\">資料から役職別の内容は読み取れませんでした。</p>";
  const sources = answer.sources.map((s) => {
    const href = safeHref(s.url);
    const title = href ? `<a href="${escapeHtml(href)}">${escapeHtml(s.title)}</a>` : escapeHtml(s.title);
    const tags = s.tags.map((t) => `<span class="chip">${escapeHtml(t)}</span>`).join("");
    return `<li>${title} <span class="meta">${escapeHtml(SOURCE_LABEL[s.source] ?? s.source)}</span><br>${tags}</li>`;
  }).join("");
  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ナレッジ検索 ${escapeHtml(input.query)}</title><style>${STYLE}</style></head>
<body><main>
<h1>ナレッジ検索: ${escapeHtml(input.query)}</h1>
<p class="meta">検索 #${input.requestId} · ${escapeHtml(input.createdAt.toISOString())}</p>
<h2>サマリー</h2><p class="summary">${escapeHtml(answer.summary)}</p>
<h2>役職別の技術スキルと技術内容</h2>${roles}
<h2>出典</h2><ul>${sources}</ul>
</main></body></html>
`;
}
