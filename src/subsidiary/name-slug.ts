/**
 * 子会社 name (slug) の自動正規化。
 *
 * 子会社の `name` は識別子 slug (`/^[a-z][a-z0-9_-]{0,63}$/`) で、 これに合わない入力は
 * 以前は 400 で弾いていた。 Discord 受付チャンネル名を自動補正するのと同じ発想で、
 * 入力を弾かず「直して通す」。 解決順:
 *   1. 既に正規 slug      → そのまま (重複判定は呼び出し側で 409)。
 *   2. 決定的 slug 化     → "Test Sub" → "test-sub" (ASCII は LLM 不要)。
 *   3. Haiku でローマ字化  → "テスト子会社" → "tesuto-kogaisha" (日本語等)。
 *   4. 表示名から slug 化。
 *   5. ランダム fallback  → "sub-xxxxxxxx" (決して 400 にしない)。
 *
 * Haiku は LUDIARS 規約に従い API ではなく claude CLI (`--model haiku`) 経由
 * (RunClaudeFn)。 失敗・タイムアウトは無言で握り潰さず warn ログを残し、 下位の決定的
 * fallback に倒す (= 正規 slug は必ず得られる)。
 */

import { randomUUID } from "node:crypto";
import type { RunClaudeFn } from "../rules/claude-runner.js";
import { extractJson } from "../rules/claude-runner.js";

/** 子会社 name の正規 slug 規則 (subsidiary API / repo の正本)。 */
export const NAME_RE = /^[a-z][a-z0-9_-]{0,63}$/;

/**
 * 任意文字列を決定的に slug 化する。 正規 slug にできなければ "" を返す。
 * 先頭が英字でない (数字始まり等) 場合は "s-" を前置して規則に寄せる。
 */
export function slugifySubsidiaryName(raw: string): string {
  const body = (raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  if (!body) return "";
  const fixed = /^[a-z]/.test(body) ? body : `s-${body}`.slice(0, 64);
  return NAME_RE.test(fixed) ? fixed : "";
}

/** Haiku に渡す slug 生成プロンプト (純粋関数 / テスト対象)。 */
export function buildSlugPrompt(rawName: string, displayName?: string): string {
  return [
    "次の名前を、識別子として使う英小文字スラッグに変換してください。",
    "規則: 先頭は英小文字 (a-z)、使える文字は a-z 0-9 ハイフン(-) アンダースコア(_) のみ、最大40文字。",
    "日本語はヘボン式ローマ字または簡潔な英訳にし、意味が伝わる短い slug にしてください。",
    '出力は JSON のみ: {"slug":"..."}',
    `名前: ${rawName}`,
    displayName?.trim() ? `表示名: ${displayName.trim()}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** Haiku stdout から slug を取り出し、 決定的に再正規化する (不正は "")。 */
export function parseSlugFromClaude(stdout: string): string {
  const obj = extractJson(stdout) as { slug?: unknown } | null;
  const slug = obj && typeof obj.slug === "string" ? obj.slug : "";
  return slugifySubsidiaryName(slug);
}

async function generateSlugViaHaiku(
  rawName: string,
  displayName: string | undefined,
  runClaude: RunClaudeFn | undefined,
  log?: { warn: (msg: string) => void },
): Promise<string> {
  if (!runClaude) return "";
  try {
    const r = await runClaude(buildSlugPrompt(rawName, displayName), { model: "haiku", timeoutMs: 30_000 });
    if (!r.ok) {
      log?.warn(`subsidiary name slug: haiku 異常終了 (fallback to deterministic): ${(r.stderr ?? "").slice(0, 200)}`);
      return "";
    }
    return parseSlugFromClaude(r.stdout);
  } catch (e) {
    log?.warn(`subsidiary name slug: haiku 例外 (fallback to deterministic): ${(e as Error).message}`);
    return "";
  }
}

/** base が衝突する場合 -2, -3, … を足して一意化。 それでも埋まればランダム後置。 */
function uniquify(base: string, exists: (name: string) => boolean): string {
  if (!exists(base)) return base;
  for (let i = 2; i <= 50; i++) {
    const cand = `${base}-${i}`.slice(0, 64);
    if (!exists(cand)) return cand;
  }
  return `${base.slice(0, 55)}-${randomUUID().slice(0, 8)}`.slice(0, 64);
}

export interface ResolveSubsidiaryNameDeps {
  /** その name が既に存在するか (repo.findByName(name) != null)。 */
  exists: (name: string) => boolean;
  /** Haiku 呼び出し (claude CLI)。 省略時は決定的経路のみ。 */
  runClaude?: RunClaudeFn;
  log?: { warn: (msg: string) => void };
}

export interface ResolveSubsidiaryNameResult {
  /** 確定した正規 slug (必ず NAME_RE に合致)。 */
  name: string;
  /** 入力をそのまま使えず補正したか。 */
  normalized: boolean;
  /** 解決経路 (監査/通知用)。 */
  source: "raw" | "slug" | "haiku" | "random";
}

/**
 * 子会社 name を必ず正規 slug へ解決する (400 にしない)。 既に正規 slug の場合は補正せず
 * そのまま返す (重複は呼び出し側で 409 にするか自動一意化するか選べる)。 補正経路では
 * 自動一意化まで行う。
 */
export async function resolveSubsidiaryName(
  rawNameInput: string | undefined,
  displayName: string | undefined,
  deps: ResolveSubsidiaryNameDeps,
): Promise<ResolveSubsidiaryNameResult> {
  const raw = (rawNameInput ?? "").trim();

  // 1. 既に正規 slug → そのまま (重複判定は呼び出し側)。
  if (NAME_RE.test(raw)) return { name: raw, normalized: false, source: "raw" };

  // 2. 決定的 slug 化 (ASCII / 記号区切り)。
  const simple = slugifySubsidiaryName(raw);
  if (simple) return { name: uniquify(simple, deps.exists), normalized: true, source: "slug" };

  // 3. Haiku でローマ字 slug 化 (日本語等、 決定的に slug 化できない入力)。
  const ai = await generateSlugViaHaiku(raw, displayName, deps.runClaude, deps.log);
  if (ai) return { name: uniquify(ai, deps.exists), normalized: true, source: "haiku" };

  // 4. 表示名からの決定的 slug。
  const fromDisplay = slugifySubsidiaryName(displayName ?? "");
  if (fromDisplay) return { name: uniquify(fromDisplay, deps.exists), normalized: true, source: "slug" };

  // 5. 最終 fallback: ランダム (必ず正規 slug を返す)。
  return { name: uniquify(`sub-${randomUUID().slice(0, 8)}`, deps.exists), normalized: true, source: "random" };
}
