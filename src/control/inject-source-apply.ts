/**
 * Cc 本体の `dist/control/inject-source-apply.js <get|history|apply> <id> [...]` の入口。
 * AI セッションの許可ルールをこのコマンドだけに絞るため、管理 API への書込みはここを通す。
 */

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { InjectSourceClient, InjectSourceError, resolveConcordiaUrl, type FetchLike } from "./inject-source-client.js";

export interface CliIo {
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  out(text: string): void;
  err(text: string): void;
}

const USAGE = [
  "使い方:",
  "  inject-source-apply.js get <id> [--out <file>]",
  "  inject-source-apply.js history <id> [--limit <1-50>]",
  "  inject-source-apply.js apply <id> --file <file> --expected-revision <revision>",
].join("\n");

export function parseFlags(args: readonly string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!key?.startsWith("--") || value === undefined) throw new InjectSourceError(`引数 ${key ?? ""} の値がありません`, 2);
    flags.set(key.slice(2), value);
  }
  return flags;
}

export async function runInjectSourceCli(argv: readonly string[], io: CliIo): Promise<number> {
  const [command, id, ...rest] = argv;
  if (!command || !id || !["get", "history", "apply"].includes(command)) {
    io.err(USAGE);
    return 2;
  }
  try {
    const flags = parseFlags(rest);
    const client = new InjectSourceClient(resolveConcordiaUrl(io.env), io.fetch);
    if (command === "get") {
      const source = await client.get(id);
      const outFile = flags.get("out");
      if (outFile) io.writeFile(outFile, source.content);
      else io.out(source.content);
      io.err(`id=${source.id} revision=${source.revision} version=${source.history_version_id ?? "-"} apply=${source.apply_scope ?? "-"}`);
      return 0;
    }
    if (command === "history") {
      const limit = Number(flags.get("limit") ?? "20");
      for (const v of await client.history(id, limit)) {
        io.out(`${v.version_id}\tparent=${v.parent_version_id ?? "-"}\t${v.change_kind}\t${v.actor}\t`
          + `${new Date(v.created_at).toISOString()}\t${v.revision}`);
      }
      return 0;
    }
    const file = flags.get("file");
    const expected = flags.get("expected-revision");
    if (!file || !expected) {
      io.err("apply には --file と --expected-revision (get で読んだ revision) が要ります");
      return 2;
    }
    const saved = await client.apply(id, io.readFile(file), expected);
    io.err(`保存しました: id=${saved.id} revision=${saved.revision} version=${saved.history_version_id ?? "-"} apply=${saved.apply_scope ?? "-"}`);
    return 0;
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error));
    return error instanceof InjectSourceError && error.status === 2 ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const io: CliIo = {
    env: process.env,
    fetch: (url, init) => fetch(url, init),
    readFile: (path) => readFileSync(path, "utf8"),
    writeFile: (path, content) => writeFileSync(path, content, "utf8"),
    out: (text) => process.stdout.write(`${text}\n`),
    err: (text) => process.stderr.write(`${text}\n`),
  };
  process.exitCode = await runInjectSourceCli(process.argv.slice(2), io);
}
