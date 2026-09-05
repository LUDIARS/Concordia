/**
 * Augur CLI の呼び出し口 — 契約ファイルの検出、 CLI パスの解決、 `contracts report
 * --acceptance` の実行と JSON 解釈だけを持つ。
 *
 * 突合そのもの (自己申告と集計の照合) は acceptance-reconcile.ts、 completed 判定への
 * 組み込みは completion-evidence.ts。 ここを分けているのは、 突合ロジックを外部プロセス
 * 無しでテストできるようにするため (実行は DI で差し替える)。
 *
 * Augur は PATH に居ない (`node <Augur>/bin/augur.mjs` で起動する) ので、 パスは
 * 実行時に解決する。 端末固有の絶対パスをソースへ書かない。
 *
 * @implements spec/feature/task-workflow.md §5 — 受け入れ条件の契約書式と完了証跡
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** worktree 直下に置く契約ファイル。 これがある委託だけが突合の対象になる。 */
export const AUGUR_CONTRACTS_FILE = "augur.contracts.json";

/** Augur の `--acceptance --json` が返す 1 項目。 `met` は covered のみ true。 */
export interface AugurAcceptanceItem {
  criterion: string;
  met: boolean;
  note?: string | null;
}

/** Augur CLI の起動 (DI 点)。 既定実装は node で bin/augur.mjs を execFile する。 */
export type AugurRunner = (input: {
  cliPath: string;
  args: readonly string[];
  cwd: string;
}) => Promise<string>;

const AUGUR_TIMEOUT_MS = 120_000;
const MAX_ACCEPTANCE_ITEMS = 200;
const MAX_CRITERION_LENGTH = 1_000;
const MAX_NOTE_LENGTH = 4_000;

/** 委託先の checkout に契約ファイルが置かれているか。 */
export function hasAcceptanceContract(dir: string): boolean {
  return existsSync(join(dir, AUGUR_CONTRACTS_FILE));
}

/**
 * Augur CLI (`bin/augur.mjs`) の場所を解決する。
 *
 * 1. env `CONCORDIA_AUGUR_DIR` (明示指定が最優先)
 * 2. ワークスペースルート直下の `Augur/` — repo 走査 (src/work/repo-scan.ts) と同じ、
 *    「ローカルクローンはワークスペースルートに並ぶ」という規則。
 *
 * どこにも無ければ null。 呼び出し側は「証跡を取れない」として扱う。
 */
export function resolveAugurCliPath(input: {
  env?: NodeJS.ProcessEnv;
  workspaceRoots?: readonly string[];
  exists?: (path: string) => boolean;
}): string | null {
  const exists = input.exists ?? existsSync;
  const explicit = (input.env?.CONCORDIA_AUGUR_DIR ?? "").trim();
  const candidates = explicit
    ? [join(explicit, "bin", "augur.mjs")]
    : (input.workspaceRoots ?? []).map((root) => join(root, "Augur", "bin", "augur.mjs"));
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 注入テンプレへ載せる起動コマンド表記 (`node <path>`)。 */
export function augurCliCommand(cliPath: string): string {
  // This text is copied into a PowerShell-oriented delegation prompt. Keep the
  // executable path inside a literal so a configured workspace path containing
  // spaces, `$`, or command separators cannot become prompt-supplied shell syntax.
  if (/[\r\n]/.test(cliPath)) throw new Error("Augur CLI path contains a line break");
  return `node '${cliPath.replace(/'/g, "''")}'`;
}

const defaultRunner: AugurRunner = async ({ cliPath, args, cwd }) => {
  // shell を挟まない (引数のクォート事故と injection をどちらも避ける)。
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    cwd,
    timeout: AUGUR_TIMEOUT_MS,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout;
};

/**
 * `contracts report --acceptance --json --since <ISO>` を実行して項目一覧を得る。
 * 実行失敗・JSON 不正はそのまま throw する (呼び出し側が「証跡取得不能」として扱う)。
 */
export async function collectAugurAcceptance(input: {
  cliPath: string;
  projectDir: string;
  since: string;
  runner?: AugurRunner;
}): Promise<AugurAcceptanceItem[]> {
  const runner = input.runner ?? defaultRunner;
  const stdout = await runner({
    cliPath: input.cliPath,
    args: ["contracts", "report", "--project", input.projectDir, "--acceptance", "--json", "--since", input.since],
    cwd: input.projectDir,
  });
  return parseAugurAcceptance(stdout);
}

/**
 * `--acceptance --json` の出力を項目配列にする。 素の配列と、 `acceptance` / `items`
 * キーに入った形の両方を受ける (Augur 側の出力ラッパが増えても落ちないように)。
 */
export function parseAugurAcceptance(stdout: string): AugurAcceptanceItem[] {
  const trimmed = stdout.trim();
  if (!trimmed) throw new Error("augur acceptance report was empty");
  const parsed: unknown = JSON.parse(trimmed);
  const list = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.acceptance)
      ? parsed.acceptance
      : isRecord(parsed) && Array.isArray(parsed.items)
        ? parsed.items
        : null;
  if (!list) throw new Error("augur acceptance report was not an array");
  if (list.length > MAX_ACCEPTANCE_ITEMS) throw new Error("augur acceptance report had too many items");
  return list.map((entry, index): AugurAcceptanceItem => {
    if (!isRecord(entry)
      || typeof entry.criterion !== "string"
      || entry.criterion.trim().length === 0
      || entry.criterion.length > MAX_CRITERION_LENGTH
      || typeof entry.met !== "boolean"
      || (entry.note !== undefined && entry.note !== null && typeof entry.note !== "string")
      || (typeof entry.note === "string" && entry.note.length > MAX_NOTE_LENGTH)) {
      throw new Error(`augur acceptance item ${index} was invalid`);
    }
    return {
      criterion: entry.criterion,
      met: entry.met,
      note: typeof entry.note === "string" ? entry.note : null,
    };
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
