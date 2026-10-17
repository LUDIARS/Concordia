/**
 * `/spawn site:` と Session forum の担当拠点起動が共有する、 連合への起動の口と失敗文言。
 *
 * `command-port.ts` (コマンド依存) ・ `forum-spawn.ts` ・ `commands/spawn-site.ts` の三者が
 * 使う。 どれか一方に置くと三者の import が循環するので、 依存を持たないここへ分ける。
 * 公開名は元のモジュールからも再エクスポートする。
 */

/** `/spawn site:` が使う連合の口 (federation runtime の listSpawnSites / routeSiteSpawn)。 */
export interface SpawnSitePort {
  list(): Array<{ siteId: string; name: string }>;
  /** project を担当する有効な拠点 (空なら本社で起動)。 */
  forProject(project: string): Array<{ siteId: string; name: string }>;
  route(input: {
    site: string; guildId: string; channelId: string; authorId: string | null; title: string; body: string;
    options: import("../federation/remote-session-payload.js").RemoteSpawnOptions;
    runtimeRules?: readonly string[];
  }): { ok: true; siteId: string; siteName: string } | { ok: false; reason: "unknown_site" | "inactive_site" | "ambiguous_site" | "listener_unavailable" };
}

export function siteSpawnFailureMessage(reason: "unknown_site" | "inactive_site" | "ambiguous_site" | "listener_unavailable"): string {
  switch (reason) {
    case "unknown_site": return "指定した拠点が見つかりません。拠点 ID か表示名を指定してください。";
    case "inactive_site": return "指定した拠点は失効しています。";
    case "ambiguous_site": return "同じ名前の拠点が複数あります。拠点 ID で指定してください。";
    case "listener_unavailable": return "本社の連合 listener が停止しているため、拠点へ起動を渡せません。";
  }
}
