import path from "node:path";

/**
 * main 直 push の許可リスト。
 *
 * ハーネスの `no-main-push` は「変更はブランチ → PR」を強制するためのものだが、
 * push を閉じておらず全リポ private な取引先 org のような運用では main へ
 * 直接 push してよい。 リポ単位の例外をここで判定し、 予測子 (predicates.ts) と blackbox の
 * 特徴量 (blackbox-engine.ts) の双方が同じ規則を共有する。
 *
 * 許可リストの要素は「リポジトリのディレクトリ名」 (例 `AlphaGame`) または「絶対パス」
 * (例 `C:/repos/AlphaGame`)。 判定対象は action.cwd に加え、 コマンド中の
 * `git -C <path>` の path — 別リポを cwd 外から push する形 (実失敗例) を拾うため。
 */

/**
 * 既定の許可リストは**空**。 このリポジトリは public なので、どの取引先リポに
 * main 直 push を許しているかを既定値として同梱しない。
 *
 * 例外は運用側で入れる: 設定 UI (`harness.main_push_allowlist`) か env
 * {@link MAIN_PUSH_ALLOWLIST_ENV}。 未設定なら例外なし = 全リポで main 直 push を
 * 止める、という**安全側**に倒れる (許してしまう方向には倒れない)。
 */
export const DEFAULT_MAIN_PUSH_ALLOWLIST: readonly string[] = [];

/** 許可リストを供給する env (Cc 設定 `harness.main_push_allowlist` が優先)。 */
export const MAIN_PUSH_ALLOWLIST_ENV = "HARNESS_MAIN_PUSH_ALLOWLIST";

/** カンマ / 改行区切りの文字列を許可リストへ。 未設定 (null/undefined/空) なら null。 */
export function parseMainPushAllowlist(raw: string | null | undefined): string[] | null {
  if (raw === null || raw === undefined) return null;
  const entries = raw.split(/[,\n]/).map((e) => e.trim()).filter(Boolean);
  return entries.length > 0 ? entries : null;
}

/** パスを比較用に正規化する (小文字・`\` → `/`・`.` / `..` 解決)。 */
function normalizePath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  const unquoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
      ? trimmed.slice(1, -1)
      : trimmed;
  const slashed = unquoted.replace(/\\/g, "/");
  if (!slashed) return "";
  const normalized = path.posix.normalize(slashed).toLowerCase();
  if (normalized === "/" || /^[a-z]:\/$/i.test(normalized)) return normalized;
  return normalized.replace(/\/+$/, "");
}

const SIMPLE_GIT_PUSH_RE =
  /^\s*git(?:\.exe)?(?:\s+-C\s+(?:"([^"]+)"|'([^']+)'|([^\s"']+)))?\s+push(?:\s|$)/i;
const SHELL_COMPOSITION_RE = /[;&|`()\r\n]/;

function isAbsolutePath(value: string): boolean {
  return /^(?:[a-z]:\/|\/)/i.test(value);
}

/** 許可エントリは単一ディレクトリ名か絶対パスだけ。曖昧な相対パスは無効として扱う。 */
function normalizeAllowlistEntry(value: string): string {
  const normalized = normalizePath(value);
  if (!normalized || normalized === "." || normalized === "..") return "";
  if (normalized.includes("/")) return isAbsolutePath(normalized) ? normalized : "";
  return /^[a-z]:/i.test(normalized) ? "" : normalized;
}

/** `git -C` の相対パスは action.cwd 基準で解決する。 drive-relative は安全に解決できないため拒否。 */
function resolveGitCPath(value: string, cwd?: string): string {
  const normalized = normalizePath(value);
  if (!normalized || /^[a-z]:[^/]/i.test(normalized)) return "";
  if (isAbsolutePath(normalized)) return normalized;
  const base = normalizePath(cwd ?? "");
  return base ? normalizePath(`${base}/${normalized}`) : normalized;
}

/**
 * main push の実対象パスを列挙する。 単純な `git push` は cwd、 `git -C <path> push`
 * は `-C` の path を使う。 引用符付きパス (空白を含む Windows パス) にも対応する。
 *
 * 複合 shell コマンドや `-c` / `--git-dir` 等の追加 global option は対象コマンドとの対応を
 * 安全に確定できないため空配列を返す。 呼び出し側は空配列を非許可として扱い、 inline alias、
 * decoy の `-C`、別の Git 対象指定による gate 回避を防ぐ。
 */
export function mainPushTargetPaths(action: { command?: string; cwd?: string }): string[] {
  const command = action.command?.trim();
  if (!command) return action.cwd?.trim() ? [normalizePath(action.cwd)] : [];
  if (SHELL_COMPOSITION_RE.test(command)) return [];

  const push = SIMPLE_GIT_PUSH_RE.exec(command);
  if (!push) return [];
  const rawGitC = push[1] ?? push[2] ?? push[3];
  if (rawGitC !== undefined) {
    const target = resolveGitCPath(rawGitC, action.cwd);
    return target ? [target] : [];
  }
  return action.cwd?.trim() ? [normalizePath(action.cwd)] : [];
}

/**
 * 1 パスが 1 許可エントリに該当するか。
 * - エントリがパス区切りを含む (= 絶対パス指定) → 完全一致 or その配下
 * - 含まない (= ディレクトリ名指定) → パス区切り単位のセグメント一致
 */
function matchesEntry(path: string, entry: string): boolean {
  if (!path || !entry) return false;
  if (entry === "/" || /^[a-z]:\/$/i.test(entry)) return path.startsWith(entry);
  if (entry.includes("/")) return path === entry || path.startsWith(`${entry}/`);
  return path.split("/").includes(entry);
}

/** action の対象リポが許可リストに載っているか (main 直 push を許可してよいか)。 */
export function isMainPushAllowlisted(
  action: { command?: string; cwd?: string },
  allowlist: readonly string[],
): boolean {
  const entries = allowlist.map(normalizeAllowlistEntry).filter(Boolean);
  if (entries.length === 0) return false;
  const paths = mainPushTargetPaths(action);
  return paths.length > 0 && paths.every((path) => entries.some((entry) => matchesEntry(path, entry)));
}
