/**
 * LUDIARS の service-map.json (`<workspace>/LUDIARS/service-map.json`) からリポの一覧を読む。
 *
 * @implements spec/feature/parttimer-agent-dispatch.md — 読み取り adapter
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface ServiceMapRepo {
  name: string;
  code: string | null;
  dailyReview: boolean;
}

/** 純関数: service-map.json の中身から repos を取り出す。 形が違えば throw (黙って空にしない)。 */
export function parseServiceMap(raw: unknown): ServiceMapRepo[] {
  const repos = raw !== null && typeof raw === "object" ? (raw as { repos?: unknown }).repos : undefined;
  if (!Array.isArray(repos)) throw new Error("service-map.json has no repos array");
  return repos.flatMap((repo): ServiceMapRepo[] => {
    if (repo === null || typeof repo !== "object") return [];
    const { name, code, daily_review: dailyReview } = repo as { name?: unknown; code?: unknown; daily_review?: unknown };
    if (typeof name !== "string" || !/^[A-Za-z0-9._-]+$/u.test(name)) return [];
    return [{ name, code: typeof code === "string" ? code : null, dailyReview: dailyReview === true }];
  });
}

export async function readServiceMap(workspaceRoot: string): Promise<ServiceMapRepo[]> {
  const text = await readFile(join(workspaceRoot, "LUDIARS", "service-map.json"), "utf8");
  return parseServiceMap(JSON.parse(text) as unknown);
}
