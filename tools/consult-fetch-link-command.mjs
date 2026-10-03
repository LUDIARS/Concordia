/**
 * 相談セッションに許す唯一のシェルコマンド (公開リンクの取得) の判定 (spec/feature/tech-consultation.md §6、 CC-CONSULT-INV-07)。
 *
 *   node <相談フォルダ>/_source/tools/fetch-link/fetch-link.mjs '<URL>'
 *
 * Astra (codex) の相談のフック (consult-codex-hook.mjs) が、 シェルのツールのたびにこれで判定し、 外れたら Cc に聞かずに止める。
 * 形を「node + 既知のスクリプト + URL 1 つ」に固定する。 スクリプトは既知のパスとの一致で縛り、 自由に入る URL は
 * 文字の範囲で縛る (区切り記号・変数展開・改行を入れさせない)。 URL のホストの検査は取得スクリプト側が持つ。
 */

/** 起動 env に入る取得スクリプトの絶対パス (projectless-consult.ts の CONSULT_FETCH_LINK_SCRIPT_ENV と揃える)。 */
export const FETCH_LINK_SCRIPT_ENV = "CONCORDIA_CONSULT_FETCH_LINK_SCRIPT";

const SHELL_WRAPPERS = new Set(["bash", "bash.exe", "sh", "zsh", "powershell", "powershell.exe", "pwsh", "pwsh.exe", "cmd", "cmd.exe"]);

const normalizePath = (path) => path.replace(/\\/g, "/").replace(/\/+/g, "/").toLowerCase();

/** codex がシェルを包んだ形 (["powershell", "-Command", "..."] / ["bash", "-lc", "..."]) から、 実行する文を取り出す。 */
export function commandText(command) {
  if (typeof command === "string") return command;
  if (!Array.isArray(command) || command.length === 0 || !command.every((part) => typeof part === "string")) return null;
  const shell = command[0].replace(/\\/g, "/").split("/").pop().toLowerCase();
  if (SHELL_WRAPPERS.has(shell)) return command.length >= 3 ? command[command.length - 1] : null;
  return command.join(" ");
}

// スクリプト: "..." / '...' / 引用なし。 URL: '...' (中の & ; ? は文字どおり) / "..." / 引用なし (& ; を含まない)。
// どの形も $ ` 改行 引用符 バックスラッシュ < > | を含めない (シェルや PowerShell が解釈する文字)。
const SCRIPT = String.raw`(?:"([^"\r\n$\x60]+)"|'([^'\r\n]+)'|([^\s'"$\x60;&|<>]+))`;
const SAFE = String.raw`\-A-Za-z0-9._~:/?#=%+@!*,()\[\]`;
const URL_ARG = String.raw`(?:'([${SAFE}&;]+)'|"([${SAFE}&;]+)"|([${SAFE}]+))`;
const FORM = new RegExp(String.raw`^\s*node(?:\.exe)?\s+${SCRIPT}\s+${URL_ARG}\s*$`);

/** そのコマンドが「取得スクリプトを URL 1 つで呼ぶだけ」か。 scriptPath が無い (起動 env に無い) ときは何も許さない。 */
export function isAllowedFetchLinkCommand(command, scriptPath) {
  if (typeof scriptPath !== "string" || !scriptPath.trim()) return false;
  const text = commandText(command);
  if (typeof text !== "string" || text.length > 4096) return false;
  const match = text.match(FORM);
  if (!match) return false;
  const script = match[1] ?? match[2] ?? match[3];
  if (normalizePath(script) !== normalizePath(scriptPath)) return false;
  const url = match[4] ?? match[5] ?? match[6];
  return /^https:\/\//i.test(url);
}
