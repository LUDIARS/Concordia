/**
 * src/domain-review/layer-diagram.ts — レポート → 層図の自己完結 HTML。
 *
 * 画像化 (§8.2 C-5) の元絵をここで作る。 Anatomia の web UI を撮らずに Cc 側で
 * 描くのは、 (a) web UI は prepare 済みが前提で未 prepare だと撮る絵が無い、
 * (b) 撮った絵と同じ投稿に載るリストが食い違うと読み手が混乱する、の 2 点による。
 * 同じ `DomainReviewReport` から**リストと図の両方**を作れば必ず一致する。
 *
 * SRP: HTML 文字列を作るだけ。 ブラウザも I/O も持たない (graph-image.ts)。
 *
 * @implements spec/feature/domain-review-discord.md §3
 */

import type { DomainReviewReport } from "./types.js";

/** 図に載せる 1 層あたりのドメイン数の上限。 超えた分は「+N」に畳む。 */
const MAX_DOMAINS_PER_LAYER = 12;
/** 図に載せる層違反の本数。 */
const MAX_VIOLATIONS = 12;

/**
 * 層図の HTML。 外部リソースを一切参照しない (headless ブラウザに
 * ネットワークを使わせない — 撮影が Anatomia の生死に左右されなくなる)。
 */
export function renderLayerDiagramHtml(report: DomainReviewReport): string {
  const layers = report.layers.map((layer) => {
    const shown = layer.domains.slice(0, MAX_DOMAINS_PER_LAYER);
    const hidden = layer.domains.length - shown.length;
    const chips = shown
      .map((domain) => {
        const misfit = domain.misfitCount > 0 ? ` <b>⚠${domain.misfitCount}</b>` : "";
        return `<span class="chip">${escapeHtml(domain.id)}${misfit}</span>`;
      })
      .join("");
    const more = hidden > 0 ? `<span class="chip more">+${hidden}</span>` : "";
    return `<section class="layer">
      <h2>${escapeHtml(layer.layer)} <em>${layer.domains.length}</em></h2>
      <div class="chips">${chips}${more}</div>
    </section>`;
  }).join("\n");

  const violations = report.layerViolations.slice(0, MAX_VIOLATIONS)
    .map((violation) =>
      `<li>${escapeHtml(violation.from)} <span class="arrow">→</span> ${escapeHtml(violation.to)}`
      + ` <em>${violation.weight}</em></li>`)
    .join("\n");
  const hiddenViolations = report.layerViolations.length - Math.min(report.layerViolations.length, MAX_VIOLATIONS);

  return `<!doctype html>
<html lang="ja"><head><meta charset="utf-8"><title>${escapeHtml(report.target.project)} 層図</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 24px; background: #1b1e24; color: #e6e8ee;
         font-family: "Yu Gothic UI", "Segoe UI", system-ui, sans-serif; width: 1200px; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  .sub { color: #9aa3b2; font-size: 12px; margin-bottom: 18px; }
  .layer { border: 1px solid #333a46; border-radius: 6px; padding: 10px 12px; margin-bottom: 10px;
           background: #232733; }
  .layer h2 { font-size: 13px; margin: 0 0 8px; color: #8ab4ff; letter-spacing: .04em; }
  .layer h2 em { color: #6b7484; font-style: normal; font-size: 11px; }
  .chips { display: flex; flex-wrap: wrap; gap: 6px; }
  .chip { background: #2d3342; border: 1px solid #3d4557; border-radius: 4px;
          padding: 3px 8px; font-size: 12px; }
  .chip b { color: #f0b232; }
  .chip.more { color: #9aa3b2; }
  .violations { margin-top: 18px; }
  .violations h2 { font-size: 13px; color: #ff6b6b; margin: 0 0 8px; }
  .violations ul { margin: 0; padding-left: 18px; }
  .violations li { font-size: 12px; margin-bottom: 3px; }
  .violations .arrow { color: #ff6b6b; }
  .violations em { color: #6b7484; font-style: normal; }
  .none { color: #57f287; font-size: 12px; }
</style></head><body>
<h1>${escapeHtml(report.target.code)} ${escapeHtml(report.target.project)} — プログラムドメイン層図</h1>
<div class="sub">${escapeHtml(sourceLabel(report))}</div>
${layers || '<div class="none">層情報がありません (未 prepare)。</div>'}
<div class="violations">
  <h2>層違反依存 ${report.layerViolations.length} 件</h2>
  ${report.layerViolations.length === 0
    ? '<div class="none">層違反はありません。</div>'
    : `<ul>${violations}</ul>${hiddenViolations > 0 ? `<div class="sub">以下省略 (${hiddenViolations} 件)</div>` : ""}`}
</div>
</body></html>`;
}

function sourceLabel(report: DomainReviewReport): string {
  const base = report.source === "prepared"
    ? "Anatomia web-cache (prepared)"
    : "Anatomia /api/projects/:id/domains (未 prepare フォールバック)";
  return `${base} · コアドメイン ${report.coreDomains.length} 件`;
}

/** HTML 文脈のエスケープ。 ドメイン名は Anatomia 由来 = 信頼できない入力。 */
function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
