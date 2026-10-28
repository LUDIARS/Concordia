/**
 * 拠点間ワンショット調査の業務判断 (純関数)。 I/O は持たない。
 *
 * - 本社での振り分け: 自分で実行 / 宛先拠点へ中継 / 断る
 * - 実行側の CLI 引数: 読み取り専用の道具だけを許す
 * - 結果本文の切り詰め
 *
 * @implements spec/feature/federation-link.md §拠点間ワンショット調査 (SPEC-FED-INQUIRY)
 */
import { INQUIRY_HQ, INQUIRY_MAX_OUTPUT, INQUIRY_MAX_TIMEOUT_SEC, INQUIRY_MIN_TIMEOUT_SEC } from "./protocol.js";
import { contract } from './ontime-runtime.js'; /* augur-inject:import:9d3163ca */
import augurContract_7f99f9cc from './inquiry-boundary.contract.js'; /* augur-inject:contract-predicate:059fdb65 */

export const INQUIRY_DEFAULT_TIMEOUT_SEC = 300;
/** 宛先の実行期限に足す待ち時間 (中継・CLI 起動・結果返送の分)。 */
export const INQUIRY_RESPONSE_GRACE_MS = 20_000;

/**
 * 調査で使ってよい道具。 ファイル・設定・サービスを変更できるものは含めない。
 * 各読取は実行時ガードを通す。gitも設定・引数から範囲外へ届くためBashは許さない。
 */
export const INQUIRY_ALLOWED_TOOLS = [
  "Read",
  "Grep",
  "Glob",
] as const;

/** 明示的に塞ぐ道具 (allowedTools の解釈が変わっても書き込みに届かないように二重にする)。 */
export const INQUIRY_DISALLOWED_TOOLS = [
  "Bash",
  "Edit",
  "Write",
  "NotebookEdit",
  "WebFetch",
  "WebSearch",
  "Agent",
  "Task",
] as const;

export function clampInquiryTimeoutSec(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return INQUIRY_DEFAULT_TIMEOUT_SEC;
  return Math.min(INQUIRY_MAX_TIMEOUT_SEC, Math.max(INQUIRY_MIN_TIMEOUT_SEC, Math.floor(value)));
}

export function truncateInquiryOutput(output: string): string {
  if (output.length <= INQUIRY_MAX_OUTPUT) return output;
  const note = "\n\n…(出力上限を超えたため以降を省略しました)";
  return output.slice(0, INQUIRY_MAX_OUTPUT - note.length) + note;
}

/** 拠点からの依頼を本社がどう扱うか。 */
export type HqInquiryRoute =
  | { kind: "local" }
  | { kind: "forward"; siteId: string }
  | { kind: "reject"; error: string };

export function decideHqInquiryRoute(input: {
  origin: string;
  target: string;
  /** 依頼を送ってきた拠点 (認証済みの接続)。 */
  fromSite: string;
  isActiveSite(siteId: string): boolean;
  isConnected(siteId: string): boolean;
}): HqInquiryRoute {
  // origin は接続の主体と一致させる (他拠点になりすまして結果を横取りさせない)。
  if (input.origin !== input.fromSite) return { kind: "reject", error: "origin does not match the sending site" };
  if (input.target === INQUIRY_HQ) return { kind: "local" };
  if (input.target === input.fromSite) return { kind: "reject", error: "target is the requesting site itself" };
  if (!input.isActiveSite(input.target)) return { kind: "reject", error: `unknown or revoked site: ${input.target}` };
  if (!input.isConnected(input.target)) return { kind: "reject", error: `site is offline: ${input.target}` };
  return { kind: "forward", siteId: input.target };
}

/** 本社が自分から出す依頼の宛先検証。 */
export function validateHqInquiryTarget(input: {
  target: string;
  isActiveSite(siteId: string): boolean;
  isConnected(siteId: string): boolean;
}): { ok: true; local: boolean } | { ok: false; error: string } {
  if (input.target === INQUIRY_HQ) return { ok: true, local: true };
  if (!input.isActiveSite(input.target)) return { ok: false, error: `unknown or revoked site: ${input.target}` };
  if (!input.isConnected(input.target)) return { ok: false, error: `site is offline: ${input.target}` };
  return { ok: true, local: false };
}

/** 結果を返してきた拠点が、 依頼を渡した宛先と一致するか。 */
export function isExpectedInquiryResponder(expectedTarget: string, fromSite: string): boolean {
  return expectedTarget === fromSite;
}

/** `claude -p` に渡す引数。 依頼文は stdin で渡す。 */
export function inquiryClaudeArgs(model: string, settings: string): string[] {
  return [
    "-p",
    "--model", model,
    "--effort", "medium",
    "--tools", INQUIRY_ALLOWED_TOOLS.join(","),
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--setting-sources", "",
    "--settings", settings,
    "--allowedTools", INQUIRY_ALLOWED_TOOLS.join(","),
    "--disallowedTools", INQUIRY_DISALLOWED_TOOLS.join(","),
  ];
}
// @ts-expect-error augur-inject
inquiryClaudeArgs = contract(inquiryClaudeArgs, { ...augurContract_7f99f9cc, contractId: 'inquiry-boundary-C-2', mode: 'observe', sample: 1, where: 'src/federation/inquiry-policy.ts:90', rule: 'contract-wrap', id: '7f99f9cc' }); /* augur-inject:contract-wrap:7f99f9cc */

/** 実行側で依頼文に添える前置き (読み取り専用であること・結果の書き方)。 */
export function buildInquiryPrompt(input: { origin: string; prompt: string; cwd: string }): string {
  return [
    `これは連合の拠点 "${input.origin}" からのワンショット調査依頼です。作業ディレクトリ: ${input.cwd}`,
    "読み取りだけで調べ、ファイル・設定・サービスを変更しないでください。",
    "結論を先に、根拠 (ファイルパス・ログ行・コマンド結果) を添えて簡潔に答えてください。",
    "",
    "--- 依頼 ---",
    input.prompt,
  ].join("\n");
}
