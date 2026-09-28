// @implements CC-COMMAND-CATALOG-01: read the authoritative root command list only.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const TIMEOUT_MS = 5_000;
const MAX_OUTPUT_BYTES = 256 * 1024;
let inFlight = 0;

export interface CommonCommand {
  name: string;
  usage: string;
  description: string;
}

/** Only fixed Cc/Castra entrypoints and literal list arguments may cross this boundary. */
export async function readCatalogProcess(file: string, args: readonly string[], cwd: string): Promise<string> {
  if (inFlight >= 2) throw new Error("catalog_reader_busy");
  inFlight++;
  try {
    const result = await execFileAsync(process.execPath, [file, ...args], {
      cwd,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      maxBuffer: MAX_OUTPUT_BYTES,
      windowsHide: true,
      shell: false,
    });
    return result.stdout;
  } finally {
    inFlight--;
  }
}

/** Strict pair parser: an incomplete or changed source format must be visible as an error. */
export function parseCommonCommands(output: string): CommonCommand[] {
  const lines = output.replace(/\r\n/g, "\n").split("\n");
  if (!lines[0]?.startsWith("LUDIARS command runner")) throw new Error("command_catalog_format_changed");
  const commands: CommonCommand[] = [];
  for (let index = 1; index < lines.length; index++) {
    const line = lines[index] ?? "";
    if (!/^  \S/.test(line)) {
      if (/^      \S/.test(line)) throw new Error("command_catalog_format_changed");
      continue;
    }
    const usage = /^  ([a-z][a-z0-9:-]*(?:<[^>]+>)?(?: .+)?)$/.exec(line);
    if (!usage) throw new Error("command_catalog_format_changed");
    const description = /^      (.+)$/.exec(lines[index + 1] ?? "");
    if (!description) throw new Error("command_catalog_format_changed");
    const name = usage[1].split(" ", 1)[0];
    commands.push({ name, usage: usage[1], description: description[1] });
    index++;
  }
  if (commands.length === 0 || new Set(commands.map(command => command.name)).size !== commands.length) {
    throw new Error("command_catalog_format_changed");
  }
  return commands;
}

export async function listCommonCommands(ccRoot: string): Promise<CommonCommand[]> {
  const runner = resolve(ccRoot, "..", "command-runner.mjs");
  return parseCommonCommands(await readCatalogProcess(runner, ["list"], ccRoot));
}
