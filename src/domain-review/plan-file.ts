/**
 * src/domain-review/plan-file.ts — `.anatomia/plan/<hash>.json` の読み書き。
 *
 * plan の所有者は Anatomia で、 Concordia は (a) 投稿に載せる `questions[]` を読み、
 * (b) Discord で返ってきた回答を **突合資料として同じファイルへ追記する** だけ。
 * plan 本体のフィールドには触らない — 追記は `reviewAnswers[]` の 1 本に閉じる。
 *
 * hash は必ず 16 桁 hex で検証する。 Discord から来た文字列がそのままパスの一部に
 * なる経路なので、 ここを緩めると任意ファイル書き込みになる。
 *
 * SRP: plan ファイルの位置決めと入出力だけ。
 *
 * @implements SPEC-DOMAIN-REVIEW-PLAN-FILE — spec/feature/domain-review-discord.md §4.1
 */

import { randomUUID } from "node:crypto";
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { DomainReviewPlanInput } from "./report.js";

/** repo 直下の plan 置き場 (Anatomia の PLAN_DIR_REL と同じ)。 */
export const PLAN_DIR_REL = ".anatomia/plan";

/** 同一 process 内で同じ plan への read-modify-write を直列化する。 */
const planWriteQueues = new Map<string, Promise<void>>();

/** plan は小さな突合資料。巨大ファイルを丸ごと読むローカル DoS を避ける。 */
const PLAN_MAX_BYTES = 5 * 1024 * 1024;

/** plan ファイル名に使える task hash か。 */
export function isPlanTaskHash(value: string): boolean {
  return /^[a-f0-9]{16}$/.test(value);
}

/** plan ファイルの絶対パス。 hash が不正なら null (投げない)。 */
export function planFilePath(repoPath: string, taskHash: string): string | null {
  if (!isPlanTaskHash(taskHash)) return null;
  return join(repoPath, PLAN_DIR_REL, `${taskHash}.json`);
}

/** Discord 返信 1 件を plan へ書き戻す形。 */
export interface PlanReviewAnswer {
  /** 回答者 (platform user id)。 */
  answeredBy: string;
  /** 回答本文 (人間の言葉のまま)。 */
  text: string;
  /** ISO8601。 */
  answeredAt: string;
  /** 出所 (`discord:<channel>/<message>` 等)。 誰の何への回答かを追える形。 */
  source: string;
}

/** hash 指定で plan の投稿材料を読む。 無い / 壊れているときは null。 */
export async function readPlan(
  repoPath: string,
  taskHash: string,
): Promise<DomainReviewPlanInput | null> {
  const file = await safePlanFile(repoPath, taskHash);
  if (!file) return null;
  const parsed = await readPlanJson(file);
  return parsed ? toPlanInput(taskHash, parsed) : null;
}

/**
 * その repo の直近 plan。 `anatomia plan` が作られた契機での投稿はこれを載せる
 * (どの plan かを外から渡せないため、 Anatomia の `verify --plan` と同じ
 * 「最後に書かれたもの」規則に合わせる)。
 */
export async function readLatestPlan(repoPath: string): Promise<DomainReviewPlanInput | null> {
  const dir = join(repoPath, PLAN_DIR_REL);
  let entries: string[];
  try {
    if (!await isSafePlanDirectory(repoPath)) return null;
    entries = await readdir(dir);
  } catch {
    return null;
  }
  const candidates: Array<{ hash: string; file: string; mtime: number }> = [];
  for (const entry of entries) {
    const hash = entry.endsWith(".json") ? entry.slice(0, -".json".length) : "";
    if (!isPlanTaskHash(hash)) continue;
    const file = await safePlanFile(repoPath, hash);
    if (!file) continue;
    try {
      candidates.push({ hash, file, mtime: (await stat(file)).mtimeMs });
    } catch {
      // readdir と stat のあいだに消えたファイルは候補ではない、それだけ。
    }
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file));
  const newest = candidates[0]!;
  const parsed = await readPlanJson(newest.file);
  return parsed ? toPlanInput(newest.hash, parsed) : null;
}

/**
 * 回答を `reviewAnswers[]` に追記する。 追記できたら true。
 *
 * plan が無い / 読めない / 書けないときは false を返すだけで投げない —
 * 「Discord の返信が受け取れなかった」ではなく「突合資料に残せなかった」だけで、
 * 回答そのものは Cc 側の台帳に残っている。
 */
export async function appendPlanReviewAnswer(
  repoPath: string,
  taskHash: string,
  answer: PlanReviewAnswer,
): Promise<boolean> {
  const file = await safePlanFile(repoPath, taskHash);
  if (!file) return false;
  return serializePlanWrite(file, async () => {
    const parsed = await readPlanJson(file);
    if (!parsed) return false;
    const existing = Array.isArray(parsed["reviewAnswers"]) ? parsed["reviewAnswers"] : [];
    if (existing.some((entry) => isRecord(entry) && entry["source"] === answer.source)) return true;
    const next = { ...parsed, reviewAnswers: [...existing, answer] };
    const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, "utf8");
      await rename(temporary, file);
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(() => undefined);
      return false;
    }
  });
}

async function serializePlanWrite<T>(file: string, operation: () => Promise<T>): Promise<T> {
  const previous = planWriteQueues.get(file) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(operation);
  const tail = result.then(() => undefined, () => undefined);
  planWriteQueues.set(file, tail);
  try {
    return await result;
  } finally {
    if (planWriteQueues.get(file) === tail) planWriteQueues.delete(file);
  }
}

async function readPlanJson(file: string): Promise<Record<string, unknown> | null> {
  try {
    const fileStat = await lstat(file);
    if (!fileStat.isFile() || fileStat.isSymbolicLink() || fileStat.size > PLAN_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** repo 外への junction / symlink を plan 読み書き経路として受け入れない。 */
async function safePlanFile(repoPath: string, taskHash: string): Promise<string | null> {
  const file = planFilePath(repoPath, taskHash);
  if (!file || !await isSafePlanDirectory(repoPath)) return null;
  try {
    const fileStat = await lstat(file);
    return fileStat.isFile() && !fileStat.isSymbolicLink() && fileStat.size <= PLAN_MAX_BYTES
      ? file
      : null;
  } catch {
    return null;
  }
}

async function isSafePlanDirectory(repoPath: string): Promise<boolean> {
  try {
    for (const directory of [repoPath, join(repoPath, ".anatomia"), join(repoPath, PLAN_DIR_REL)]) {
      const directoryStat = await lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function toPlanInput(taskHash: string, parsed: Record<string, unknown>): DomainReviewPlanInput {
  return {
    taskHash,
    questions: Array.isArray(parsed["questions"])
      ? parsed["questions"].filter((entry): entry is string => typeof entry === "string")
      : [],
    unresolved: Array.isArray(parsed["unresolved"])
      ? parsed["unresolved"].flatMap((entry) => {
        if (!isRecord(entry)) return [];
        const subject = entry["subject"];
        const reason = entry["reason"];
        if (typeof subject !== "string") return [];
        return [{ subject, reason: typeof reason === "string" ? reason : "" }];
      })
      : [],
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
