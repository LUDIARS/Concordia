import type { Database } from "better-sqlite3";

export interface WatchTarget { platform: "slack" | "discord"; team: string; channel: string }
export function parseWatchTarget(input: string): WatchTarget | null {
  const discord = /^https:\/\/(?:www\.)?discord\.com\/channels\/(\d{17,20})\/(\d{17,20})\/?$/.exec(input.trim());
  if (discord) return { platform: "discord", team: discord[1], channel: discord[2] };
  const slack = /^(?:https:\/\/app\.slack\.com\/client\/)?(T[A-Z0-9]+)\/([CG][A-Z0-9]+)\/?$/.exec(input.trim());
  return slack ? { platform: "slack", team: slack[1], channel: slack[2] } : null;
}
export function watchedChannels(db: Database) {
  db.exec(`CREATE TABLE IF NOT EXISTS knowledge_flow_channels(
    platform TEXT NOT NULL, team TEXT NOT NULL, channel TEXT NOT NULL, PRIMARY KEY(platform,team,channel))`);
  const exists = db.prepare("SELECT 1 FROM knowledge_flow_channels WHERE platform=? AND team=? AND channel=?");
  return {
    has(platform: WatchTarget["platform"], team: string, channel: string) { return !!exists.get(platform,team,channel); },
    list(): WatchTarget[] { return db.prepare("SELECT platform,team,channel FROM knowledge_flow_channels ORDER BY platform,team,channel").all() as WatchTarget[]; },
    change(target: WatchTarget, enabled: boolean) {
      const sql = enabled ? "INSERT OR IGNORE INTO knowledge_flow_channels VALUES (?,?,?)" : "DELETE FROM knowledge_flow_channels WHERE platform=? AND team=? AND channel=?";
      db.prepare(sql).run(target.platform,target.team,target.channel);
    }
  };
}
export type WatchedChannels = ReturnType<typeof watchedChannels>;
