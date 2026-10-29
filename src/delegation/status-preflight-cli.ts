import { preflightStatusJson } from "./status-preflight.js";

export interface PreflightCliResult { exitCode: number; stdout: string; stderr: string }

/** File access is injected; this use case never posts a status or changes a file. */
export async function runStatusPreflightCli(
  args: readonly string[],
  readFile: (path: string) => Promise<string>,
): Promise<PreflightCliResult> {
  if (args.length !== 1 || args[0].startsWith("-")) {
    return { exitCode: 2, stdout: "", stderr: "使い方: node --import tsx tools/delegation-status-preflight.mjs <report.json>\n" };
  }
  let text: string;
  try { text = await readFile(args[0]); }
  catch { return { exitCode: 2, stdout: "", stderr: '{"valid":false,"issues":[{"field":"$","code":"read_failed"}]}\n' }; }
  const result = preflightStatusJson(text);
  const output = `${JSON.stringify(result)}\n`;
  return { exitCode: result.valid ? 0 : 1, stdout: result.valid ? output : "", stderr: result.valid ? "" : output };
}
