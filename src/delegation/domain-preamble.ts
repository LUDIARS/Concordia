/**
 * 委託指示書の「ドメイン先行」前置き (設計 §5 C-2 / §12.3-12.4 C-11)。
 *
 * 委託される側は plan を走らせていない新しいセッションなので、「正しいドメインに置け」は
 * ドメインの説明・所有パス・既存のデータ定義が一緒に来ないと実行できない。 そこで invoke の
 * 直前に
 *
 *   1. 横断ドメインマップ検索でプロジェクトとコアドメインを確定し (C-11)
 *   2. そのプロジェクトの OKF ドメイン定義を取って (C-2)
 *
 * 指示書の **先頭** に埋め込む。 0 件なら「索引に無い」と書いて人間の確認を促す。
 *
 * **委託を止めないこと**が最優先。 Anatomia が落ちている / 索引に無い / ドメイン定義が
 * 無いときは織り込みを飛ばし、 従来どおりの指示書をそのまま返す。
 *
 * SRP: 前置きの組み立てのみ。 HTTP は anatomia/domain-map-client.ts。
 *
 * @implements SPEC-DELEGATION-DOMAIN-PREAMBLE
 */

import { basename } from "node:path";
import {
  fetchPlanOkf,
  searchDomainMap,
  type DomainMapSearchHit,
} from "../anatomia/domain-map-client.js";
import type { DelegationCategory } from "../db/delegation-repo.js";
import { resolveManualKind } from "./manual-kind.js";

/** 前置きの組み立て結果。 `text` が空なら何も足さない。 */
export interface DomainPreamble {
  text: string;
  /** 確定したプロジェクト id (Anatomia registry の id)。 */
  project: string | null;
  /** 何を織り込めたか (ログ / テスト用)。 */
  source: "map+okf" | "map" | "not-indexed" | "none";
}

const EMPTY: DomainPreamble = { text: "", project: null, source: "none" };

/** OKF は長くなりうるので、 指示書の先頭に置ける量へ切る。 */
const MAX_OKF = 12_000;

export interface DomainPreambleInput {
  /** 依頼文 (map 検索のクエリ、 plan の task)。 */
  task: string;
  /** 対象リポジトリの絶対パス (プロジェクト確定のヒント)。 */
  targetRepo?: string | null;
  /** map 検索のタイムアウト (既定 2s)。 */
  mapTimeoutMs?: number;
  /** plan のタイムアウト (既定 8s)。 */
  planTimeoutMs?: number;
}

/** テスト差し替え用の口 (既定は warm Anatomia server)。 */
export interface DomainPreambleDeps {
  search: typeof searchDomainMap;
  plan: typeof fetchPlanOkf;
}

const defaultDeps: DomainPreambleDeps = { search: searchDomainMap, plan: fetchPlanOkf };

/** 実装を伴う employee / freelancer テンプレだけを前置き対象にする。 */
export function isDomainPreambleTarget(input: {
  callName: string;
  title: string;
  category?: DelegationCategory | null;
}): boolean {
  if (input.category !== "employee" && input.category !== "freelancer") return false;
  return resolveManualKind({
    call_name: input.callName,
    title: input.title,
    category: input.category,
  }) === "実装";
}

/**
 * ヒットから対象プロジェクトを選ぶ。 target_repo の basename と一致するものを最優先
 * (「Pictor の作業なのに Figmentum の計画を貼る」を避ける)、 無ければ最上位ヒット。
 */
export function pickProject(
  hits: readonly DomainMapSearchHit[],
  targetRepo: string | null | undefined,
): string | null {
  if (hits.length === 0) return null;
  const repoName = targetRepo ? basename(targetRepo.replace(/[\\/]+$/, "")).toLowerCase() : "";
  if (repoName) {
    const exact = hits.find((hit) => hit.project.toLowerCase() === repoName);
    if (exact) return exact.project;
    // worktree は `<Project>-<branch-slug>` の形をとる。 先頭一致でも拾う。
    const prefixed = hits.find((hit) => repoName.startsWith(`${hit.project.toLowerCase()}-`));
    if (prefixed) return prefixed.project;
  }
  return hits[0]?.project ?? null;
}

