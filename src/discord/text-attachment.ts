/**
 * Choose a Discord-expandable filename without changing the uploaded bytes.
 * @implements spec/feature/discord-ui.md — テキスト添付の展開
 * Domain: chat-platforms (presentation policy; no file or network I/O).
 */
import { extname } from "node:path";
import { isUtf8 } from "node:buffer";

const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".log", ".csv", ".tsv",
  ".json", ".jsonl", ".ndjson", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".xml", ".html", ".htm", ".css", ".scss", ".sql", ".diff", ".patch",
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".py", ".rb",
  ".go", ".rs", ".java", ".c", ".h", ".cpp", ".hpp", ".cs",
  ".sh", ".bash", ".ps1", ".psm1", ".bat", ".cmd",
]);

/**
 * 制御文字の走査は添付 1 件あたり最大 24 MiB を舐めるので、 JS コールバックの
 * `Buffer#some` ではなく `indexOf` の native 走査を使う。 タブ (9) / LF (10) /
 * CR (13) は本文に現れるため除外する。
 */
function hasNonTextControlByte(data: Buffer): boolean {
  for (let byte = 0; byte < 32; byte += 1) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (data.indexOf(byte) !== -1) return true;
  }
  return false;
}

export function discordTextAttachmentName(name: string, data: Buffer): string {
  const extension = extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) || !isUtf8(data)) return name;
  // A text-looking extension alone must not relabel binary or legacy encodings.
  if (hasNonTextControlByte(data)) return name;
  return extension === ".txt" ? name : `${name}.txt`;
}
