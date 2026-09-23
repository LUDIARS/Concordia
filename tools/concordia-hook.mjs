#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runConcordiaHook } from "./concordia-hook-runtime.mjs";

/** CLI boundary only; disabled hooks must not wait for stdin. */
export async function runHookCli({
  argv = process.argv.slice(2), env = process.env,
  readInput = () => readFileSync(0, "utf8"), run = runConcordiaHook,
} = {}) {
  if (env.CONCORDIA_DISABLE === "1") return;
  let ctx = null;
  try { ctx = JSON.parse(readInput()); }
  catch { /* Hook input may be absent; preserve best-effort CLI behavior. */ }
  const flags = Object.fromEntries(argv.slice(1).flatMap(arg => {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    return match ? [[match[1], match[2]]] : [];
  }));
  await run({ event: argv[0] ?? "noop", ctx, flags, provider: flags.provider, env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await runHookCli().catch(error => {
    process.stderr.write("[concordia-hook] " + String(error?.message ?? error) + "\n");
  });
}
