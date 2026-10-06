import type { StatusProjection, StatusChange } from "./policy.js";
const safe = (name: string): string => name
  .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069`*_~|<>@\[\]()\\]/g, " ")
  .slice(0, 180);
const labels: Record<string, string> = { up: "稼働", down: "停止/異常", unknown: "未確認", unmonitored: "監視なし" };
export function statusPages(projection: StatusProjection | null): string[] {
  const lines = ["## サービス稼働"];
  if (!projection) lines.push("監視情報を取得できません。以前の稼働状態は未確認です。");
  else {
    lines.push(`稼働中: ${projection.running.length} サービス`);
    for (const site of projection.sites) {
      lines.push(`\n**${safe(site.name)}**${!site.connected ? "（接続断）" : site.stale ? "（観測が古い/未取得）" : ""}`);
      const running = projection.running.filter((service) => service.siteId === site.id);
      lines.push(...running.map((service) => `- ${safe(service.name)} (${safe(service.code)})`));
      if (!running.length) lines.push("- 確認できる稼働サービスなし");
    }
    if (!projection.sites.length) lines.push("公開対象の拠点・サービスが設定されていません。");
  }
  const pages: string[] = []; let page = "";
  for (const line of lines) {
    if (page.length + line.length + 1 > 1800) { pages.push(page); page = "## サービス稼働（続き）"; }
    page += `${page ? "\n" : ""}${line}`;
  }
  if (page) pages.push(page);
  return pages;
}
export function renderChanges(changes: readonly StatusChange[], projection: StatusProjection): string[] {
  return changes.map((change) => {
    const site = projection.sites.find((entry) => entry.id === change.siteId);
    return `${safe(site?.name ?? "")} / ${safe(change.name)} (${safe(change.code)}): ${labels[change.before]} → ${labels[change.after]}`;
  });
}
