/**
 * @implements spec/feature/director-inquiry-session.md §3
 *
 * 問診セッションの読み取り専用契約 (決定的述語)。
 *
 * 問診セッションは「問いを組み立てる」ためだけに起動される。実装させると、
 * 人間の判断を待つべき点を自分で決めて進んでしまい、装置の目的が壊れる。
 * そのため編集・commit・push・PR・テスト・サービス制御・追加委託を deny する。
 * 問診は通常セッションより強い境界なので、未知の tool / shell command も fail-closed にする。
 *
 * 対象かどうかは session metadata の申告ではなく、**その run が問診として起動されたか**
 * (configured ask template + 正規の `director-inquiry:<subject>:<reason>:<UTC day>`) で決める。
 * セッション側が自称を書き換えて制約を外せないようにするため。
 */

import { posix, win32 } from "node:path";

interface InquiryAction {
  tool: string;
  command?: string;
  filePath?: string;
  cwd?: string;
  readOnlyInquiry?: boolean;
  inquiryCaseId?: string;
  inquiryApiBaseUrl?: string;
  inquiryReadRoot?: string;
  inquiryAllowedRunIds?: string[];
}

interface InquiryPredicateHit {
  rule: string;
  decision: "deny" | "warn";
  reason: string;
  suggestion?: string;
}

type InquiryPredicate = (action: InquiryAction) => InquiryPredicateHit | null;

const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep"]);

function isEditTool(tool: string): boolean {
  return EDIT_TOOLS.has(tool);
}

/**
 * 問診起動の triggered_by 全体形。inquiry-patrol.ts の冪等キー
 * (`director-inquiry:<subject>:<reason>:<UTC day>`) と対になる。接頭辞一致では
 * `director-inquiry:` を名乗るだけの値を通してしまうため、全体を照合する。
 */
const INQUIRY_TRIGGER_RE = /^director-inquiry:([^:]+):[^:]+:\d{4}-\d{2}-\d{2}$/;

export function isInquiryTriggeredBy(triggeredBy: string | null | undefined): boolean {
  return inquirySubjectFromTriggeredBy(triggeredBy) !== null;
}

/** 正規の問診冪等キーから subject (step id または case id) を取り出す。 */
export function inquirySubjectFromTriggeredBy(
  triggeredBy: string | null | undefined,
): string | null {
  if (typeof triggeredBy !== "string") return null;
  return INQUIRY_TRIGGER_RE.exec(triggeredBy)?.[1] ?? null;
}