/** 命中を 1 行で書く (プロダクト → コンテンツ → コアドメイン → 主要パス)。 */
function formatHit(hit: DomainMapSearchHit): string {
  const parts = [`${hit.project} / ${hit.name} (${hit.kind})`];
  if (hit.coreDomain) parts.push(`コアドメイン: ${hit.coreDomain}`);
  if (hit.paths.length > 0) parts.push(`主要パス: ${hit.paths.slice(0, 3).join(", ")}`);
  if (hit.spec) parts.push(`spec: ${hit.spec}`);
  return `- ${parts.join(" — ")}`;
}

/**
 * 前置きを組み立てる。 織り込むものが何も無ければ `text: ""` を返す
 * (呼び出し側はそのまま従来の指示書を使う)。
 */
export async function buildDomainPreamble(
  input: DomainPreambleInput,
  deps: DomainPreambleDeps = defaultDeps,
): Promise<DomainPreamble> {
  const task = input.task.trim();
  if (!task) return EMPTY;

  let result;
  try {
    result = await deps.search(task, { limit: 5, timeoutMs: input.mapTimeoutMs });
  } catch {
    return EMPTY; // Anatomia が居ない = 織り込みを飛ばす (委託は止めない)。
  }
  if (!result) return EMPTY;

  if (result.hits.length === 0) {
    // 0 件は「索引に無い」= 新規コンテンツか表記ゆれ。 委託は進めるが人間に確認を促す。
    return {
      text: [
        "## ドメイン先行 (Anatomia 横断ドメインマップ)",
        "",
        "この依頼文は横断ドメインマップの **索引に無い** — 1 件も当たりませんでした (新規コンテンツか表記ゆれ)。",
        "対象プロジェクトとコアドメインが確定していないので、着手前に `anatomia plan --task \"<依頼文>\" --project <project>` を自分で走らせ、",
        "着地ドメインが決まらなければ人間に確認してください (推測で新規ドメインを作らない)。",
        "",
      ].join("\n"),
      project: null,
      source: "not-indexed",
    };
  }

  const project = pickProject(result.hits, input.targetRepo);
  const lines: string[] = [
    "## ドメイン先行 (Anatomia 横断ドメインマップ)",
    "",
    `検索語: ${task.slice(0, 200)}`,
    ...result.hits.slice(0, 5).map(formatHit),
    "",
  ];
  if (project) lines.push(`確定したプロジェクト: **${project}**`, "");

  let okf: string | null = null;
  if (project) {
    try {
      okf = await deps.plan(project, task, { timeoutMs: input.planTimeoutMs });
    } catch {
      okf = null;
    }
  }
  if (okf) {
    lines.push(
      "以下はこのタスクの **OKF ドメイン計画** です。ここに挙がったドメインの中で設計し、",
      "`予定パス` の外に出るなら同じ PR で membership を足してください。",
      "",
      okf.length > MAX_OKF ? `${okf.slice(0, MAX_OKF)}\n…(truncated)` : okf,
      "",
    );
  } else {
    lines.push(
      "(対象リポにドメイン定義が無い、または Anatomia から計画を取得できませんでした。",
      "着手時に `anatomia plan` / `where` を自分で走らせて着地ドメインを決めてください。)",
      "",
    );
  }
  return { text: lines.join("\n"), project, source: okf ? "map+okf" : "map" };
}

/**
 * 委託 args から「依頼文」を選ぶ (map 検索のクエリ)。 テンプレごとに変数名が違うので
 * 実装系で使われる順に見る。 どれも無ければ null (= 織り込みを飛ばす)。
 */
export function pickDelegationTaskText(args: Record<string, unknown>): string | null {
  for (const key of ["task", "description", "problem", "goal", "target"]) {
    const value = args[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

/** 織り込みを止める env スイッチ (既定 ON)。 */
export function domainPreambleEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env.CONCORDIA_DELEGATION_DOMAIN_PREAMBLE ?? "1") !== "0";
}

/** 前置きを指示書の先頭へ足す。 空なら元のプロンプトをそのまま返す。 */
export function prependDomainPreamble(prompt: string, preamble: DomainPreamble): string {
  if (!preamble.text.trim()) return prompt;
  return `${preamble.text.trimEnd()}\n\n---\n\n${prompt}`;
}
