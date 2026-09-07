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

export function discordTextAttachmentName(name: string, data: Buffer): string {
  const extension = extname(name).toLowerCase();
  if (!TEXT_EXTENSIONS.has(extension) || !isUtf8(data)) return name;
  // A text-looking extension alone must not relabel binary or legacy encodings.
  // Allow tabs, LF and CR; other ASCII control bytes are not plain-text content.
  if (data.some((byte) => byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) return name;
  return extension === ".txt" ? name : `${name}.txt`;
}