// 連結・置換・redirect を許すと、先頭だけ安全な command に見せて後段で書き込める。
const SHELL_COMPOSITION = /(?:\r|\n|&&|\|\||[;&|`<>]|\$\(|(?:^|\s)--output(?:=|\s))/i;
const HTTP_TOOL = /^(?:curl(?:\.exe)?|Invoke-RestMethod|Invoke-WebRequest)\b/i;
const HTTP_WRITE_METHOD = /(?:^|\s)(?:-X\s*|--request(?:=|\s+)|-Method\s+)["']?(POST|PATCH|PUT|DELETE)\b/i;
// body を伴う flag は method 未指定でも POST になる。短縮形は `-dBODY` のように値が
// 直結する形も許されるため、ここは境界を要求せず前方一致のままにしてある (fail-closed)。
// 長い形だけは `--data-ascii` のような別 flag へ巻き込まれないよう境界を要求する。
const CURL_IMPLICIT_POST =
  /(?:^|\s)(?:-[dF]|--(?:data(?:-raw|-binary|-urlencode|-ascii)?|form(?:-string)?|json)(?=[=\s]|$))/i;
// 出力先ファイルを作る flag。shell の redirect (`>`) は SHELL_COMPOSITION で塞いであるので、
// ここが残る唯一のファイル書き込み経路になる。curl は -o 以外にも header dump / cookie jar /
// trace をファイルへ書けるため、同じ列に並べて塞ぐ。
const HTTP_FILE_WRITE = /(?:^|\s)(?:-o|--output|-O|--remote-name|-T|--upload-file|-c|--cookie-jar|--dump-header|--remote-header-name|--create-dirs|--etag-save|--stderr|--trace|--xattr|-OutFile|-InFile)/i;
// -D (--dump-header) と -J (--remote-header-name) は小文字の -d / -j (許可された body 送信)
// と別物なので、-x / -X と同じ理由でこの行だけ大小文字を区別する。
const HTTP_FILE_WRITE_SHORT_FLAG = /(?:^|\s)-[DJ]/;
const HTTP_DATA_FILE = /(?:^|\s)(?:-[dF]|--(?:data(?:-raw|-binary|-urlencode|-ascii)?|form(?:-string)?|json))(?:=|\s*)["']?@/i;
const HTTP_FILE_INPUT = /(?:^|\s)(?:-K|--config|-H|--header|-b|--cookie|--cert|--key|--netrc-file)(?:=|\s)/i;
const HTTP_NESTED_EXPRESSION = /[()]/;
// -x は curl の --proxy 短縮形。 -X (メソッド指定) と大小文字で区別する必要があるため、
// この行だけ /i を外し、他の長い flag だけ大小文字を許容する。
const HTTP_PROXY_SHORT_FLAG = /(?:^|\s)-x\b/;
const HTTP_ROUTE_OVERRIDE = /(?:^|\s)(?:-L|--location|--proxy|-Proxy|--connect-to|--resolve|--(?:abstract-)?unix-socket|--request-target)\b/i;
const HTTP_URL = /https?:\/\/[^\s"'`]+/gi;
const DECISION_POST_PATH = /^\/v1\/director\/cases\/([^/]+)\/steps\/[^/]+\/decisions\/?$/i;
const STEP_PATCH_PATH = /^\/v1\/director\/cases\/([^/]+)\/steps\/[^/]+\/?$/i;
// JSON の **キー位置** にある status だけを拒否する。値の中の "run status: failed" のような
// 正当な handoff_note まで拒否すると、問診セッションは shell を持たず自己診断できないため
// 原因不明の deny で詰む。キー位置は直前が `{` か `,` であることで判定する。
const STATUS_FIELD = /[{,]\s*["']?status["']?\s*:/i;
const HANDOFF_FIELD = /["']?handoff_note["']?\s*:/i;
const JSON_UNICODE_ESCAPE = /\\u[0-9a-f]{4}/i;

/**
 * quote の外側だけを残した文字列。閉じていない quote があれば解析不能として null を返す。
 *
 * 括弧 (PowerShell の部分式) は quote の外にあるときだけ実行される。JSON 本文に含まれる
 * 括弧まで一律に拒否すると、Decision Request の question / facts に丸括弧を書いた瞬間に
 * 唯一の書き込み経路が閉じる。問診セッションは shell を持たず deny を自己診断できないため、
 * それは原因不明の詰みになる。flag の判定は quote されていても効く (curl は `'-o'` も
 * flag として解釈する) ので、この緩和は **shell が解釈する記号だけ** に使う。
 */
function outsideQuotes(command: string): string | null {
  let out = "";
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    out += char;
  }
  return quote === null ? out : null;
}

function allowedInquiryCommand(
  command: string,
  inquiryCaseId: string | undefined,
  inquiryApiBaseUrl: string | undefined,
  inquiryAllowedRunIds: readonly string[] | undefined,
): boolean {
  const trimmed = command.trim();
  if (!trimmed || SHELL_COMPOSITION.test(trimmed)) return false;
  // quote を閉じていない command は shell の解釈が読めないので、その時点で落とす。
  const unquoted = outsideQuotes(trimmed);
  if (unquoted === null) return false;
  if (HTTP_TOOL.test(trimmed)) {
    if (HTTP_FILE_WRITE.test(trimmed) || HTTP_FILE_WRITE_SHORT_FLAG.test(trimmed)
      || HTTP_DATA_FILE.test(trimmed)
      || HTTP_FILE_INPUT.test(trimmed) || HTTP_NESTED_EXPRESSION.test(unquoted)
      || HTTP_PROXY_SHORT_FLAG.test(trimmed) || HTTP_ROUTE_OVERRIDE.test(trimmed)) return false;
    const urls = [...trimmed.matchAll(HTTP_URL)].map((match) => match[0]);
    if (urls.length !== 1) return false;
    const requestUrl = sameOriginUrl(urls[0]!, inquiryApiBaseUrl);
    if (!requestUrl) return false;
    const explicitMethod = HTTP_WRITE_METHOD.exec(trimmed)?.[1]?.toUpperCase();
    const method = explicitMethod ?? (CURL_IMPLICIT_POST.test(trimmed) ? "POST" : "GET");
    if (method === "GET") return allowedInquiryGetPath(
      requestUrl.pathname,
      inquiryCaseId,
      inquiryAllowedRunIds,
    );
    if (method === "POST") return inquiryCaseId !== undefined
      && DECISION_POST_PATH.exec(requestUrl.pathname)?.[1] === inquiryCaseId;
    if (method === "PATCH") return inquiryCaseId !== undefined
      && STEP_PATCH_PATH.exec(requestUrl.pathname)?.[1] === inquiryCaseId
      && HANDOFF_FIELD.test(trimmed)
      && !STATUS_FIELD.test(trimmed)
      && !JSON_UNICODE_ESCAPE.test(trimmed);
    return false;
  }
  // リポジトリ設定による pager / hook / textconv 等の外部実行を避けるため、
  // shell のファイル参照は許可しない。ソースは path-scoped Read/Glob/Grep で読む。
  return false;
}

function allowedInquiryGetPath(
  pathname: string,
  inquiryCaseId: string | undefined,
  inquiryAllowedRunIds: readonly string[] | undefined,
): boolean {
  if (inquiryCaseId && pathname === `/v1/director/cases/${inquiryCaseId}`) return true;
  const run = /^\/v1\/delegation\/runs\/([^/]+)\/?$/.exec(pathname)?.[1];
  return run !== undefined && (inquiryAllowedRunIds?.includes(run) ?? false);
}

function isInsideReadRoot(
  root: string | undefined,
  candidate: string | undefined,
  relativeBase: string | undefined = root,
): boolean {
  if (!root?.trim() || !candidate?.trim() || !relativeBase?.trim()
    || root.includes("\0") || candidate.includes("\0") || relativeBase.includes("\0")) return false;
  const pathApi = /^[A-Za-z]:[\\/]/.test(root) ? win32 : posix;
  const resolvedRoot = pathApi.resolve(root);
  const resolvedCandidate = pathApi.resolve(relativeBase, candidate);
  const relative = pathApi.relative(resolvedRoot, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !pathApi.isAbsolute(relative));
}

function sameOriginUrl(url: string, allowedBaseUrl: string | undefined): URL | null {
  if (!allowedBaseUrl) return null;
  try {
    const parsed = new URL(url);
    return parsed.origin === new URL(allowedBaseUrl).origin ? parsed : null;
  } catch {
    return null;
  }
}

const SUGGESTION = "問診セッションは読み取りと問いかけだけを行います。"
  + " 判断が要る点は decisions API へ Decision Request として出してください。";

/**
 * 問診セッションからの編集・書き込み可能な tool / command を deny する。
 *
 * 問診でないセッション (`readOnlyInquiry` が true でない) には一切干渉しない。
 * 判定材料が無いときも強制しない (predicates.ts 全体の方針と同じ)。
 */
export const inquiryReadOnly: InquiryPredicate = (a) => {
  if (a.readOnlyInquiry !== true) return null;
  if (isEditTool(a.tool)) {
    return {
      rule: "inquiry-read-only",
      decision: "deny",
      reason: "問診セッションはリポジトリのファイルを編集できません。",
      suggestion: SUGGESTION,
    };
  }
  if (READ_ONLY_TOOLS.has(a.tool)) {
    // Glob / Grep は探索パスを省略できる (既定は cwd) ので、hook から filePath が来ない。
    // その場合に無条件 deny すると、指示テンプレートが指示している調査手段が丸ごと使えない。
    // 対象は cwd そのものになるので、cwd を read root 判定へ回す (cwd も無ければ従来どおり deny)。
    return isInsideReadRoot(a.inquiryReadRoot, a.filePath ?? a.cwd, a.cwd ?? a.inquiryReadRoot)
      ? null
      : {
          rule: "inquiry-read-only",
          decision: "deny",
          reason: "問診セッションは解決済みの対象リポジトリ外を読み取れません。",
          suggestion: SUGGESTION,
        };
  }
  if (a.tool !== "Bash") {
    return {
      rule: "inquiry-read-only",
      decision: "deny",
      reason: `問診セッションでは未許可の tool (${a.tool}) を実行できません。`,
      suggestion: SUGGESTION,
    };
  }
  if (!a.command) return null;
  if (allowedInquiryCommand(
    a.command,
    a.inquiryCaseId,
    a.inquiryApiBaseUrl,
    a.inquiryAllowedRunIds,
  )) return null;
  return {
    rule: "inquiry-read-only",
    decision: "deny",
    reason: "問診セッションでは未許可の command または API 書き込みを実行できません。",
    suggestion: SUGGESTION,
  };
};
